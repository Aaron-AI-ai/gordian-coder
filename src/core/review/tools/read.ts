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
import type { Finding } from "../contract";

export const FILE_READ_MAX_LINES = 500;
export const FILE_READ_MAX_CHARS = 16_000;
export const GREP_MAX_COUNT = 100;
export const FILE_FIND_MAX_COUNT = 100;
const TIMEOUT_MS = 10_000;

/** Max exploration tool calls before the loop is forced to converge. */
export const MAX_ITER = 20;

// ── low-level ────────────────────────────────────────────────────

/** Run a command under the shared timeout. Exported for the other repo-access
 * modules (tools/related, imports) so the timeout lives in one place. */
export function sh(cmd: string[], cwd: string): { code: number; stdout: string } {
  const p = Bun.spawnSync(cmd, { cwd, timeout: TIMEOUT_MS });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

/** Bound text to a character budget, reserving room for the marker so the
 * result never exceeds `maxChars`. `cap` below overshoots by the marker's
 * length; sections that must fit an exact budget use this one. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n… (truncated)";
  return text.slice(0, maxChars - suffix.length) + suffix;
}

/** Bound output by lines and chars to keep the prompt from blowing up. */
export function cap(
  s: string,
  maxLines = FILE_READ_MAX_LINES,
  maxChars = FILE_READ_MAX_CHARS
): string {
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

/** Total line count of a file's after-version, or null when unreadable. */
export function fileLineCount(cwd: string, ref: string | null, path: string): number | null {
  const content = readFileAt(cwd, ref, path);
  if (content === null) return null;
  return content.replace(/\n$/, "").split("\n").length;
}

/**
 * Drop hallucinated line numbers: a finding whose `line` exceeds the file's
 * actual length loses the line (the finding itself is kept — the issue may be
 * real, only its anchor is wrong). Unreadable files are left untouched.
 * Returns how many line numbers were dropped.
 */
export function sanitizeFindingLines(
  findings: Finding[],
  cwd: string,
  ref: string | null
): number {
  const totals = new Map<string, number | null>();
  let dropped = 0;
  for (const f of findings) {
    if (f.line === undefined) continue;
    if (!totals.has(f.file)) totals.set(f.file, fileLineCount(cwd, ref, f.file));
    const total = totals.get(f.file);
    if (total !== null && total !== undefined && f.line > total) {
      delete f.line;
      dropped++;
    }
  }
  return dropped;
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

/**
 * Render text that has already been loaded with the same bounded, line-numbered
 * shape as `fileRead`. Keeping this separate lets callers expose an in-memory
 * or working-tree value without accidentally bypassing the read limits.
 */
export function renderFileContent(
  filePath: string,
  content: string,
  startLine = 1,
  endLine?: number,
  maxLines = FILE_READ_MAX_LINES,
  maxChars = FILE_READ_MAX_CHARS
): string {
  // Drop a single trailing newline so a file ending in "\n" doesn't report an
  // inflated line count and a phantom blank final line.
  const lines = content.replace(/\n$/, "").split("\n");
  const total = lines.length;
  // The tool guidance suggests start=m-50, which is <=0 for hunks near the top
  // of a file. Clamp rather than reject that useful request.
  const start = Math.max(1, startLine ?? 1);
  let end = endLine ?? total;

  if (start > total) return `Error: start_line ${start} exceeds total lines ${total}`;
  if (start > end) return `Error: start_line ${start} > end_line ${end}`;
  if (end > total) end = total;

  let lineTruncated = false;
  if (end - start + 1 > maxLines) {
    end = start + maxLines - 1;
    lineTruncated = true;
  }

  const body = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}|${line}`)
    .join("\n");

  const render = (truncated: boolean): string => {
    const header = [
      `File: ${filePath} (Total lines: ${total})`,
      `IS_TRUNCATED: ${truncated}`,
      `LINE_RANGE: ${start}-${end}`,
    ];
    if (truncated) {
      const limit = Number.isFinite(maxChars)
        ? `${maxLines} lines / ${maxChars} characters`
        : `${maxLines} lines`;
      header.push(`Note: output truncated at ${limit} — narrow the range.`);
    }
    return `${header.join("\n")}\n${body}`;
  };

  let output = render(lineTruncated);
  if (output.length <= maxChars) return output;

  output = render(true);
  const suffix = "\n… (truncated)";
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars);
  return `${output.slice(0, maxChars - suffix.length)}${suffix}`;
}

export function fileRead(
  cwd: string,
  ref: string | null,
  file_path: string,
  start_line = 1,
  end_line?: number,
  maxLines = FILE_READ_MAX_LINES
): string {
  const content = readFileAt(cwd, ref, file_path);
  if (content === null)
    return (
      `Error: file not found: ${file_path}. It is not in this repository at the reviewed ref — ` +
      `do NOT retry path variations. If it belongs to an external library or framework, ` +
      `rely on the injected evidence and move on.`
    );

  // Preserve the existing reader contract: callers such as the judge choose a
  // larger line window and reason about the exact visible line range. The
  // exported helper's default character cap is for already-loaded prompt text.
  return renderFileContent(file_path, content, start_line, end_line, maxLines, Infinity);
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
  if (hits.length === 0)
    return (
      `// No file matches "${query_name}" in this repository. Do NOT retry variations of ` +
      `this name — an external library/framework file cannot be found here; move on.`
    );
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

  if (total === 0)
    return (
      `No matches for: ${search_text}. The symbol is not in this repository at the reviewed ` +
      `ref (it may come from an external dependency). Do NOT repeat this search or minor ` +
      `variations of it — continue the review with what you have.`
    );

  const out: string[] = [];
  for (const [path, matches] of byFile) {
    out.push(`File: ${path}`, `Match lines: ${matches.length}`, ...matches, "");
  }
  if (total >= GREP_MAX_COUNT) {
    out.push(`Note: capped at ${GREP_MAX_COUNT} matches — narrow file_patterns.`);
  }
  return out.join("\n").trim();
}
