/**
 * Parallel-review run store (Model A orchestration).
 *
 * A "run" is one fan-out review: an orchestrator agent calls f_review_plan
 * (creates the run), spawns one f-reviewer subagent per target file, and each
 * subagent writes its own per-file report under the run directory. All shared
 * state lives ON DISK — no in-memory coordination — so any number of subagent
 * sessions can join without growing process memory:
 *
 *   fcq/f-review/runs/<runId>/
 *     run.json                    expected targets + shared review config
 *     reviews/<slug>.md           human-readable per-file review
 *     reviews/<slug>.json         structured findings (what finalize aggregates)
 *
 * f_review_finalize verifies coverage (expected vs written), aggregates the
 * per-file findings into the normal report, and appends a run-quality summary.
 *
 * Defensive limits: MAX_RUN_TARGETS caps a run's size, RUN_BATCH_SIZE is the
 * spawn-batch guidance given to the orchestrator, and pruneRuns keeps recent
 * terminal runs while expiring abandoned unfinished runs.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  FindingSchema,
  REQUIRED_CATEGORIES,
  SEVERITIES,
  verdict,
  type Category,
  type Finding,
  type Severity,
} from "./contract";
import {
  collectTargets,
  loadConfig,
  resolveDeepPasses,
  resolveDiffRange,
  type CommitSpec,
} from "./context";
import { defaultLabel, loadBaseline, resolveOutputPath, writeReport } from "./output";
import { DEFAULT_JUDGE_THRESHOLD, readRunJudgments } from "./judge";
import { buildRubric, loadExtraRules, loadFrameworkGuide } from "./rubric";

export const RUNS_DIR = "fcq/f-review/runs";
/** Hard cap on targets per run — refuse larger fan-outs (split the range instead). */
export const MAX_RUN_TARGETS = 100;
/** Spawn-batch guidance for the orchestrator: at most this many subagents at once. */
export const RUN_BATCH_SIZE = 5;
/** How many terminal run directories pruneRuns keeps (newest first). */
export const RUNS_KEEP = 10;
/** Bound on unfinished fan-out runs. A looping orchestrator is refused after
 * this point instead of deleting an older run that may still have workers. */
export const MAX_UNFINISHED_RUNS = 10;
/** Unfinished runs older than this are abandoned and eligible for pruning. */
export const UNFINISHED_RUN_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunMeta {
  runId: string;
  createdAt: string; // ISO timestamp
  targets: string[]; // expected real file paths (coverage baseline)
  range: string | null; // git diff range shared by every subagent
  whole: boolean;
  label: string; // report filename stem
  language: string;
  output?: string;
  failOn?: Severity;
  requirementBackground?: string;
  planGuidance?: string;
  /** Review rounds per target, shared by every subagent (clamped 1..5). */
  deepPasses?: number;
  /** Judge gate: each file's review is evaluated by an independent judge agent
   * after submit; below-threshold reviews are re-reviewed with feedback. */
  judge?: boolean;
  /** Judge pass score (0..100, default DEFAULT_JUDGE_THRESHOLD). */
  judgeThreshold?: number;
  /** Max judge rework (re-review) rounds per file (0..5, default
   * MAX_JUDGE_ROUNDS; 0 = judge once, never re-review). */
  judgeRounds?: number;
  /** Baseline finding keys snapshotted at PLAN time (like sequential mode does
   * at start). Finalize must not re-read the report dir: a finalize retry would
   * otherwise see its own partial report and mislabel this run's findings as
   * pre-existing. */
  baseline?: string[];
  /** Identity of the exact source snapshot used by this plan. Diff runs pin
   * symbolic refs to commit SHAs; files-only runs hash target contents. */
  sourceIdentity?: string;
  /** Hash of every effective review rule/guide used when planning. */
  criteriaIdentity?: string;
}

/** Persisted run metadata is external state, even though this process created it. */
export const RunMetaSchema: z.ZodType<RunMeta> = z.object({
  runId: z.string().regex(/^[\w.-]+$/),
  createdAt: z.string(),
  targets: z.array(z.string()),
  range: z.string().nullable(),
  whole: z.boolean(),
  label: z.string(),
  language: z.string(),
  output: z.string().optional(),
  failOn: z.enum(SEVERITIES).optional(),
  requirementBackground: z.string().optional(),
  planGuidance: z.string().optional(),
  deepPasses: z.number().int().min(1).max(5).optional(),
  judge: z.boolean().optional(),
  judgeThreshold: z.number().min(0).max(100).optional(),
  judgeRounds: z.number().int().min(0).max(5).optional(),
  baseline: z.array(z.string()).optional(),
  sourceIdentity: z.string().optional(),
  criteriaIdentity: z.string().optional(),
});

