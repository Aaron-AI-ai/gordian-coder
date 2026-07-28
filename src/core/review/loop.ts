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
  verdict,
  type Finding,
  type Severity,
} from "./contract";
import {
  collectTargets,
  loadConfig,
  buildDiffMap,
  resolveDiffRange,
  type CommitSpec,
} from "./context";
import { buildRubric, loadFrameworkGuide, rubricSources } from "./rubric";
import { buildReviewPrompt, targetVars } from "./template";
import {
  resolveOutputPath,
  resolveManifestPath,
  writeReport,
  writeManifest,
  loadBaseline,
  defaultLabel,
  manifestTimestamp,
} from "./output";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  activeStates,
  type ReviewState,
} from "./state";
import { afterRef, fileRead, sanitizeFindingLines, MAX_ITER } from "./reader";
import { buildReviewEvidence } from "./evidence";
import { SEGMENT_THRESHOLD, inFileRelated, planSegments, targetPath, targetRange } from "./segment";
import { dbg, dbgOnce, setReviewDebug } from "./debug";
import { VERSION } from "../../version";

export const NO_ACTIVE_REVIEW = "No active review. Call f_review_context first.";

/** Sequential single-session loop: past this many files context degrades. */
export const LARGE_REVIEW_WARN_AT = 30;

/** Max times a single file can be sent back for rework by the final check.
 * The file passes as soon as the check is clean, or once this cap is hit. */
export const MAX_FINAL_RECHECKS = 5;

/** Max times the idle watchdog re-drives an incomplete review (LLM stopped
 * before submitting every file). Past this, finalize a partial report. */
export const MAX_RESUMES = 3;

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
}

/** Collect targets, seed session state, write the manifest. Returns the
 * message the reviewer model sees (target preview, warnings, next step). */
export async function startReview(
  args: StartReviewArgs,
  cwd: string,
  sessionId: string
): Promise<string> {
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

  const whole = args.whole ?? false;
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
    categories: [...REQUIRED_CATEGORIES], // copy: don't mutate the shared constant
    // diff context (git):
    diffRange: range,
    ref, // post-diff ref that file_read / code_search operate on
    diffMap: buildDiffMap(range, targets, cwd), // per-file diff snapshot (real paths), computed once
    wholeFile: whole, // review full file content instead of the diff
    // review criteria injected into every per-file prompt:
    systemRule: buildRubric(cwd),
    frameworkRules: loadFrameworkGuide(cwd),
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
    callLog: {},
    recheckCount: {},
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
  const manifestPath = resolveManifestPath(state.label);
  await writeManifest(
    manifestPath,
    reviewTargets,
    {
      mode,
      range,
      excludes,
      rubricSources: rubricSources(cwd),
      generatedAt: manifestTimestamp(),
    },
    state.label,
    cwd
  );

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
    `Review the first target (${reviewTargets[0]}). Related-code and Git-history evidence is injected`,
    `automatically; use related_code / git_history / file_read / code_search / file_read_diff`,
    `for deeper context, then call f_review_submit when done with each file.`,
  ].join("\n");
}

/** Count an exploration call (logged per file/tool for the final check);
 * past the cap, append a wrap-up nudge. */
