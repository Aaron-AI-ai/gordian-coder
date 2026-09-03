/**
 * On-disk state of a parallel review run.
 *
 * A "run" is one fan-out review. ALL shared state lives on disk — no in-memory
 * coordination — so any number of subagent sessions can join without growing
 * process memory:
 *
 *   fcq/f-review/runs/<runId>/
 *     run.json                    expected targets + shared review config
 *     reviews/<slug>.md           human-readable per-file review
 *     reviews/<slug>.json         structured findings (what finalize aggregates)
 *
 * This module owns that directory: its schemas, its paths, reading and writing
 * an artifact, and deciding whether a run is finished, stale, or abandoned.
 * run.ts drives the orchestration on top of it.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { FindingSchema, REQUIRED_CATEGORIES, SEVERITIES, type Severity } from "../contract";
import { FcqRunStatusSchema, type FcqRunStatus } from "../evidence/fcq";
import { buildRubric, loadExtraRules, loadFrameworkGuide } from "../evidence/rubric";
import { readRunJudgments } from "./judge";

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
  /** Effective exclude globs (config + plan args), kept for the report's
   * Review Context appendix. */
  excludes?: string[];
  /** Static analysis (fcq) step outcome; absent when not enabled for the run. */
  fcq?: FcqRunStatus;
  /** Config `fcqFix`: reviewers must write a TO-BE fix for every fcq hit, not
   * just CRITICAL/MAJOR. Costs reviewer budget; buys real code in the report. */
  fcqFix?: boolean;
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
  excludes: z.array(z.string()).optional(),
  fcq: FcqRunStatusSchema.optional(),
  fcqFix: z.boolean().optional(),
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

export const FinalizeCacheSchema = z.object({
  fingerprint: z.string(),
  response: z.string(),
  reportPath: z.string(),
  reportHash: z.string(),
  terminal: z.boolean(),
});

export function diskTextHash(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return Bun.hash(readFileSync(path, "utf8")).toString();
  } catch {
    return null;
  }
}

export function absoluteOutputPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export function finalizeFingerprint(
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

export function filesSnapshotIdentity(cwd: string, targets: string[]): string {
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

export function runIsTerminal(runId: string, cwd: string): boolean {
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
export function runLastActivity(meta: RunMeta, cwd: string): number {
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

export function runIsAbandoned(meta: RunMeta, cwd: string, now = Date.now()): boolean {
  return now - runLastActivity(meta, cwd) > UNFINISHED_RUN_TTL_MS;
}

export function unfinishedRuns(cwd: string): RunMeta[] {
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