/**
 * Structured per-file result written next to the rendered md (the aggregation
 * input). There is deliberately no findings-array cap here: a segmented review
 * merges several individually capped submissions and can legitimately exceed
 * SubmitSchema's per-submit limit.
 *
 * `revision` is assigned by writeFileReview, not trusted from a caller. A judge
 * attempt is bound to this monotonic revision so retrying the same tool call is
 * idempotent while a genuinely rewritten review may be judged again.
 */
const FileReviewResultObjectSchema = z
  .object({
    file: z.string().min(1).max(500),
    assessed: z.array(z.enum(REQUIRED_CATEGORIES)),
    findings: z.array(FindingSchema),
    explorationCalls: z.number().int().nonnegative(),
    partial: z.boolean(),
    forced: z.string().max(4000).optional(),
    coverageComplete: z.boolean().optional(),
    revision: z.number().int().positive().default(1),
  })
  .superRefine((result, ctx) => {
    result.findings.forEach((finding, index) => {
      if (finding.file !== result.file) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", index, "file"],
          message: `finding file ${finding.file} does not match review file ${result.file}`,
        });
      }
    });
  });

export const FileReviewResultSchema = FileReviewResultObjectSchema.transform((result) => ({
    ...result,
    // Legacy artifacts predate this field. Infer conservatively so a partial or
    // bounded-recovery artifact can never become a clean result during migration.
    coverageComplete:
      (result.coverageComplete ?? true) &&
      !result.partial &&
      result.forced === undefined &&
      REQUIRED_CATEGORIES.every((category) => result.assessed.includes(category)),
}));

/** Caller input (revision/coverageComplete remain optional for compatibility). */
export type FileReviewResult = z.input<typeof FileReviewResultSchema>;
/** Fully validated and normalized persisted result. */
export type PersistedFileReviewResult = z.output<typeof FileReviewResultSchema>;

const FinalizeCacheSchema = z.object({
  fingerprint: z.string(),
  response: z.string(),
  reportPath: z.string(),
  reportHash: z.string(),
  terminal: z.boolean(),
});

function diskTextHash(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return Bun.hash(readFileSync(path, "utf8")).toString();
  } catch {
    return null;
  }
}

function absoluteOutputPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function finalizeFingerprint(
  meta: RunMeta,
  results: PersistedFileReviewResult[],
  judgments: ReturnType<typeof readRunJudgments>,
  currentCriteriaIdentity: string,
  currentSourceIdentity: string
): string {
  return Bun.hash(
    JSON.stringify({
      // Every output-affecting option participates. A valid external edit to
      // run.json (threshold/output/language/baseline/...) must invalidate a
      // previously cached verdict and report.
      meta,
      currentCriteriaIdentity,
      currentSourceIdentity,
      results: results
        .map((result) => ({ file: result.file, hash: reviewArtifactHash(result) }))
        .sort((a, b) => a.file.localeCompare(b.file)),
      // Include the full validated judgment semantics, not only caller-owned
      // submissionHash/revision fields. Score/verdict/check changes must never
      // reuse a stale PASS response.
      judgments: judgments
        .map((judgment) => judgment)
        .sort((a, b) => a.file.localeCompare(b.file)),
    })
  ).toString();
}

/** Stable semantic hash of a normalized persisted review. */
export function reviewArtifactHash(result: PersistedFileReviewResult): string {
  return Bun.hash(JSON.stringify(result)).toString();
}

export function runDir(runId: string, cwd: string): string {
  return join(cwd, RUNS_DIR, runId);
}

/** Filesystem-safe, collision-resistant per-file review filename stem. The
 * readable prefix aids inspection; the full-path hash keeps aliases such as
 * `a/b.ts` and `a__b.ts` distinct. */
export function reviewSlug(file: string): string {
  const readable = file.replace(/[\\/]/g, "__").replace(/[^\w.__-]/g, "_").slice(0, 180);
  return `${readable}--${Bun.hash(file).toString(36)}`;
}

function shortSha(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  return p.exitCode === 0 ? p.stdout.toString().trim() || undefined : undefined;
}

