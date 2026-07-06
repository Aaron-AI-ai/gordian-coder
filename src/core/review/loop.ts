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
import { buildReviewPrompt } from "./template";
import {
  resolveOutputPath,
  writeReport,
  writeManifest,
  loadBaseline,
  defaultLabel,
} from "./output";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  type ReviewState,
} from "./state";
import { afterRef, sanitizeFindingLines, MAX_ITER } from "./reader";

export const NO_ACTIVE_REVIEW = "No active review. Call k_review_context first.";

/** Sequential single-session loop: past this many files context degrades. */
export const LARGE_REVIEW_WARN_AT = 30;

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
  package?: string;
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
  let commit: CommitSpec | undefined;
  if (args.from) commit = { from: args.from, to: args.to ?? "HEAD" };
  else if (args.commit) commit = args.commit;

  let targets: string[];
  try {
    targets = await collectTargets(
      { commit, files: args.files, package: args.package, exclude: args.exclude },
      cwd
    );
  } catch (err) {
    return `Could not collect review targets: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (targets.length === 0) return "No files to review (empty target set after excludes).";

  const range = resolveDiffRange(commit, !!(args.files?.length || args.package));
  const state: ReviewState = {
    active: true,
    cwd,
    targets,
    currentIndex: 0,
    categories: [...REQUIRED_CATEGORIES],
    diffRange: range,
    ref: afterRef(range),
    diffMap: buildDiffMap(range, targets, cwd),
    systemRule: buildRubric(cwd),
    frameworkRules: loadFrameworkGuide(cwd),
    requirementBackground: args.requirementBackground ?? "",
    planGuidance: args.planGuidance ?? "",
    findings: {},
    output: args.output,
    failOn:
      args.failOn ??
      (SEVERITIES.includes(loadConfig(cwd).failOn as Severity)
        ? (loadConfig(cwd).failOn as Severity)
        : undefined),
    baseline: loadBaseline(args.output, cwd),
    label: shortSha(cwd) ?? defaultLabel(),
    language: args.language ?? loadConfig(cwd).language ?? "ko",
    iterations: 0,
  };
  setState(sessionId, state);

  // Write the target manifest alongside where the report will go, so the
  // full (possibly large) list lives in a file and the model only sees a
  // preview inline.
  const mode = range
    ? `commit diff (${range})`
    : args.package
      ? `package scan (${args.package})`
      : "explicit files";
  const excludes = [...(loadConfig(cwd).exclude ?? []), ...(args.exclude ?? [])];
  const manifestPath = resolveOutputPath(args.output, state.label, cwd).replace(
    /\.md$/,
    "-targets.md"
  );
  await writeManifest(
    manifestPath,
    targets,
    { mode, range, excludes, rubricSources: rubricSources(cwd) },
    state.label,
    cwd
  );

  const PREVIEW = 30;
  const preview = targets.slice(0, PREVIEW).map((t) => `  - ${t}`);
  if (targets.length > PREVIEW) preview.push(`  … and ${targets.length - PREVIEW} more`);

  // The loop is sequential in ONE session: every file's exploration stays in
  // context, so very large target sets degrade review quality near the end.
  const sizeWarning =
    targets.length > LARGE_REVIEW_WARN_AT
      ? [
          "",
          `⚠️ ${targets.length} files is a lot for one review session — context will fill up`,
          `and late files get a degraded review. Consider splitting the range (narrower`,
          `commit range, per-package runs, or exclude globs) and reviewing in batches.`,
        ]
      : [];

  return [
    `Queued ${targets.length} file(s) for review — mode: ${mode}.`,
    ...sizeWarning,
    ...preview,
    "",
    `Full target list written to: ${manifestPath}`,
    `The review checklist is now injected into your instructions.`,
    `Review the first file (${targets[0]}). Use file_read / code_search / file_find / file_read_diff`,
    `for more context; call k_review_submit when done with each file.`,
  ].join("\n");
}

/** Count an exploration call; past the cap, append a wrap-up nudge. */
export function guardExploration(st: ReviewState, out: string): string {
  st.iterations++;
  if (st.iterations > MAX_ITER) {
    return `${out}\n\n⚠️ Exploration limit reached — review with what you have and call k_review_submit now.`;
  }
  return out;
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
  // Drop line numbers that point past the end of their file (hallucinated anchors).
  sanitizeFindingLines(parsed.data.findings, st.cwd, st.ref);
  st.findings[file] = parsed.data.findings;
  st.currentIndex++;
  st.iterations = 0; // reset the exploration budget for the next file

  if (!isDone(st)) {
    return `✅ ${file} reviewed (${parsed.data.findings.length} issue(s)). Next file: ${currentFile(st)}.`;
  }

  st.active = false;
  const path = resolveOutputPath(st.output, st.label, st.cwd);
  await writeReport(path, st.findings, st.label, st.cwd, st.language, st.failOn, st.baseline);
  clearState(sessionId);
  const all = Object.values(st.findings).flat();
  let gate = "";
  if (st.failOn) {
    const v = verdict(all, st.failOn);
    gate = v.pass
      ? ` Verdict: PASS (failOn: ${st.failOn}).`
      : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${st.failOn}.`;
  }
  return `✅ Review complete — ${st.targets.length} file(s), ${all.length} issue(s).${gate} Report: ${path}`;
}

/** The per-file review prompt for the file currently under review. */
export function reviewPromptFor(st: ReviewState): string | null {
  const file = currentFile(st);
  if (!file) return null;
  return buildReviewPrompt({
    change_files: otherFiles(st).join("\n"),
    current_file_path: file,
    diff: st.diffMap[file] ?? "",
    current_system_date_time: new Date().toISOString(),
    requirement_background: st.requirementBackground,
    system_rule: st.systemRule,
    framework_rules: st.frameworkRules,
    plan_guidance: st.planGuidance,
  });
}

/** Instruction pinning the findings/report language. */
export function languageInstructionFor(st: ReviewState): string {
  return (
    `Write every finding's \`message\` and \`rule\` text in ${languageName(st.language)}. ` +
    `Keep enum values (category, severity) and code identifiers as-is.`
  );
}
