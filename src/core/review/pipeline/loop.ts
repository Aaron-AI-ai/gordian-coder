/**
 * Platform-independent review-loop orchestration: start → explore → submit.
 *
 * Adapters stay thin: they adapt tool schemas and prompt delivery — OpenCode
 * injects the per-file prompt via its system.transform hook, MCP appends it
 * to tool-result text (no system-prompt access there).
 */

import {
  REQUIRED_CATEGORIES,
  SEVERITIES,
  SubmitSchema,
  coverage,
  degenerateReason,
  verdict,
  type Finding,
  type Severity,
} from "../contract";
import { collectTargets, buildDiffMap, resolveDiffRange, type CommitSpec } from "./context";
import { loadConfig, resolveDeepPasses, resolveMaxIter, resolveMaxToolCalls } from "../config";
import {
  buildRubric,
  loadFrameworkGuide,
  loadExtraRules,
  renderExtraRules,
  rubricSources,
} from "../evidence/rubric";
import { buildReviewPrompt, targetVars } from "../evidence/template";
import {
  renderReviewContext,
  resolveOutputPath,
  resolveManifestPath,
  writeReport,
  writeManifest,
  loadBaseline,
  defaultLabel,
  manifestTimestamp,
  renderReport,
} from "../report/output";
import {
  loadRun,
  readFileReviewResult,
  runFreshness,
  writeFileReview,
  type FileReviewResult,
} from "./run";
import {
  judgeFeedbackFor,
  currentReviewTerminal,
  reworkCount,
  reviewReworkStatus,
  MAX_JUDGE_ROUNDS,
} from "./judge";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  activeStates,
  rotateSubmitToken,
  type ReviewState,
} from "./state";
import { afterRef, fileRead, renderFileContent, sanitizeFindingLines, MAX_ITER } from "../tools/read";
import { reviewEvidence } from "../evidence/dossier";
import { SEGMENT_THRESHOLD, inFileRelated, planSegments, targetPath, targetRange } from "./segment";
import { dbg, dbgOnce, setReviewDebug } from "../debug";
import { VERSION } from "../../../version";
import { readFcqFile, renderFcqEvidence, violationsForTarget } from "../evidence/fcq";
import { runDir } from "./run";

export const NO_ACTIVE_REVIEW = "No active review. Call f_review_context first.";

/** Sequential single-session loop: past this many files context degrades. */
export const LARGE_REVIEW_WARN_AT = 30;

/** Max times a single file can be sent back for rework by the final check.
 * The file passes as soon as the check is clean, or once this cap is hit. */
export const MAX_FINAL_RECHECKS = 5;

/** Max times the idle watchdog re-drives an incomplete review (LLM stopped
 * before submitting every file). Past this, finalize a partial report. */
export const MAX_RESUMES = 3;

/** Max rejected submits (schema-invalid / coverage-missing / degenerate text)
 * per file. Past this, salvage what parsed and force-advance — a small model
 * looping on the same broken payload must not stall the review forever. */
export const MAX_FAILED_SUBMITS = 5;

/** Serialize context initialization per session. The same small model can emit
 * duplicate calls concurrently; without this lock both calls pass the active
 * check before either stores state, and the later call resets the first. */
const contextStarts = new Map<string, Promise<string>>();

const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese" };

export function languageName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

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

/** Max times the SAME tool call (identical args) is answered per target/round;
 * past this, the output is withheld — a looping model gets no new content. */
export const MAX_DUP_CALLS = 2;

/** Max CONSECUTIVE not-found exploration results; past this, output is
 * withheld. Catches the "hunt an external symbol with endless pattern
 * variations" loop that exact-duplicate detection cannot see — each attempt
 * differs, but they all miss. Any hit resets the streak. */
export const MAX_MISS_STREAK = 4;

/** Not-found openings of the reader ops (see reader.ts / evidence.ts). */
const MISS_PREFIXES = [
  "No matches for:", // code_search
  "// No file matches", // file_find
  "Error: file not found", // file_read
  "Error: diff not found", // file_read_diff
  "No related code candidates", // related_code
  "No git history found", // git_history
];

