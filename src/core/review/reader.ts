/**
 * Code search / read operations for the review loop, ported from the
 * file_read / file_read_diff / file_find / code_search design.
 *
 * All four ops share a "reader" parameterised by (cwd, ref):
 *   - ref === null            → workspace mode (working tree / untracked)
 *   - ref is a git ref        → ref mode (files as of that commit/range end)
 *   - cwd is not a git repo   → plain filesystem walk / grep --no-index
 *
 * Output sizes are capped (500 lines / 100 matches) to keep the prompt bounded.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

export const FILE_READ_MAX_LINES = 500;
export const GREP_MAX_COUNT = 100;
export const FILE_FIND_MAX_COUNT = 100;
const TIMEOUT_MS = 10_000;

/** Max exploration tool calls before the loop is forced to converge. */
export const MAX_ITER = 40;

// ── low-level ────────────────────────────────────────────────────

function sh(cmd: string[], cwd: string): { code: number; stdout: string } {
  const p = Bun.spawnSync(cmd, { cwd, timeout: TIMEOUT_MS });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

/** Bound output by lines and chars to keep the prompt from blowing up. */
export function cap(s: string, maxLines = FILE_READ_MAX_LINES, maxChars = 16_000): string {
  let truncated = false;
  let lines = s.split("\n");
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${out}\n… (truncated)` : out;
}

const repoCache = new Map<string, boolean>();
/** Whether cwd is inside a git work tree (memoized — invariant per directory). */
export function isGitRepo(cwd: string): boolean {
  let v = repoCache.get(cwd);
  if (v === undefined) {
    v = sh(["git", "rev-parse", "--is-inside-work-tree"], cwd).code === 0;
    repoCache.set(cwd, v);
  }
  return v;
}

/** The "after" ref to read from, derived from a diff range ("A..B" → "B").
 * Handles symmetric ("A...B") ranges and a missing end ("A.." → HEAD). */
export function afterRef(range: string | null): string | null {
  if (!range) return null;
  // Normalize "..."/".." to a single delimiter, then take the right side.
  const m = /^(.*?)\.{2,3}(.*)$/.exec(range);
  if (!m) return range; // single ref
  return m[2] || "HEAD"; // empty end (e.g. "A..") means up to HEAD
}

// ── FileReader (cwd + ref) ───────────────────────────────────────

/** Read a file's "after" content, or null when it does not exist. */
export function readFileAt(cwd: string, ref: string | null, path: string): string | null {
  if (ref) {
    const r = sh(["git", "show", `${ref}:${path}`], cwd);
    return r.code === 0 ? r.stdout : null;
  }
  const abs = join(cwd, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return readFileSync(abs, "utf8");
}

function walk(dir: string, base: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
}

/** List candidate files for the current mode. */
export function listFilesAt(cwd: string, ref: string | null): string[] {
  if (ref && isGitRepo(cwd)) {
    return sh(["git", "ls-tree", "-r", "--name-only", ref], cwd).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (isGitRepo(cwd)) {
    return sh(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const out: string[] = [];
  walk(cwd, cwd, out);
  return out;
}

/** Run `git grep` (or a non-git fallback). Returns raw stdout. */
function grepAt(
  cwd: string,
  ref: string | null,
  pattern: string,
  filePatterns: string[],
  caseSensitive: boolean,
  perl: boolean
): string {
  const flags = ["-n", "--no-color", "--max-count", String(GREP_MAX_COUNT)];
  if (!caseSensitive) flags.push("-i");
  flags.push(perl ? "-P" : "-F");

  const pathspec = filePatterns.length ? ["--", ...filePatterns] : [];

  if (isGitRepo(cwd)) {
    const args = ref
      ? ["git", "grep", ...flags, pattern, ref, ...pathspec]
      : ["git", "grep", ...flags, "--untracked", pattern, ...pathspec];
    return sh(args, cwd).stdout;
  }
  // non-git: search the plain directory
  return sh(["git", "grep", "--no-index", "--exclude-standard", ...flags, pattern, ...pathspec], cwd).stdout;
}

// ── ops: file_read ───────────────────────────────────────────────

export function fileRead(
  cwd: string,
  ref: string | null,
  file_path: string,
  start_line = 1,
  end_line?: number
): string {
  const content = readFileAt(cwd, ref, file_path);
  if (content === null) return `Error: file not found: ${file_path}`;

  // Drop a single trailing newline so a file ending in "\n" doesn't report an
  // inflated line count and a phantom blank final line.
  const lines = content.replace(/\n$/, "").split("\n");
  const total = lines.length;
  // Clamp start to >=1: the tool guidance suggests start=m-50, which is <=0
  // for hunks near the top of a file — clamp rather than reject.
  const start = Math.max(1, start_line ?? 1);
  let end = end_line ?? total;

  if (start > total) return `Error: start_line ${start} exceeds total lines ${total}`;
  if (start > end) return `Error: start_line ${start} > end_line ${end}`;
  if (end > total) end = total;

  let truncated = false;
  if (end - start + 1 > FILE_READ_MAX_LINES) {
    end = start + FILE_READ_MAX_LINES - 1;
    truncated = true;
  }

  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}|${l}`)
    .join("\n");

  const header = [
    `File: ${file_path} (Total lines: ${total})`,
    `IS_TRUNCATED: ${truncated}`,
    `LINE_RANGE: ${start}-${end}`,
  ];
  if (truncated) {
    header.push(`Note: output truncated at ${FILE_READ_MAX_LINES} lines — narrow the range.`);
  }
  return `${header.join("\n")}\n${body}`;
}

