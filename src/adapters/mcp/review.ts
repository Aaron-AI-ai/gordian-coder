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
  REVIEW_TOOLS,
  runReviewTool,
  startReview,
  submitReview,
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
          "Review rounds per file/segment (1-5; default from project config `deepPasses`, else 1)",
      },
    },
    execute: async (params) => {
      const msg = await startReview(params as StartReviewArgs, cwd, SESSION);
      return ok(msg + promptBlock());
    },
  };

  // Every exploration tool comes from the core table (core/review/tools):
  // one name, description, and body per tool, rendered here into MCP's schema.
  const explorationTools: ToolDefinition[] = REVIEW_TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: Object.fromEntries(
      Object.entries(spec.args).map(([name, arg]) => [
        name,
        { type: arg.type, description: arg.description, ...(arg.required ? { required: true } : {}) },
      ])
    ),
    execute: async (params) => ok(runReviewTool(getState(SESSION), spec.name, params)),
  }));

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
    ...explorationTools,
    f_review_submit,
  ];
}
