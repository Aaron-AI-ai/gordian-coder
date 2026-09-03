/**
 * Starting a reviewer session.
 *
 * Two entry shapes converge on one in-memory ReviewState: a run-mode subagent
 * opening ONE file of an existing run (startRunFileReview), and a sequential
 * session collecting its own targets from a commit range or file list.
 *
 * Everything a reviewer needs for its first target is assembled here — rubric,
 * rules, injected evidence, fcq violations, judge feedback from a previous
 * round — because a subagent gets no second chance to ask.
 *
 * Starts are serialized per session (contextStarts): two concurrent calls for
 * the same session would otherwise race to install conflicting state.
 */

import { REQUIRED_CATEGORIES, SEVERITIES, type Severity } from "../contract";
import { collectTargets, buildDiffMap, resolveDiffRange, type CommitSpec } from "./context";
import { loadConfig, resolveDeepPasses, resolveMaxIter, resolveMaxToolCalls } from "../config";
import { buildRubric, loadFrameworkGuide, loadExtraRules, rubricSources } from "../evidence/rubric";

import { renderReviewContext, resolveOutputPath, resolveManifestPath, writeManifest, loadBaseline, defaultLabel, manifestTimestamp } from "../report/output";
import { runFreshness } from "./run-store";
import { loadRun } from "./artifact";
import { readFileReviewResult } from "./artifact";
import { judgeFeedbackFor, currentReviewTerminal, reworkCount, reviewReworkStatus } from "./judge";
import { MAX_JUDGE_ROUNDS } from "./judge-store";
import { setState, getState, currentFile, activeStates, type ReviewState } from "./state";
import { afterRef, MAX_ITER } from "../tools/read";

import { SEGMENT_THRESHOLD, planSegments, targetRange } from "./segment";
import { dbg, setReviewDebug } from "../debug";
import { VERSION } from "../../../version";
import { readFcqFile } from "../evidence/fcq";
import { runDir } from "./artifact";

/** Sequential single-session loop: past this many files context degrades. */
export const LARGE_REVIEW_WARN_AT = 30;

/** Serialize context initialization per session. The same small model can emit
 * duplicate calls concurrently; without this lock both calls pass the active
 * check before either stores state, and the later call resets the first. */
const contextStarts = new Map<string, Promise<string>>();

function shortSha(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  return p.exitCode === 0 ? p.stdout.toString().trim() || undefined : undefined;
}

export interface StartReviewArgs {
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
  /** Review rounds per target (default from config `deepPasses`, else 1; clamp 1..5). */
  deepPasses?: number;
  /** Parallel-run mode (Model A): join run `runId` and review exactly ONE file
   * from its target list. All other inputs come from the run's shared config. */
  runId?: string;
}

/** Run-mode session seeding: one subagent = one file of a parallel run. The
 * review config (range/whole/rubric/language/…) comes from run.json so every
 * subagent reviews consistently; the caller may only pick WHICH target file. */
