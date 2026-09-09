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

import { join, resolve } from "node:path";

import { loadRun } from "./artifact";
import { runDir, type PersistedFileReviewResult } from "./artifact";
import { DEFAULT_JUDGE_THRESHOLD, JudgeIdentitySchema, JudgeSubmitSchema, MAX_INVALID_JUDGE_SUBMISSIONS, MAX_JUDGE_ROUNDS, artifactIdentity, attemptMatchesReview, judgmentPath, consistencyValidationError, indexValidationError, loadJudgment, loadReviewResult, persistJudgment, persistJudgmentSync, submissionHash, terminalMatchesReview, terminalMessage, type FileJudgment, type JudgeAttempt, type JudgeTerminal } from "./judge-store";
import { buildJudgePrompt, contextOverflowTerminal, isContextOverflow, overflowContext } from "./judge-prompt";

/** Effective rework cap for a run: `judgeRounds` snapshotted into the run
 * meta at plan time, else MAX_JUDGE_ROUNDS. Exported so every gate that
 * refuses a re-review uses the SAME cap the judge enforces. */
export function reworkCap(meta: { judgeRounds?: number } | null | undefined): number {
  return meta?.judgeRounds ?? MAX_JUDGE_ROUNDS;
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
