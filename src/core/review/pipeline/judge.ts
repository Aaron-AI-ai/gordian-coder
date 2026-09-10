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
import { DEFAULT_JUDGE_THRESHOLD, JudgeIdentitySchema, JudgeSubmitSchema, MAX_INVALID_JUDGE_SUBMISSIONS, MAX_JUDGE_ROUNDS, artifactIdentity, attemptMatchesReview, currentPendingParts, judgmentPath, consistencyValidationError, indexValidationError, loadJudgment, loadReviewResult, persistJudgment, persistJudgmentSync, submissionHash, terminalMatchesReview, terminalMessage, type FileJudgment, type JudgeAttempt, type JudgeSubmitPayload, type JudgeTerminal } from "./judge-store";
import { buildPartContext, buildPartPrompt, contextOverflowTerminal, isContextOverflow, judgePartPlanFor, overflowContext } from "./judge-prompt";
import { FEEDBACK_MAX_CHARS, synthesiseParts } from "./judge-parts";

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
export function judgeContext(runId: string, file: string, cwd: string, part?: number): string {
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
  const plan = judgePartPlanFor(meta, result, judgment, cwd);
  const total = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
  const requested = part ?? 0;
  if (requested < 0 || requested >= total) {
    return `❌ part ${requested} does not exist for ${file} — this review has ${total} part(s) (0..${total - 1}).`;
  }

  const submitted = currentPendingParts(judgment, result).map((p) => p.part);
  if (submitted.includes(requested)) {
    const next = Array.from({ length: total }, (_, i) => i).find((i) => !submitted.includes(i));
    return next === undefined
      ? `ℹ️ Every part of ${file} was already submitted; the verdict is being assembled. Do NOT judge it again.`
      : `ℹ️ part ${requested} of ${file} was already submitted. Spawn a NEW f-judge for part ${next}: call f_review_judge_context with runId="${runId}", file="${file}", part=${next}.`;
  }

  const prompt = buildPartPrompt(meta, result, judgment, cwd, requested, plan);
  if (!isContextOverflow(prompt)) {
    return total === 1
      ? prompt
      : `${prompt}\n\nThis file is judged in ${total} parts; submit with part=${requested}.`;
  }

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

/** The orchestrator instruction that keeps a split judgment moving. Same
 * wording judgeContext hands back when the part asked for is already in. */
function nextPartInstruction(runId: string, file: string, next: number): string[] {
  return [
    `Spawn a NEW f-judge subagent (fresh session) with this prompt:`,
    `  "Call f_review_judge_context with runId=\"${runId}\", file=\"${file}\", part=${next}, ` +
      `evaluate that part, then call f_review_judge with part=${next}."`,
  ];
}

/** Which slice of the invalid-submission budget one rejected payload spends.
 * `part` undefined is its own bucket — what an unsplit review and every
 * pre-existing judgment file use. */
interface InvalidBudget {
  part?: number;
  /** This review's part count, which bounds how many buckets can exist. */
  totalParts: number;
}

async function recordInvalidSubmission(
  runId: string,
  file: string,
  review: PersistedFileReviewResult,
  payload: unknown,
  error: string,
  cwd: string,
  budget: InvalidBudget
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
    part: budget.part,
    submissionHash: submissionHash(payload),
    error: error.slice(0, 2000),
    at: new Date().toISOString(),
  });
  // A bounded audit tail is enough; run directories themselves are also pruned.
  // Sized to hold every bucket that can still be counted: the cap, for each
  // part of this review, for each artifact revision a rework round can produce.
  // A fixed tail evicted a 16-part review's history before any one part's
  // entries had reached the cap.
  judgment.invalidSubmissions = judgment.invalidSubmissions.slice(
    -MAX_INVALID_JUDGE_SUBMISSIONS * (MAX_JUDGE_ROUNDS + 2) * Math.max(1, budget.totalParts)
  );
  // Counted per part, not per revision: every part gets its OWN f-judge, so
  // three judges each doubting one of their own findings once is not the same
  // as one judge doing it three times. Sharing one budget would terminalize a
  // split review on the first honest round.
  const invalids = judgment.invalidSubmissions.filter(
    (entry) =>
      entry.reviewRevision === review.revision &&
      entry.reviewArtifactHash === artifactIdentity(review) &&
      entry.part === budget.part
  ).length;
  const forPart = budget.part === undefined ? "" : ` part ${budget.part}`;
  if (invalids >= MAX_INVALID_JUDGE_SUBMISSIONS) {
    judgment.terminal = {
      status: "judge-incomplete",
      reviewRevision: review.revision,
      reviewArtifactHash: artifactIdentity(review),
      reason:
        `${invalids} malformed judge submissions${forPart} ` +
        `(last error: ${error.slice(0, 500)})`,
      at: new Date().toISOString(),
    };
    await persistJudgment(runId, file, cwd, judgment);
    return terminalMessage(file, judgment.terminal);
  }
  await persistJudgment(runId, file, cwd, judgment);
  return (
    `Invalid judge submission for ${file} review revision ${review.revision}${forPart}: ${error}. ` +
    `Retry ${invalids}/${MAX_INVALID_JUDGE_SUBMISSIONS}${forPart === "" ? "" : ` for${forPart}`}; ` +
    `after the limit this judge terminates as INCOMPLETE.`
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

  // The part plan is never stored — it is recomputed here and matched against
  // what the submission claims. `judgePartPlanFor` folds this judgment's round
  // number into its measurement, so it is deterministic only against the SAME
  // judgment object already loaded above; reloading a fresher one mid-flight
  // would shift the expected index sets and reject valid submissions.
  const plan = judgePartPlanFor(meta, review, judgment, cwd);
  const totalParts = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
  const submittedPart = parsed.success ? parsed.data.part : undefined;
  const part = submittedPart ?? 0;
  if (part < 0 || part >= totalParts) {
    // Charged to the no-part bucket on purpose: a part number outside the plan
    // gets no bucket of its own, or a judge walking the numbers upward would
    // never reach the cap in any of them.
    return recordInvalidSubmission(
      runId,
      file,
      review,
      payload,
      `part ${part} does not exist (this review has ${totalParts} part(s))`,
      cwd,
      { totalParts }
    );
  }
  // Past the range check `submittedPart` is either in the plan or absent, so it
  // names the budget bucket this submission spends directly.
  const budget: InvalidBudget = { part: submittedPart, totalParts };

  // Re-check the same budget enforced by judgeContext, SCOPED to the part this
  // submission claims. A caller can invoke the state-changing submit tool
  // directly; it must not manufacture PASS for a review whose findings and
  // evidence could never fit in the judge's bounded context. Unscoped, this
  // check terminalized on first submit exactly the reviews the split salvages —
  // the coverage-only and oversized-findings cases judgeContext now serves.
  const context = buildPartContext(meta, review, judgment, cwd, part, plan);
  if (isContextOverflow(context)) {
    judgment.terminal = contextOverflowTerminal(review, context.reason);
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
      cwd,
      budget
    );
  }

  // What is validated and recorded below: one part's submission until the last
  // one arrives, then the synthesis of them all.
  let submission: JudgeSubmitPayload = parsed.data;

  if (totalParts > 1) {
    const pending = currentPendingParts(judgment, review);
    // The coverage part judges no findings; a finding part must carry exactly
    // the index set the recomputed plan assigns it.
    const expected = plan.findingParts[part] ?? [];
    const received = submission.findingJudgments.map((entry) => entry.index);
    const same =
      received.length === expected.length &&
      new Set(received).size === expected.length &&
      expected.every((index) => received.includes(index));
    if (!same) {
      return recordInvalidSubmission(
        runId,
        file,
        review,
        payload,
        `part ${part} must judge exactly indices [${expected.join(", ")}] ` +
          `(received [${received.join(", ")}])`,
        cwd,
        budget
      );
    }

    // Every cross-field rule this part CAN answer for, applied where a failure
    // is still cheap: one part is re-judged, not all of them. The one rule that
    // does not transfer is coverageGaps-must-be-empty — a finding part sees a
    // slice of the file, its gap report is discarded by synthesiseParts, and
    // holding it to that rule would refuse a submission over a value nobody
    // reads. So it is masked out for every part but the coverage part.
    const isCoveragePart = part >= plan.findingParts.length;
    const partInconsistent = consistencyValidationError(
      isCoveragePart ? submission : { ...submission, coverageGaps: [] },
      review.findings,
      threshold
    );
    if (partInconsistent) {
      return recordInvalidSubmission(
        runId,
        file,
        review,
        payload,
        partInconsistent,
        cwd,
        budget
      );
    }

    const submitted = new Set(pending.map((entry) => entry.part));
    const firstMissing = (): number | undefined =>
      Array.from({ length: totalParts }, (_, index) => index).find((index) => !submitted.has(index));
    if (submitted.has(part)) {
      const next = firstMissing();
      return [
        `ℹ️ part ${part} of ${file} was already submitted; no new record was made.`,
        ...(next === undefined ? [] : nextPartInstruction(runId, file, next)),
      ].join("\n");
    }

    judgment.pendingParts = [
      ...pending,
      {
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        part,
        score: submission.score,
        feedback: submission.feedback,
        coverageGaps: submission.coverageGaps,
        findingJudgments: submission.findingJudgments,
        at: new Date().toISOString(),
      },
    ];
    submitted.add(part);

    const next = firstMissing();
    if (next !== undefined) {
      await persistJudgment(runId, file, cwd, judgment);
      return [
        `📝 part ${part + 1}/${totalParts} recorded for ${file} (score ${submission.score}).`,
        ...nextPartInstruction(runId, file, next),
      ].join("\n");
    }

    // Every part is in — synthesiseParts' precondition — so one judgment can be
    // assembled and taken down the ordinary attempt path from here.
    const merged = synthesiseParts(plan, judgment.pendingParts);
    judgment.pendingParts = [];
    // Consumed even if the synthesis fails validation below. Left in place they
    // would freeze this judgment with every part submitted: each re-submission
    // reads as a duplicate, and nothing could ever complete it.
    await persistJudgment(runId, file, cwd, judgment);
    submission = { ...submission, ...merged };

    // The merged payload is a shape no single judge chose, so the pass-side
    // rules can refuse a combination every part answered honestly: a coverage
    // part scoring 0 still cannot pull 0.8·90 under the threshold, and a part
    // that correctly rejects findings can be outvoted by the others. Refusing
    // it would discard every part's work behind a bare "Retry k/3". Record the
    // honest REWORK instead — the verdict still follows the score, and the
    // attempt survives persistedAttemptValidationError on reload.
    //
    // Only the pass-side rules are clamped. Below the threshold the sole rule
    // is "feedback must be non-empty", which no clamp can satisfy and which
    // keeps its existing invalid-submission handling below.
    const mergedError = consistencyValidationError(submission, review.findings, threshold);
    if (mergedError && submission.score >= threshold && threshold > 0) {
      const mean = submission.score;
      const clamped = threshold - 1;
      submission = {
        ...submission,
        score: clamped,
        // The reduction has to be visible: otherwise the recorded number
        // silently disagrees with the weighted-mean formula and the report
        // shows a figure nobody can derive.
        feedback: [
          `⚠️ Score reduced from ${mean} (the weighted mean of the part scores) to ` +
            `${clamped}, so this review is recorded as REWORK: ${mergedError}.`,
          submission.feedback,
        ]
          .join("\n\n")
          .slice(0, FEEDBACK_MAX_CHARS),
      };
    }
  }

  const invalidIndices = indexValidationError(review.findings, submission.findingJudgments);
  if (invalidIndices) {
    return recordInvalidSubmission(runId, file, review, payload, invalidIndices, cwd, budget);
  }
  const inconsistent = consistencyValidationError(submission, review.findings, threshold);
  if (inconsistent) {
    return recordInvalidSubmission(runId, file, review, payload, inconsistent, cwd, budget);
  }

  // What the judge was actually shown, when it was less than the whole change.
  // The coverage part owns it, whichever part happened to arrive last — so for
  // a split review it is re-derived here rather than read off `context`.
  const shownContext =
    totalParts > 1 && plan.hasCoveragePart
      ? buildPartContext(meta, review, judgment, cwd, plan.findingParts.length, plan)
      : context;
  const truncated = isContextOverflow(shownContext) ? undefined : shownContext.truncated;

  // Synthesised or not, the verdict comes from the score and the threshold.
  const verdict: JudgeAttempt["verdict"] = submission.score >= threshold ? "pass" : "rework";
  const attempt: JudgeAttempt = {
    reviewRevision: review.revision,
    reviewArtifactHash: artifactIdentity(review),
    submissionHash: submissionHash(submission),
    score: submission.score,
    verdict,
    feedback: submission.feedback,
    coverageGaps: submission.coverageGaps,
    findingJudgments: submission.findingJudgments,
    ...(truncated ? { truncated } : {}),
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
        reason: `score ${submission.score} remained below threshold ${threshold} after ${reworkCap(meta)} rework rounds`,
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