// ── ops: file_read_diff ──────────────────────────────────────────

export function fileReadDiff(
  diffMap: Record<string, string>,
  path_array: string[]
): string {
  const blocks: string[] = [];
  for (const p of path_array) {
    const diff = diffMap[p];
    if (diff) blocks.push(`==== FILE: ${p} ====\n${diff}`);
  }
  if (blocks.length === 0) {
    return `Error: diff not found for any of: ${path_array.join(", ")}`;
  }
  return cap(blocks.join("\n"));
}

// ── ops: file_find ───────────────────────────────────────────────

export function fileFind(
  cwd: string,
  ref: string | null,
  query_name: string,
  case_sensitive = false
): string {
  // No extension filtering: file_find is a filename search, so extensionless
  // files (README, CHANGELOG, Jenkinsfile, Dockerfile, …) must be findable.
  const needle = case_sensitive ? query_name : query_name.toLowerCase();
  const hits: string[] = [];
  for (const f of listFilesAt(cwd, ref)) {
    const name = case_sensitive ? basename(f) : basename(f).toLowerCase();
    if (name.includes(needle)) hits.push(f);
    if (hits.length >= FILE_FIND_MAX_COUNT) break;
  }
  if (hits.length === 0) return "// The file was not found.";
  return hits.join("\n");
}

// ── ops: code_search ─────────────────────────────────────────────

export function codeSearch(
  cwd: string,
  ref: string | null,
  search_text: string,
  file_patterns: string[] = [],
  case_sensitive = false,
  use_perl_regexp = false
): string {
  const raw = grepAt(cwd, ref, search_text, file_patterns, case_sensitive, use_perl_regexp);
  const byFile = new Map<string, string[]>();
  let total = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim() || total >= GREP_MAX_COUNT) break;
    let s = line;
    if (ref && s.startsWith(`${ref}:`)) s = s.slice(ref.length + 1);
    const m = /^(.+?):(\d+):(.*)$/.exec(s);
    if (!m) continue;
    const path = m[1].replace(/^\.\//, "");
    const arr = byFile.get(path) ?? [];
    arr.push(`${m[2]}|${m[3]}`);
    byFile.set(path, arr);
    total++;
  }

  if (total === 0) return `No matches for: ${search_text}`;

  const out: string[] = [];
  for (const [path, matches] of byFile) {
    out.push(`File: ${path}`, `Match lines: ${matches.length}`, ...matches, "");
  }
  if (total >= GREP_MAX_COUNT) {
    out.push(`Note: capped at ${GREP_MAX_COUNT} matches — narrow file_patterns.`);
  }
  return out.join("\n").trim();
}
