/**
 * The analyst's seven tools. Five wrap the same read.ts/related.ts functions
 * f-review uses (working tree, ref = null); two are new: callers of a method
 * (a grep approximation of a call graph) and line-level blame (Sentry/Datadog
 * style suspect commit). Every call passes the shared guard under the run id.
 */
import { guardExploration } from "../guard";
import type { ToolArg } from "../review/tools/index";
import { codeSearch, fileFind, fileRead, GREP_MAX_COUNT, isGitRepo, sh } from "../review/tools/read";
import { gitHistory, renderRelatedCode } from "../review/tools/related";
import type { LogSession } from "./state";

export interface LogToolSpec {
  name: string;
  description: string;
  args: Record<string, ToolArg>;
  run(st: LogSession, a: Record<string, unknown>): string;
}

export const NO_ACTIVE_LOG = "No active log analysis. Call f_log_context first.";
const CALLERS_MAX = 50;

const str = (a: Record<string, unknown>, k: string) => a[k] as string | undefined;
const num = (a: Record<string, unknown>, k: string) => a[k] as number | undefined;
const bool = (a: Record<string, unknown>, k: string) => a[k] as boolean | undefined;

/** `.method(` call sites as `path:line: text`, capped. Declarations are
 * excluded by requiring a preceding `.` — `void save(` never matches. */
export function findCallers(cwd: string, method: string, maxResults = CALLERS_MAX): string {
  if (!isGitRepo(cwd)) return "No callers found: not a git repository.";
  const r = sh(["git", "grep", "-n", "-E", "--", `\\.${method}\\(`, "*.java", "*.kt"], cwd);
  const lines = r.stdout.split("\n").filter(Boolean);
  if (!lines.length) return `No callers found for .${method}(`;
  const shown = lines.slice(0, maxResults);
  return [
    `Callers of .${method}( — ${lines.length} site(s)${lines.length > maxResults ? `, showing ${maxResults}` : ""}:`,
    ...shown.map((l) => `  ${l.replace(/\\/g, "/")}`),
  ].join("\n");
}

/** Last commit touching `file:line` plus that line's recent history. */
export function gitBlame(cwd: string, file: string, line: number): string {
  if (!isGitRepo(cwd)) return "No blame available: not a git repository.";
  const blame = sh(["git", "blame", "-L", `${line},${line}`, "--porcelain", "--", file], cwd);
  if (blame.code !== 0 || !blame.stdout.trim()) return `No blame available for ${file}:${line}`;
  const sha = blame.stdout.split("\n")[0]?.split(" ")[0] ?? "";
  const author = /^author (.*)$/m.exec(blame.stdout)?.[1] ?? "?";
  const summary = /^summary (.*)$/m.exec(blame.stdout)?.[1] ?? "?";
  const when = /^author-time (\d+)$/m.exec(blame.stdout)?.[1];
  const date = when ? new Date(Number(when) * 1000).toISOString().slice(0, 10) : "?";
  const log = sh(["git", "log", "-L", `${line},${line}:${file}`, "-n", "3", "--format=%h %ad %an %s", "--date=short", "--no-patch"], cwd);
  return [
    `Blame ${file}:${line} → ${sha.slice(0, 8)} ${date} ${author}: ${summary}`,
    "Line history (newest first):",
    ...(log.stdout.split("\n").filter(Boolean).map((l) => `  ${l}`) || ["  (none)"]),
  ].join("\n");
}