/** Create the run directory + run.json. Returns the full meta (with runId). */
export async function createRun(
  meta: Omit<RunMeta, "runId" | "createdAt">,
  cwd: string
): Promise<RunMeta> {
  const t = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const stem = `${meta.label}-${t}`;
  // Claim a unique run with an exclusive-create lock. `existsSync` followed by
  // Bun.write is a TOCTOU race when several orchestrator processes plan in the
  // same second; the lock makes only one process own each candidate.
  let runId = stem;
  let claimPath = "";
  mkdirSync(join(cwd, RUNS_DIR, ".claims"), { recursive: true });
  for (let n = 1; ; n++) {
    runId = n === 1 ? stem : n <= 10_000 ? `${stem}-${n}` : `${stem}-${crypto.randomUUID()}`;
    claimPath = join(cwd, RUNS_DIR, ".claims", runId);
    try {
      closeSync(openSync(claimPath, "wx"));
      if (existsSync(runDir(runId, cwd))) {
        rmSync(claimPath, { force: true });
        continue;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
  try {
    const full: RunMeta = { ...meta, runId, createdAt: new Date().toISOString() };
    await Bun.write(join(runDir(runId, cwd), "run.json"), JSON.stringify(full, null, 2));
    return full;
  } finally {
    rmSync(claimPath, { force: true });
  }
}

/** Load a run's meta, or null when the run does not exist / is unreadable. */
export function loadRun(runId: string, cwd: string): RunMeta | null {
  // Path-safety: a runId is a filename we generated — never a path. Reject
  // anything that could escape the runs directory.
  if (!/^[\w.-]+$/.test(runId)) return null;
  const p = join(runDir(runId, cwd), "run.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = RunMetaSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success && parsed.data.runId === runId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Load one exact review artifact, rejecting corrupt and wrong-file state. */
export function readFileReviewResult(
  runId: string,
  file: string,
  cwd: string
): PersistedFileReviewResult | null {
  const p = join(runDir(runId, cwd), "reviews", `${reviewSlug(file)}.json`);
  if (!existsSync(p)) return null;
  try {
    const parsed = FileReviewResultSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success && parsed.data.file === file ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write one file's review artifacts (md + json). Overwrites — retries are idempotent. */
export async function writeFileReview(
  runId: string,
  result: FileReviewResult,
  md: string,
  cwd: string
): Promise<string> {
  const previous = readFileReviewResult(runId, result.file, cwd);
  // A corrupt/deleted review artifact must not reset to revision 1 and match a
  // stale verdict. Valid judgment records retain the greatest revision that
  // has ever escaped this process, so advance beyond both sources.
  const judgedRevision = readRunJudgments(runId, cwd)
    .filter((judgment) => judgment.file === result.file)
    .flatMap((judgment) => [
      ...judgment.attempts.map((attempt) => attempt.reviewRevision),
      ...judgment.invalidSubmissions.map((entry) => entry.reviewRevision),
      ...(judgment.terminal ? [judgment.terminal.reviewRevision] : []),
    ])
    .reduce((greatest, revision) => Math.max(greatest, revision), 0);
  const normalized = FileReviewResultSchema.parse({
    ...result,
    // Ignore a caller-supplied revision: only the persisted predecessor may
    // advance this value.
    revision: Math.max(previous?.revision ?? 0, judgedRevision) + 1,
  });
  const base = join(runDir(runId, cwd), "reviews", reviewSlug(normalized.file));
  await Bun.write(`${base}.json`, JSON.stringify(normalized, null, 2));
  await Bun.write(`${base}.md`, md);
  return `${base}.md`;
}

/** All structured per-file results written so far for a run. */
export function readRunResults(runId: string, cwd: string): PersistedFileReviewResult[] {
  const dir = join(runDir(runId, cwd), "reviews");
  if (!existsSync(dir)) return [];
  const out: PersistedFileReviewResult[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = FileReviewResultSchema.safeParse(
        JSON.parse(readFileSync(join(dir, f), "utf8"))
      );
      // The filename is part of the persistence contract. Without this check a
      // copied/renamed artifact could falsely satisfy another target's coverage.
      if (parsed.success && f === `${reviewSlug(parsed.data.file)}.json`) out.push(parsed.data);
    } catch {
      /* skip unreadable or partially-written state */
    }
  }
  return out;
}

/** Expected-vs-written coverage for a run. */
export function runCoverage(
  meta: RunMeta,
  results: FileReviewResult[]
): { reviewed: string[]; missing: string[] } {
  const written = new Set(results.map((r) => r.file));
  return {
    reviewed: meta.targets.filter((t) => written.has(t)),
    missing: meta.targets.filter((t) => !written.has(t)),
  };
}

function runIsTerminal(runId: string, cwd: string): boolean {
  const path = join(runDir(runId, cwd), "finalize.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = FinalizeCacheSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success || !parsed.data.terminal) return false;
    const meta = loadRun(runId, cwd);
    if (!meta) return false;
    const results = readRunResults(runId, cwd);
    // A run with missing artifacts is active even if a stale/edited cache says
    // terminal. Also bind the marker to current review/judgment/meta state and
    // to the report still present on disk before allowing pruning.
    if (runCoverage(meta, results).missing.length) return false;
    const judgments = readRunJudgments(runId, cwd);
    const freshness = runFreshness(meta, cwd);
    return (
      parsed.data.fingerprint ===
        finalizeFingerprint(
          meta,
          results,
          judgments,
          freshness.currentCriteriaIdentity,
          freshness.currentSourceIdentity
        ) &&
      diskTextHash(absoluteOutputPath(parsed.data.reportPath, cwd)) === parsed.data.reportHash
    );
  } catch {
    return false;
  }
}

/** Latest persisted activity in a run. Writing a review or judgment does not
 * reliably update the run directory's own mtime, so inspect the two bounded
 * artifact directories instead of expiring a live worker by `createdAt` alone. */
function runLastActivity(meta: RunMeta, cwd: string): number {
  const created = Date.parse(meta.createdAt);
  let latest = Number.isFinite(created) ? created : 0;
  const root = runDir(meta.runId, cwd);
  const include = (path: string): void => {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      /* an artifact may disappear while prune inspects it */
    }
  };
  include(root);
  include(join(root, "run.json"));
  include(join(root, "finalize.json"));
  for (const directory of [join(root, "reviews"), join(root, "judgments")]) {
    if (!existsSync(directory)) continue;
    include(directory);
    try {
      for (const name of readdirSync(directory).slice(0, MAX_RUN_TARGETS * 4)) {
        include(join(directory, name));
      }
    } catch {
      /* concurrent writer/remover; the timestamps collected so far suffice */
    }
  }
  return latest;
}

function runIsAbandoned(meta: RunMeta, cwd: string, now = Date.now()): boolean {
  return now - runLastActivity(meta, cwd) > UNFINISHED_RUN_TTL_MS;
}

function unfinishedRuns(cwd: string): RunMeta[] {
  const root = join(cwd, RUNS_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((runId) => runId !== ".claims")
    .map((runId) => loadRun(runId, cwd))
    .filter(
      (meta): meta is RunMeta =>
        !!meta && !runIsTerminal(meta.runId, cwd) && !runIsAbandoned(meta, cwd)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete all but the newest `keep` TERMINAL run directories. Recent unfinished
 * runs are protected; only those idle past UNFINISHED_RUN_TTL_MS are abandoned.
 * planReview bounds the remaining active count separately. */
export function pruneRuns(cwd: string, keep: number = RUNS_KEEP): string[] {
  const root = join(cwd, RUNS_DIR);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .map((name) => ({ name, p: join(root, name) }))
    .filter((entry) => entry.name !== ".claims")
    .filter((e) => statSync(e.p).isDirectory())
    .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs);
  const removed: string[] = [];
  const terminal = dirs.filter((entry) => runIsTerminal(entry.name, cwd));
  for (const e of terminal.slice(Math.max(0, keep))) {
    rmSync(e.p, { recursive: true, force: true });
    removed.push(e.name);
  }
  for (const entry of dirs) {
    if (removed.includes(entry.name) || terminal.some((item) => item.name === entry.name)) continue;
    const meta = loadRun(entry.name, cwd);
    if (meta && runIsAbandoned(meta, cwd)) {
      rmSync(entry.p, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

// ── orchestrator-facing operations ───────────────────────────────

export interface PlanReviewArgs {
  commit?: string;
  from?: string;
  to?: string;
  files?: string[];
  whole?: boolean;
  exclude?: string[];
  output?: string;
  failOn?: Severity;
  requirementBackground?: string;
  planGuidance?: string;
  language?: string;
  deepPasses?: number; // review rounds per target (arg > config `deepPasses` > 1; clamp 1..5)
  judge?: boolean; // judge gate (arg > config `judge` > off)
}

type PlannedRun = Omit<RunMeta, "runId" | "createdAt" | "baseline">;

function planFingerprint(meta: PlannedRun | RunMeta): string {
  return JSON.stringify({
    targets: meta.targets,
    range: meta.range,
    whole: meta.whole,
    language: meta.language,
    output: meta.output ?? null,
    failOn: meta.failOn ?? null,
    requirementBackground: meta.requirementBackground ?? null,
    planGuidance: meta.planGuidance ?? null,
    deepPasses: meta.deepPasses ?? 1,
    judge: meta.judge ?? false,
    judgeThreshold: meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD,
    sourceIdentity: meta.sourceIdentity ?? null,
    criteriaIdentity: meta.criteriaIdentity ?? null,
  });
}

const PLAN_CLAIM_WAIT_MS = 10_000;
const PLAN_CLAIM_STALE_MS = 30_000;

/** Acquire a cross-process claim for one semantic plan. The caller repeats the
 * reuse/cap checks only after owning this claim, closing the scan→create race
 * that otherwise fans out duplicate runs. A crashed planner's claim expires. */
async function acquirePlanClaim(fingerprint: string, cwd: string): Promise<string | null> {
  const directory = join(cwd, RUNS_DIR, ".claims", "plans");
  mkdirSync(directory, { recursive: true });
  const id = createHash("sha256").update(fingerprint).digest("hex");
  const path = join(directory, `${id}.lock`);
  const deadline = Date.now() + PLAN_CLAIM_WAIT_MS;

  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > PLAN_CLAIM_STALE_MS) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return null;
    await Bun.sleep(25);
  }
}

function resolveCommitRef(cwd: string, ref: string): string | null {
  const process = Bun.spawnSync(["git", "rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  return process.exitCode === 0 ? process.stdout.toString().trim() || null : null;
}

/** Freeze a symbolic diff range so workers joining later cannot observe a
 * different HEAD. Preserve two-dot vs three-dot diff semantics. */
function pinDiffRange(range: string | null, cwd: string): string | null {
  if (!range) return null;
  const match = /^(.*?)(\.{2,3})(.*)$/.exec(range);
  if (!match) return resolveCommitRef(cwd, range) ?? range;
  const left = resolveCommitRef(cwd, match[1] || "HEAD");
  const right = resolveCommitRef(cwd, match[3] || "HEAD");
  return left && right ? `${left}${match[2]}${right}` : range;
}

function filesSnapshotIdentity(cwd: string, targets: string[]): string {
  return Bun.hash(
    JSON.stringify(
      targets.map((file) => [file, diskTextHash(join(cwd, file)) ?? "missing"])
    )
  ).toString();
}

export function reviewCriteriaIdentity(cwd: string): string {
  return Bun.hash(
    JSON.stringify({
      rubric: buildRubric(cwd),
      framework: loadFrameworkGuide(cwd),
      extraRules: loadExtraRules(cwd),
    })
  ).toString();
}

export interface RunFreshness {
  currentCriteriaIdentity: string;
  currentSourceIdentity: string;
  criteriaStale: boolean;
  sourceStale: boolean;
}

/** Compare a persisted plan to the effective inputs a worker/finalizer would
 * use now. Diff runs are already pinned to immutable commit SHAs; files-only
 * runs must re-hash their targets because they read the working tree. */
export function runFreshness(meta: RunMeta, cwd: string): RunFreshness {
  const currentCriteriaIdentity = reviewCriteriaIdentity(cwd);
  const currentSourceIdentity = meta.range ?? filesSnapshotIdentity(cwd, meta.targets);
  return {
    currentCriteriaIdentity,
    currentSourceIdentity,
    criteriaStale:
      meta.criteriaIdentity !== undefined &&
      meta.criteriaIdentity !== currentCriteriaIdentity,
    sourceStale:
      meta.sourceIdentity !== undefined && meta.sourceIdentity !== currentSourceIdentity,
  };
}

/** Collect targets, create the run, and return the fan-out instructions the
 * orchestrator follows. All error cases come back as text (shown to the model). */
export async function planReview(args: PlanReviewArgs, cwd: string): Promise<string> {
  let commit: CommitSpec | undefined;
  if (args.from) commit = { from: args.from, to: args.to ?? "HEAD" };
  else if (args.commit) commit = args.commit;

  // Resolve symbolic refs before collecting targets, then use the same pinned
  // range for collection and every worker. Otherwise HEAD could move between
  // `git diff --name-only` and run metadata creation, mixing two snapshots.
  const symbolicRange = resolveDiffRange(commit, !!args.files?.length);
  const range = pinDiffRange(symbolicRange, cwd);
  const collectionCommit: CommitSpec | undefined = range ?? undefined;

  let targets: string[];
  try {
    targets = await collectTargets(
      { commit: collectionCommit, files: args.files, exclude: args.exclude },
      cwd
    );
  } catch (err) {
    return `Could not collect review targets: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (targets.length === 0) return "No files to review (empty target set after excludes).";
  if (targets.length > MAX_RUN_TARGETS) {
    return (
      `❌ ${targets.length} files exceed the per-run cap of ${MAX_RUN_TARGETS}. ` +
      `Narrow the commit range or add exclude globs, and run several smaller reviews.`
    );
  }

  const config = loadConfig(cwd);
  const planned: PlannedRun = {
    targets,
    range,
    // Files-only reviews default to whole-file (same rule as startReview):
    // no commit diff exists, so a diff-mode review could be empty.
    whole: args.whole ?? (commit === undefined && !!args.files?.length),
    label: shortSha(cwd) ?? defaultLabel(),
    language: args.language ?? config.language ?? "ko",
    output: args.output,
    // arg wins, else config value only if a valid severity (same rule as startReview)
    failOn:
      args.failOn ??
      (SEVERITIES.includes(config.failOn as Severity) ? (config.failOn as Severity) : undefined),
    requirementBackground: args.requirementBackground,
    planGuidance: args.planGuidance,
    deepPasses: resolveDeepPasses(args.deepPasses, cwd),
    judge: args.judge ?? config.judge === true,
    judgeThreshold:
      typeof config.judgeThreshold === "number"
        ? Math.max(0, Math.min(100, config.judgeThreshold))
        : undefined,
    judgeRounds:
      typeof config.judgeRounds === "number"
        ? Math.max(0, Math.min(5, Math.trunc(config.judgeRounds)))
        : undefined,
    sourceIdentity: range ?? filesSnapshotIdentity(cwd, targets),
    criteriaIdentity: reviewCriteriaIdentity(cwd),
  };

  const fingerprint = planFingerprint(planned);
  const claimPath = await acquirePlanClaim(fingerprint, cwd);
  if (!claimPath) {
    return (
      `⚠️ An identical f_review_plan is still being created by another process. ` +
      `No run was created by this call; retry once after the other planner returns.`
    );
  }
  try {
    // Tool-call replay safety: the same unfinished plan is a read of existing
    // state, not a request to fan out a second set of workers. This scan and
    // the eventual create occur under the fingerprint claim above.
    pruneRuns(cwd);
    const unfinished = unfinishedRuns(cwd);
    const reused = unfinished.find(
      (candidate) => planFingerprint(candidate) === fingerprint
    );
    if (reused) {
      const reusedResults = readRunResults(reused.runId, cwd);
      const { missing } = runCoverage(reused, reusedResults);
      const reusedJudgments = reused.judge ? readRunJudgments(reused.runId, cwd) : [];
      const judgePending = reused.judge
        ? reused.targets.filter((file) => {
            const review = reusedResults.find((result) => result.file === file);
            if (!review) return false;
            const hash = reviewArtifactHash(review);
            const judgment = reusedJudgments.find((candidate) => candidate.file === file);
            const terminal = judgment?.terminal;
            if (
              terminal?.reviewRevision === review.revision &&
              terminal.reviewArtifactHash === hash
            ) {
              return false;
            }
            const attempt = judgment?.attempts.findLast(
              (candidate) =>
                candidate.reviewRevision === review.revision &&
                candidate.reviewArtifactHash === hash
            );
            return (
              !attempt ||
              attempt.verdict !== "pass" ||
              attempt.score < (reused.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD)
            );
          })
        : [];
      return (
        `ℹ️ Duplicate f_review_plan ignored; resume unfinished run ${reused.runId}. ` +
        `STOP calling f_review_plan and do NOT spawn duplicate workers for targets already dispatched. ` +
        (missing.length
          ? `Review artifacts are still missing for: ${missing.join(", ")}. Coordinate only those outstanding targets, then call f_review_finalize.`
          : judgePending.length
            ? `Review artifacts exist, but the judge gate is still pending/rework for: ${judgePending.join(", ")}. Resume those judge/reviewer rounds; finalize only after they pass or become terminal INCOMPLETE.`
            : `All review artifacts exist; call f_review_finalize now.`)
      );
    }
    if (unfinished.length >= MAX_UNFINISHED_RUNS) {
      return (
        `⚠️ Refusing to create another run: ${unfinished.length} unfinished runs already exist ` +
        `(cap ${MAX_UNFINISHED_RUNS}). Resume/finalize one of: ` +
        unfinished.slice(0, MAX_UNFINISHED_RUNS).map((run) => run.runId).join(", ")
      );
    }

    const meta = await createRun(
      { ...planned, baseline: [...loadBaseline(args.output, cwd)] },
      cwd
    );
    pruneRuns(cwd);
    return renderPlanInstructions(meta);
  } finally {
    rmSync(claimPath, { force: true });
  }
}

function renderPlanInstructions(meta: RunMeta): string {
  // List every target: the orchestrator dispatches from this text, so a
  // truncated list would silently drop files onto the single finalize retry.
  const list = meta.targets.map((target) => `  - ${target}`);
  const judgeSteps = meta.judge
    ? [
        `3. JUDGE GATE — after EACH f-reviewer subagent finishes, spawn ONE f-judge subagent with this prompt:`,
        `   "Call f_review_judge_context with runId=\"${meta.runId}\" and file=\"<file>\", evaluate that review, then call f_review_judge."`,
        `4. Follow the message f_review_judge returns EXACTLY: it either accepts the file, or tells you to re-spawn the f-reviewer for that file (judge feedback is injected automatically) and judge again. The rework cap is enforced by the tool — never re-spawn beyond what it instructs.`,
        `5. When every file is accepted, call f_review_finalize with runId="${meta.runId}".`,
        `6. If finalize reports missing files, re-spawn subagents for ONLY those files ONCE (judging each again), then finalize again.`,
      ]
    : [
        `3. When every file has been dispatched, call f_review_finalize with runId="${meta.runId}".`,
        `4. If finalize reports missing files, re-spawn subagents for ONLY those files ONCE, then finalize again.`,
      ];
  return [
    `Run created: ${meta.runId} — ${meta.targets.length} file(s), mode: ${meta.range ? `commit diff (${meta.range})` : "explicit files"}${meta.whole ? " · whole-file" : ""}${(meta.deepPasses ?? 1) > 1 ? ` · ${meta.deepPasses} review rounds/target` : ""}${meta.failOn ? ` · gate: failOn=${meta.failOn}` : ""}${meta.judge ? ` · judge gate on` : ""}.`,
    ...list,
    "",
    `Fan-out instructions (follow exactly):`,
    `1. For EACH file above, spawn ONE f-reviewer subagent with this prompt:`,
    `   "Call f_review_context with runId=\"${meta.runId}\" and files=[\"<file>\"], review that single file, and call f_review_submit. Review no other files."`,
    `2. Spawn at most ${RUN_BATCH_SIZE} subagents at a time; wait for a batch to finish before the next.`,
    ...judgeSteps,
  ].join("\n");
}

/** Aggregate a run: verify coverage, merge per-file findings into the standard
 * report (+ run summary appendix), and report what is still missing. */
export async function finalizeRun(runId: string, cwd: string): Promise<string> {
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first.`;

  const results = readRunResults(runId, cwd);
  const allJudgments = readRunJudgments(runId, cwd);
  const freshness = runFreshness(meta, cwd);
  const { criteriaStale, sourceStale } = freshness;
  const fingerprint = finalizeFingerprint(
    meta,
    results,
    allJudgments,
    freshness.currentCriteriaIdentity,
    freshness.currentSourceIdentity
  );
  const cachePath = join(runDir(runId, cwd), "finalize.json");
  if (existsSync(cachePath)) {
    try {
      const cached = FinalizeCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf8")));
      if (
        cached.success &&
        cached.data.fingerprint === fingerprint &&
        diskTextHash(absoluteOutputPath(cached.data.reportPath, cwd)) === cached.data.reportHash
      ) {
        return cached.data.response;
      }
    } catch {
      /* corrupt cache is ignored; normal finalize rebuilds it */
    }
  }
  const { reviewed, missing } = runCoverage(meta, results);

  const targetResults = results.filter((result) => meta.targets.includes(result.file));
  const resultByFile = new Map(targetResults.map((result) => [result.file, result]));
  const findings: Record<string, Finding[]> = {};
  for (const r of targetResults) findings[r.file] = r.findings;

  const all = Object.values(findings).flat();
  const partials = targetResults.filter((r) => r.partial).map((r) => r.file);
  const forced = targetResults.filter((r) => r.forced).map((r) => r.file);
  const coverageIncomplete = targetResults
    .filter((r) => !r.coverageComplete)
    .map((r) => r.file);
  const unexplored = targetResults.filter((r) => !r.explorationCalls).map((r) => r.file);

  // Judge outcomes are bound to the current review revision. A pass for an
  // artifact that was subsequently rewritten cannot bless the newer review.
  const judgeLines: string[] = [];
  let judgeBelowThreshold: string[] = [];
  let judgeUnjudged: string[] = [];
  let judgeIncomplete: string[] = [];
  if (meta.judge) {
    const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
    const judgments = allJudgments;
    const byFile = new Map(judgments.map((judgment) => [judgment.file, judgment]));
    const currentAttempt = (file: string) => {
      const review = resultByFile.get(file);
      if (!review) return undefined;
      const hash = reviewArtifactHash(review);
      return byFile.get(file)?.attempts.findLast(
        (attempt) =>
          attempt.reviewRevision === review.revision &&
          attempt.reviewArtifactHash === hash
      );
    };
    const currentTerminal = (file: string) => {
      const review = resultByFile.get(file);
      if (!review) return undefined;
      const hash = reviewArtifactHash(review);
      const terminal = byFile.get(file)?.terminal;
      return terminal?.reviewRevision === review.revision &&
        terminal.reviewArtifactHash === hash
        ? terminal
        : undefined;
    };
    const passed = reviewed.filter((file) => {
      const attempt = currentAttempt(file);
      return (
        !currentTerminal(file) &&
        attempt?.verdict === "pass" &&
        attempt.score >= threshold
      );
    });
    judgeIncomplete = reviewed.filter((file) => !!currentTerminal(file));
    judgeBelowThreshold = reviewed.filter((file) => {
      const attempt = currentAttempt(file);
      return (
        !currentTerminal(file) &&
        !!attempt &&
        (attempt.verdict !== "pass" || attempt.score < threshold)
      );
    });
    judgeUnjudged = reviewed.filter(
      (file) => !currentTerminal(file) && !currentAttempt(file)
    );
    judgeLines.push(
      `- Judge: ${passed.length}/${reviewed.length} file(s) passed (threshold ${threshold})`
    );
    if (judgeBelowThreshold.length) {
      judgeLines.push(
        `- ⚠️ Below judge threshold (quality incomplete): ${judgeBelowThreshold
          .map((file) => `${file} (score ${currentAttempt(file)?.score})`)
          .join(", ")}`
      );
    }
    if (judgeIncomplete.length) {
      judgeLines.push(
        `- ⚠️ Judge incomplete (bounded terminal): ${judgeIncomplete
          .map((file) => `${file} (${currentTerminal(file)?.reason})`)
          .join(", ")}`
      );
    }
    if (judgeUnjudged.length) {
      judgeLines.push(`- ⚠️ Reviewed but never judged: ${judgeUnjudged.join(", ")}`);
    }
  }

  const qualityReasons: string[] = [];
  if (missing.length) qualityReasons.push(`${missing.length} missing artifact(s)`);
  if (partials.length) qualityReasons.push(`${partials.length} partial review(s)`);
  if (forced.length) qualityReasons.push(`${forced.length} bounded-recovery review(s)`);
  if (coverageIncomplete.length) {
    qualityReasons.push(`${coverageIncomplete.length} review(s) without complete coverage`);
  }
  if (judgeIncomplete.length) qualityReasons.push(`${judgeIncomplete.length} judge-incomplete`);
  if (judgeBelowThreshold.length) {
    qualityReasons.push(`${judgeBelowThreshold.length} below judge threshold`);
  }
  if (judgeUnjudged.length) qualityReasons.push(`${judgeUnjudged.length} unjudged review(s)`);
  if (criteriaStale) qualityReasons.push("effective review rules changed after planning");
  if (sourceStale) qualityReasons.push("review source files changed after planning");
  const qualityIncomplete = qualityReasons.length > 0;

  let gate = "";
  if (meta.failOn) {
    if (qualityIncomplete) {
      gate = ` Verdict: FAIL — review quality INCOMPLETE (failOn: ${meta.failOn}; fail closed).`;
    } else {
      const v = verdict(all, meta.failOn);
      gate = v.pass
        ? ` Verdict: PASS (failOn: ${meta.failOn}).`
        : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${meta.failOn}.`;
    }
  }

  // Run-quality appendix rendered under the standard report body.
  const summary = [
    "## Run Summary",
    "",
    `- Run: ${runId} (${meta.range ? `commit diff ${meta.range}` : "explicit files"}${meta.whole ? " · whole-file" : ""})`,
    `- Coverage: ${reviewed.length}/${meta.targets.length} file(s) reviewed${
      missing.length
        ? ` — **INCOMPLETE**, missing: ${missing.join(", ")}`
        : qualityIncomplete
          ? " — artifacts present; **QUALITY INCOMPLETE**"
          : " — complete"
    }`,
    `- Quality status: ${qualityIncomplete ? `**INCOMPLETE** — ${qualityReasons.join("; ")}` : "complete"}`,
    ...(partials.length ? [`- ⚠️ Partial reviews (subagent cut off early): ${partials.join(", ")}`] : []),
    ...(forced.length
      ? [`- ⚠️ Force-advanced by bounded recovery (terminal, not quality-complete): ${forced.join(", ")}`]
      : []),
    ...(coverageIncomplete.length
      ? [`- ⚠️ Coverage incomplete: ${coverageIncomplete.join(", ")}`]
      : []),
    ...(unexplored.length
      ? [`- ⚠️ Reviewed without exploration calls (evidence only): ${unexplored.join(", ")}`]
      : []),
    ...judgeLines,
    ...(meta.failOn && qualityIncomplete
      ? [`- Verdict: **FAIL** — quality incomplete; failOn=${meta.failOn} fails closed`]
      : []),
    `- Per-file reviews: ${join(RUNS_DIR, runId, "reviews")}/`,
    "",
  ].join("\n");

  const path = resolveOutputPath(meta.output, meta.label, cwd);
  const baseline = new Set(meta.baseline ?? []); // plan-time snapshot (see RunMeta.baseline)
  // renderReport only knows finding severity, not run quality. Suppress its
  // finding-only PASS line for incomplete runs; the appendix records the
  // fail-closed quality verdict instead.
  await writeReport(
    path,
    findings,
    meta.label,
    cwd,
    meta.language,
    qualityIncomplete ? undefined : meta.failOn,
    baseline,
    new Date(),
    summary
  );

  const forcedWarn = forced.length
    ? ` ⚠️ ${forced.length} file(s) force-advanced by bounded recovery: ${forced.join(", ")}.`
    : "";
  let response: string;
  if (missing.length) {
    response = (
      `⚠️ INCOMPLETE — ${reviewed.length}/${meta.targets.length} file(s) reviewed; missing: ${missing.join(", ")}.` +
      `${gate}${forcedWarn} Partial report: ${path}\n` +
      `Re-spawn ONE f-reviewer subagent per missing file (same runId), then call f_review_finalize again. Do this at most once.`
    );
  } else if (qualityIncomplete) {
    response = (
      `⚠️ Run terminated — INCOMPLETE: ${reviewed.length}/${meta.targets.length} review artifact(s) present; ` +
      `${qualityReasons.join("; ")}.${gate}${forcedWarn} Report: ${path}`
    );
  } else {
    response = `✅ Run complete — ${reviewed.length} file(s), ${all.length} issue(s).${gate}${forcedWarn} Report: ${path}`;
  }
  await Bun.write(
    cachePath,
    JSON.stringify(
      {
        fingerprint,
        response,
        reportPath: path,
        reportHash: diskTextHash(absoluteOutputPath(path, cwd)) ?? "missing",
        terminal: missing.length === 0,
      },
      null,
      2
    )
  );
  return response;
}