/** Count an exploration call (logged per file/tool for the final check) and
 * guard against degenerate loops: past MAX_ITER the output is withheld entirely
 * (returning content past the budget keeps a runaway loop fed), and an exact
 * duplicate call (same tool + args, tracked when the adapter passes `args`) is
 * answered at most MAX_DUP_CALLS times. The op itself still runs — it's local
 * and cheap; the defense is starving the loop of fresh tokens. */
export function guardExploration(
  st: ReviewState,
  tool: string,
  out: string,
  args?: unknown
): string {
  if (st.explorationSealed) {
    return (
      `⚠️ Exploration is sealed for this reviewer session (${st.toolCalls}/${st.maxToolCalls} ` +
      `tool calls used). Output withheld. Call f_review_submit now.`
    );
  }
  const file = currentFile(st);
  if (file) {
    const log = (st.callLog[file] ??= {});
    log[tool] = (log[tool] ?? 0) + 1;
  }
  st.iterations++;
  const budget = st.maxIter ?? MAX_ITER;
  if (st.iterations > budget) {
    return `⚠️ Exploration limit reached (${budget} calls this round) — output withheld. Review with what you have and call f_review_submit now. Do not fetch more context through any other tool.`;
  }
  if (args !== undefined) {
    const key = JSON.stringify([file ?? "", tool, Bun.hash(JSON.stringify(args)).toString()]);
    const n = (st.dupCalls[key] = (st.dupCalls[key] ?? 0) + 1);
    if (n > MAX_DUP_CALLS) {
      return (
        `⚠️ Duplicate call — this exact ${tool} call already ran ${MAX_DUP_CALLS} times and its result does not change; output withheld. ` +
        `Explore something different or call f_review_submit for ${file ?? "the current file"} — do not re-fetch this content through any other tool.`
      );
    }
  }
  const miss = MISS_PREFIXES.some((p) => out.startsWith(p));
  st.missStreak = miss ? st.missStreak + 1 : 0;
  if (miss && st.missStreak >= MAX_MISS_STREAK) {
    return (
      `⚠️ ${st.missStreak} consecutive lookups found NOTHING — output withheld. What you are ` +
      `hunting was not resolved by the allowed targeted lookups; it may be external, generated, ` +
      `or a local alias the resolver cannot map. STOP retrying path/name variations with any tool. ` +
      `Review with the evidence you already have and call f_review_submit.`
    );
  }
  return out;
}

/** Content of a review RULE file listed in the prompt (reference mode), or
 * null when `path` is not a loaded rule. Rules are review INPUTS read from the
 * working tree at load time — the git-ref-scoped file_read would miss
 * untracked/uncommitted rule files, silently no-op'ing the reference feature —
 * so adapters serve them from state before falling back to fileRead. */
export function ruleFileContent(
  st: ReviewState,
  path: string,
  startLine?: number,
  endLine?: number
): string | null {
  const norm = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const rule = st.extraRules.find((r) => r.file === norm);
  return rule ? renderFileContent(norm, rule.content, startLine, endLine) : null;
}

/** One-shot pre-report check, driven by the session's tool-call log. Only
 * flags what the model can still fix by resubmitting the last file. */
function finalCheckNotes(
  st: ReviewState,
  file: string,
  findings: { severity: Severity; suggestion?: string }[]
): string[] {
  const notes: string[] = [];
  if (!Object.keys(st.callLog[file] ?? {}).length) {
    notes.push(
      `- ${file} was submitted without any exploration call (auto-injected evidence only). ` +
        `If the change is non-trivial, verify with file_read / related_code first.`
    );
  }
  const noFix = findings.filter(
    (f) => (f.severity === "blocker" || f.severity === "major") && !f.suggestion
  ).length;
  if (noFix) notes.push(`- ${noFix} blocker/major finding(s) lack a concrete \`suggestion\`.`);
  return notes;
}

