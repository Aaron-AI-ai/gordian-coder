/**
 * Review-quality judge (run mode only).
 *
 * After a reviewer subagent finishes a file (its review json is on disk), the
 * orchestrator spawns an INDEPENDENT judge subagent that evaluates the review
 * itself — not the code — against a fixed rubric:
 *
 *   f_review_judge_context(runId, file) → the change + submitted findings +
 *                                         judging criteria
 *   f_review_judge(verdict payload)     → verdict recorded; returns the
 *                                         orchestrator's next action
 *
 * The pass/rework verdict is computed HERE from the score threshold — never
 * trusted from the judge model — and rework rounds are capped at
 * MAX_JUDGE_ROUNDS so the loop always terminates. Verdicts persist under
 * `<runDir>/judgments/<slug>.json`; a rework verdict is injected as feedback
 * into the re-spawned reviewer's context (see startRunFileReview), and
 * finalizeRun reports per-file judge outcomes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { capped, type Finding } from "./contract";
import { buildDiffMap } from "./context";
import { afterRef, readFileAt, renderFileContent } from "./reader";
import { loadExtraRules, loadFrameworkGuide, renderExtraRules } from "./rubric";
import {
  loadRun,
  readFileReviewResult,
  reviewArtifactHash,
  reviewSlug,
  runDir,
  type PersistedFileReviewResult,
  type RunMeta,
} from "./run";

/** Max rework (re-review) instructions per file — after that judging becomes
 * terminal INCOMPLETE and is flagged fail-closed in the final report.
 * Default only; `.f-review.json` `judgeRounds` overrides it per run. */
export const MAX_JUDGE_ROUNDS = 2;

/** Effective rework cap for a run: `judgeRounds` snapshotted into the run
 * meta at plan time, else MAX_JUDGE_ROUNDS. */
function reworkCap(meta: { judgeRounds?: number } | null | undefined): number {
  return meta?.judgeRounds ?? MAX_JUDGE_ROUNDS;
}
/** Malformed submissions for one review revision before judging terminates
 * fail-closed. This is separate from (and never consumes) rework rounds. */
export const MAX_INVALID_JUDGE_SUBMISSIONS = 3;
export const DEFAULT_JUDGE_THRESHOLD = 70;

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

// Judge text is truncated (never rejected) at the same kind of caps the
// reviewer's findings get — a looping judge's runaway feedback would otherwise
// be persisted and re-injected into every rework reviewer prompt.
export const FindingJudgmentSchema = z.object({
  index: z.number().int().nonnegative(), // position in the submitted findings array
  valid: z.boolean(), // matches the actual code (survived refutation)
  evidenced: z.boolean(), // concrete failure scenario given
  severityFit: z.boolean(), // neither inflated nor buried
  actionable: z.boolean(), // suggestion applicable (blocker/major)
  note: capped(500), // one-line justification
});
export type FindingJudgment = z.infer<typeof FindingJudgmentSchema>;

export const JudgeSubmitSchema = z.object({
  runId: z.string(),
  file: z.string(),
  // Do not truncate this array: segmented reviews can legitimately merge more
  // than 60 findings, and every persisted finding must receive a judgment.
  findingJudgments: z.array(FindingJudgmentSchema),
  // significant change areas the review never examined
  coverageGaps: z.array(capped(500)).transform((a) => a.slice(0, 20)),
  score: z.number().min(0).max(100),
  feedback: capped(4000), // concrete rework instructions (used when the verdict is rework)
});
export type JudgeSubmitPayload = z.infer<typeof JudgeSubmitSchema>;

