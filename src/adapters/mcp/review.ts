/**
 * f-review tools for the MCP adapter (Claude Code / Cline).
 *
 * Same core loop as the OpenCode plugin, adapted to MCP's constraints:
 * MCP servers cannot inject system prompts, so the per-file review prompt is
 * appended to the f_review_context / f_review_submit tool results instead.
 * A stdio MCP server serves one client, so a single fixed session id is used.
 */

import type { ToolDefinition, ToolResult } from "../../core/types";
import {
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
  NO_ACTIVE_REVIEW,
  ruleFileContent,
  type StartReviewArgs,
} from "../../core/review";

const SESSION = "mcp"; // ponytail: stdio server = one client = one session

function ok(text: string): ToolResult {
  return { success: true, data: text };
}

/** The review prompt block appended to results (MCP has no system-prompt hook). */
function promptBlock(): string {
  const st = getState(SESSION);
  if (!st?.active) return "";
  const prompt = reviewPromptFor(st);
  if (!prompt) return "";
  return [
    "",
    "───── REVIEW PROMPT (follow these instructions for the current file) ─────",
    prompt,
    languageInstructionFor(st),
  ].join("\n");
}

export function createReviewTools(cwd: string = process.cwd()): ToolDefinition[] {
  const f_review_context: ToolDefinition = {
    name: "f_review_context",
    description:
      "Start a code review. Collects target files from a git commit/range and/or explicit files (minus excludes), loads the rubric, and seeds the review loop. All inputs optional; with none, reviews the latest commit. The result includes the review instructions for the first file.",
    parameters: {
      commit: { type: "string", description: 'Single ref ("HEAD","<sha>") or range ("A..B")' },
      from: { type: "string", description: "Range start (used with `to`)" },
      to: { type: "string", description: "Range end (defaults HEAD)" },
      files: { type: "array", description: "Explicit file paths" },
      whole: {
        type: "boolean",
        description:
          "Review full file content instead of the diff; files over ~1000 lines are split into overlapping segments, each reviewed with its referenced same-file declarations. Defaults to true for files-only reviews (no commit).",
      },
      exclude: { type: "array", description: "Glob patterns to exclude" },
      output: { type: "string", description: "Report output file or directory" },
      failOn: {
        type: "string",
        description:
          "CI gate: verdict is FAIL when any finding is at/above this severity (blocker|major|minor|nit)",
      },
      requirementBackground: { type: "string", description: "Why this change was made" },
      planGuidance: { type: "string", description: "Focus areas for the review" },
      language: { type: "string", description: 'Findings/report language (default "ko")' },
      deepPasses: {
        type: "number",
        description:
          "Review rounds per file/segment (1-5; default from .f-review.json `deepPasses`, else 1)",
      },
    },
    execute: async (params) => {
      const msg = await startReview(params as StartReviewArgs, cwd, SESSION);
      return ok(msg + promptBlock());
    },
  };

  const file_read: ToolDefinition = {
    name: "file_read",
    description:
      "Read the after-version of a file under review (optionally a line range). Line-numbered; capped at 500 lines.",
    parameters: {
      file_path: { type: "string", description: "Relative path of the file to read", required: true },
      start_line: { type: "number", description: "Start line (default 1; clamped to >=1)" },
      end_line: { type: "number", description: "End line (default EOF)" },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      // Reference-mode rule files are served from state: they live in the
      // working tree, which the ref-scoped fileRead may not see.
      return ok(
        guardExploration(
          st,
          "file_read",
          ruleFileContent(
            st,
            params.file_path as string,
            params.start_line as number | undefined,
            params.end_line as number | undefined
          ) ??
            fileRead(
              st.cwd,
              st.ref,
              params.file_path as string,
              params.start_line as number | undefined,
              params.end_line as number | undefined
            ),
          params
        )
      );
    },
  };

  const file_read_diff: ToolDefinition = {
    name: "file_read_diff",
    description:
      "Read the diff of other changed files in this review (from the pre-parsed snapshot).",
    parameters: {
      path_array: { type: "array", description: "File paths whose diff to read", required: true },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      return ok(
        guardExploration(st, "file_read_diff", fileReadDiff(st.diffMap, (params.path_array as string[]) ?? []), params)
      );
    },
  };

  const file_find: ToolDefinition = {
    name: "file_find",
    description: "Find files by filename substring (matches basename only).",
    parameters: {
      query_name: { type: "string", description: "Filename keyword (substring)", required: true },
      case_sensitive: { type: "boolean", description: "Case-sensitive match (default false)" },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      return ok(
        guardExploration(
          st,
          "file_find",
          fileFind(st.cwd, st.ref, params.query_name as string, params.case_sensitive as boolean),
          params
        )
      );
    },
  };

  const code_search: ToolDefinition = {
    name: "code_search",
    description:
      "Search the codebase with git grep. Capped at 100 matches, grouped by file.",
    parameters: {
      search_text: { type: "string", description: "Search string or regex", required: true },
      file_patterns: {
        type: "array",
        description: "git pathspec, e.g. ['*.ts', ':(exclude)*.test.ts']",
      },
      case_sensitive: { type: "boolean", description: "Case-sensitive (default false)" },
      use_perl_regexp: {
        type: "boolean",
        description: "true = Perl regex (-P), false = literal (-F, default)",
      },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      return ok(
        guardExploration(
          st,
          "code_search",
          codeSearch(
            st.cwd,
            st.ref,
            params.search_text as string,
            (params.file_patterns as string[]) ?? [],
            params.case_sensitive as boolean,
            params.use_perl_regexp as boolean
          ),
          params
        )
      );
    },
  };

  const related_code: ToolDefinition = {
    name: "related_code",
    description:
      "Find code related to the current review file using imports, symbol usages, likely tests, and git co-change history. Ranked results can include bounded previews.",
    parameters: {
      file_path: {
        type: "string",
        description: "Relative path (defaults to the file currently under review)",
      },
      max_results: { type: "number", description: "Maximum candidates (default 12, max 30)" },
      include_preview: {
        type: "boolean",
        description: "Include first lines of top candidates (default true)",
      },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      const file = (params.file_path as string | undefined) ?? currentFilePath(st);
      if (!file) return ok("No current file under review.");
      return ok(
        guardExploration(
          st,
          "related_code",
          renderRelatedCode(
            st.cwd,
            st.ref,
            file,
            params.max_results as number | undefined,
            (params.include_preview as boolean | undefined) ?? true
          ),
          params
        )
      );
    },
  };

  const git_history: ToolDefinition = {
    name: "git_history",
    description:
      "Inspect recent git history for a review file, including commit intent and files changed together. Can include bounded historical patches.",
    parameters: {
      file_path: {
        type: "string",
        description: "Relative path (defaults to the file currently under review)",
      },
      max_commits: { type: "number", description: "Recent commits (default 5, max 10)" },
      include_patch: { type: "boolean", description: "Include historical patches" },
    },
    execute: async (params) => {
      const st = getState(SESSION);
      if (!st?.active) return ok(NO_ACTIVE_REVIEW);
      const file = (params.file_path as string | undefined) ?? currentFilePath(st);
      if (!file) return ok("No current file under review.");
      return ok(
        guardExploration(
          st,
          "git_history",
          gitHistory(
            st.cwd,
            file,
            params.max_commits as number | undefined,
            (params.include_patch as boolean | undefined) ?? false,
            st.ref
          ),
          params
        )
      );
    },
  };

  const f_review_submit: ToolDefinition = {
    name: "f_review_submit",
    description:
      "Declare the current file reviewed. Copy CURRENT_SUBMIT_TOKEN from the latest prompt, then provide assessed/findings. Token identity and coverage are gated; the result includes next-file instructions.",
    parameters: {
      submitToken: {
        type: "string",
        description: "Exact CURRENT_SUBMIT_TOKEN from the latest review prompt",
        required: true,
      },
      assessed: { type: "array", description: "Categories actually evaluated", required: true },
      findings: { type: "array", description: "Issues found (may be empty)", required: true },
    },
    execute: async (params) => {
      const msg = await submitReview(params, SESSION);
      return ok(msg + promptBlock());
    },
  };

  return [
    f_review_context,
    file_read,
    file_read_diff,
    file_find,
    code_search,
    related_code,
    git_history,
    f_review_submit,
  ];
}
