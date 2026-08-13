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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { capped, type Finding } from "./contract";
import { buildDiffMap } from "./context";
import { afterRef, fileRead } from "./reader";
import { loadRun, reviewSlug, runDir, type FileReviewResult, type RunMeta } from "./run";

/** Max rework (re-review) instructions per file — after that the latest review
 * is accepted as-is and flagged in the final report. */
export const MAX_JUDGE_ROUNDS = 2;
export const DEFAULT_JUDGE_THRESHOLD = 70;

/** Cap on the change excerpt embedded in the judge context. */
const JUDGE_DIFF_MAX_CHARS = 10_000;
/** Whole-file lines shown to the judge before falling back to per-finding windows. */
const JUDGE_FILE_MAX_LINES = 2000;
/** Context lines around a finding whose line the capped excerpt did not show. */
const JUDGE_WINDOW = 25;

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
  findingJudgments: z.array(FindingJudgmentSchema).transform((a) => a.slice(0, 60)),
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
  score: z.number(),
  verdict: z.enum(["pass", "rework"]),
  feedback: z.string(),
  coverageGaps: z.array(z.string()),
  findingJudgments: z.array(FindingJudgmentSchema),
  at: z.string(), // ISO timestamp
});
export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

export const FileJudgmentSchema = z.object({
  file: z.string(),
  attempts: z.array(JudgeAttemptSchema),
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
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to empty */
    }
  }
  return { file, attempts: [] };
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
      if (parsed.success) out.push(parsed.data);
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
  const last = loadJudgment(runId, file, cwd).attempts.at(-1);
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

function loadReviewResult(runId: string, file: string, cwd: string): FileReviewResult | null {
  const p = join(runDir(runId, cwd), "reviews", `${reviewSlug(file)}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FileReviewResult;
  } catch {
    return null;
  }
}

/** The change being reviewed, as shown to the judge: the file's diff hunks in
 * commit mode, else the (capped) file content.
 *
 * The judge scores validity by matching findings against this excerpt, so any
 * finding whose line the cap hides would be refuted as "does not match the
 * code" — a systematic misjudgment on large files. Whenever the base excerpt
 * is truncated, per-finding windows are appended so every finding's anchor is
 * visible. */
function changeExcerpt(meta: RunMeta, file: string, cwd: string, findings: Finding[]): string {
  const ref = afterRef(meta.range);
  let base = "";
  let truncated = false;
  let visibleTo = Infinity; // file lines visibly included (unknowable for a truncated diff)
  if (meta.range && !meta.whole) {
    const diff = buildDiffMap(meta.range, [file], cwd)[file] ?? "";
    if (diff) {
      truncated = diff.length > JUDGE_DIFF_MAX_CHARS;
      base = truncated ? `${diff.slice(0, JUDGE_DIFF_MAX_CHARS)}\n… (diff truncated)` : diff;
      if (truncated) visibleTo = 0;
    }
  }
  if (!base) {
    base = fileRead(cwd, ref, file, 1, undefined, JUDGE_FILE_MAX_LINES);
    truncated = base.includes(`truncated at ${JUDGE_FILE_MAX_LINES} lines`);
    if (truncated) visibleTo = JUDGE_FILE_MAX_LINES;
  }
  if (!truncated) return base;

  const unseen = [
    ...new Set(findings.map((f) => f.line).filter((l): l is number => !!l && l > visibleTo)),
  ].sort((a, b) => a - b);
  if (!unseen.length) return base;
  const windows = unseen.map((l) =>
    fileRead(cwd, ref, file, Math.max(1, l - JUDGE_WINDOW), l + JUDGE_WINDOW)
  );
  return [
    base,
    `### Excerpts around finding lines the capped excerpt above does not show`,
    `(judge these findings against the windows below, not against absence)`,
    ...windows,
  ].join("\n\n");
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
  // Hard cap enforcement (the tool descriptions promise it): past the rework
  // cap no further judge round is served — the latest review stands.
  if (reworkCount(runId, file, cwd) > MAX_JUDGE_ROUNDS) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${MAX_JUDGE_ROUNDS}) in run ${runId}. ` +
      `The latest review stands — do NOT judge or re-review it; it is flagged in the final report.`
    );
  }
  const round = loadJudgment(runId, file, cwd).attempts.length + 1;
  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  return [
    `You are judging the review of ${file} (run ${runId}, judge round ${round}).`,
    `Score threshold: ${threshold} (score < ${threshold} ⇒ the review is sent back for rework).`,
    ``,
    `### Criteria`,
    JUDGE_CRITERIA,
    ``,
    `### The change under review`,
    changeExcerpt(meta, file, cwd, result.findings),
    ``,
    `### The submitted review (findings to judge, by index)`,
    JSON.stringify(result.findings, null, 2),
    ``,
    `Judge every finding by its index, list coverage gaps, then call f_review_judge`,
    `with runId="${runId}", file="${file}", your findingJudgments, coverageGaps,`,
    `score, and feedback. Feedback must be concrete, numbered instructions the`,
    `next reviewer can follow (required when the score is below the threshold).`,
  ].join("\n");
}

