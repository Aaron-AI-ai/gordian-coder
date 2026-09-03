/**
 * What the judge subagent is shown: the change under review, the findings the
 * reviewer submitted, and the criteria to score them against.
 *
 * Every section is budgeted against JUDGE_CONTEXT_MAX_CHARS, because the judge
 * runs on the same context as the reviewer it is checking. When the change
 * alone cannot fit, the build fails with a JudgeContextOverflow rather than
 * silently handing over a truncated diff — a judge scoring a review of code it
 * only partly saw is worse than no judge.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Finding } from "../contract";
import { buildDiffMap } from "./context";
import { afterRef, readFileAt, renderFileContent } from "../tools/read";
import { loadExtraRules, loadFrameworkGuide, renderExtraRules } from "../evidence/rubric";
import { readFcqFile, renderFcqEvidence } from "../evidence/fcq";
import { loadRun, type RunMeta } from "./artifact";
import { runDir, type PersistedFileReviewResult } from "./artifact";
import {
  DEFAULT_JUDGE_THRESHOLD,
  artifactIdentity,
  type FileJudgment,
  type JudgeTerminal,
} from "./judge-store";

/** Cap on the change excerpt embedded in the judge context. */
const JUDGE_DIFF_MAX_CHARS = 10_000;

/** Whole-file lines shown to the judge before falling back to per-finding windows. */
const JUDGE_FILE_MAX_LINES = 2000;

/** Context lines around a finding whose line the capped excerpt did not show. */
const JUDGE_WINDOW = 25;

/** Hard ceiling for the complete judge prompt returned to a small model.
 * Raised with the authoritative-rules section rather than shrinking the
 * findings/change budgets: those shrink into contextOverflow, which is
 * terminal, so trading evidence for rules would buy one fix with a regression. */
export const JUDGE_CONTEXT_MAX_CHARS = 48_000;

/** Section budgets leave room for the rules, identities, and instructions. */
const JUDGE_FINDINGS_MAX_CHARS = 18_000;

const JUDGE_CHANGE_MAX_CHARS = 18_000;

/** Cap on the authoritative-rules section (framework guide + glob-gated
 * project rules). Truncated, never rejected: a review judged against partial
 * rules still beats one judged against none. */
const JUDGE_RULES_MAX_CHARS = 8_000;

const JUDGE_BASE_MAX_CHARS = 10_000;

/** The judging rubric injected into every judge context. Kept as data so an
 * offline evaluation script can reuse the exact same criteria. */
export const JUDGE_CRITERIA = [
  `Evaluate the REVIEW, not the code. Score 0-100:`,
  `1. Validity (40%) — try to REFUTE each finding against the actual code shown.`,
  `   A finding whose line/claim does not match the code is invalid.`,
  `2. Evidence (15%) — each finding states a concrete failure scenario`,
  `   (input/state → wrong outcome), not just "this could be a problem".`,
  `3. Severity calibration (15%) — blockers/majors are truly that severe, and`,
  `   real defects are not buried as minor/nit.`,
  `4. Actionability (10%) — every blocker/major carries an applicable fix`,
  `   (\`asIs\` + \`toBe\`), not just a description of the problem.`,
  `5. Coverage (20%) — every significant part of the change was actually`,
  `   examined; list unexamined areas in coverageGaps.`,
  ``,
  `Do NOT reward finding count — a clean file with zero findings can score 100.`,
  `Penalize noise: duplicates, style nits inflated to issues, hallucinated lines.`,
  `Prefer false negatives over false positives, matching the review's own rules.`,
].join("\n");

export interface JudgeContextOverflow {
  reason: string;
}

export function contextOverflow(reason: string): JudgeContextOverflow {
  return { reason };
}

export function isContextOverflow(value: string | JudgeContextOverflow): value is JudgeContextOverflow {
  return typeof value !== "string";
}

/** Merge overlapping finding windows so nearby anchors do not inject the same
 * source lines repeatedly. */
export function findingWindows(lines: number[], total: number): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const next = {
      start: Math.max(1, line - JUDGE_WINDOW),
      end: Math.min(total, line + JUDGE_WINDOW),
    };
    const previous = windows.at(-1);
    if (previous && next.start <= previous.end + 1) previous.end = Math.max(previous.end, next.end);
    else windows.push(next);
  }
  return windows;
}

/** The change being reviewed, as shown to the judge: a bounded base plus
 * merged windows around every finding anchor hidden by that base. If all
 * anchors cannot fit, fail closed instead of silently omitting evidence and
 * allowing a misleading PASS. */
