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
import { moebiusReviewerTerminal } from "../moebius-reporter";
import {
  REQUIRED_CATEGORIES,
  SEVERITIES,
  getState,
  fileRead,
  fileReadDiff,
  fileFind,
  codeSearch,
  renderRelatedCode,
  gitHistory,
  currentFilePath,
  startReview,
  submitReview,
  guardExploration,
  reviewPromptFor,
  languageInstructionFor,
  onSessionIdle,
  NO_ACTIVE_REVIEW,
  planReview,
  finalizeRun,
  judgeContext,
  submitJudge,
  ruleFileContent,
  resolveMaxToolCalls,
} from "../../../core/review";
import {
  REVIEWER_AGENT_NAME,
  REVIEWER_AGENT_DESCRIPTION,
  REVIEWER_AGENT_PROMPT,
  REVIEWER_AGENT_PERMISSION,
  REVIEWER_AGENT_TOOLS,
  JUDGE_AGENT_NAME,
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

  const file_read = tool({
    description:
      "Read the after-version of a file (optionally a line range). Output is line-numbered for precise comments; capped at 500 lines. Use hunk headers @@ -x,y +m,n @@ to target start=m-50, end=m+n+50.",
    args: {
      file_path: z.string().min(1).describe("Relative path of the file to read"),
      start_line: z.number().int().optional().describe("Start line (default 1; clamped to >=1)"),
      end_line: z.number().int().positive().optional().describe("End line (default EOF)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      // Reference-mode rule files are served from state: they live in the
      // working tree, which the ref-scoped fileRead may not see.
      return guardExploration(
        st,
        "file_read",
        ruleFileContent(st, args.file_path, args.start_line, args.end_line) ??
          fileRead(st.cwd, st.ref, args.file_path, args.start_line, args.end_line),
        args
      );
    },
  });

  const file_read_diff = tool({
    description:
      "Read the diff of other changed files in this review (from the pre-parsed snapshot). Paths not in the change set are skipped.",
    args: {
      path_array: z.array(z.string()).min(1).describe("File paths whose diff to read"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      return guardExploration(st, "file_read_diff", fileReadDiff(st.diffMap, args.path_array), args);
    },
  });

  const file_find = tool({
    description:
      "Find files by filename substring (not glob/regex; matches basename only). Use to locate files outside the change set.",
    args: {
      query_name: z.string().min(1).describe("Filename keyword (substring)"),
      case_sensitive: z.boolean().optional().describe("Case-sensitive match (default false)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      return guardExploration(
        st,
        "file_find",
        fileFind(st.cwd, st.ref, args.query_name, args.case_sensitive),
        args
      );
    },
  });

  const code_search = tool({
    description:
      "Search the codebase with git grep. Find symbols, call sites, patterns. Capped at 100 matches, grouped by file.",
    args: {
      search_text: z.string().min(1).describe("Search string or regex"),
      file_patterns: z
        .array(z.string())
        .optional()
        .describe("git pathspec, e.g. ['*.ts', ':(exclude)*.test.ts']"),
      case_sensitive: z.boolean().optional().describe("Case-sensitive (default false)"),
      use_perl_regexp: z
        .boolean()
        .optional()
        .describe("true = Perl regex (-P), false = literal (-F, default)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      return guardExploration(
        st,
        "code_search",
        codeSearch(
          st.cwd,
          st.ref,
          args.search_text,
          args.file_patterns,
          args.case_sensitive,
          args.use_perl_regexp
        ),
        args
      );
    },
  });

  const related_code = tool({
    description:
      "Find code related to the current file using imports, symbol usages, likely tests, and git co-change history. Results are ranked and can include bounded source previews.",
    args: {
      file_path: z
        .string()
        .optional()
        .describe("Relative path (defaults to the file currently under review)"),
      max_results: z.number().int().positive().max(30).optional().describe("Maximum candidates"),
      include_preview: z
        .boolean()
        .optional()
        .describe("Include first lines of top candidates (default true)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      const file = args.file_path ?? currentFilePath(st);
      if (!file) return "No current file under review.";
      return guardExploration(
        st,
        "related_code",
        renderRelatedCode(
          st.cwd,
          st.ref,
          file,
          args.max_results,
          args.include_preview ?? true
        ),
        args
      );
    },
  });

  const git_history = tool({
    description:
      "Inspect recent git history for a review file, including commit intent and files changed together. Enable include_patch for historical diffs when checking regressions.",
    args: {
      file_path: z
        .string()
        .optional()
        .describe("Relative path (defaults to the file currently under review)"),
      max_commits: z.number().int().positive().max(10).optional().describe("Recent commits"),
      include_patch: z.boolean().optional().describe("Include bounded historical patches"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE_REVIEW;
      const file = args.file_path ?? currentFilePath(st);
      if (!file) return "No current file under review.";
      return guardExploration(
        st,
        "git_history",
        gitHistory(st.cwd, file, args.max_commits, args.include_patch, st.ref),
        args
      );
    },
  });

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
            // Stays .optional() at the schema level on purpose: a hard-required
            // field would reject the whole submit and funnel a valid review into
            // the failed-submit loop. The MUST lives in the prompts.
            suggestion: z
              .string()
              .optional()
              .describe(
                "REQUIRED: the fix as an AS-IS / TO-BE pair — AS-IS: fenced block with the current problematic code, TO-BE: fenced block with the corrected code"
              ),
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
    if (action?.kind === "finalized") {
      // The watchdog finalized outside f_review_submit, so no normal tool
      // after-hook exists to close Moebius correlation state.
      moebiusReviewerTerminal(sessionID, action.text);
    }
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
    (cfg.command ??= {})[REVIEW_COMMAND_NAME] ??= {
      description: REVIEW_COMMAND_DESCRIPTION,
      template: REVIEW_COMMAND_TEMPLATE,
    };
  };

  return {
    tools: {
      f_review_plan,
      f_review_context,
      file_read,
      file_read_diff,
      file_find,
      code_search,
      related_code,
      git_history,
      f_review_submit,
      f_review_finalize,
      f_review_judge_context,
      f_review_judge,
    },
    systemTransform,
    event,
    config,
  };
}