function startRunFileReview(
  runId: string,
  files: string[] | undefined,
  cwd: string,
  sessionId: string
): string {
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  const freshness = runFreshness(meta, cwd);
  if (freshness.criteriaStale) {
    return (
      `⚠️ Run ${runId} is stale because the effective review rules changed after planning. ` +
      `Do NOT reuse its artifacts; call f_review_plan again to create a run bound to the current rules.`
    );
  }
  if (freshness.sourceStale) {
    return (
      `⚠️ Run ${runId} is stale because its files-only source snapshot changed after planning. ` +
      `Do NOT mix old and new file contents; call f_review_plan again to create a run bound to the current source.`
    );
  }

  // Defense: a run subagent reviews exactly one file, and only one that the
  // plan actually queued — it cannot widen the fan-out on its own.
  if (files?.length !== 1) {
    return `Run mode reviews exactly ONE file: call f_review_context with runId and files=["<one target>"].`;
  }
  const file = files[0].replaceAll("\\", "/").replace(/^\.\//, "");
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  const existingReview = readFileReviewResult(runId, file, cwd);
  if (existingReview) {
    const status = meta.judge ? reviewReworkStatus(runId, file, cwd) : "complete";
    if (status !== "rework") {
      if (status === "unjudged") {
        return (
          `ℹ️ ${file} already has a submitted review artifact in run ${runId}. ` +
          `Do NOT overwrite it; spawn f-judge for this file next. Finalizing now would mark it INCOMPLETE.`
        );
      }
      return (
        `ℹ️ ${file} already has a terminal review artifact in run ${runId}` +
        `${meta.judge ? ` (${status})` : ""}. Do NOT overwrite it; continue with the other files or call f_review_finalize.`
      );
    }
  }
  if (meta.judge && currentReviewTerminal(runId, file, cwd)) {
    return (
      `⚠️ ${file} has a terminal Judge INCOMPLETE result in run ${runId}. ` +
      `Do NOT re-review it; continue with the other files or call f_review_finalize.`
    );
  }
  // Judge-cap enforcement: past MAX_JUDGE_ROUNDS reworks the latest review
  // stands — an orchestrator that lost the cap message must not respawn
  // reviewer+judge pairs forever.
  if (meta.judge && reworkCount(runId, file, cwd) > MAX_JUDGE_ROUNDS) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${MAX_JUDGE_ROUNDS}) in run ${runId} — ` +
      `its latest review stands. Do NOT re-review; continue with the other files or call f_review_finalize.`
    );
  }

  setReviewDebug(loadConfig(cwd).debug === true);
  const ref = afterRef(meta.range);
  const reviewTargets = meta.whole ? planSegments(cwd, ref, file) : [file];
  dbg("run", `join runId=${runId} file=${file} targets=${reviewTargets.length}`);

  const state: ReviewState = {
    active: true,
    cwd,
    targets: reviewTargets, // this file only (or its segments)
    currentIndex: 0,
    submitToken: crypto.randomUUID(),
    categories: [...REQUIRED_CATEGORIES],
    diffRange: meta.range,
    ref,
    diffMap: buildDiffMap(meta.range, [file], cwd),
    wholeFile: meta.whole,
    systemRule: buildRubric(cwd),
    frameworkRules: loadFrameworkGuide(cwd),
    extraRules: loadExtraRules(cwd),
    evidenceCache: {},
    // A judge-rework re-review carries the judge's feedback into every prompt
    // render via the requirement-background slot; "" on the first review.
    requirementBackground: [meta.requirementBackground ?? "", judgeFeedbackFor(runId, file, cwd)]
      .filter(Boolean)
      .join("\n\n"),
    planGuidance: meta.planGuidance ?? "",
    findings: {},
    output: meta.output,
    failOn: meta.failOn,
    baseline: new Set(), // baseline marking happens once, at finalize
    label: meta.label,
    language: meta.language,
    iterations: 0,
    toolCalls: 1, // the f_review_context call that created this state
    explorationCalls: 0,
    maxToolCalls: resolveMaxToolCalls(cwd),
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    recheckCount: {},
    failedSubmits: {},
    staleSubmits: {},
    lastSubmitHash: {},
    lastValidFindings: {},
    forcedNotes: {},
    assessedByTarget: {},
    dupCalls: {},
    missStreak: 0,
    deepPasses: meta.deepPasses ?? 1, // run-wide setting so every subagent iterates alike
    maxIter: resolveMaxIter(cwd), // per-round exploration budget (config, else MAX_ITER)
    deepPassDone: {},
    resumes: 0,
    runId,
    fcqViolations: meta.fcq?.status === "ok" ? readFcqFile(runDir(runId, cwd), file) : undefined,
    fcqFix: meta.fcqFix,
  };
  setState(sessionId, state);

  const seg =
    reviewTargets.length > 1
      ? ` It is split into ${reviewTargets.length} segments — review them in order, calling f_review_submit after each.`
      : "";
  const rounds =
    state.deepPasses > 1
      ? ` Each target goes through ${state.deepPasses} review rounds — after each submit, follow the returned round instruction and resubmit.`
      : "";
  return [
    `Run ${runId}: reviewing ${file} (${meta.range ? `commit diff ${meta.range}` : "explicit files"}${meta.whole ? " · whole-file" : ""}).${seg}${rounds}`,
    `Tool-call budget: 1/${state.maxToolCalls} used (context); reserve the final two calls for f_review_submit/recovery.`,
    `The review checklist is injected into your instructions. Use ONLY the review tools`,
    `(related_code / git_history / file_read / code_search) for deeper context — never the`,
    `host's built-in Read/Grep/Glob — then call f_review_submit.`,
    `Review ONLY this file. When the submit confirms completion, your task is done.`,
  ].join("\n");
}

/** Collect targets, seed session state, write the manifest. Returns the
 * message the reviewer model sees (target preview, warnings, next step). */
