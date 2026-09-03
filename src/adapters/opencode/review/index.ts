/**
 * f-review wiring for the OpenCode plugin.
 *
 * Exposes the review tools and one system-prompt injection hook:
 *   - f_review_plan    : create a parallel run (orchestrator fan-out mode)
 *   - f_review_context : collect targets + rubric + diff snapshot, seed state
 *                        (with runId: join a run for exactly one file)
 *   - f_review_finalize: aggregate a run's per-file reviews into the report
 *   - file_read        : read a file's after-version (line range, numbered)
 *   - file_read_diff   : read the diff of other changed files
 *   - file_find        : find files by filename substring
 *   - code_search      : git grep the codebase (regex / pathspec)
 *   - related_code     : rank dependencies, callers, tests, and co-change files
 *   - git_history      : inspect commits, co-changes, and historical patches
 *   - f_review_submit  : declare done for a file → coverage gate → advance/finish
 *   - f_review_judge_context : judge input for one file's submitted review (run mode)
 *   - f_review_judge   : record a judge verdict → accept or rework instruction
 *   - system.transform : inject the per-file review template each turn
 *
 * The loop itself lives in core (core/review/loop.ts); this file only adapts
 * tool schemas and the system-prompt hook.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  REQUIRED_CATEGORIES,
  SEVERITIES,
  getState,
  fixContext,
  submitFix,
  REVIEW_TOOLS,
  runReviewTool,
  startReview,
  submitReview,
  reviewPromptFor,
  languageInstructionFor,
  onSessionIdle,
  NO_ACTIVE_REVIEW,
  planReview,
  finalizeRun,
  judgeContext,
  submitJudge,
  resolveMaxToolCalls,
} from "../../../core/review";
import {
  REVIEWER_AGENT_NAME,
  REVIEWER_AGENT_DESCRIPTION,
  REVIEWER_AGENT_PROMPT,
  REVIEWER_AGENT_PERMISSION,
  REVIEWER_AGENT_TOOLS,
  JUDGE_AGENT_NAME,
  FIXER_AGENT_NAME,
  FIXER_AGENT_DESCRIPTION,
  FIXER_AGENT_PROMPT,
  FIXER_AGENT_TOOLS,
  JUDGE_AGENT_DESCRIPTION,
  JUDGE_AGENT_PROMPT,
  JUDGE_AGENT_PERMISSION,
  reviewerAgentSteps,
  JUDGE_AGENT_STEPS,
  JUDGE_AGENT_TOOLS,
  REVIEW_COMMAND_NAME,
  REVIEW_COMMAND_DESCRIPTION,
  REVIEW_COMMAND_TEMPLATE,
} from "./prompts";

const z = tool.schema;

export function createReviewModule(input: PluginInput): {
  tools: Record<string, ReturnType<typeof tool>>;
  systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]>;
  event: NonNullable<Hooks["event"]>;
  config: NonNullable<Hooks["config"]>;
} {
  const cwd = input.directory;

  const f_review_context = tool({
    description:
      "Start a code review. Collects target files from a git commit/range and/or explicit files (minus excludes), loads the rubric, and seeds the review loop. All inputs optional; with none, reviews the latest commit.",
    args: {
      commit: z.string().optional().describe('Single ref ("HEAD","<sha>") or range ("A..B")'),
      from: z.string().optional().describe("Range start (used with `to`)"),
      to: z.string().optional().describe("Range end (defaults HEAD)"),
      files: z.array(z.string()).optional().describe("Explicit file paths"),
      whole: z
        .boolean()
        .optional()
        .describe(
          "Review full file content instead of the diff; large files (>~1000 lines) are split into overlapping segments, each reviewed with its referenced same-file declarations. Defaults to true for files-only reviews (no commit)."
        ),
      exclude: z.array(z.string()).optional().describe("Glob patterns to exclude"),
      output: z.string().optional().describe("Report output file or directory"),
      failOn: z
        .enum(SEVERITIES)
        .optional()
        .describe("CI gate: verdict is FAIL when any finding is at/above this severity"),
      requirementBackground: z.string().optional(),
      planGuidance: z.string().optional(),
      language: z.string().optional().describe('Findings/report language (default "ko")'),
      deepPasses: z
        .number()
        .int()
        .optional()
        .describe(
          "Review rounds per file/segment (1-5; default from .f-review.json `deepPasses`, else 1). Rounds >1 make the submit gate bounce clean submissions back for refute/deepen/calibrate passes."
        ),
      runId: z
        .string()
        .optional()
        .describe(
          "Parallel-run mode: join the run created by f_review_plan and review exactly ONE file from its targets (pass it via `files`). Other inputs come from the run's shared config."
        ),
    },
    async execute(args, ctx) {
      return startReview(args, cwd, ctx.sessionID);
    },
  });

  const f_review_plan = tool({
    description:
      "Plan a PARALLEL code review (orchestrator only). Collects target files like f_review_context, creates a run, and returns the runId plus exact fan-out instructions: spawn one f-reviewer subagent per file (batched), then call f_review_finalize. Use this instead of f_review_context when reviewing files in parallel subagents.",
    args: {
      commit: z.string().optional().describe('Single ref ("HEAD","<sha>") or range ("A..B")'),
      from: z.string().optional().describe("Range start (used with `to`)"),
      to: z.string().optional().describe("Range end (defaults HEAD)"),
      files: z.array(z.string()).optional().describe("Explicit file paths"),
      whole: z
        .boolean()
        .optional()
        .describe(
          "Review full file content instead of the diff (large files auto-segment). Defaults to true for files-only reviews (no commit)."
        ),
      exclude: z.array(z.string()).optional().describe("Glob patterns to exclude"),
      output: z.string().optional().describe("Report output file or directory"),
      failOn: z
        .enum(SEVERITIES)
        .optional()
        .describe("CI gate: verdict is FAIL when any finding is at/above this severity"),
      requirementBackground: z.string().optional(),
      planGuidance: z.string().optional(),
      language: z.string().optional().describe('Findings/report language (default "ko")'),
      deepPasses: z
        .number()
        .int()
        .optional()
        .describe(
          "Review rounds per file/segment for every subagent (1-5; default from .f-review.json `deepPasses`, else 1)"
        ),
      judge: z
        .boolean()
        .optional()
        .describe(
          "Judge gate: after each file's review, an independent f-judge subagent scores it; below-threshold reviews are re-reviewed with feedback (default from .f-review.json `judge`)"
        ),
      fcq: z
        .boolean()
        .optional()
        .describe(
          "Static analysis: run the fcq CLI over the targets before fan-out, inject its violations into each reviewer as evidence, and merge them into the final report (default from .f-review.json `fcq`; options in `fcqOptions`)"
        ),
    },
    async execute(args) {
      return planReview(args, cwd);
    },
  });

  const f_review_judge_context = tool({
    description:
      "Judge-agent entry point (run mode): returns the change under review, the submitted findings, and the scoring criteria for one file of a run. Call before f_review_judge.",
    args: {
      runId: z.string().min(1).describe("The runId of the reviewed run"),
      file: z.string().min(1).describe("The reviewed file to judge"),
    },
    async execute(args) {
      return judgeContext(args.runId, args.file, cwd);
    },
  });

  const f_review_judge = tool({
    description:
      "Submit a judge verdict for one file's review. The pass/rework verdict is derived from the score threshold; the result tells the orchestrator whether to accept the review or re-spawn the reviewer with feedback (rework cap enforced).",
    args: {
      runId: z.string().min(1),
      file: z.string().min(1),
      findingJudgments: z
        .array(
          z.object({
            index: z.number().int().min(0).describe("Finding index in the submitted review"),
            valid: z.boolean().describe("Matches the actual code (survived refutation)"),
            evidenced: z.boolean().describe("Concrete failure scenario given"),
            severityFit: z.boolean().describe("Severity neither inflated nor buried"),
            actionable: z.boolean().describe("Suggestion applicable (blocker/major)"),
            note: z.string().describe("One-line justification"),
          })
        )
        .describe("One judgment per submitted finding"),
      coverageGaps: z
        .array(z.string())
        .describe("Significant change areas the review never examined (empty if none)"),
      score: z.number().min(0).max(100).describe("Review quality score 0-100"),
      feedback: z
        .string()
        .describe("Concrete, numbered rework instructions (required when below threshold)"),
    },
    async execute(args) {
      return submitJudge(args, cwd);
    },
  });

  const f_review_fix_context = tool({
    description:
      "Fix pass (f-fixer only): the source of one file plus every static-analysis violation in it, to be turned into corrected code.",
    args: {
      runId: z.string().min(1).describe("The runId returned by f_review_plan"),
      file: z.string().min(1).describe("Repo-relative path of the file to fix"),
    },
    async execute(args) {
      return fixContext(args.runId, args.file, cwd);
    },
  });

  const f_review_fix_submit = tool({
    description:
      "Fix pass (f-fixer only): record the corrected code for each violation. Anchored on line + ruleId, merged onto the fcq rows at finalize.",
    args: {
      runId: z.string().min(1),
      file: z.string().min(1),
      fixes: z
        .array(
          z.object({
            line: z.number().int().nonnegative().describe("Violation line, exactly as listed"),
            ruleId: z.string().describe("Violation rule id, exactly as listed"),
            asIs: z.string().optional().describe("The code as it stands — code only"),
            toBe: z.string().optional().describe("The corrected code — code only"),
            falsePositive: z.boolean().optional().describe("True when no change applies"),
            note: z.string().optional().describe("One line; required for a false positive"),
          })
        )
        .describe("One entry per violation"),
    },
    async execute(args) {
      return submitFix(args, cwd);
    },
  });

  const f_review_finalize = tool({
    description:
      "Finalize a parallel review run (orchestrator only): verifies every planned file was reviewed, aggregates the per-file reviews into the final report with a coverage/quality summary, and reports any missing files (re-spawn those once, then finalize again).",
    args: {
      runId: z.string().min(1).describe("The runId returned by f_review_plan"),
    },
    async execute(args) {
      return finalizeRun(args.runId, cwd);
    },
  });

  // Every exploration tool comes from the core table (core/review/tools):
  // one name, description, and body per tool, rendered here into zod args.
  const explorationTools = Object.fromEntries(
    REVIEW_TOOLS.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        args: Object.fromEntries(
          Object.entries(spec.args).map(([name, arg]) => {
            const build = () => {
              if (arg.type === "boolean") return z.boolean();
              if (arg.type === "array") {
                const a = z.array(z.string());
                return arg.required ? a.min(1) : a;
              }
              if (arg.type === "number") {
                let n = z.number().int();
                if (arg.min !== undefined) n = n.min(arg.min);
                if (arg.max !== undefined) n = n.max(arg.max);
                return n;
              }
              const str = z.string();
              return arg.required ? str.min(1) : str;
            };
            const schema = build();
            return [
              name,
              (arg.required ? schema : schema.optional()).describe(arg.description),
            ];
          })
        ),
        async execute(args, ctx) {
          return runReviewTool(getState(ctx.sessionID), spec.name, args as Record<string, unknown>);
        },
      }),
    ])
  );

  const f_review_submit = tool({
    description:
      "Declare the current file reviewed. Copy CURRENT_SUBMIT_TOKEN from the latest injected prompt, then provide `assessed` and `findings`. Token identity and coverage are gated.",
    args: {
      submitToken: z.string().min(1).describe("Exact CURRENT_SUBMIT_TOKEN from the latest prompt"),
      assessed: z.array(z.enum(REQUIRED_CATEGORIES)).describe("Categories actually evaluated"),
      findings: z
        .array(
          z.object({
            category: z.enum(REQUIRED_CATEGORIES),
            severity: z.enum(SEVERITIES),
            file: z.string(),
            line: z.number().int().positive().optional(),
            rule: z.string(),
            message: z.string(),
            // Two fields with separate budgets. As one, a long AS-IS truncated
            // the corrected code away entirely. Both stay .optional() at the
            // schema level on purpose: a hard-required field would reject the
            // whole submit and funnel a valid review into the failed-submit
            // loop. The MUST lives in the prompts.
            asIs: z
              .string()
              .optional()
              .describe("REQUIRED: the current problematic code, verbatim"),
            toBe: z
              .string()
              .optional()
              .describe("REQUIRED: the corrected code, ready to paste over the AS-IS"),
            suggestion: z
              .string()
              .optional()
              .describe("Deprecated — send asIs/toBe instead; an AS-IS/TO-BE string still parses"),
          })
        )
        .describe("Issues found (may be empty)"),
    },
    async execute(args, ctx) {
      return submitReview(args, ctx.sessionID);
    },
  });

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (
    hookInput,
    output
  ) => {
    const st = getState(hookInput.sessionID);
    if (!st?.active) return;
    const prompt = reviewPromptFor(st);
    if (!prompt) return;
    output.system.push(prompt);
    output.system.push(languageInstructionFor(st));
  };

  // Turn-end watchdog: when the session goes idle with an unfinished review,
  // re-drive the LLM to finish the remaining files (up to MAX_RESUMES), or let
  // core finalize a partial report once the cap is hit.
  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;
    const action = await onSessionIdle(sessionID);
    if (action?.kind === "resume") {
      await input.client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: action.text }] },
      });
    }
    // action.kind === "finalized" needs no further handling here: core already
    // wrote the partial artifact/report inside onSessionIdle.
  };

  // Register the f-reviewer agent and /f-review command from the bundle.
  // `??=` keeps any project/global md definition of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    const reviewerSteps = reviewerAgentSteps(resolveMaxToolCalls(cwd));
    (cfg.agent ??= {})[REVIEWER_AGENT_NAME] ??= {
      mode: "subagent",
      description: REVIEWER_AGENT_DESCRIPTION,
      prompt: REVIEWER_AGENT_PROMPT,
      permission: REVIEWER_AGENT_PERMISSION,
      tools: REVIEWER_AGENT_TOOLS,
      steps: reviewerSteps,
      maxSteps: reviewerSteps,
    };
    cfg.agent[JUDGE_AGENT_NAME] ??= {
      mode: "subagent",
      description: JUDGE_AGENT_DESCRIPTION,
      prompt: JUDGE_AGENT_PROMPT,
      permission: JUDGE_AGENT_PERMISSION,
      tools: JUDGE_AGENT_TOOLS,
      steps: JUDGE_AGENT_STEPS,
      maxSteps: JUDGE_AGENT_STEPS,
    };
    cfg.agent[FIXER_AGENT_NAME] ??= {
      mode: "subagent",
      description: FIXER_AGENT_DESCRIPTION,
      prompt: FIXER_AGENT_PROMPT,
      permission: JUDGE_AGENT_PERMISSION,
      tools: FIXER_AGENT_TOOLS,
    };
    (cfg.command ??= {})[REVIEW_COMMAND_NAME] ??= {
      description: REVIEW_COMMAND_DESCRIPTION,
      template: REVIEW_COMMAND_TEMPLATE,
    };
  };

  return {
    tools: {
      f_review_plan,
      f_review_context,
      ...explorationTools,
      f_review_submit,
      f_review_finalize,
      f_review_fix_context,
      f_review_fix_submit,
      f_review_judge_context,
      f_review_judge,
    },
    systemTransform,
    event,
    config,
  };
}
