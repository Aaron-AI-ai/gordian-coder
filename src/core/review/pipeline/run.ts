/**
 * Parallel-review orchestration (Model A): the two operations an orchestrator
 * agent calls.
 *
 * f_review_plan creates the run — resolves the target files, runs fcq once over
 * them, and hands back per-file fan-out instructions. f_review_finalize
 * verifies coverage (expected vs written), aggregates the per-file findings
 * into the report, and appends a run-quality summary.
 *
 * The run directory those operate on belongs to run-store.ts.
 *
 * Defensive limits: MAX_RUN_TARGETS caps a run's size, RUN_BATCH_SIZE is the
 * spawn-batch guidance given to the orchestrator, and pruneRuns keeps recent
 * terminal runs while expiring abandoned unfinished runs.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { SEVERITIES, verdict, type Finding, type Severity } from "../contract";
import { collectTargets, resolveDiffRange, type CommitSpec } from "./context";
import { FinalizeCacheSchema, MAX_RUN_TARGETS, RUNS_DIR, MAX_UNFINISHED_RUNS, RUN_BATCH_SIZE, absoluteOutputPath, createRun, diskTextHash, filesSnapshotIdentity, finalizeFingerprint, loadRun, pruneRuns, readRunResults, reviewArtifactHash, reviewCriteriaIdentity, runCoverage, runDir, runFreshness, unfinishedRuns, type RunMeta } from "./run-store";
import { loadConfig, resolveDeepPasses } from "../config";
import { defaultLabel, loadBaseline, manifestTimestamp, renderReviewContext, resolveOutputPath, writeReport } from "../report/output";
import { DEFAULT_JUDGE_THRESHOLD, readRunJudgments } from "./judge";
import { fcqFindings, mergeFcqFindings, readFcqFile, readFcqSummary, renderFcqSection, runFcq } from "../evidence/fcq";
import { rubricSources } from "../evidence/rubric";

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
  fcq?: boolean; // static analysis step (arg > config `fcq` > off)
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

function shortSha(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  return p.exitCode === 0 ? p.stdout.toString().trim() || undefined : undefined;
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
    excludes: [...(config.exclude ?? []), ...(args.exclude ?? [])],
    ...(config.fcqFix === true ? { fcqFix: true } : {}),
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
    // Every plan call fans out a fresh review, even for an identical unfinished
    // plan — resuming a prior run's artifacts is future work. The fingerprint
    // claim above still keeps two simultaneous identical planners from creating
    // two runs in the same instant.
    pruneRuns(cwd);
    const unfinished = unfinishedRuns(cwd);
    if (unfinished.length >= MAX_UNFINISHED_RUNS) {
      return (
        `⚠️ Refusing to create another run: ${unfinished.length} unfinished runs already exist ` +
        `(cap ${MAX_UNFINISHED_RUNS}). Finalize one of: ` +
        unfinished.slice(0, MAX_UNFINISHED_RUNS).map((run) => run.runId).join(", ")
      );
    }

    let meta = await createRun(
      { ...planned, baseline: [...loadBaseline(args.output, cwd)] },
      cwd
    );
    // Static analysis runs BEFORE the fan-out so every reviewer gets the same
    // evidence; the result (ok or failed) is pinned into run.json.
    if (args.fcq ?? config.fcq === true) {
      const fcq = await runFcq(cwd, targets, runDir(meta.runId, cwd));
      meta = { ...meta, fcq };
      await Bun.write(join(runDir(meta.runId, cwd), "run.json"), JSON.stringify(meta, null, 2));
    }
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
  const fcqLine = !meta.fcq
    ? []
    : meta.fcq.status === "ok"
      ? [
          `Static analysis (fcq): done in ${(meta.fcq.durationMs / 1000).toFixed(1)}s — violations are injected into each reviewer as evidence and merged at finalize.` +
            (meta.fcqFix ? " `fcqFix` is on: reviewers must write a TO-BE fix for every hit." : ""),
        ]
      : [`⚠️ Static analysis (fcq) FAILED: ${meta.fcq.reason}. The LLM review proceeds without it; finalize fails closed on failOn.`];
  return [
    `Run created: ${meta.runId} — ${meta.targets.length} file(s), mode: ${meta.range ? `commit diff (${meta.range})` : "explicit files"}${meta.whole ? " · whole-file" : ""}${(meta.deepPasses ?? 1) > 1 ? ` · ${meta.deepPasses} review rounds/target` : ""}${meta.failOn ? ` · gate: failOn=${meta.failOn}` : ""}${meta.judge ? ` · judge gate on` : ""}.`,
    ...list,
    ...fcqLine,
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
  // Copy: the fcq merge below appends to these arrays, and the judge check
  // hashes the parsed review objects — mutating them would unmatch every
  // recorded judgment and report the run as unjudged.
  for (const r of targetResults) findings[r.file] = [...r.findings];

  // Static-analysis findings merge into the same per-file tables (rule `fcq:…`).
  const runRoot = runDir(runId, cwd);
  const fcqSummary = meta.fcq?.status === "ok" ? readFcqSummary(runRoot) : null;
  if (meta.fcq?.status === "ok") {
    for (const file of meta.targets) {
      const rows = fcqFindings(file, readFcqFile(runRoot, file));
      if (rows.length) findings[file] = mergeFcqFindings(findings[file] ?? [], rows);
    }
  }
  const all = Object.values(findings).flat();
  const partials = targetResults.filter((r) => r.partial).map((r) => r.file);
  const forced = targetResults.filter((r) => r.forced).map((r) => r.file);
  const coverageIncomplete = targetResults
    .filter((r) => !r.coverageComplete)
    .map((r) => r.file);

  // Judge outcomes are bound to the current review revision. A pass for an
  // artifact that was subsequently rewritten cannot bless the newer review.
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
  if (meta.fcq && (meta.fcq.status !== "ok" || !fcqSummary)) {
    qualityReasons.push(`static analysis (fcq) did not complete: ${meta.fcq.reason ?? "no summary"}`);
  }
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

  // Name the report by runId, not just label: runId is claimed under an
  // exclusive-create lock, so parallel runs of the same commit (even across
  // processes, in the same second) can never resolve to the same file.
  const path = resolveOutputPath(meta.output, meta.runId, cwd);
  const baseline = new Set(meta.baseline ?? []); // plan-time snapshot (see RunMeta.baseline)
  // renderReport only knows finding severity, not run quality. Suppress its
  // finding-only PASS line for incomplete runs; the tool response carries the
  // fail-closed quality verdict. The only appendix is the Review Context —
  // input parameters and criteria sources, never run-quality noise.
  const context = renderReviewContext(meta.targets, {
    mode: `${meta.range ? `commit diff (${meta.range})` : "explicit files"}${meta.whole ? " · whole-file" : ""}`,
    range: meta.range,
    excludes: meta.excludes ?? [],
    rubricSources: rubricSources(cwd),
    generatedAt: manifestTimestamp(new Date(meta.createdAt)),
  });
  await writeReport(
    path,
    findings,
    meta.label,
    cwd,
    meta.language,
    qualityIncomplete ? undefined : meta.failOn,
    baseline,
    new Date(),
    `${renderFcqSection(meta.fcq, fcqSummary)}${context}`
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
    const fcqNote = fcqSummary ? ` (incl. ${fcqSummary.targetViolations} from fcq)` : "";
    response = `✅ Run complete — ${reviewed.length} file(s), ${all.length} issue(s)${fcqNote}.${gate}${forcedWarn} Report: ${path}`;
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
