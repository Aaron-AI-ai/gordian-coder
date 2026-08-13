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
 * spawn-batch guidance given to the orchestrator, and pruneRuns keeps only the
 * newest few run directories.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, verdict, type Category, type Finding, type Severity } from "./contract";
import {
  collectTargets,
  loadConfig,
  resolveDeepPasses,
  resolveDiffRange,
  type CommitSpec,
} from "./context";
import { defaultLabel, loadBaseline, resolveOutputPath, writeReport } from "./output";
import { DEFAULT_JUDGE_THRESHOLD, readRunJudgments } from "./judge";

export const RUNS_DIR = "fcq/f-review/runs";
/** Hard cap on targets per run — refuse larger fan-outs (split the range instead). */
export const MAX_RUN_TARGETS = 100;
/** Spawn-batch guidance for the orchestrator: at most this many subagents at once. */
export const RUN_BATCH_SIZE = 5;
/** How many run directories pruneRuns keeps (newest first). */
export const RUNS_KEEP = 10;

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
  /** Baseline finding keys snapshotted at PLAN time (like sequential mode does
   * at start). Finalize must not re-read the report dir: a finalize retry would
   * otherwise see its own partial report and mislabel this run's findings as
   * pre-existing. */
  baseline?: string[];
}

/** Structured per-file result written next to the rendered md (the aggregation input). */
export interface FileReviewResult {
  file: string;
  assessed: Category[];
  findings: Finding[];
  explorationCalls: number;
  partial: boolean; // true when the subagent was cut off before finishing every segment
  forced?: string; // force-accept note(s): the loop salvage-advanced this file — NOT a clean, fully-assessed review
}

export function runDir(runId: string, cwd: string): string {
  return join(cwd, RUNS_DIR, runId);
}

/** Filesystem-safe per-file review filename stem.
 * ponytail: "__" for "/" plus a small deny-list — a real file named `a__b.ts`
 * could collide with `a/b.ts`, but the .json carries the true path so only
 * coverage of that exotic pair would suffer. */
export function reviewSlug(file: string): string {
  return file.replace(/[\\/]/g, "__").replace(/[^\w.__-]/g, "_");
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
  let runId = `${meta.label}-${t}`;
  // Same-second re-plan: suffix instead of silently merging into the old run.
  for (let n = 2; existsSync(runDir(runId, cwd)) && n < 10; n++) runId = `${meta.label}-${t}-${n}`;
  const full: RunMeta = { ...meta, runId, createdAt: new Date().toISOString() };
  await Bun.write(join(runDir(runId, cwd), "run.json"), JSON.stringify(full, null, 2));
  return full;
}