// Persisted judgment shape — validated on every load: judgment files are
// external state (CLAUDE.md: runtime validation), and a shape-corrupt file
// must degrade to "never judged", not crash the rework round or finalize.
export const JudgeAttemptSchema = z.object({
  /** Monotonic FileReviewResult revision this attempt judged. */
  reviewRevision: z.number().int().positive().default(1),
  /** Hash of the exact review artifact judged. Legacy attempts may omit it for
   * shape compatibility, but intentionally never match the current artifact:
   * an unverifiable legacy verdict fails closed as unjudged. */
  reviewArtifactHash: z.string().optional(),
  /** Deterministic hash of the normalized judge payload (audit/idempotency). */
  submissionHash: z.string().default("legacy"),
  score: z.number(),
  verdict: z.enum(["pass", "rework"]),
  feedback: z.string(),
  coverageGaps: z.array(z.string()),
  findingJudgments: z.array(FindingJudgmentSchema),
  at: z.string(), // ISO timestamp
});
export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

export const InvalidJudgeSubmissionSchema = z.object({
  reviewRevision: z.number().int().positive(),
  reviewArtifactHash: z.string().optional(),
  submissionHash: z.string(),
  error: z.string(),
  at: z.string(),
});
export type InvalidJudgeSubmission = z.infer<typeof InvalidJudgeSubmissionSchema>;

export const JudgeTerminalSchema = z.object({
  status: z.literal("judge-incomplete"),
  reviewRevision: z.number().int().positive(),
  reviewArtifactHash: z.string().optional(),
  reason: z.string(),
  at: z.string(),
});
export type JudgeTerminal = z.infer<typeof JudgeTerminalSchema>;

export const FileJudgmentSchema = z.object({
  file: z.string(),
  attempts: z.array(JudgeAttemptSchema),
  invalidSubmissions: z.array(InvalidJudgeSubmissionSchema).default([]),
  terminal: JudgeTerminalSchema.optional(),
});
export type FileJudgment = z.infer<typeof FileJudgmentSchema>;

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
  `4. Actionability (10%) — every blocker/major carries an applicable suggestion.`,
  `5. Coverage (20%) — every significant part of the change was actually`,
  `   examined; list unexamined areas in coverageGaps.`,
  ``,
  `Do NOT reward finding count — a clean file with zero findings can score 100.`,
  `Penalize noise: duplicates, style nits inflated to issues, hallucinated lines.`,
  `Prefer false negatives over false positives, matching the review's own rules.`,
].join("\n");

function judgmentPath(runId: string, file: string, cwd: string): string {
  return join(runDir(runId, cwd), "judgments", `${reviewSlug(file)}.json`);
}

/** All recorded judgments for one file (empty attempts when never judged or
 * the file on disk is unreadable/shape-corrupt). */
export function loadJudgment(runId: string, file: string, cwd: string): FileJudgment {
  const p = judgmentPath(runId, file, cwd);
  if (existsSync(p)) {
    try {
      const parsed = FileJudgmentSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (parsed.success && parsed.data.file === file) {
        return validatePersistedAttempts(parsed.data, runId, cwd);
      }
    } catch {
      /* fall through to empty */
    }
  }
  return { file, attempts: [], invalidSubmissions: [] };
}

/** Every file's judgment for a run (finalize summary input). */
export function readRunJudgments(runId: string, cwd: string): FileJudgment[] {
  const dir = join(runDir(runId, cwd), "judgments");
  if (!existsSync(dir)) return [];
  const out: FileJudgment[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = FileJudgmentSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (parsed.success && f === `${reviewSlug(parsed.data.file)}.json`) {
        out.push(validatePersistedAttempts(parsed.data, runId, cwd));
      }
    } catch {
      /* skip unreadable partial writes */
    }
  }
  return out;
}

/** Rework verdicts recorded so far for a file — the judge-cap driver. */
export function reworkCount(runId: string, file: string, cwd: string): number {
  return loadJudgment(runId, file, cwd).attempts.filter((a) => a.verdict === "rework").length;
}

/** The judge feedback to inject into a re-spawned reviewer's context, or ""
 * when the file's latest verdict is not a pending rework. */
