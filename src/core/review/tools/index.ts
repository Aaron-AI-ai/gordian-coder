/**
 * The exploration tools, declared once for every adapter.
 *
 * MCP and OpenCode describe tools in different type systems, so both used to
 * carry their own copy of each name, description, argument list, and body.
 * The copies drifted: MCP's `file_read` lost the hunk-header hint that tells a
 * reviewer to target `start = m-50` — which is the whole reason `read.ts`
 * clamps a non-positive start line.
 *
 * A tool description is the model's only instruction for using it, so a
 * divergence here is a behavior difference between platforms, not a cosmetic
 * one. This table is the single source; an adapter renders `args` into its own
 * schema format and calls `runReviewTool` for the body.
 *
 * This is the binding layer, so unlike read.ts and related.ts it knows about
 * session state: it resolves the active review, applies the exploration guard,
 * and defaults a file argument to the file under review.
 */

import {
  NO_ACTIVE_REVIEW,
  guardExploration,
  ruleFileContent,
} from "../pipeline/loop";
import { currentFilePath, type ReviewState } from "../pipeline/state";
import { codeSearch, fileFind, fileRead, fileReadDiff } from "./read";
import { gitHistory, renderRelatedCode } from "./related";

/** One argument, in the least-common-denominator shape both adapters render.
 * Bounds are advisory for MCP (its schema has none) and enforced by zod. */
export interface ToolArg {
  type: "string" | "number" | "boolean" | "array";
  description: string;
  required?: boolean;
  /** Numbers: inclusive bounds. Leave `min` unset where a non-positive value
   * is legal — `file_read`'s start_line takes the `m-50` the description asks
   * for and lets read.ts clamp it, so bounding it here would reject the
   * documented usage. Required strings and arrays are always non-empty. */
  min?: number;
  max?: number;
}

export interface ReviewToolSpec {
  name: string;
  description: string;
  args: Record<string, ToolArg>;
  /** Body, run with an active review. Returning null means "no file to act
   * on" — reported to the model without spending exploration budget. */
  run(st: ReviewState, a: Record<string, unknown>): string | null;
}

const str = (a: Record<string, unknown>, k: string) => a[k] as string | undefined;
const num = (a: Record<string, unknown>, k: string) => a[k] as number | undefined;
const bool = (a: Record<string, unknown>, k: string) => a[k] as boolean | undefined;

const PATH_DEFAULTS_TO_CURRENT = "Relative path (defaults to the file currently under review)";

export const REVIEW_TOOLS: ReviewToolSpec[] = [
  {
    name: "file_read",
    description:
      "Read the after-version of a file under review (optionally a line range). Output is line-numbered for precise comments; capped at 500 lines. Use hunk headers @@ -x,y +m,n @@ to target start=m-50, end=m+n+50.",
    args: {
      file_path: { type: "string", description: "Relative path of the file to read", required: true },
      start_line: { type: "number", description: "Start line (default 1; clamped to >=1)" },
      end_line: { type: "number", description: "End line (default EOF)", min: 1 },
    },
    // Reference-mode rule files are served from state: they live in the working
    // tree, which the ref-scoped fileRead may not see.
    run: (st, a) =>
      ruleFileContent(st, str(a, "file_path")!, num(a, "start_line"), num(a, "end_line")) ??
      fileRead(st.cwd, st.ref, str(a, "file_path")!, num(a, "start_line"), num(a, "end_line")),
  },
  {
    name: "file_read_diff",
    description:
      "Read the diff of other changed files in this review (from the pre-parsed snapshot). Paths not in the change set are skipped.",
    args: {
      path_array: { type: "array", description: "File paths whose diff to read", required: true },
    },
    run: (st, a) => fileReadDiff(st.diffMap, (a.path_array as string[]) ?? []),
  },
  {
    name: "file_find",
    description:
      "Find files by filename substring (not glob/regex; matches basename only). Use to locate files outside the change set.",
    args: {
      query_name: { type: "string", description: "Filename keyword (substring)", required: true },
      case_sensitive: { type: "boolean", description: "Case-sensitive match (default false)" },
    },
    run: (st, a) => fileFind(st.cwd, st.ref, str(a, "query_name")!, bool(a, "case_sensitive")),
  },
  {
    name: "code_search",
    description:
      "Search the codebase with git grep. Find symbols, call sites, patterns. Capped at 100 matches, grouped by file.",
    args: {
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
    run: (st, a) =>
      codeSearch(
        st.cwd,
        st.ref,
        str(a, "search_text")!,
        (a.file_patterns as string[]) ?? [],
        bool(a, "case_sensitive"),
        bool(a, "use_perl_regexp")
      ),
  },
  {
    name: "related_code",
    description:
      "Find code related to the current review file using imports, symbol usages, likely tests, and git co-change history. Results are ranked and can include bounded source previews.",
    args: {
      file_path: { type: "string", description: PATH_DEFAULTS_TO_CURRENT },
      max_results: { type: "number", description: "Maximum candidates (default 12, max 30)", min: 1, max: 30 },
      include_preview: {
        type: "boolean",
        description: "Include first lines of top candidates (default true)",
      },
    },
    run: (st, a) => {
      const file = str(a, "file_path") ?? currentFilePath(st);
      if (!file) return null;
      return renderRelatedCode(
        st.cwd,
        st.ref,
        file,
        num(a, "max_results"),
        bool(a, "include_preview") ?? true
      );
    },
  },
  {
    name: "git_history",
    description:
      "Inspect recent git history for a review file, including commit intent and files changed together. Enable include_patch for historical diffs when checking regressions.",
    args: {
      file_path: { type: "string", description: PATH_DEFAULTS_TO_CURRENT },
      max_commits: { type: "number", description: "Recent commits (default 5, max 10)", min: 1, max: 10 },
      include_patch: {
        type: "boolean",
        description: "Include bounded historical patches (default false)",
      },
    },
    run: (st, a) => {
      const file = str(a, "file_path") ?? currentFilePath(st);
      if (!file) return null;
      return gitHistory(st.cwd, file, num(a, "max_commits"), bool(a, "include_patch") ?? false, st.ref);
    },
  },
];

const BY_NAME = new Map(REVIEW_TOOLS.map((t) => [t.name, t]));

/**
 * Run one exploration tool for an adapter: resolve the active review, run the
 * body, and count the call against the exploration budget.
 *
 * `st` is passed in rather than looked up because each adapter keys state
 * differently (MCP has one fixed session; OpenCode has one per sessionID).
 */
export function runReviewTool(
  st: ReviewState | undefined,
  name: string,
  args: Record<string, unknown>
): string {
  if (!st?.active) return NO_ACTIVE_REVIEW;
  const spec = BY_NAME.get(name);
  if (!spec) return `Unknown review tool: ${name}`;
  const out = spec.run(st, args);
  // A missing target is not exploration — don't charge it to the budget.
  if (out === null) return "No current file under review.";
  return guardExploration(st, name, out, args);
}
