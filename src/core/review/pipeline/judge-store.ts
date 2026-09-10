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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { capped, type Finding } from "../contract";
import { loadRun, readFileReviewResult, reviewArtifactHash, reviewSlug, runDir, type PersistedFileReviewResult } from "./artifact";

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
  /** 분할 심사에서 이 제출이 담당한 part. 분할되지 않은 리뷰는 생략한다.
   * 선언하지 않으면 non-strict z.object가 조용히 떼어내 모든 제출이 part 0으로
   * 보인다 — 거절이 아니라 오인이므로 스키마에 반드시 있어야 한다. */
  part: z.number().int().nonnegative().optional(),
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
/**
 * What the judge was shown, when it was not the whole change.
 *
 * A coverage-only PASS salvaged from a file too large to show whole is
 * otherwise indistinguishable on disk from a judgment made over everything.
 * Optional, so every judgment file written before this still loads.
 */
export const JudgeTruncationSchema = z.object({
  /** `lines` — a leading run of source lines; `outline` — every declaration of
   * the whole file with no bodies; `diff` — a leading run of diff lines. */
  view: z.enum(["lines", "outline", "diff"]),
  /** Lines shown, or declarations listed for `outline`. */
  shown: z.number().int().nonnegative(),
  /** Lines the change has, or the file's line count for `outline`. */
  total: z.number().int().nonnegative(),
});

export type JudgeTruncation = z.infer<typeof JudgeTruncationSchema>;

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
  /** Set when this verdict was reached over less than the whole change. */
  truncated: JudgeTruncationSchema.optional(),
  at: z.string(), // ISO timestamp
});

export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

export const InvalidJudgeSubmissionSchema = z.object({
  reviewRevision: z.number().int().positive(),
  reviewArtifactHash: z.string().optional(),
  /** 이 제출이 담당한 part. 예산은 이 값으로 나눠 센다 — part마다 새 심사관이
   * 뜨므로, 서로 다른 심사관이 한 번씩 틀린 것과 한 심사관이 상한만큼 틀린 것을
   * 같게 볼 수 없다. 생략된 제출(파싱 실패, part 없는 제출)과 기존 판정 파일은
   * undefined로 남아 지금까지와 똑같이 하나의 버킷을 쓴다. */
  part: z.number().int().nonnegative().optional(),
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

/**
 * 한 part의 심사 제출. 모든 part가 모이면 하나의 JudgeAttempt로 합성되어
 * `attempts`로 옮겨가므로, 여기 남아있는 항목은 아직 미완인 심사를 뜻한다.
 *
 * attempt와 같은 방식으로 리뷰 아티팩트에 바인딩된다. 재리뷰로 새 revision이
 * 나오면 해시가 어긋나 자동으로 무효가 된다.
 */
export const JudgePartSubmissionSchema = z.object({
  reviewRevision: z.number().int().positive(),
  reviewArtifactHash: z.string(),
  /** 0..findingParts.length-1 은 지적 part, 그 다음 번호가 coverage part. */
  part: z.number().int().nonnegative(),
  score: z.number().min(0).max(100),
  feedback: z.string(),
  coverageGaps: z.array(z.string()),
  findingJudgments: z.array(FindingJudgmentSchema),
  at: z.string(),
});

export type JudgePartSubmission = z.infer<typeof JudgePartSubmissionSchema>;

export const FileJudgmentSchema = z.object({
  file: z.string(),
  attempts: z.array(JudgeAttemptSchema),
  invalidSubmissions: z.array(InvalidJudgeSubmissionSchema).default([]),
  /** 아직 전부 모이지 않은 part 제출. 합성되면 비워진다. */
  pendingParts: z.array(JudgePartSubmissionSchema).default([]),
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

export function loadReviewResult(
  runId: string,
  file: string,
  cwd: string
): PersistedFileReviewResult | null {
  return readFileReviewResult(runId, file, cwd);
}

export function indexValidationError(
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

export function consistencyValidationError(
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
export function persistedAttemptValidationError(
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

export function validatePersistedAttempts(
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
  return { file, attempts: [], invalidSubmissions: [], pendingParts: [] };
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

/** 현재 리뷰 아티팩트에 속한 part 제출만. 다른 revision에 남은 것은 버린다. */
export function currentPendingParts(
  judgment: FileJudgment,
  review: PersistedFileReviewResult
): JudgePartSubmission[] {
  const hash = artifactIdentity(review);
  return judgment.pendingParts.filter(
    (submission) =>
      submission.reviewRevision === review.revision && submission.reviewArtifactHash === hash
  );
}