async function startReviewUnlocked(
  args: StartReviewArgs,
  cwd: string,
  sessionId: string
): Promise<string> {
  const existing = getState(sessionId);
  if (existing?.active) {
    return (
      `ℹ️ Duplicate f_review_context ignored; this session is already reviewing ` +
      `${currentFile(existing) ?? "its current target"}. Continue the existing review and call ` +
      `f_review_submit with CURRENT_SUBMIT_TOKEN=${existing.submitToken}; progress was preserved.`
    );
  }

  // Parallel-run mode: join an existing run and review one file of it.
  if (args.runId) return startRunFileReview(args.runId, args.files, cwd, sessionId);

  // Commit range takes precedence: `from..to` (to defaults to HEAD) over a
  // single `commit`. Left undefined for explicit-file reviews.
  let commit: CommitSpec | undefined;
  if (args.from) commit = { from: args.from, to: args.to ?? "HEAD" };
  else if (args.commit) commit = args.commit;

  // Merge the two input modes (commit range / explicit files) into one target
  // list, minus `exclude` globs. Errors and the empty case are returned as text
  // — this string is shown to the reviewer model, not thrown.
  let targets: string[];
  try {
    targets = await collectTargets(
      { commit, files: args.files, exclude: args.exclude },
      cwd
    );
  } catch (err) {
    return `Could not collect review targets: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (targets.length === 0) return "No files to review (empty target set after excludes).";

  // Commit spec → `git diff` range string (e.g. "A..B"), or null for a
  // files-only review where there is no diff to compute.
  const range = resolveDiffRange(commit, !!args.files?.length);
  const ref = afterRef(range); // post-diff ref that file_read / code_search operate on

  // Whole-file mode splits files past SEGMENT_THRESHOLD lines into overlapping
  // line segments — each becomes its own review target (`path#start-end`) so a
  // huge file gets several focused passes instead of one degraded one. Diff mode
  // and small whole-file targets are left as plain paths.
  setReviewDebug(loadConfig(cwd).debug === true); // config flag turns tracing on (env var also works)

  // Files-only reviews default to whole-file: there is no commit diff, and a
  // possibly-unchanged file would otherwise get an empty diff block reviewed.
  const whole = args.whole ?? (commit === undefined && !!args.files?.length);
  const reviewTargets = whole ? targets.flatMap((p) => planSegments(cwd, ref, p)) : targets;
  dbg(
    "start",
    `whole=${whole} range=${range ?? "—"} ref=${ref ?? "workspace"} ` +
      `files=${targets.length} targets=${reviewTargets.length}`
  );
  const segments = reviewTargets.filter((t) => targetRange(t));
  if (segments.length) dbg("start", `segmented into: ${segments.join(", ")}`);

  // Concurrency guard: if another active review already targets the same report
  // path (same commit, no distinct --output), suffix this session's label so the
  // two don't clobber each other's report/manifest. The pathFor(...) inequality
  // check skips the suffix in explicit-file --output mode, where the label is
  // ignored and disambiguation is impossible anyway. Sequential re-runs of the
  // same commit still overwrite (intended: refresh the report). Safe against
  // races: no await between this check and setState below, so in the single
  // event loop no other startReview can interleave in that window.
  let label = shortSha(cwd) ?? defaultLabel();
  const pathFor = (l: string) => resolveOutputPath(args.output, l, cwd);
  const clash = activeStates().some(
    (s) => resolveOutputPath(s.output, s.label, s.cwd) === pathFor(label)
  );
  if (clash && pathFor(`${label}-x`) !== pathFor(label)) label = `${label}-${sessionId.slice(-6)}`;

  // The per-session review state consumed by repeated submitReview() calls:
  // it carries the loop cursor, diff context, review criteria, and results
  // across otherwise-stateless tool invocations.
  const state: ReviewState = {
    active: true, // submitReview's first guard; cleared when the loop finishes
    cwd,
    targets: reviewTargets, // the work queue the reviewer drains one file/segment at a time
    currentIndex: 0, // loop cursor; ++ per passed submit
    submitToken: crypto.randomUUID(), // replay identity for the first target/round
    categories: [...REQUIRED_CATEGORIES], // copy: don't mutate the shared constant
    // diff context (git):
    diffRange: range,
    ref, // post-diff ref that file_read / code_search operate on
    diffMap: buildDiffMap(range, targets, cwd), // per-file diff snapshot (real paths), computed once
    wholeFile: whole, // review full file content instead of the diff
    // review criteria injected into every per-file prompt:
    systemRule: buildRubric(cwd),
    frameworkRules: loadFrameworkGuide(cwd),
    extraRules: loadExtraRules(cwd), // glob-gated per file at prompt render
    evidenceCache: {}, // related-code + git-history dossier, memoized per target
    requirementBackground: args.requirementBackground ?? "",
    planGuidance: args.planGuidance ?? "",
    // results + output:
    findings: {}, // filled per file on submit
    output: args.output,
    // CI gate threshold — arg wins, else config value only if a valid severity, else no gate.
    failOn:
      args.failOn ??
      (SEVERITIES.includes(loadConfig(cwd).failOn as Severity)
        ? (loadConfig(cwd).failOn as Severity)
        : undefined),
    baseline: loadBaseline(args.output, cwd), // prior report's finding keys → mark re-founds
    label, // report/manifest filename stem (commit SHA, +suffix if concurrent)
    // report language — arg → config → default "ko".
    language: args.language ?? loadConfig(cwd).language ?? "ko",
    iterations: 0, // exploration budget for the current file; reset on advance
    toolCalls: 1, // the f_review_context call that created this state
    explorationCalls: 0,
    maxToolCalls: resolveMaxToolCalls(cwd),
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    recheckCount: {},
    failedSubmits: {},
    staleSubmits: {},
    lastSubmitHash: {},
    lastValidFindings: {},
    forcedNotes: {},
    assessedByTarget: {},
    dupCalls: {},
    missStreak: 0,
    deepPasses: resolveDeepPasses(args.deepPasses, cwd), // review rounds per target (1..5)
    maxIter: resolveMaxIter(cwd), // per-round exploration budget (config, else MAX_ITER)
    deepPassDone: {},
    resumes: 0, // idle-watchdog re-drive counter
  };
  // Key by sessionId so concurrent reviews stay isolated and each subsequent
  // submitReview(payload, sessionId) resumes exactly this state.
  setState(sessionId, state);

  // Write the target manifest alongside where the report will go, so the
  // full (possibly large) list lives in a file and the model only sees a
  // preview inline.
  const scope = range ? `commit diff (${range})` : "explicit files";
  const mode = state.wholeFile ? `${scope} · whole-file` : scope;
  const excludes = [...(loadConfig(cwd).exclude ?? []), ...(args.exclude ?? [])];
  const manifestMeta = {
    mode,
    range,
    excludes,
    rubricSources: rubricSources(cwd),
    generatedAt: manifestTimestamp(),
  };
  const manifestPath = resolveManifestPath(state.label);
  await writeManifest(manifestPath, reviewTargets, manifestMeta, state.label, cwd);
  // Same data again as the report's Review Context appendix — the report alone
  // should tell the reader what was reviewed and against which rules.
  state.reportContext = renderReviewContext(reviewTargets, manifestMeta);

  const PREVIEW = 30;
  const preview = reviewTargets.slice(0, PREVIEW).map((t) => `  - ${t}`);
  if (reviewTargets.length > PREVIEW)
    preview.push(`  … and ${reviewTargets.length - PREVIEW} more`);

  // The loop is sequential in ONE session: every target's exploration stays in
  // context, so very large target sets degrade review quality near the end.
  const sizeWarning =
    reviewTargets.length > LARGE_REVIEW_WARN_AT
      ? [
          "",
          `⚠️ ${reviewTargets.length} targets is a lot for one review session — context will fill`,
          `up and late targets get a degraded review. Consider splitting the range (narrower`,
          `commit range or exclude globs) and reviewing in batches.`,
        ]
      : [];

  return [
    `Queued ${reviewTargets.length} target(s) for review — gordian-coder v${VERSION}, mode: ${mode}.`,
    ...sizeWarning,
    ...preview,
    "",
    `Full target list written to: ${manifestPath}`,
    `The review checklist is now injected into your instructions.`,
    `Tool-call budget: 1/${state.maxToolCalls} used (context); reserve the final two calls for f_review_submit/recovery.`,
    `Review the first target (${reviewTargets[0]}). Related-code and Git-history evidence is injected`,
    `automatically; use ONLY the review tools (related_code / git_history / file_read / code_search /`,
    `file_read_diff) for deeper context — never the host's built-in Read/Grep/Glob — then call`,
    `f_review_submit when done with each file.`,
  ].join("\n");
}

export function startReview(
  args: StartReviewArgs,
  cwd: string,
  sessionId: string
): Promise<string> {
  const previous = contextStarts.get(sessionId) ?? Promise.resolve("");
  const current = previous
    .catch(() => "")
    .then(() => startReviewUnlocked(args, cwd, sessionId));
  contextStarts.set(sessionId, current);
  const cleanup = (): void => {
    if (contextStarts.get(sessionId) === current) contextStarts.delete(sessionId);
  };
  // Use a two-branch then instead of an ignored `.finally()` promise: if
  // initialization fails, `.finally()` would create a second rejected promise
  // and surface an unhandled rejection even when the caller handles `current`.
  void current.then(cleanup, cleanup);
  return current;
}