/** The rework message driving one deep-review round: echoes what was just
 * submitted and focuses the round — 2: refute/hunt, middle: edge cases,
 * last: calibrate & polish. The resubmission REPLACES the previous findings. */
function deepPassInstruction(
  file: string,
  round: number,
  total: number,
  findings: Finding[]
): string {
  const echo = findings.length
    ? findings.map((f) => `  - [${f.severity}/${f.category}] L${f.line ?? "?"} ${f.rule}`).join("\n")
    : "  (none)";
  // Round focuses compose: 2 = adversarial refute, middle = deepen, last =
  // calibrate. A round can be both (e.g. 2/2 gets refute AND calibrate).
  const focus: string[] = [];
  if (round === 2) {
    focus.push(
      `- Try to REFUTE each finding above: re-read the code (file_read / code_search) and drop any that don't hold.`,
      `- Hunt for what round 1 missed — go category by category (correctness, security, performance, maintainability, tests, framework).`,
      `- Verify every line anchor against the actual file.`
    );
  }
  if (round > 2 && round < total) {
    focus.push(
      `- Deepen the analysis: edge cases, error/exception paths, boundary values, concurrency, resource leaks.`,
      `- Follow one caller/callee you have not read yet (related_code / code_search) and check the contract holds.`
    );
  }
  if (round === total) {
    focus.push(
      `- Calibrate each severity honestly (blocker | major | minor | nit) — no inflation, no burying.`,
      `- Give every blocker/major a concrete \`suggestion\` (code or exact steps).`,
      `- Merge duplicates; drop anything you cannot defend with evidence.`
    );
  }
  return [
    `🔁 Deep review round ${round}/${total} for ${file}. Your previous findings:`,
    echo,
    ``,
    ...focus,
    ``,
    `Then call f_review_submit again with the COMPLETE, refined finding set for ${file}`,
    `(your resubmission replaces the previous one).`,
  ].join("\n");
}

/** Commit `findings` for `file` and advance the loop; on the last file, write
 * the report and clear the session. `note` marks a forced (salvage) accept. */