export function changeExcerpt(
  meta: RunMeta,
  file: string,
  cwd: string,
  findings: Finding[]
): string | JudgeContextOverflow {
  const ref = afterRef(meta.range);
  const content = readFileAt(cwd, ref, file);
  const totalLines = content === null ? 0 : content.replace(/\n$/, "").split("\n").length;
  let base = "";
  let visibleTo = 0;
  let needsWindows = false;

  if (meta.range && !meta.whole) {
    const diff = buildDiffMap(meta.range, [file], cwd)[file] ?? "";
    if (diff) {
      needsWindows = diff.length > JUDGE_DIFF_MAX_CHARS;
      base = needsWindows
        ? `${diff.slice(0, JUDGE_DIFF_MAX_CHARS)}\n… (diff truncated)`
        : diff;
    }
  }

  if (!base) {
    if (content === null) {
      base = `Error: file not found: ${file}. The reviewed source is unavailable.`;
    } else {
      const shownLines = Math.min(totalLines, JUDGE_FILE_MAX_LINES);
      base = renderFileContent(file, content, 1, shownLines, JUDGE_FILE_MAX_LINES, JUDGE_BASE_MAX_CHARS);
      const characterTruncated = base.includes("IS_TRUNCATED: true");
      // A character-truncated line-numbered block may end midway through an
      // early line even though its header names the requested end. Treat none
      // of its lines as reliably visible and add windows for every anchor.
      visibleTo = characterTruncated ? 0 : shownLines;
      needsWindows = shownLines < totalLines || characterTruncated;
    }
  }

  // Unreachable while JUDGE_BASE_MAX_CHARS and JUDGE_DIFF_MAX_CHARS both sit
  // below JUDGE_CHANGE_MAX_CHARS — both sources are already capped above. Kept
  // as the guard on that invariant: raise either budget past the change budget
  // and this is what stops a partial excerpt from reaching the judge.
  if (base.length > JUDGE_CHANGE_MAX_CHARS) {
    return contextOverflow(`the base change excerpt exceeds ${JUDGE_CHANGE_MAX_CHARS} characters`);
  }
  if (!needsWindows) return base;
  if (content === null) {
    return contextOverflow("the capped change excerpt requires finding windows but source is unavailable");
  }

  // Once any part of the change is hidden, a clean review has no anchors from
  // which to recover the omitted code, and an unanchored finding cannot be
  // checked against a targeted window. Letting either case continue would let
  // a judge see only the prefix and still award PASS/complete coverage.
  if (!findings.length) {
    return contextOverflow(
      "the change excerpt is truncated and the zero-finding review has no anchors for the omitted code"
    );
  }
  const unanchored = findings.filter((finding) => finding.line === undefined).length;
  if (unanchored) {
    return contextOverflow(
      `the change excerpt is truncated and ${unanchored} finding(s) have no line anchor`
    );
  }

  // A truncated diff has no reliable line coverage, so every anchored finding
  // receives a source window. A capped whole-file base needs only later lines.
  const hiddenLines = findings
    .map((finding) => finding.line)
    .filter((line): line is number => line !== undefined && line > visibleTo);
  if (!hiddenLines.length) return base;

  const windows = findingWindows(hiddenLines, totalLines).map(({ start, end }) =>
    renderFileContent(file, content, start, end, end - start + 1, JUDGE_CHANGE_MAX_CHARS)
  );
  const excerpt = [
    base,
    `### Excerpts around finding lines the capped excerpt above does not show`,
    `(judge these findings against the windows below, not against absence)`,
    ...windows,
  ].join("\n\n");
  if (excerpt.length > JUDGE_CHANGE_MAX_CHARS) {
    return contextOverflow(
      `${windows.length} merged finding window(s) plus the base exceed ${JUDGE_CHANGE_MAX_CHARS} characters`
    );
  }
  return excerpt;
}

export function overflowContext(file: string, revision: number, reason: string): string {
  return (
    `⚠️ Judge context INCOMPLETE for ${file} review revision ${revision}: ${reason}. ` +
    `The bounded context cannot show every finding and its evidence within ${JUDGE_CONTEXT_MAX_CHARS} characters. ` +
    `This artifact is now terminal Judge INCOMPLETE — Do NOT call f_review_judge or re-spawn it, ` +
    `because a partial judgment must never PASS. Continue with the remaining files, then call ` +
    `f_review_finalize; the run fails closed as INCOMPLETE.`
  );
}

