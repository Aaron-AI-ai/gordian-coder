/**
 * k-codereview wiring for the OpenCode plugin.
 *
 * Exposes the review tools and one system-prompt injection hook:
 *   - k_review_context : collect targets + rubric + diff snapshot, seed state
 *   - file_read        : read a file's after-version (line range, numbered)
 *   - file_read_diff   : read the diff of other changed files
 *   - file_find        : find files by filename substring
 *   - code_search      : git grep the codebase (regex / pathspec)
 *   - k_review_submit  : declare done for a file → coverage gate → advance/finish
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
  startReview,
  submitReview,
  guardExploration,
  reviewPromptFor,
  languageInstructionFor,
  NO_ACTIVE_REVIEW,
} from "../../../core/review";

const z = tool.schema;

export function createReviewModule(input: PluginInput): {
  tools: Record<string, ReturnType<typeof tool>>;
  systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]>;
} {
  const cwd = input.directory;

  const k_review_context = tool({
    description:
      "Start a code review. Collects target files from a git commit/range, explicit files, and/or a package path (minus excludes), loads the rubric, and seeds the review loop. All inputs optional; with none, reviews the latest commit.",
    args: {
      commit: z.string().optional().describe('Single ref ("HEAD","<sha>") or range ("A..B")'),
      from: z.string().optional().describe("Range start (used with `to`)"),
      to: z.string().optional().describe("Range end (defaults HEAD)"),
      files: z.array(z.string()).optional().describe("Explicit file paths"),
      package: z.string().optional().describe("Directory/package path to scan"),
      exclude: z.array(z.string()).optional().describe("Glob patterns to exclude"),
      output: z.string().optional().describe("Report output file or directory"),
      failOn: z
        .enum(SEVERITIES)
        .optional()
        .describe("CI gate: verdict is FAIL when any finding is at/above this severity"),
      requirementBackground: z.string().optional(),
      planGuidance: z.string().optional(),
      language: z.string().optional().describe('Findings/report language (default "ko")'),
    },
    async execute(args, ctx) {
      return startReview(args, cwd, ctx.sessionID);
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
      return guardExploration(st, fileReadDiff(st.diffMap, args.path_array));
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
      return guardExploration(st, fileFind(st.cwd, st.ref, args.query_name, args.case_sensitive));
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

  const k_review_submit = tool({
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

  return {
    tools: {
      k_review_context,
      file_read,
      file_read_diff,
      file_find,
      code_search,
      k_review_submit,
    },
    systemTransform,
  };
}
