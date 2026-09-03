/**
 * The persisted judgment record: `<runDir>/judgments/<slug>.json`.
 *
 * Schemas for what a judge submits and what is kept, the path it is kept at,
 * and the writes themselves. Everything here is about the RECORD — deciding a
 * verdict, building the judge's prompt, and validating a submission live in
 * judge.ts and judge-prompt.ts.
 *
 * A record is bound to the review artifact it judged (`artifactIdentity`), so
 * an attempt left over from an earlier revision of the same file can be
 * recognized and ignored rather than mistaken for a current verdict.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { capped } from "../contract";
import { reviewArtifactHash, reviewSlug, runDir, type PersistedFileReviewResult } from "./run-store";

/** Max rework (re-review) instructions per file — after that judging becomes
 * terminal INCOMPLETE and is flagged fail-closed in the final report.
 * Default only; `.f-review.json` `judgeRounds` overrides it per run. */
export const MAX_JUDGE_ROUNDS = 2;

/** Malformed submissions for one review revision before judging terminates
 * fail-closed. This is separate from (and never consumes) rework rounds. */
export const MAX_INVALID_JUDGE_SUBMISSIONS = 3;

export const DEFAULT_JUDGE_THRESHOLD = 70;

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

export const JudgeIdentitySchema = z.object({ runId: z.string(), file: z.string() });

export function submissionHash(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function judgmentPath(runId: string, file: string, cwd: string): string {
  return join(runDir(runId, cwd), "judgments", `${reviewSlug(file)}.json`);
}

export async function persistJudgment(
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
export function persistJudgmentSync(
  runId: string,
  file: string,
  cwd: string,
  judgment: FileJudgment
): void {
  mkdirSync(join(runDir(runId, cwd), "judgments"), { recursive: true });
  writeFileSync(judgmentPath(runId, file, cwd), JSON.stringify(judgment, null, 2));
}

export function artifactIdentity(review: PersistedFileReviewResult): string {
  return reviewArtifactHash(review);
}

export function attemptMatchesReview(
  attempt: JudgeAttempt,
  review: PersistedFileReviewResult
): boolean {
  return (
    attempt.reviewRevision === review.revision &&
    attempt.reviewArtifactHash === artifactIdentity(review)
  );
}

export function terminalMatchesReview(
  terminal: JudgeTerminal | undefined,
  review: PersistedFileReviewResult
): boolean {
  return !!terminal &&
    terminal.reviewRevision === review.revision &&
    terminal.reviewArtifactHash === artifactIdentity(review);
}

export function terminalMessage(file: string, terminal: JudgeTerminal): string {
  return (
    `⚠️ Judge INCOMPLETE for ${file} review revision ${terminal.reviewRevision}: ${terminal.reason}. ` +
    `This file is terminal — do NOT re-spawn or judge it again; continue with the remaining files, then f_review_finalize.`
  );
}
