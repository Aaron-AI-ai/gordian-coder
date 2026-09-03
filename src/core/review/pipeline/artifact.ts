/**
 * Everything a run persists, and how to read it back: run.json, the per-file
 * review artifact, and the paths both live at.
 *
 * The lowest layer of a run — reads only. Creating a run, writing a review,
 * and the run's lifecycle are run-store.ts.
 *
 * It sits under both stores on purpose. run-store needs judgments to decide a
 * run is finished, and judge-store needs the review artifact to tell a current
 * verdict from one left over by an earlier revision; without a shared floor
 * those two import each other.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FindingSchema, REQUIRED_CATEGORIES, SEVERITIES, type Severity } from "../contract";
import { FcqRunStatusSchema, type FcqRunStatus } from "../evidence/fcq";

export const RUNS_DIR = "fcq/f-review/runs";

/**
 * Structured per-file result written next to the rendered md (the aggregation
 * input). There is deliberately no findings-array cap here: a segmented review
 * merges several individually capped submissions and can legitimately exceed
 * SubmitSchema's per-submit limit.
 *
 * `revision` is assigned by writeFileReview, not trusted from a caller. A judge
 * attempt is bound to this monotonic revision so retrying the same tool call is
 * idempotent while a genuinely rewritten review may be judged again.
 */
export const FileReviewResultObjectSchema = z
  .object({
    file: z.string().min(1).max(500),
    assessed: z.array(z.enum(REQUIRED_CATEGORIES)),
    findings: z.array(FindingSchema),
    explorationCalls: z.number().int().nonnegative(),
    partial: z.boolean(),
    forced: z.string().max(4000).optional(),
    coverageComplete: z.boolean().optional(),
    revision: z.number().int().positive().default(1),
  })
  .superRefine((result, ctx) => {
    result.findings.forEach((finding, index) => {
      if (finding.file !== result.file) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", index, "file"],
          message: `finding file ${finding.file} does not match review file ${result.file}`,
        });
      }
    });
  });

export const FileReviewResultSchema = FileReviewResultObjectSchema.transform((result) => ({
    ...result,
    // Legacy artifacts predate this field. Infer conservatively so a partial or
    // bounded-recovery artifact can never become a clean result during migration.
    coverageComplete:
      (result.coverageComplete ?? true) &&
      !result.partial &&
      result.forced === undefined &&
      REQUIRED_CATEGORIES.every((category) => result.assessed.includes(category)),
}));

/** Caller input (revision/coverageComplete remain optional for compatibility). */
export type FileReviewResult = z.input<typeof FileReviewResultSchema>;

/** Fully validated and normalized persisted result. */
export type PersistedFileReviewResult = z.output<typeof FileReviewResultSchema>;

/** Stable semantic hash of a normalized persisted review. */
export function reviewArtifactHash(result: PersistedFileReviewResult): string {
  return Bun.hash(JSON.stringify(result)).toString();
}

export function runDir(runId: string, cwd: string): string {
  return join(cwd, RUNS_DIR, runId);
}

/** Filesystem-safe, collision-resistant per-file review filename stem. The
 * readable prefix aids inspection; the full-path hash keeps aliases such as
 * `a/b.ts` and `a__b.ts` distinct. */
export function reviewSlug(file: string): string {
  const readable = file.replace(/[\\/]/g, "__").replace(/[^\w.__-]/g, "_").slice(0, 180);
  return `${readable}--${Bun.hash(file).toString(36)}`;
}

/** Load one exact review artifact, rejecting corrupt and wrong-file state. */
export function readFileReviewResult(
  runId: string,
  file: string,
  cwd: string
): PersistedFileReviewResult | null {
  const p = join(runDir(runId, cwd), "reviews", `${reviewSlug(file)}.json`);
  if (!existsSync(p)) return null;
  try {
    const parsed = FileReviewResultSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success && parsed.data.file === file ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RunMeta {
  runId: string;
  createdAt: string; // ISO timestamp
  targets: string[]; // expected real file paths (coverage baseline)
  range: string | null; // git diff range shared by every subagent
  whole: boolean;
  label: string; // report filename stem
  language: string;
  output?: string;
  failOn?: Severity;
  requirementBackground?: string;
  planGuidance?: string;
  /** Review rounds per target, shared by every subagent (clamped 1..5). */
  deepPasses?: number;
  /** Judge gate: each file's review is evaluated by an independent judge agent
   * after submit; below-threshold reviews are re-reviewed with feedback. */
  judge?: boolean;
  /** Judge pass score (0..100, default DEFAULT_JUDGE_THRESHOLD). */
  judgeThreshold?: number;
  /** Max judge rework (re-review) rounds per file (0..5, default
   * MAX_JUDGE_ROUNDS; 0 = judge once, never re-review). */
  judgeRounds?: number;
  /** Baseline finding keys snapshotted at PLAN time (like sequential mode does
   * at start). Finalize must not re-read the report dir: a finalize retry would
   * otherwise see its own partial report and mislabel this run's findings as
   * pre-existing. */
  baseline?: string[];
  /** Identity of the exact source snapshot used by this plan. Diff runs pin
   * symbolic refs to commit SHAs; files-only runs hash target contents. */
  sourceIdentity?: string;
  /** Hash of every effective review rule/guide used when planning. */
  criteriaIdentity?: string;
  /** Effective exclude globs (config + plan args), kept for the report's
   * Review Context appendix. */
  excludes?: string[];
  /** Static analysis (fcq) step outcome; absent when not enabled for the run. */
  fcq?: FcqRunStatus;
  /** Config `fcqFix`: reviewers must write a TO-BE fix for every fcq hit, not
   * just CRITICAL/MAJOR. Costs reviewer budget; buys real code in the report. */
  fcqFix?: boolean;
}

/** Persisted run metadata is external state, even though this process created it. */
export const RunMetaSchema: z.ZodType<RunMeta> = z.object({
  runId: z.string().regex(/^[\w.-]+$/),
  createdAt: z.string(),
  targets: z.array(z.string()),
  range: z.string().nullable(),
  whole: z.boolean(),
  label: z.string(),
  language: z.string(),
  output: z.string().optional(),
  failOn: z.enum(SEVERITIES).optional(),
  requirementBackground: z.string().optional(),
  planGuidance: z.string().optional(),
  deepPasses: z.number().int().min(1).max(5).optional(),
  judge: z.boolean().optional(),
  judgeThreshold: z.number().min(0).max(100).optional(),
  judgeRounds: z.number().int().min(0).max(5).optional(),
  baseline: z.array(z.string()).optional(),
  sourceIdentity: z.string().optional(),
  criteriaIdentity: z.string().optional(),
  excludes: z.array(z.string()).optional(),
  fcq: FcqRunStatusSchema.optional(),
  fcqFix: z.boolean().optional(),
});

/** Load a run's meta, or null when the run does not exist / is unreadable. */
export function loadRun(runId: string, cwd: string): RunMeta | null {
  // Path-safety: a runId is a filename we generated — never a path. Reject
  // anything that could escape the runs directory.
  if (!/^[\w.-]+$/.test(runId)) return null;
  const p = join(runDir(runId, cwd), "run.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = RunMetaSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success && parsed.data.runId === runId ? parsed.data : null;
  } catch {
    return null;
  }
}