async function acceptFile(
  st: ReviewState,
  file: string,
  findings: Finding[],
  sessionId: string,
  note = "",
  assessed: readonly (typeof REQUIRED_CATEGORIES)[number][] = st.categories
): Promise<string> {
  // A forced (salvage) accept must survive into the report/run result — the
  // chat string alone is lost when this is the last target (isDone below).
  if (note) st.forcedNotes[file] = note;
  const forcedNote = st.forcedNotes[file] ?? "";
  st.assessedByTarget[file] = [...new Set(assessed)];
  // Drop line numbers that point past the end of their file (hallucinated anchors).
  sanitizeFindingLines(findings, st.cwd, st.ref);
  // Dedupe exact repeats — a looping model may submit the same finding N times.
  const seen = new Set<string>();
  st.findings[file] = findings.filter((f) => {
    const key = JSON.stringify(f);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  st.currentIndex++;
  rotateSubmitToken(st);
  st.iterations = 0; // reset the exploration budget for the next file
  st.dupCalls = {}; // the next target may legitimately repeat earlier calls
  st.missStreak = 0;

  if (!isDone(st)) {
    const response = forcedNote
      ? `⚠️ ${file} force-advanced after bounded recovery (${st.findings[file].length} issue(s) salvaged)${forcedNote}. Next file: ${currentFile(st)}.`
      : `✅ ${file} reviewed (${st.findings[file].length} issue(s)). Next file: ${currentFile(st)}.`;
    return response;
  }

  // Run mode writes this file's own review under the run dir; the aggregate
  // report is written once, by f_review_finalize — never by a subagent.
  return st.runId ? writeRunReview(st, sessionId, false) : finalizeReport(st, sessionId, false);
}

/** Validate a submit payload, gate on category coverage, advance the loop.
 * On the last file: write the report and clear the session. */
export async function submitReview(payload: unknown, sessionId: string): Promise<string> {
  const st = getState(sessionId);
  if (!st?.active) return NO_ACTIVE_REVIEW;

  const file = currentFile(st);
  if (!file) return "No current file under review.";

  // Every rejection (schema / degenerate text / coverage) funnels through this
  // counter: within the cap it bounces back to the model, past the cap it
  // returns null and the caller salvages what it can and force-advances —
  // otherwise a degenerate model resubmitting the same broken payload loops forever.
  const reject = (msg: string): string | null => {
    const n = (st.failedSubmits[file] = (st.failedSubmits[file] ?? 0) + 1);
    return n <= MAX_FAILED_SUBMITS
      ? `${msg}\n(rejected submit ${n}/${MAX_FAILED_SUBMITS} for ${file} — past the cap the review force-advances.)`
      : null;
  };

  const parsed = SubmitSchema.safeParse(payload);
  if (!parsed.success) {
    const bounce = reject(`Invalid submission: ${parsed.error.message}`);
    if (bounce) return bounce;
    // Past the cap: salvage the findings of the last submit that DID parse
    // (bounced on coverage/degenerate/final check) — never commit an empty
    // review when real findings were already on the table.
    const salvaged = st.lastValidFindings[file] ?? [];
    const response = await acceptFile(
      st,
      file,
      salvaged,
      sessionId,
      ` — forced after repeated invalid submissions${salvaged.length ? " (salvaged an earlier submit's findings)" : ""}`,
      []
    );
    return response;
  }

  if (parsed.data.submitToken !== undefined && parsed.data.submitToken !== st.submitToken) {
    const stale = (st.staleSubmits[file] = (st.staleSubmits[file] ?? 0) + 1);
    if (stale <= MAX_FAILED_SUBMITS) {
      return (
        `ℹ️ Stale/duplicate f_review_submit ignored; no state changed ` +
        `(${stale}/${MAX_FAILED_SUBMITS}). Use CURRENT_SUBMIT_TOKEN=${st.submitToken} for ${file}.`
      );
    }
    return acceptFile(
      st,
      file,
      st.lastValidFindings[file] ?? [],
      sessionId,
      " — forced after repeated stale submit-token replays",
      []
    );
  }

  // A valid current-token submit proves the model recovered from any stale
  // replay. Count only a consecutive stale loop, not occasional one-step lag
  // across legitimate deep-pass/final-check token rotations.
  st.staleSubmits[file] = 0;

  const realFile = targetPath(file);
  const wrongFile = parsed.data.findings.find((finding) => finding.file !== realFile);
  if (wrongFile) {
    const bounce = reject(
      `❌ Finding file mismatch: current target ${JSON.stringify(file)} requires every finding.file ` +
        `to be the real path ${JSON.stringify(realFile)}, received ${JSON.stringify(wrongFile.file)}.`
    );
    if (bounce) return bounce;
    return acceptFile(
      st,
      file,
      st.lastValidFindings[file] ?? [],
      sessionId,
      " — forced after repeated finding-file mismatches",
      []
    );
  }

  // Identical-payload loop detection: the model resubmitted byte-for-byte the
  // payload the final check already bounced — re-bouncing with the same notes
  // is pointless, so accept instead. Only the final check arms this (see below):
  // deep-pass rounds each give a DIFFERENT instruction, and an identical
  // resubmission there is honest convergence, not a loop.
  const { submitToken: _submitToken, ...semanticSubmit } = parsed.data;
  const hash = Bun.hash(JSON.stringify(semanticSubmit)).toString();
  const repeat = st.lastSubmitHash[file] === hash;

  // Degenerate-output guard: drop findings whose prose is runaway repetition or
  // an unexpected script (e.g. Chinese text in a Korean review) — small-model
  // glitches. Bounce for a rewrite while the cap allows; past it, keep the
  // clean findings and continue.
  let findings = parsed.data.findings;
  const degenerate = findings
    .map((f) => ({ f, reason: degenerateReason(f, st.language) }))
    .filter((d) => d.reason);
  findings = findings.filter((f) => !degenerate.some((d) => d.f === f));
  // Salvage source for the invalid-submission force path above.
  st.lastValidFindings[file] = findings;
  if (degenerate.length) {
    const bounce = reject(
      `❌ ${degenerate.length} finding(s) rejected as degenerate output ` +
        `(${[...new Set(degenerate.map((d) => d.reason))].join("; ")}). ` +
        `Rewrite them in ${languageName(st.language)} and resubmit the full set for ${file}.`
    );
    if (bounce) return bounce;
    // The bounded escape continues with only the non-degenerate subset, but it
    // is not a clean quality pass: persist the degraded marker through final
    // acceptance so an empty salvaged set can never produce a findings-only PASS.
    st.forcedNotes[file] = " — forced after repeated degenerate outputs (invalid findings dropped)";
  }

  const missing = coverage(parsed.data.assessed, st.categories);
  if (missing.length) {
    const response = await (
      reject(
        `❌ Incomplete — categories not assessed: ${missing.join(
          ", "
        )}. Keep analyzing this file, then resubmit.`
      ) ??
        acceptFile(
          st,
          file,
          findings,
          sessionId,
          " — forced with incomplete coverage",
          parsed.data.assessed
        )
    );
    return response;
  }

  // A complete, non-degenerate submission proves recovery from earlier schema,
  // file, or coverage mistakes. Bound consecutive malformed output without
  // penalizing one corrected mistake in each legitimate review round.
  if (!degenerate.length) st.failedSubmits[file] = 0;

  // Deep-pass gate: with deepPasses > 1, the first (deepPasses - 1) clean
  // submissions for a target are NOT accepted — each one bounces back with a
  // round-specific instruction to re-analyze, so the model iterates on its own
  // findings. Bounded by deepPasses (≤ MAX_DEEP_PASSES), so it cannot loop —
  // which is also why an identical resubmission does NOT skip it: a converged
  // round still owes the user the remaining rounds' (different) instructions.
  const done = st.deepPassDone[file] ?? 0;
  if (done < st.deepPasses - 1) {
    st.deepPassDone[file] = done + 1;
    rotateSubmitToken(st);
    // MAX_ITER is a per-ROUND budget, not per-file: the round instruction below
    // explicitly orders a re-read ("REFUTE each finding: re-read the code"), so
    // carrying a spent budget over would answer that order with "exploration
    // limit reached — submit now". Still bounded: deepPasses ≤ MAX_DEEP_PASSES,
    // so a file can never exceed MAX_DEEP_PASSES × MAX_ITER exploration calls.
    st.iterations = 0;
    st.dupCalls = {}; // the round instruction orders re-reads — don't answer them with "duplicate"
    st.missStreak = 0;
    return deepPassInstruction(file, done + 2, st.deepPasses, findings);
  }

  // Per-file check before this file's findings are committed and the loop
  // advances: use the session call log to catch skipped essentials while a
  // resubmit can still fix THIS file. Sends the file back for rework up to
  // MAX_FINAL_RECHECKS times; it passes as soon as the check is clean, or once
  // the cap is hit — so it can never loop forever.
  const tries = st.recheckCount[file] ?? 0;
  const notes = finalCheckNotes(st, file, findings);
  if (!repeat && notes.length && tries < MAX_FINAL_RECHECKS) {
    st.recheckCount[file] = tries + 1;
    rotateSubmitToken(st);
    st.lastSubmitHash[file] = hash; // arm the repeat detector: same payload again → accept
    // The notes order re-verification ("verify with file_read", write concrete
    // suggestions) — like the deep-pass bounce, give the round a fresh budget
    // or the ordered re-reads come back "output withheld". Still bounded:
    // MAX_FINAL_RECHECKS × MAX_ITER.
    st.iterations = 0;
    st.dupCalls = {};
    st.missStreak = 0;
    return [
      `🔎 Final check for ${file} (attempt ${tries + 1}/${MAX_FINAL_RECHECKS}):`,
      ...notes,
      `Address what applies, then call f_review_submit again for ${file}.`,
    ].join("\n");
  }

  return acceptFile(st, file, findings, sessionId, "", parsed.data.assessed);
}

/** Run-mode completion: persist THIS session's single-file review (md + json)
 * into the run directory and end the session. `partial` marks a review the
 * watchdog cut off before every segment was submitted. */
async function writeRunReview(
  st: ReviewState,
  sessionId: string,
  partial: boolean
): Promise<string> {
  const file = targetPath(st.targets[0]); // single file per run session (segments share it)
  // Merge segment-keyed findings back under the real file path.
  const merged = Object.values(st.findings).flat();
  const explorationCalls = Object.values(st.callLog)
    .flatMap((byTool) => Object.values(byTool))
    .reduce((a, b) => a + b, 0);
  // A force-advanced (salvage) target must not persist as a clean, complete
  // review — carry the note into the run result so finalize can surface it.
  const forced = st.targets.map((t) => st.forcedNotes[t]).filter(Boolean).join(";").slice(0, 4000);
  const assessed = [
    ...new Set(st.targets.flatMap((target) => st.assessedByTarget[target] ?? [])),
  ];
  const result: FileReviewResult = {
    file,
    assessed,
    findings: merged,
    explorationCalls,
    partial,
    coverageComplete: !partial && !forced,
    ...(forced ? { forced } : {}),
  };
  const partialReason = st.toolBudgetExhausted
    ? `The reviewer reached maxToolCalls=${st.maxToolCalls} after ${st.toolCalls} tool calls.`
    : `Only ${Object.keys(st.findings).length}/${st.targets.length} segment(s) completed.`;
  const quality = partial || forced
    ? [
        "",
        "## Review Quality",
        "",
        "- Status: **INCOMPLETE**",
        ...(partial ? [`- ${partialReason}`] : []),
        ...(forced ? [`- Bounded recovery force-advanced one or more targets:${forced}`] : []),
        "",
      ].join("\n")
    : "";
  const md = `${renderReport({ [file]: merged }, `run ${st.runId} · ${st.label}`, st.language)}${quality}`;
  const path = await writeFileReview(st.runId!, result, md, st.cwd);
  st.active = false;
  clearState(sessionId);
  const head = partial
    ? st.toolBudgetExhausted
      ? `⚠️ ${file} review stopped at maxToolCalls=${st.maxToolCalls}; partial review saved.`
      : `⚠️ ${file} partially reviewed (${Object.keys(st.findings).length}/${st.targets.length} segment(s)); partial review saved.`
    : forced
      ? `⚠️ ${file} force-advanced after bounded recovery (${merged.length} issue(s) salvaged)${forced}; incomplete review saved with a forced marker.`
      : `✅ ${file} reviewed (${merged.length} issue(s)); review saved.`;
  return `${head} ${path}\nThis subagent's task is COMPLETE. Do not review any other file.`;
}

/** Write the report, clear the session, and build the summary line. Shared by
 * normal completion (submitReview) and the watchdog's partial finalize.
 * `partial` marks a finalize forced before every file was reviewed. */
async function finalizeReport(
  st: ReviewState,
  sessionId: string,
  partial: boolean
): Promise<string> {
  // Session id in the filename: the in-process clash suffix (startReview) can't
  // see sessions in OTHER processes, so two same-commit reviews finalizing in
  // the same second would otherwise collide.
  const path = resolveOutputPath(st.output, `${st.label}-${sessionId.slice(-6)}`, st.cwd);
  // Findings are keyed per target (a large file's segments each have their own
  // key); merge them back under the real file path so the report groups by file.
  const report: Record<string, Finding[]> = {};
  for (const [target, fs] of Object.entries(st.findings)) {
    (report[targetPath(target)] ??= []).push(...fs);
  }
  const all = Object.values(st.findings).flat();
  const forcedTargets = Object.keys(st.forcedNotes);
  const degraded = partial || forcedTargets.length > 0;
  // A partial/forced terminal result must never render a findings-only PASS in
  // the persisted artifact: failOn is suppressed for degraded runs and the
  // fail-closed verdict travels in the returned summary line. The report itself
  // stays findings-only (no quality appendix).
  await writeReport(
    path,
    report,
    st.label,
    st.cwd,
    st.language,
    degraded ? undefined : st.failOn,
    st.baseline,
    new Date(),
    st.reportContext
  );
  st.active = false;
  clearState(sessionId);
  let gate = "";
  if (st.failOn) {
    if (degraded) {
      gate = ` Verdict: FAIL — review incomplete (failOn: ${st.failOn}).`;
    } else {
      const v = verdict(all, st.failOn);
      gate = v.pass
        ? ` Verdict: PASS (failOn: ${st.failOn}).`
        : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${st.failOn}.`;
    }
  }
  // Informational: reviewed targets that used no exploration calls (auto-evidence
  // only). Scoped to reviewed targets so a partial report doesn't flag the ones
  // that were never reached.
  const reviewed = Object.keys(st.findings);
  const unexplored = reviewed.filter((f) => !Object.keys(st.callLog[f] ?? {}).length);
  const audit = unexplored.length
    ? ` ⚠️ ${unexplored.length} target(s) reviewed without exploration calls: ${unexplored.slice(0, 5).join(", ")}${unexplored.length > 5 ? ", …" : ""}.`
    : "";
  // Force-accepted targets (salvage path) — a clean-looking count must not
  // hide that some files never passed a real submit.
  const forcedWarn = forcedTargets.length
    ? ` ⚠️ ${forcedTargets.length} target(s) force-advanced after repeated rejected submits: ${forcedTargets.slice(0, 5).join(", ")}${forcedTargets.length > 5 ? ", …" : ""}.`
    : "";
  const fileCount = Object.keys(report).length; // distinct real files (segments merged)
  const head = partial
    ? st.toolBudgetExhausted
      ? `⚠️ Review incomplete — maxToolCalls=${st.maxToolCalls} reached; ${reviewed.length}/${st.targets.length} target(s) reviewed and partial report written.`
      : `⚠️ Review incomplete — ${reviewed.length}/${st.targets.length} target(s) reviewed after ${MAX_RESUMES} auto-resumes; partial report written.`
    : forcedTargets.length
      ? `⚠️ Review incomplete — bounded recovery force-advanced ${forcedTargets.length} target(s); ${fileCount} file(s), ${all.length} issue(s) salvaged.`
      : `✅ Review complete — ${fileCount} file(s), ${all.length} issue(s).`;
  return `${head}${gate}${audit}${forcedWarn} Report: ${path}`;
}

/** Turn-end watchdog. Called when the session goes idle (the LLM stopped). If a
 * review is active but not every file was submitted, re-drive it up to
 * MAX_RESUMES times; past the cap, finalize a partial report. Returns null when
 * there is nothing to do (no active review, or it already finished). */
export async function onSessionIdle(
  sessionId: string
): Promise<{ kind: "resume"; text: string } | { kind: "finalized"; text: string } | null> {
  const st = getState(sessionId);
  if (!st?.active || isDone(st)) return null;
  if (st.toolBudgetExhausted) {
    return {
      kind: "finalized",
      text: st.runId
        ? await writeRunReview(st, sessionId, true)
        : await finalizeReport(st, sessionId, true),
    };
  }
  if (st.resumes < MAX_RESUMES) {
    st.resumes++;
    return {
      kind: "resume",
      text:
        `Review incomplete: ${st.currentIndex}/${st.targets.length} file(s) submitted. ` +
        `Continue with ${currentFile(st)} and call f_review_submit for each remaining file ` +
        `(auto-resume ${st.resumes}/${MAX_RESUMES}).`,
    };
  }
  return {
    kind: "finalized",
    // Run mode: save what this subagent got through as a partial per-file
    // review — finalize's coverage check will surface it. Never write the
    // aggregate report from a subagent session.
    text: st.runId
      ? await writeRunReview(st, sessionId, true)
      : await finalizeReport(st, sessionId, true),
  };
}

/** The per-file review prompt for the target currently under review. */
export function reviewPromptFor(st: ReviewState): string | null {
  const target = currentFile(st);
  if (!target) return null;
  const path = targetPath(target); // strip a segment's #start-end back to the real path
  const range = targetRange(target); // set for a segment of a large whole-file review
  // Evidence (cross-file related + history) is per real file — segments share it.
  let evidence = st.evidenceCache[path];
  if (evidence === undefined) {
    evidence = st.evidenceCache[path] = reviewEvidence(st.cwd, st.ref, path).text;
  }
  // fcq evidence is per TARGET (a segment sees only its window), so it is
  // composed here instead of cached with the per-file dossier.
  if (st.fcqViolations?.length) {
    const fcq = renderFcqEvidence(violationsForTarget(st.fcqViolations, target), st.fcqFix);
    if (fcq) evidence = `${fcq}\n\n${evidence}`;
  }

  // Choose what goes in the review block: a segment slice (+ same-file related
  // declarations it references), the whole file, or the diff hunks.
  let vars: ReturnType<typeof targetVars>;
  let related = "";
  if (range) {
    const slice = fileRead(st.cwd, st.ref, path, range.start, range.end, range.end - range.start + 1);
    related = inFileRelated(st.cwd, st.ref, path, range.start, range.end);
    vars = targetVars("segment", related ? `${slice}\n\n${related}` : slice, range);
  } else if (st.wholeFile) {
    vars = targetVars("whole", fileRead(st.cwd, st.ref, path, 1, undefined, SEGMENT_THRESHOLD));
  } else {
    vars = targetVars("diff", st.diffMap[path] ?? "");
  }

  // "Other changed files" is a file-level hint — collapse sibling segments to
  // their real path, drop the current file, dedupe.
  const others = [...new Set(otherFiles(st).map(targetPath))].filter((p) => p !== path);
  const prompt = buildReviewPrompt({
    change_files: others.join("\n"),
    current_file_path: path, // real path → findings anchor to the actual file
    ...vars,
    current_system_date_time: new Date().toISOString(),
    requirement_background: st.requirementBackground,
    system_rule: st.systemRule + renderExtraRules(st.extraRules, path),
    framework_rules: st.frameworkRules,
    review_evidence: evidence,
    plan_guidance: st.planGuidance,
  });

  // Once per target (system.transform re-renders every turn): dump what was
  // injected so `F_REVIEW_DEBUG=1` lets you verify segment/related/evidence.
  const kind = range ? `segment ${range.start}-${range.end}` : st.wholeFile ? "whole" : "diff";
  dbgOnce(
    target,
    "prompt",
    [
      `target=${target} path=${path} kind=${kind}`,
      `evidenceChars=${evidence.length} inFileRelatedChars=${related.length} promptChars=${prompt.length}`,
      "--- review_evidence ---",
      evidence,
      ...(related ? ["--- same-file related (segment) ---", related] : []),
    ].join("\n")
  );
  return (
    `${prompt}\n\nTOOL_CALL_BUDGET: ${st.toolCalls}/${st.maxToolCalls} used; ` +
    `${Math.max(0, st.maxToolCalls - st.toolCalls)} remaining. ` +
    `The final two calls are reserved for f_review_submit/recovery.${st.explorationSealed ? " EXPLORATION IS SEALED — submit now." : ""}\n` +
    `CURRENT_SUBMIT_TOKEN: ${st.submitToken}\n` +
    `Copy this exact value into f_review_submit.submitToken. It changes after each target/review round; never reuse an earlier token.`
  );
}

/** Instruction pinning the findings/report language. */
export function languageInstructionFor(st: ReviewState): string {
  return (
    `Write every finding's \`message\` and \`rule\` text in ${languageName(st.language)}. ` +
    `Keep enum values (category, severity) and code identifiers as-is.`
  );
}