export const LOG_TOOLS: LogToolSpec[] = [
  {
    name: "f_log_read",
    description: "Read a repository file (numbered lines). Use start_line/end_line around a suspect frame; whole-file reads are capped.",
    args: {
      file_path: { type: "string", description: "Repository-relative path", required: true },
      start_line: { type: "number", description: "First line (1-based); default 1" },
      end_line: { type: "number", description: "Last line inclusive; default start+500" },
    },
    run: (st, a) => fileRead(st.cwd, null, str(a, "file_path")!, num(a, "start_line") ?? 1, num(a, "end_line")),
  },
  {
    name: "f_log_find",
    description: "Find files whose name contains the query (e.g. SONAQ001Service, AccountMapper.xml).",
    args: { query_name: { type: "string", description: "Filename substring", required: true }, case_sensitive: { type: "boolean", description: "Default false" } },
    run: (st, a) => fileFind(st.cwd, null, str(a, "query_name")!, bool(a, "case_sensitive") ?? false),
  },
  {
    name: "f_log_search",
    description: `git grep the working tree (max ${GREP_MAX_COUNT} hits). Use for error codes (create("1001"), mapper ids (id="selectAccount"), URIs, config keys.`,
    args: {
      search_text: { type: "string", description: "Text or regex", required: true },
      file_patterns: { type: "array", description: 'Pathspecs, e.g. ["*.java"], ["*.xml"], ["*.yml"]' },
      case_sensitive: { type: "boolean", description: "Default false" },
      use_perl_regexp: { type: "boolean", description: "Default false" },
    },
    run: (st, a) =>
      codeSearch(st.cwd, null, str(a, "search_text")!, (a.file_patterns as string[] | undefined) ?? [], bool(a, "case_sensitive") ?? false, bool(a, "use_perl_regexp") ?? false),
  },
  {
    name: "f_log_related",
    description: "Rank files related to one file: its imports, importers, tests and co-changed files, with previews.",
    args: { file_path: { type: "string", description: "Repository-relative path", required: true }, max_results: { type: "number", description: "Default 10", min: 1, max: 30 } },
    run: (st, a) => renderRelatedCode(st.cwd, null, str(a, "file_path")!, num(a, "max_results") ?? 10, true),
  },
  {
    name: "f_log_history",
    description: "Recent commits touching a file (file-level). For a single line use f_log_blame.",
    args: { file_path: { type: "string", description: "Repository-relative path", required: true }, max_commits: { type: "number", description: "Default 5", min: 1, max: 20 }, include_patch: { type: "boolean", description: "Default false" } },
    run: (st, a) => gitHistory(st.cwd, str(a, "file_path")!, num(a, "max_commits") ?? 5, bool(a, "include_patch") ?? false, null),
  },
  {
    name: "f_log_callers",
    description: `Call sites of .method( across *.java (max ${CALLERS_MAX}). Walk UP the call chain from the exception site — the fault is often in a caller, not where it was thrown.`,
    args: { method: { type: "string", description: "Method name without parentheses", required: true }, max_results: { type: "number", description: `Default ${CALLERS_MAX}`, min: 1, max: 200 } },
    run: (st, a) => findCallers(st.cwd, str(a, "method")!, num(a, "max_results") ?? CALLERS_MAX),
  },
  {
    name: "f_log_blame",
    description: "Who last changed this exact line, when, in which commit — and the line's last 3 changes. Use on the cause line to find the suspect commit.",
    args: { file_path: { type: "string", description: "Repository-relative path", required: true }, line: { type: "number", description: "1-based line", required: true, min: 1 } },
    run: (st, a) => gitBlame(st.cwd, str(a, "file_path")!, num(a, "line")!),
  },
];

export const LOG_EXPLORERS: ReadonlySet<string> = new Set(LOG_TOOLS.map((t) => t.name));
const BY_NAME = new Map(LOG_TOOLS.map((t) => [t.name, t]));

/** The f-log guard: scope = runId, productive next move = f_log_submit. */
export function logGuard(st: LogSession, tool: string, out: string, args?: unknown): string {
  return guardExploration(st, st.runId, tool, out, args, "f_log_submit");
}

export function runLogTool(st: LogSession | undefined, name: string, args: Record<string, unknown>): string {
  if (!st?.active) return NO_ACTIVE_LOG;
  const spec = BY_NAME.get(name);
  if (!spec) return `Unknown f-log tool: ${name}`;
  return logGuard(st, name, spec.run(st, args), args);
}
