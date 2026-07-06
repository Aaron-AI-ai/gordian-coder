/**
 * k-codereview tools for the MCP adapter (Claude Code / Cline).
 *
 * Same core loop as the OpenCode plugin, adapted to MCP's constraints:
 * MCP servers cannot inject system prompts, so the per-file review prompt is
 * appended to the k_review_context / k_review_submit tool results instead.
 * A stdio MCP server serves one client, so a single fixed session id is used.
 */

import type { ToolDefinition, ToolResult } from "../../core/types";
import {
  getState,
  fileRead,
  fileReadDiff,
  fileFind,
  codeSearch,
  startReview,
  submitReview,
  guardExploration,
  reviewPromptFor,
  languageInstructionFor,
  NO_ACTIVE_REVIEW,
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
  const k_review_context: ToolDefinition = {
    name: "k_review_context",
    description:
      "Start a code review. Collects target files from a git commit/range, explicit files, and/or a package path (minus excludes), loads the rubric, and seeds the review loop. All inputs optional; with none, reviews the latest commit. The result includes the review instructions for the first file.",
    parameters: {
      commit: { type: "string", description: 'Single ref ("HEAD","<sha>") or range ("A..B")' },
      from: { type: "string", description: "Range start (used with `to`)" },
      to: { type: "string", description: "Range end (defaults HEAD)" },
      files: { type: "array", description: "Explicit file paths" },
      package: { type: "string", description: "Directory/package path to scan" },
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
      return ok(
        guardExploration(
          st,
          fileRead(
            st.cwd,
            st.ref,
            params.file_path as string,
            params.start_line as number | undefined,
            params.end_line as number | undefined
          )
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
      return ok(guardExploration(st, fileReadDiff(st.diffMap, (params.path_array as string[]) ?? [])));
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
          fileFind(st.cwd, st.ref, params.query_name as string, params.case_sensitive as boolean)
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
          codeSearch(
            st.cwd,
            st.ref,
            params.search_text as string,
            (params.file_patterns as string[]) ?? [],
            params.case_sensitive as boolean,
            params.use_perl_regexp as boolean
          )
        )
      );
    },
  };

  const k_review_submit: ToolDefinition = {
    name: "k_review_submit",
    description:
      "Declare the current file reviewed. Provide `assessed` (every rubric category you evaluated: security, nfr, correctness, tests, framework) and `findings` (issues with category/severity/file/line/rule/message/suggestion; may be empty). Coverage is gated. The result includes the review instructions for the next file.",
    parameters: {
      assessed: { type: "array", description: "Categories actually evaluated", required: true },
      findings: { type: "array", description: "Issues found (may be empty)", required: true },
    },
    execute: async (params) => {
      const msg = await submitReview(params, SESSION);
      return ok(msg + promptBlock());
    },
  };

  return [k_review_context, file_read, file_read_diff, file_find, code_search, k_review_submit];
}
