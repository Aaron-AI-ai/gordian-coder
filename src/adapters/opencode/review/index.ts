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
} from "../../../core/review";
import {
  REVIEWER_AGENT_NAME,
  REVIEWER_AGENT_DESCRIPTION,
  REVIEWER_AGENT_PROMPT,
  REVIEWER_AGENT_TOOLS,
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
    },
    async execute(args) {
      return planReview(args, cwd);
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
      return guardExploration(
        st,
        "file_read",
        fileRead(st.cwd, st.ref, args.file_path, args.start_line, args.end_line)
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
      return guardExploration(st, "file_read_diff", fileReadDiff(st.diffMap, args.path_array));
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
        fileFind(st.cwd, st.ref, args.query_name, args.case_sensitive)
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
        )
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
        )
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
        gitHistory(st.cwd, file, args.max_commits, args.include_patch, st.ref)
      );
    },
  });

  const f_review_submit = tool({
    description:
      "Declare the current file reviewed. Provide `assessed` (every rubric category you evaluated) and `findings` (issues, may be empty). Coverage is gated: if a category is unassessed, you must continue.",
    args: {
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
            suggestion: z
              .string()
              .optional()
              .describe("Concrete fix (code or steps), when you can offer one"),
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
    // "finalized": partial report already written; nothing to re-drive.
  };

  // Register the f-reviewer agent and /f-review command from the bundle.
  // `??=` keeps any project/global md definition of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    (cfg.agent ??= {})[REVIEWER_AGENT_NAME] ??= {
      mode: "subagent",
      description: REVIEWER_AGENT_DESCRIPTION,
      prompt: REVIEWER_AGENT_PROMPT,
      tools: REVIEWER_AGENT_TOOLS,
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
    },
    systemTransform,
    event,
    config,
  };
}