/** Load a run's meta, or null when the run does not exist / is unreadable. */
export function loadRun(runId: string, cwd: string): RunMeta | null {
  // Path-safety: a runId is a filename we generated — never a path. Reject
  // anything that could escape the runs directory.
  if (!/^[\w.-]+$/.test(runId)) return null;
  const p = join(runDir(runId, cwd), "run.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunMeta;
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
  const base = join(runDir(runId, cwd), "reviews", reviewSlug(result.file));
  await Bun.write(`${base}.json`, JSON.stringify(result, null, 2));
  await Bun.write(`${base}.md`, md);
  return `${base}.md`;
}

/** All structured per-file results written so far for a run. */
export function readRunResults(runId: string, cwd: string): FileReviewResult[] {
  const dir = join(runDir(runId, cwd), "reviews");
  if (!existsSync(dir)) return [];
  const out: FileReviewResult[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as FileReviewResult);
    } catch {
      /* skip unreadable partial writes */
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

/** Delete all but the newest `keep` run directories. Returns what was removed. */
export function pruneRuns(cwd: string, keep: number = RUNS_KEEP): string[] {
  const root = join(cwd, RUNS_DIR);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .map((name) => ({ name, p: join(root, name) }))
    .filter((e) => statSync(e.p).isDirectory())
    .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs);
  const removed: string[] = [];
  for (const e of dirs.slice(Math.max(0, keep))) {
    rmSync(e.p, { recursive: true, force: true });
    removed.push(e.name);
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

/** Collect targets, create the run, and return the fan-out instructions the
 * orchestrator follows. All error cases come back as text (shown to the model). */
export async function planReview(args: PlanReviewArgs, cwd: string): Promise<string> {
  let commit: CommitSpec | undefined;
  if (args.from) commit = { from: args.from, to: args.to ?? "HEAD" };
  else if (args.commit) commit = args.commit;

  let targets: string[];
  try {
    targets = await collectTargets({ commit, files: args.files, exclude: args.exclude }, cwd);
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
  const meta = await createRun(
    {
      targets,
      range: resolveDiffRange(commit, !!args.files?.length),
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
      baseline: [...loadBaseline(args.output, cwd)],
    },
    cwd
  );
  // Drop old run dirs; the one just created is newest, so it always survives.
  pruneRuns(cwd);

  // List every target: the orchestrator dispatches from this text, so a
  // truncated list would silently drop files onto the single finalize retry.
  const list = targets.map((t) => `  - ${t}`);
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
    `Run created: ${meta.runId} — ${targets.length} file(s), mode: ${meta.range ? `commit diff (${meta.range})` : "explicit files"}${meta.whole ? " · whole-file" : ""}${(meta.deepPasses ?? 1) > 1 ? ` · ${meta.deepPasses} review rounds/target` : ""}${meta.failOn ? ` · gate: failOn=${meta.failOn}` : ""}${meta.judge ? ` · judge gate on` : ""}.`,
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
  const { reviewed, missing } = runCoverage(meta, results);

  const findings: Record<string, Finding[]> = {};
  for (const r of results) {
    if (meta.targets.includes(r.file)) findings[r.file] = r.findings;
  }

  const all = Object.values(findings).flat();
  const partials = results.filter((r) => r.partial).map((r) => r.file);
  const forced = results.filter((r) => r.forced).map((r) => r.file);
  const unexplored = results.filter((r) => !r.explorationCalls).map((r) => r.file);

  // Judge outcomes (judge-gated runs): latest verdict per reviewed file.
  const judgeLines: string[] = [];
  if (meta.judge) {
    const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
    const judgments = readRunJudgments(runId, cwd);
    const latest = new Map(judgments.map((j) => [j.file, j.attempts.at(-1)]));
    const passed = reviewed.filter((f) => latest.get(f)?.verdict === "pass");
    const failed = reviewed.filter((f) => {
      const a = latest.get(f);
      return a && a.verdict === "rework";
    });
    const unjudged = reviewed.filter((f) => !latest.get(f));
    judgeLines.push(
      `- Judge: ${passed.length}/${reviewed.length} file(s) passed (threshold ${threshold})`
    );
    if (failed.length) {
      judgeLines.push(
        // "after rework" would be a lie for a file whose last verdict is rework
        // but that was never re-reviewed — say only what the data shows.
        `- ⚠️ Below judge threshold (accepted as-is): ${failed
          .map((f) => `${f} (score ${latest.get(f)?.score})`)
          .join(", ")}`
      );
    }
    if (unjudged.length) judgeLines.push(`- ⚠️ Reviewed but never judged: ${unjudged.join(", ")}`);
  }

  // Run-quality appendix rendered under the standard report body.
  const summary = [
    "## Run Summary",
    "",
    `- Run: ${runId} (${meta.range ? `commit diff ${meta.range}` : "explicit files"}${meta.whole ? " · whole-file" : ""})`,
    `- Coverage: ${reviewed.length}/${meta.targets.length} file(s) reviewed${missing.length ? ` — **INCOMPLETE**, missing: ${missing.join(", ")}` : " — complete"}`,
    ...(partials.length ? [`- ⚠️ Partial reviews (subagent cut off early): ${partials.join(", ")}`] : []),
    ...(forced.length
      ? [`- ⚠️ Force-accepted after repeated rejected submits (findings salvaged or empty): ${forced.join(", ")}`]
      : []),
    ...(unexplored.length
      ? [`- ⚠️ Reviewed without exploration calls (evidence only): ${unexplored.join(", ")}`]
      : []),
    ...judgeLines,
    `- Per-file reviews: ${join(RUNS_DIR, runId, "reviews")}/`,
    "",
  ].join("\n");

  const path = resolveOutputPath(meta.output, meta.label, cwd);
  const baseline = new Set(meta.baseline ?? []); // plan-time snapshot (see RunMeta.baseline)
  await writeReport(path, findings, meta.label, cwd, meta.language, meta.failOn, baseline, new Date(), summary);

  let gate = "";
  if (meta.failOn) {
    const v = verdict(all, meta.failOn);
    gate = v.pass
      ? ` Verdict: PASS (failOn: ${meta.failOn}).`
      : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${meta.failOn}.`;
  }
  const forcedWarn = forced.length
    ? ` ⚠️ ${forced.length} file(s) force-accepted after repeated rejected submits: ${forced.join(", ")}.`
    : "";
  if (missing.length) {
    return (
      `⚠️ INCOMPLETE — ${reviewed.length}/${meta.targets.length} file(s) reviewed; missing: ${missing.join(", ")}.` +
      `${gate}${forcedWarn} Partial report: ${path}\n` +
      `Re-spawn ONE f-reviewer subagent per missing file (same runId), then call f_review_finalize again. Do this at most once.`
    );
  }
  return `✅ Run complete — ${reviewed.length} file(s), ${all.length} issue(s).${gate}${forcedWarn} Report: ${path}`;
}