export function judgeFeedbackFor(runId: string, file: string, cwd: string): string {
  const last = currentReviewAttempt(runId, file, cwd);
  if (!last || last.verdict !== "rework") return "";
  return [
    `## Judge feedback (previous review round scored ${last.score} — rework required)`,
    last.feedback,
    ...(last.coverageGaps.length
      ? [``, `Unexamined areas flagged by the judge:`, ...last.coverageGaps.map((g) => `- ${g}`)]
      : []),
    ``,
    `Address every point above in this review round.`,
  ].join("\n");
}

/** Whether a run reviewer may rewrite an existing artifact. First submissions
 * are handled by the caller; an existing artifact may be reopened only after
 * its current revision received a non-terminal REWORK verdict. */
export function reviewReworkStatus(
  runId: string,
  file: string,
  cwd: string
): "rework" | "pass" | "terminal" | "unjudged" | "missing" {
  const review = loadReviewResult(runId, file, cwd);
  if (!review) return "missing";
  const judgment = loadJudgment(runId, file, cwd);
  if (terminalMatchesReview(judgment.terminal, review)) return "terminal";
  const attempt = judgment.attempts.findLast((entry) => attemptMatchesReview(entry, review));
  if (!attempt) return "unjudged";
  return attempt.verdict;
}

function loadReviewResult(
  runId: string,
  file: string,
  cwd: string
): PersistedFileReviewResult | null {
  return readFileReviewResult(runId, file, cwd);
}

interface JudgeContextOverflow {
  reason: string;
}

function contextOverflow(reason: string): JudgeContextOverflow {
  return { reason };
}

function isContextOverflow(value: string | JudgeContextOverflow): value is JudgeContextOverflow {
  return typeof value !== "string";
}

/** Merge overlapping finding windows so nearby anchors do not inject the same
 * source lines repeatedly. */
