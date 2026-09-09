/**
 * What the judge subagent is shown: the change under review, the findings the
 * reviewer submitted, and the criteria to score them against.
 *
 * Every section is budgeted against JUDGE_CONTEXT_MAX_BYTES, because the judge
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
const JUDGE_DIFF_MAX_BYTES = 10_000;

/** Whole-file lines shown to the judge before falling back to per-finding windows. */
const JUDGE_FILE_MAX_LINES = 2000;

/** Context lines around a finding whose line the capped excerpt did not show. */
const JUDGE_WINDOW = 25;

/**
 * Hard ceiling for the complete judge prompt.
 *
 * Bytes, not characters, and the same 45_000 the fix pass uses: the host
 * truncates a tool result before the model sees it (OpenCode's store cuts at
 * 51200 bytes) and the judge has no read tools to recover what was dropped. A
 * character budget silently doubles or triples in bytes on a file with Korean
 * comments, which is exactly where the judge would have been handed a cut
 * context while believing it complete.
 */
export const JUDGE_CONTEXT_MAX_BYTES = 45_000;

/** Section budgets leave room for the rules, identities, and instructions. */
const JUDGE_FINDINGS_MAX_BYTES = 20_000;

/** The change section, and so the whole-file base inside it. Sized to hold an
 * ordinary service class whole: a 400-line Java file renders to ~19_000 bytes,
 * and a base too small to hold it forced every finding into a window whose sum
 * then blew the same budget — a terminal INCOMPLETE for a file that fits. */
const JUDGE_CHANGE_MAX_BYTES = 24_000;

/** Cap on the authoritative-rules section (framework guide + glob-gated
 * project rules). Truncated, never rejected: a review judged against partial
 * rules still beats one judged against none. */
const JUDGE_RULES_MAX_BYTES = 8_000;

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

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** Truncate to a UTF-8 byte budget, dropping a character split by the cut. */
function sliceBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  const decoded = new TextDecoder("utf-8").decode(Buffer.from(s, "utf8").subarray(0, max));
  return decoded.replace(/\uFFFD$/, "");
}

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
      needsWindows = byteLen(diff) > JUDGE_DIFF_MAX_BYTES;
      base = needsWindows
        ? `${sliceBytes(diff, JUDGE_DIFF_MAX_BYTES)}\n… (diff truncated)`
        : diff;
    }
  }

  if (!base) {
    if (content === null) {
      base = `Error: file not found: ${file}. The reviewed source is unavailable.`;
    } else {
      const rendered = renderFileContent(
        file,
        content,
        1,
        totalLines,
        JUDGE_FILE_MAX_LINES,
        JUDGE_CHANGE_MAX_BYTES
      );
      // The reader caps characters; the budget is bytes. A multi-byte source
      // can pass its cap and still overrun, so measure the cut here too.
      const whole =
        totalLines <= JUDGE_FILE_MAX_LINES &&
        !rendered.includes("IS_TRUNCATED: true") &&
        byteLen(rendered) <= JUDGE_CHANGE_MAX_BYTES;
      // Whole or nothing. A partial base is a prefix the finding windows below
      // re-render line for line, and paying for it twice is what turned a file
      // that fits into a terminal INCOMPLETE. Without it the windows own the
      // whole change budget and the header says what is visible.
      base = whole ? rendered : "";
      visibleTo = whole ? totalLines : 0;
      needsWindows = !whole;
    }
  }

  // Unreachable while both sources are byte-capped at or below the change
  // budget above. Kept as the guard on that invariant: raise either cap past
  // the change budget and this is what stops a partial excerpt from reaching
  // the judge.
  if (byteLen(base) > JUDGE_CHANGE_MAX_BYTES) {
    return contextOverflow(`the base change excerpt exceeds ${JUDGE_CHANGE_MAX_BYTES} bytes`);
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
    renderFileContent(file, content, start, end, end - start + 1, JUDGE_CHANGE_MAX_BYTES)
  );
  const excerpt = [
    base,
    base
      ? `### Excerpts around finding lines the capped excerpt above does not show`
      : `### ${file} is ${totalLines} lines — too large to show whole; excerpts around every finding line`,
    `(judge these findings against the windows below, not against absence:\n` +
      `code outside these ranges was not shown to you and is not a coverage gap)`,
    ...windows,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (byteLen(excerpt) > JUDGE_CHANGE_MAX_BYTES) {
    return contextOverflow(
      `${windows.length} merged finding window(s) plus the base exceed ${JUDGE_CHANGE_MAX_BYTES} bytes`
    );
  }
  return excerpt;
}

export function overflowContext(file: string, revision: number, reason: string): string {
  return (
    `⚠️ Judge context INCOMPLETE for ${file} review revision ${revision}: ${reason}. ` +
    `The bounded context cannot show every finding and its evidence within ${JUDGE_CONTEXT_MAX_BYTES} bytes. ` +
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
    byteLen(body) > JUDGE_RULES_MAX_BYTES
      ? `${sliceBytes(body, JUDGE_RULES_MAX_BYTES)}\n… (rules truncated)`
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
  if (byteLen(findingsJson) > JUDGE_FINDINGS_MAX_BYTES) {
    return contextOverflow(
      `${result.findings.length} serialized finding(s) exceed ${JUDGE_FINDINGS_MAX_BYTES} bytes`
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
  return byteLen(prompt) <= JUDGE_CONTEXT_MAX_BYTES
    ? prompt
    : contextOverflow(`the assembled judge prompt is ${byteLen(prompt)} bytes`);
}
