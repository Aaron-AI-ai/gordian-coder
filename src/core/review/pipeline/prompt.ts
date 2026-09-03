/**
 * The per-target prompt handed to the reviewer each round.
 *
 * Composed fresh rather than cached: a target is a segment of a file, so its
 * evidence (fcq violations, in-file related code, the visible line window)
 * depends on which segment is current — and the submit token rotates per
 * round, so a stale prompt would carry a token that no longer validates.
 */

import { buildReviewPrompt, targetVars } from "../evidence/template";
import { fileRead } from "../tools/read";
import { reviewEvidence } from "../evidence/dossier";
import { renderFcqEvidence, violationsForTarget } from "../evidence/fcq";
import { SEGMENT_THRESHOLD, inFileRelated, targetPath, targetRange } from "./segment";
import { dbgOnce } from "../debug";
import { currentFile, otherFiles, type ReviewState } from "./state";
import { renderExtraRules } from "../evidence/rubric";

const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese" };

export function languageName(code: string): string {
  return LANG_NAMES[code] ?? code;
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