/** Record a judge verdict and tell the orchestrator what to do next.
 * The verdict is derived from the score threshold, never from the model. */
export async function submitJudge(payload: unknown, cwd: string): Promise<string> {
  const parsed = JudgeSubmitSchema.safeParse(payload);
  if (!parsed.success) return `Invalid judge submission: ${parsed.error.message}`;
  const { runId, file, score } = parsed.data;

  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  if (!loadReviewResult(runId, file, cwd)) {
    return `❌ No submitted review for ${file} in run ${runId} — nothing to judge yet.`;
  }
  // Hard cap enforcement: once the cap message has been issued (rework count
  // already past MAX_JUDGE_ROUNDS), further verdicts are not recorded.
  if (reworkCount(runId, file, cwd) > MAX_JUDGE_ROUNDS) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${MAX_JUDGE_ROUNDS}) — verdict NOT recorded. ` +
      `Accept the latest review as-is and continue with the remaining files, then f_review_finalize.`
    );
  }

  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  const verdict: JudgeAttempt["verdict"] = score >= threshold ? "pass" : "rework";
  const judgment = loadJudgment(runId, file, cwd);
  judgment.attempts.push({
    score,
    verdict,
    feedback: parsed.data.feedback,
    coverageGaps: parsed.data.coverageGaps,
    findingJudgments: parsed.data.findingJudgments,
    at: new Date().toISOString(),
  });
  await Bun.write(judgmentPath(runId, file, cwd), JSON.stringify(judgment, null, 2));

  if (verdict === "pass") {
    return `✅ Judge PASS for ${file} (score ${score} ≥ ${threshold}). The review is accepted — proceed with the remaining files, then f_review_finalize.`;
  }
  const reworks = judgment.attempts.filter((a) => a.verdict === "rework").length;
  if (reworks > MAX_JUDGE_ROUNDS) {
    return (
      `⚠️ Judge still below threshold for ${file} (score ${score} < ${threshold}) after ${MAX_JUDGE_ROUNDS} rework round(s). ` +
      `Accept the latest review as-is — do NOT re-spawn a reviewer for this file; it will be flagged in the final report.`
    );
  }
  return [
    `🔁 Judge REWORK for ${file} (score ${score} < ${threshold}, rework ${reworks}/${MAX_JUDGE_ROUNDS}).`,
    `Re-spawn ONE f-reviewer subagent with this prompt:`,
    `  "Call f_review_context with runId=\"${runId}\" and files=[\"${file}\"], review that single file addressing the judge feedback injected into your instructions, and call f_review_submit."`,
    `After it completes, spawn a NEW f-judge subagent for ${file} again (fresh session).`,
  ].join("\n");
}