export function contextOverflowTerminal(
  review: PersistedFileReviewResult,
  reason: string
): JudgeTerminal {
  return {
    status: "judge-incomplete",
    reviewRevision: review.revision,
    reviewArtifactHash: artifactIdentity(review),
    reason: `bounded judge context unavailable: ${reason}`,
    at: new Date().toISOString(),
  };
}

/**
 * The rulebook the reviewer was held to, as shown to the judge.
 *
 * Without it the judge scores against general best practice and rejects
 * correct rule-based findings as style preferences — observed as "Spring
 * supports @RequiredArgsConstructor, this is not a blocker" against a project
 * whose authoritative guide forbids exactly that, sinking every file below the
 * threshold no matter how many rework rounds ran.
 *
 * Mirrors what the reviewer's prompt injects (framework guide + glob-gated
 * project rules) minus the category rubric: `JUDGE_CRITERIA` already defines
 * scoring, and handing the judge the review checklist invites it to re-review
 * the code instead of judging the review.
 */
export function authoritativeRules(file: string, cwd: string): string {
  const body = [loadFrameworkGuide(cwd), renderExtraRules(loadExtraRules(cwd), file)]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!body) return "";
  const capped =
    body.length > JUDGE_RULES_MAX_CHARS
      ? `${body.slice(0, JUDGE_RULES_MAX_CHARS)}\n… (rules truncated)`
      : body;
  return [
    `### Authoritative project rules (the reviewer was REQUIRED to follow these)`,
    `A finding that correctly applies a rule below is VALID even when it`,
    `contradicts general best practice. Do not penalize it as a style`,
    `preference, an outdated pattern, or a framework misunderstanding. These`,
    `rules are not up for debate — judge only whether the reviewer applied them`,
    `correctly to this file.`,
    ``,
    capped,
    ``,
  ].join("\n");
}

export function buildJudgePrompt(
  meta: RunMeta,
  result: PersistedFileReviewResult,
  judgment: FileJudgment,
  cwd: string
): string | JudgeContextOverflow {
  const findingsJson = JSON.stringify(result.findings, null, 2);
  if (findingsJson.length > JUDGE_FINDINGS_MAX_CHARS) {
    return contextOverflow(
      `${result.findings.length} serialized finding(s) exceed ${JUDGE_FINDINGS_MAX_CHARS} characters`
    );
  }

  const excerpt = changeExcerpt(meta, result.file, cwd, result.findings);
  if (isContextOverflow(excerpt)) return excerpt;

  const round = judgment.attempts.length + 1;
  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  // The judge must see the list AND the same instructions the reviewer was
  // given — `meta.fcqFix` included. Without the flag it read "give the fix for
  // CRITICAL/MAJOR hits" while the reviewer had been told a separate pass owns
  // every fix, and scored the reviewer against an instruction it never got.
  const fcq =
    meta.fcq?.status === "ok"
      ? renderFcqEvidence(readFcqFile(runDir(meta.runId, cwd), result.file), meta.fcqFix)
      : "";
  const prompt = [
    `You are judging the review of ${result.file} (run ${meta.runId}, judge round ${round}).`,
    `Score threshold: ${threshold} (score < ${threshold} ⇒ the review is sent back for rework).`,
    ``,
    `### Criteria`,
    JUDGE_CRITERIA,
    ``,
    authoritativeRules(result.file, cwd),
    ...(fcq
      ? [
          `### Static analysis already applied`,
          `The reviewer was instructed NOT to re-report these; do not count them as coverage gaps.`,
          ...(meta.fcqFix
            ? [
                `A separate fix pass writes their corrected code, so the reviewer owed you`,
                `NO fix for them. A review that only restates these rules, however, has`,
                `added nothing this run did not already have — score it accordingly.`,
              ]
            : []),
          fcq,
          ``,
        ]
      : []),
    `### The change under review`,
    excerpt,
    ``,
    `### The submitted review (findings to judge, by index)`,
    findingsJson,
    ``,
    `Judge every finding by its index, list coverage gaps, then call f_review_judge`,
    `with runId="${meta.runId}", file="${result.file}", your findingJudgments, coverageGaps,`,
    `score, and feedback. Feedback must be concrete, numbered instructions the`,
    `next reviewer can follow (required when the score is below the threshold).`,
  ].join("\n");
  return prompt.length <= JUDGE_CONTEXT_MAX_CHARS
    ? prompt
    : contextOverflow(`the assembled judge prompt is ${prompt.length} characters`);
}