export function guardExploration(st: ReviewState, tool: string, out: string): string {
  const file = currentFile(st);
  if (file) {
    const log = (st.callLog[file] ??= {});
    log[tool] = (log[tool] ?? 0) + 1;
  }
  st.iterations++;
  if (st.iterations > MAX_ITER) {
    return `${out}\n\n⚠️ Exploration limit reached — review with what you have and call f_review_submit now.`;
  }
  return out;
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

/** Validate a submit payload, gate on category coverage, advance the loop.
 * On the last file: write the report and clear the session. */
export async function submitReview(payload: unknown, sessionId: string): Promise<string> {
  const st = getState(sessionId);
  if (!st?.active) return NO_ACTIVE_REVIEW;

  const parsed = SubmitSchema.safeParse(payload);
  if (!parsed.success) return `Invalid submission: ${parsed.error.message}`;

  const missing = coverage(parsed.data.assessed, st.categories);
  if (missing.length) {
    return `❌ Incomplete — categories not assessed: ${missing.join(
      ", "
    )}. Keep analyzing this file, then resubmit.`;
  }

  const file = currentFile(st);
  if (!file) return "No current file under review.";

  // Per-file check before this file's findings are committed and the loop
  // advances: use the session call log to catch skipped essentials while a
  // resubmit can still fix THIS file. Sends the file back for rework up to
  // MAX_FINAL_RECHECKS times; it passes as soon as the check is clean, or once
  // the cap is hit — so it can never loop forever.
  const tries = st.recheckCount[file] ?? 0;
  const notes = finalCheckNotes(st, file, parsed.data.findings);
  if (notes.length && tries < MAX_FINAL_RECHECKS) {
    st.recheckCount[file] = tries + 1;
    return [
      `🔎 Final check for ${file} (attempt ${tries + 1}/${MAX_FINAL_RECHECKS}):`,
      ...notes,
      `Address what applies, then call f_review_submit again for ${file}.`,
    ].join("\n");
  }

  // Drop line numbers that point past the end of their file (hallucinated anchors).
  sanitizeFindingLines(parsed.data.findings, st.cwd, st.ref);
  st.findings[file] = parsed.data.findings;
  st.currentIndex++;
  st.iterations = 0; // reset the exploration budget for the next file

  if (!isDone(st)) {
    return `✅ ${file} reviewed (${parsed.data.findings.length} issue(s)). Next file: ${currentFile(st)}.`;
  }

  return finalizeReport(st, sessionId, false);
}

/** Write the report, clear the session, and build the summary line. Shared by
 * normal completion (submitReview) and the watchdog's partial finalize.
 * `partial` marks a finalize forced before every file was reviewed. */
async function finalizeReport(
  st: ReviewState,
  sessionId: string,
  partial: boolean
): Promise<string> {
  st.active = false;
  const path = resolveOutputPath(st.output, st.label, st.cwd);
  // Findings are keyed per target (a large file's segments each have their own
  // key); merge them back under the real file path so the report groups by file.
  const report: Record<string, Finding[]> = {};
  for (const [target, fs] of Object.entries(st.findings)) {
    (report[targetPath(target)] ??= []).push(...fs);
  }
  await writeReport(path, report, st.label, st.cwd, st.language, st.failOn, st.baseline);
  clearState(sessionId);
  const all = Object.values(st.findings).flat();
  let gate = "";
  if (st.failOn) {
    const v = verdict(all, st.failOn);
    gate = v.pass
      ? ` Verdict: PASS (failOn: ${st.failOn}).`
      : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${st.failOn}.`;
  }
  // Informational: reviewed targets that used no exploration calls (auto-evidence
  // only). Scoped to reviewed targets so a partial report doesn't flag the ones
  // that were never reached.
  const reviewed = Object.keys(st.findings);
  const unexplored = reviewed.filter((f) => !Object.keys(st.callLog[f] ?? {}).length);
  const audit = unexplored.length
    ? ` ⚠️ ${unexplored.length} target(s) reviewed without exploration calls: ${unexplored.slice(0, 5).join(", ")}${unexplored.length > 5 ? ", …" : ""}.`
    : "";
  const fileCount = Object.keys(report).length; // distinct real files (segments merged)
  const head = partial
    ? `⚠️ Review incomplete — ${reviewed.length}/${st.targets.length} target(s) reviewed after ${MAX_RESUMES} auto-resumes; partial report written.`
    : `✅ Review complete — ${fileCount} file(s), ${all.length} issue(s).`;
  return `${head}${gate}${audit} Report: ${path}`;
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
  return { kind: "finalized", text: await finalizeReport(st, sessionId, true) };
}

/** The per-file review prompt for the target currently under review. */
export function reviewPromptFor(st: ReviewState): string | null {
  const target = currentFile(st);
  if (!target) return null;
  const path = targetPath(target); // strip a segment's #start-end back to the real path
  const range = targetRange(target); // set for a segment of a large whole-file review
  // Evidence (cross-file related + history) is per real file — segments share it.
  const evidence =
    st.evidenceCache[path] ?? (st.evidenceCache[path] = buildReviewEvidence(st.cwd, st.ref, path));

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
    system_rule: st.systemRule,
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
  return prompt;
}

/** Instruction pinning the findings/report language. */
export function languageInstructionFor(st: ReviewState): string {
  return (
    `Write every finding's \`message\` and \`rule\` text in ${languageName(st.language)}. ` +
    `Keep enum values (category, severity) and code identifiers as-is.`
  );
}