function findingWindows(lines: number[], total: number): { start: number; end: number }[] {
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
function changeExcerpt(
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

function overflowContext(file: string, revision: number, reason: string): string {
  return (
    `⚠️ Judge context INCOMPLETE for ${file} review revision ${revision}: ${reason}. ` +
    `The bounded context cannot show every finding and its evidence within ${JUDGE_CONTEXT_MAX_CHARS} characters. ` +
    `This artifact is now terminal Judge INCOMPLETE — Do NOT call f_review_judge or re-spawn it, ` +
    `because a partial judgment must never PASS. Continue with the remaining files, then call ` +
    `f_review_finalize; the run fails closed as INCOMPLETE.`
  );
}

function contextOverflowTerminal(
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
function authoritativeRules(file: string, cwd: string): string {
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

function buildJudgePrompt(
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
  const prompt = [
    `You are judging the review of ${result.file} (run ${meta.runId}, judge round ${round}).`,
    `Score threshold: ${threshold} (score < ${threshold} ⇒ the review is sent back for rework).`,
    ``,
    `### Criteria`,
    JUDGE_CRITERIA,
    ``,
    authoritativeRules(result.file, cwd),
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

/** Everything a judge subagent needs: the change, the submitted review, the
 * criteria, and the submission instructions. Stateless — no session joins. */
export function judgeContext(runId: string, file: string, cwd: string): string {
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  const result = loadReviewResult(runId, file, cwd);
  if (!result) {
    return `❌ No submitted review for ${file} in run ${runId} yet — judge only after the reviewer subagent completes.`;
  }
  const judgment = loadJudgment(runId, file, cwd);
  const currentTerminal = judgment.terminal;
  if (currentTerminal && terminalMatchesReview(currentTerminal, result)) {
    return (
      `⚠️ Judge INCOMPLETE for ${file} review revision ${result.revision}: ${currentTerminal.reason}. ` +
      `This revision is terminal — do NOT judge or re-review it; continue with the remaining files, then f_review_finalize.`
    );
  }
  const existing = judgment.attempts.findLast((attempt) => attemptMatchesReview(attempt, result));
  if (existing) {
    if (existing.verdict === "pass") {
      return (
        `ℹ️ ${file} review revision ${result.revision} already passed its judge (score ${existing.score}). ` +
        `Do NOT judge it again; continue with the remaining files, then f_review_finalize.`
      );
    }
    return (
      `ℹ️ ${file} review revision ${result.revision} was already judged REWORK (score ${existing.score}). ` +
      `Do NOT judge the unchanged artifact again; re-spawn the reviewer as previously instructed so it writes a new revision.`
    );
  }
  // Hard cap enforcement (the tool descriptions promise it): past the rework
  // cap no further judge round is served — the latest review stands.
  if (reworkCount(runId, file, cwd) > reworkCap(meta)) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${reworkCap(meta)}) in run ${runId}. ` +
      `Judging is INCOMPLETE — do NOT judge or re-review it; it is flagged in the final report.`
    );
  }
  const prompt = buildJudgePrompt(meta, result, judgment, cwd);
  if (!isContextOverflow(prompt)) return prompt;

  // Context creation itself is the terminal decision: asking a small judge to
  // retry cannot make an oversized immutable artifact smaller. Persist it now
  // so repeated context calls, direct submit attempts, and finalize all agree.
  const terminal = contextOverflowTerminal(result, prompt.reason);
  persistJudgmentSync(runId, file, cwd, { ...judgment, terminal });
  return overflowContext(file, result.revision, terminal.reason);
}

const JudgeIdentitySchema = z.object({ runId: z.string(), file: z.string() });

function submissionHash(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  return createHash("sha256").update(serialized).digest("hex");
}

async function persistJudgment(
  runId: string,
  file: string,
  cwd: string,
  judgment: FileJudgment
): Promise<void> {
  await Bun.write(judgmentPath(runId, file, cwd), JSON.stringify(judgment, null, 2));
}

/** judgeContext is intentionally synchronous for both adapters. Persist its
 * deterministic context-overflow terminal before returning so a Qwen agent
 * cannot spin on context retries while finalize still sees the file unjudged. */
function persistJudgmentSync(
  runId: string,
  file: string,
  cwd: string,
  judgment: FileJudgment
): void {
  mkdirSync(join(runDir(runId, cwd), "judgments"), { recursive: true });
  writeFileSync(judgmentPath(runId, file, cwd), JSON.stringify(judgment, null, 2));
}

// One promise gate per active judgment artifact serializes the complete
// read-modify-write transaction. The final waiter removes the gate, so a
// long-lived server retains no keys after submissions settle.
const judgeSubmissionGates = new Map<string, Promise<void>>();

async function serializeJudgeSubmission<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = judgeSubmissionGates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  judgeSubmissionGates.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (judgeSubmissionGates.get(key) === current) {
      judgeSubmissionGates.delete(key);
    }
  }
}


function terminalMessage(file: string, terminal: JudgeTerminal): string {
  return (
    `⚠️ Judge INCOMPLETE for ${file} review revision ${terminal.reviewRevision}: ${terminal.reason}. ` +
    `This file is terminal — do NOT re-spawn or judge it again; continue with the remaining files, then f_review_finalize.`
  );
}

function artifactIdentity(review: PersistedFileReviewResult): string {
  return reviewArtifactHash(review);
}

function attemptMatchesReview(
  attempt: JudgeAttempt,
  review: PersistedFileReviewResult
): boolean {
  return (
    attempt.reviewRevision === review.revision &&
    attempt.reviewArtifactHash === artifactIdentity(review)
  );
}

function terminalMatchesReview(
  terminal: JudgeTerminal | undefined,
  review: PersistedFileReviewResult
): boolean {
  return !!terminal &&
    terminal.reviewRevision === review.revision &&
    terminal.reviewArtifactHash === artifactIdentity(review);
}

/** Current artifact-bound attempt, newest first. Legacy attempts without an
 * artifact hash remain parseable for audit but intentionally do not match a
 * current review: trusting revision alone would let stale state bless it. */
export function currentReviewAttempt(
  runId: string,
  file: string,
  cwd: string
): JudgeAttempt | undefined {
  const review = loadReviewResult(runId, file, cwd);
  if (!review) return undefined;
  return loadJudgment(runId, file, cwd).attempts.findLast((attempt) =>
    attemptMatchesReview(attempt, review)
  );
}

/** Current artifact-bound terminal marker, if any. */
export function currentReviewTerminal(
  runId: string,
  file: string,
  cwd: string
): JudgeTerminal | undefined {
  const review = loadReviewResult(runId, file, cwd);
  if (!review) return undefined;
  const terminal = loadJudgment(runId, file, cwd).terminal;
  return terminalMatchesReview(terminal, review) ? terminal : undefined;
}

function attemptMessage(
  runId: string,
  file: string,
  threshold: number,
  cap: number,
  judgment: FileJudgment,
  attempt: JudgeAttempt,
  duplicate = false
): string {
  const prefix = duplicate
    ? `ℹ️ Judge result already recorded for ${file} review revision ${attempt.reviewRevision}; no new attempt was added. `
    : "";
  if (attempt.verdict === "pass") {
    return `${prefix}✅ Judge PASS for ${file} (score ${attempt.score} ≥ ${threshold}). The review is accepted — proceed with the remaining files, then f_review_finalize.`;
  }
  const terminal = judgment.terminal;
  if (
    terminal?.reviewRevision === attempt.reviewRevision &&
    terminal.reviewArtifactHash === attempt.reviewArtifactHash
  ) {
    return `${prefix}${terminalMessage(file, terminal)}`;
  }
  const reworks = judgment.attempts.filter((a) => a.verdict === "rework").length;
  return [
    `${prefix}🔁 Judge REWORK for ${file} (score ${attempt.score} < ${threshold}, rework ${reworks}/${cap}).`,
    `Re-spawn ONE f-reviewer subagent with this prompt:`,
    `  "Call f_review_context with runId=\"${runId}\" and files=[\"${file}\"], review that single file addressing the judge feedback injected into your instructions, and call f_review_submit."`,
    `After it completes, spawn a NEW f-judge subagent for ${file} again (fresh session).`,
  ].join("\n");
}

function indexValidationError(
  findings: readonly Finding[],
  judgments: readonly FindingJudgment[]
): string | null {
  const indices = judgments.map((j) => j.index);
  const unique = new Set(indices);
  const expected = findings.length;
  if (
    indices.length === expected &&
    unique.size === expected &&
    indices.every((index) => index >= 0 && index < expected)
  ) {
    return null;
  }
  return (
    `findingJudgments must contain every index 0..${Math.max(0, expected - 1)} exactly once ` +
    `(expected ${expected}, received [${indices.join(", ")}])`
  );
}

function consistencyValidationError(
  payload: JudgeSubmitPayload,
  findings: readonly Finding[],
  threshold: number
): string | null {
  if (payload.score < threshold && payload.feedback.trim().length === 0) {
    return `score ${payload.score} requires concrete non-empty rework feedback`;
  }
  if (payload.score >= threshold) {
    const rejected = payload.findingJudgments.filter(
      (judgment) =>
        !judgment.valid ||
        !judgment.evidenced ||
        !judgment.severityFit ||
        ((findings[judgment.index]?.severity === "blocker" ||
          findings[judgment.index]?.severity === "major") &&
          !judgment.actionable)
    );
    if (rejected.length) {
      return (
        `score ${payload.score} cannot pass while ${rejected.length} finding judgment(s) ` +
        `fail validity/evidence/severity/actionability checks`
      );
    }
    if (payload.coverageGaps.length) {
      return `score ${payload.score} cannot pass while coverageGaps is non-empty`;
    }
  }
  return null;
}

/** Persisted attempts are external state, so shape validation alone is not
 * enough. Re-run every cross-field invariant that guards a current artifact;
 * a tampered or legacy attempt is ignored and the artifact remains unjudged. */
function persistedAttemptValidationError(
  attempt: JudgeAttempt,
  review: PersistedFileReviewResult,
  threshold: number
): string | null {
  if (!Number.isFinite(attempt.score) || attempt.score < 0 || attempt.score > 100) {
    return `score ${attempt.score} is outside 0..100`;
  }
  const expectedVerdict: JudgeAttempt["verdict"] =
    attempt.score >= threshold ? "pass" : "rework";
  if (attempt.verdict !== expectedVerdict) {
    return (
      `verdict ${attempt.verdict} disagrees with score ${attempt.score} ` +
      `and threshold ${threshold}`
    );
  }
  const invalidIndices = indexValidationError(review.findings, attempt.findingJudgments);
  if (invalidIndices) return invalidIndices;
  return consistencyValidationError(
    {
      runId: "",
      file: review.file,
      findingJudgments: attempt.findingJudgments,
      coverageGaps: attempt.coverageGaps,
      score: attempt.score,
      feedback: attempt.feedback,
    },
    review.findings,
    threshold
  );
}

function validatePersistedAttempts(
  judgment: FileJudgment,
  runId: string,
  cwd: string
): FileJudgment {
  const review = loadReviewResult(runId, judgment.file, cwd);
  const meta = loadRun(runId, cwd);
  if (!review || !meta) return judgment;
  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  const attempts = judgment.attempts.filter(
    (attempt) =>
      !attemptMatchesReview(attempt, review) ||
      persistedAttemptValidationError(attempt, review, threshold) === null
  );
  return attempts.length === judgment.attempts.length
    ? judgment
    : { ...judgment, attempts };
}

async function recordInvalidSubmission(
  runId: string,
  file: string,
  review: PersistedFileReviewResult,
  payload: unknown,
  error: string,
  cwd: string
): Promise<string> {
  const judgment = loadJudgment(runId, file, cwd);
  const existing = judgment.attempts.findLast((attempt) => attemptMatchesReview(attempt, review));
  const meta = loadRun(runId, cwd);
  const threshold = meta?.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  if (existing) {
    return attemptMessage(runId, file, threshold, reworkCap(meta), judgment, existing, true);
  }
  const currentTerminal = judgment.terminal;
  if (currentTerminal && terminalMatchesReview(currentTerminal, review)) {
    return terminalMessage(file, currentTerminal);
  }

  judgment.invalidSubmissions.push({
    reviewRevision: review.revision,
    reviewArtifactHash: artifactIdentity(review),
    submissionHash: submissionHash(payload),
    error: error.slice(0, 2000),
    at: new Date().toISOString(),
  });
  // A bounded audit tail is enough; run directories themselves are also pruned.
  judgment.invalidSubmissions = judgment.invalidSubmissions.slice(
    -MAX_INVALID_JUDGE_SUBMISSIONS * (MAX_JUDGE_ROUNDS + 2)
  );
  const invalids = judgment.invalidSubmissions.filter(
    (entry) =>
      entry.reviewRevision === review.revision &&
      entry.reviewArtifactHash === artifactIdentity(review)
  ).length;
  if (invalids >= MAX_INVALID_JUDGE_SUBMISSIONS) {
    judgment.terminal = {
      status: "judge-incomplete",
      reviewRevision: review.revision,
      reviewArtifactHash: artifactIdentity(review),
      reason: `${invalids} malformed judge submissions (last error: ${error.slice(0, 500)})`,
      at: new Date().toISOString(),
    };
    await persistJudgment(runId, file, cwd, judgment);
    return terminalMessage(file, judgment.terminal);
  }
  await persistJudgment(runId, file, cwd, judgment);
  return (
    `Invalid judge submission for ${file} review revision ${review.revision}: ${error}. ` +
    `Retry ${invalids}/${MAX_INVALID_JUDGE_SUBMISSIONS}; after the limit this judge terminates as INCOMPLETE.`
  );
}

/** Record a judge verdict and tell the orchestrator what to do next.
 * The verdict is derived from the score threshold, never from the model. */
export async function submitJudge(payload: unknown, cwd: string): Promise<string> {
  const identity = JudgeIdentitySchema.safeParse(payload);
  if (!identity.success) {
    const parsed = JudgeSubmitSchema.safeParse(payload);
    return `Invalid judge submission: ${parsed.success ? identity.error.message : parsed.error.message}`;
  }
  const { runId, file } = identity.data;
  const key = resolve(judgmentPath(runId, file, cwd));
  return serializeJudgeSubmission(key, () => submitJudgeSerialized(payload, cwd, runId, file));
}

async function submitJudgeSerialized(
  payload: unknown,
  cwd: string,
  runId: string,
  file: string
): Promise<string> {
  const parsed = JudgeSubmitSchema.safeParse(payload);

  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  const review = loadReviewResult(runId, file, cwd);
  if (!review) {
    return `❌ No submitted review for ${file} in run ${runId} — nothing to judge yet.`;
  }

  const judgment = loadJudgment(runId, file, cwd);
  const existing = judgment.attempts.findLast((attempt) => attemptMatchesReview(attempt, review));
  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  if (existing) {
    return attemptMessage(runId, file, threshold, reworkCap(meta), judgment, existing, true);
  }
  const currentTerminal = judgment.terminal;
  if (currentTerminal && terminalMatchesReview(currentTerminal, review)) {
    return terminalMessage(file, currentTerminal);
  }
  // Hard cap enforcement: once more than the run's rework cap of rework
  // verdicts exist, no later artifact can reopen judging.
  if (reworkCount(runId, file, cwd) > reworkCap(meta)) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${reworkCap(meta)}) — verdict NOT recorded. ` +
      `Judging is INCOMPLETE; continue with the remaining files, then f_review_finalize.`
    );
  }

  // Re-check the same budget enforced by judgeContext. A caller can invoke the
  // state-changing submit tool directly; it must not manufacture PASS for a
  // review whose complete findings/evidence could never fit in the judge's
  // bounded context.
  const prompt = buildJudgePrompt(meta, review, judgment, cwd);
  if (isContextOverflow(prompt)) {
    judgment.terminal = contextOverflowTerminal(review, prompt.reason);
    await persistJudgment(runId, file, cwd, judgment);
    return terminalMessage(file, judgment.terminal);
  }

  if (!parsed.success) {
    return recordInvalidSubmission(
      runId,
      file,
      review,
      payload,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      cwd
    );
  }
  const invalidIndices = indexValidationError(review.findings, parsed.data.findingJudgments);
  if (invalidIndices) {
    return recordInvalidSubmission(runId, file, review, payload, invalidIndices, cwd);
  }
  const inconsistent = consistencyValidationError(parsed.data, review.findings, threshold);
  if (inconsistent) {
    return recordInvalidSubmission(runId, file, review, payload, inconsistent, cwd);
  }

  const verdict: JudgeAttempt["verdict"] = parsed.data.score >= threshold ? "pass" : "rework";
  const attempt: JudgeAttempt = {
    reviewRevision: review.revision,
    reviewArtifactHash: artifactIdentity(review),
    submissionHash: submissionHash(parsed.data),
    score: parsed.data.score,
    verdict,
    feedback: parsed.data.feedback,
    coverageGaps: parsed.data.coverageGaps,
    findingJudgments: parsed.data.findingJudgments,
    at: new Date().toISOString(),
  };
  judgment.attempts.push(attempt);
  if (verdict === "rework") {
    const reworks = judgment.attempts.filter((a) => a.verdict === "rework").length;
    if (reworks > reworkCap(meta)) {
      judgment.terminal = {
        status: "judge-incomplete",
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        reason: `score ${parsed.data.score} remained below threshold ${threshold} after ${reworkCap(meta)} rework rounds`,
        at: new Date().toISOString(),
      };
    }
  } else if (judgment.terminal && !terminalMatchesReview(judgment.terminal, review)) {
    // A stale malformed-submission terminal belongs to an older rewritten
    // artifact and must not taint this successful revision.
    judgment.terminal = undefined;
  }
  await persistJudgment(runId, file, cwd, judgment);
  return attemptMessage(runId, file, threshold, reworkCap(meta), judgment, attempt);
}
