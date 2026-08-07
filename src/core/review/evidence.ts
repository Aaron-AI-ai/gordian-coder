/**
 * Deterministic review evidence for models that are less reliable at deciding
 * which tools to call. It discovers nearby code and summarizes file history
 * before the model starts reviewing a file.
 */

import { extname, posix } from "node:path";
import { codeSearch, isGitRepo, listFilesAt, readFileAt } from "./reader";

const RELATED_MAX = 12;
const HISTORY_MAX = 10;
const AUTO_EVIDENCE_MAX_CHARS = 8_000;
const PREVIEW_FILES = 3;
const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 1_600;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".go",
  ".rs",
  ".cs",
  ".rb",
] as const;

export interface RelatedFile {
  path: string;
  score: number;
  reasons: string[];
}

interface HistoryCommit {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
  changedFiles: string[];
}

function sh(cmd: string[], cwd: string): { code: number; stdout: string } {
  const p = Bun.spawnSync(cmd, { cwd, timeout: 10_000 });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value!)));
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n… (truncated)";
  return text.slice(0, maxChars - suffix.length) + suffix;
}

function summarizePaths(paths: string[], max = 12): string {
  if (!paths.length) return "none";
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, … and ${paths.length - max} more` : shown;
}

function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/").replace(/^\.\//, ""));
}

/**
 * Files touched by each of `hashes`, resolved in ONE `git show` instead of one
 * spawn per commit. The name list is deliberately NOT filtered by the pathspec
 * that selected these commits — the co-changed siblings ARE the signal.
 * `%x1e` separates commits, mirroring the log format below.
 */
function changedFilesByCommit(cwd: string, hashes: string[]): Map<string, string[]> {
  const byHash = new Map<string, string[]>();
  if (!hashes.length) return byHash;
  const out = sh(
    ["git", "-c", "core.quotepath=false", "show", "--format=%x1e%H", "--name-only", ...hashes],
    cwd
  ).stdout;
  for (const record of out.split("\x1e")) {
    const [head, ...names] = record.split("\n");
    const hash = head?.trim();
    if (!hash) continue;
    byHash.set(
      hash,
      names.map((path) => path.trim()).filter(Boolean)
    );
  }
  return byHash;
}

function historyCommits(
  cwd: string,
  file: string,
  maxCommits: number,
  ref?: string | null
): HistoryCommit[] {
  if (!isGitRepo(cwd)) return [];
  const limit = boundedInt(maxCommits, 5, HISTORY_MAX);
  const log = sh(
    [
      "git",
      "-c",
      "core.quotepath=false",
      "log",
      "--follow",
      `-n${limit}`,
      "--date=short",
      "--format=%x1e%H%x1f%h%x1f%ad%x1f%an%x1f%s",
      ref ?? "HEAD",
      "--",
      file,
    ],
    cwd
  );
  if (log.code !== 0) return [];

  const commits = log.stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record): Omit<HistoryCommit, "changedFiles">[] => {
      const [hash, shortHash, date, author, subject] = record.split("\x1f");
      if (!hash || !shortHash) return [];
      return [{ hash, shortHash, date, author, subject: subject ?? "" }];
    });

  const byHash = changedFilesByCommit(
    cwd,
    commits.map((c) => c.hash)
  );
  return commits.map((c) => ({ ...c, changedFiles: byHash.get(c.hash) ?? [] }));
}

function importSpecifiers(content: string): string[] {
  const out = new Set<string>();
  const quoted = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(quoted)) out.add(match[1]);

  const languageImport = /^\s*(?:import|from)\s+(?:static\s+)?([\w.]+)/gm;
  for (const match of content.matchAll(languageImport)) {
    // Wildcard import (`import com.shop.dto.*;`): the capture stops at `*`,
    // leaving a trailing dot. There is no class name to resolve — skip it
    // deliberately instead of stem-matching the package name ("dto").
    if (match[1].endsWith(".")) continue;
    out.add(match[1]);
  }
  return [...out];
}

/** Local names each import specifier binds: `import X, { a, b as c } from "./x"`
 * → "./x": [X, a, c]; Java `import com.foo.Bar` → "com.foo.Bar": [Bar]. */
function importBindings(content: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const js = /import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:([\w$]+)|\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(js)) {
    const names: string[] = [];
    if (m[1]) names.push(m[1]);
    if (m[2]) names.push(m[2]);
    if (m[3])
      for (const part of m[3].split(",")) {
        // local name: `b as c` → c, `type T` → T
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (n && /^[\w$]+$/.test(n)) names.push(n);
      }
    if (names.length) map.set(m[4], names);
  }
  const lang = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?\s*$/gm;
  for (const m of content.matchAll(lang)) {
    if (m[1].endsWith(".")) continue; // wildcard — see importSpecifiers
    const cls = m[1].split(".").at(-1)!;
    if (/^[A-Z]/.test(cls)) map.set(m[1], [cls]);
  }
  return map;
}

/** How `name` is used in content: direct calls `name(…)` and member calls
 * `name.method(…)` — for a class, also on its lowerCamel instance
 * (`OrderRepository` → `orderRepository.findById(…)`, the Spring bean idiom). */
function usedCalls(content: string, name: string): string[] {
  const out = new Set<string>();
  const receivers = new Set([name, name[0].toLowerCase() + name.slice(1)]);
  for (const r of receivers) {
    for (const m of content.matchAll(new RegExp(`\\b${r}\\.(\\w+)\\s*\\(`, "g"))) {
      out.add(`${r}.${m[1]}()`);
    }
  }
  if (new RegExp(`\\b${name}\\s*\\(`).test(content)) out.add(`${name}()`);
  return [...out];
}

function resolveImport(specifier: string, fromFile: string, all: Set<string>): string[] {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    const base = normalizeRepoPath(posix.join(posix.dirname(fromFile), specifier));
    candidates.push(base);
    if (!extname(base)) {
      for (const ext of SOURCE_EXTENSIONS) {
        candidates.push(`${base}${ext}`, `${base}/index${ext}`);
      }
    }
  } else {
    const simple = specifier.split(/[./]/).filter(Boolean).at(-1)?.toLowerCase();
    if (simple) {
      for (const path of all) {
        const stem = posix.basename(path, extname(path)).toLowerCase();
        if (stem === simple) candidates.push(path);
      }
    }
  }
  return [...new Set(candidates.filter((path) => all.has(path)))];
}

function declaredSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /^\s*(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1].length >= 4) symbols.add(match[1]);
      if (symbols.size >= 6) return [...symbols];
    }
  }
  return [...symbols];
}

function pathsFromCodeSearch(output: string): string[] {
  return output
    .split("\n")
    .flatMap((line) => {
      const match = /^File: (.+)$/.exec(line);
      return match ? [match[1]] : [];
    });
}

function preview(cwd: string, ref: string | null, path: string): string {
  const content = readFileAt(cwd, ref, path);
  if (content === null) return "";
  const body = content.replace(/\n$/, "").split("\n").slice(0, PREVIEW_LINES).join("\n");
  return capText(body, PREVIEW_CHARS);
}

/**
 * Rank files related to `file` using four deterministic signals:
 * direct imports, exported-symbol usages, likely tests, and git co-change.
 */
export function discoverRelatedFiles(
  cwd: string,
  ref: string | null,
  file: string,
  maxResults: number = RELATED_MAX
): RelatedFile[] {
  const normalized = normalizeRepoPath(file);
  const files = listFilesAt(cwd, ref).map(normalizeRepoPath);
  const all = new Set(files);
  const content = readFileAt(cwd, ref, normalized) ?? "";
  const scores = new Map<string, { score: number; reasons: Set<string> }>();

  const add = (path: string, score: number, reason: string): void => {
    if (path === normalized || !all.has(path)) return;
    const item = scores.get(path) ?? { score: 0, reasons: new Set<string>() };
    item.score += score;
    item.reasons.add(reason);
    scores.set(path, item);
  };

  const bindings = importBindings(content);
  for (const specifier of importSpecifiers(content)) {
    // Which imported names the file actually calls (bounded — it is prompt text).
    const uses = (bindings.get(specifier) ?? []).flatMap((n) => usedCalls(content, n)).slice(0, 6);
    const detail = uses.length ? ` (uses: ${uses.join(", ")})` : "";
    for (const path of resolveImport(specifier, normalized, all)) {
      add(path, 100, `direct import: ${specifier}${detail}`);
    }
  }

  for (const symbol of declaredSymbols(content).slice(0, 4)) {
    const result = codeSearch(cwd, ref, symbol, [], true, false);
    for (const path of pathsFromCodeSearch(result)) {
      add(normalizeRepoPath(path), 65, `references symbol: ${symbol}`);
    }
  }

  const stem = posix.basename(normalized, extname(normalized)).toLowerCase();
  for (const path of files) {
    const name = posix.basename(path).toLowerCase();
    if (
      name.includes(stem) &&
      /(?:^|[._-])(test|tests|spec)(?:[._-]|$)/.test(name.replace(stem, ""))
    ) {
      add(path, 85, "likely test for current file");
    }
  }

  const coChangeCounts = new Map<string, number>();
  for (const commit of historyCommits(cwd, normalized, 8, ref)) {
    for (const path of commit.changedFiles.map(normalizeRepoPath)) {
      if (path !== normalized) coChangeCounts.set(path, (coChangeCounts.get(path) ?? 0) + 1);
    }
  }
  for (const [path, count] of coChangeCounts) {
    add(path, Math.min(60, count * 20), `changed together in ${count} recent commit(s)`);
  }

  const limit = boundedInt(maxResults, RELATED_MAX, 30);
  return [...scores]
    .map(([path, item]) => ({ path, score: item.score, reasons: [...item.reasons] }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/** Render ranked related files, optionally including bounded source previews. */
export function renderRelatedCode(
  cwd: string,
  ref: string | null,
  file: string,
  maxResults: number = RELATED_MAX,
  includePreview = true
): string {
  const related = discoverRelatedFiles(cwd, ref, file, maxResults);
  if (!related.length) return `No related code candidates found for: ${file}`;

  const lines = [
    `Related code candidates for ${file} (ranked by deterministic evidence):`,
    ...related.map((item) => `- ${item.path} — ${item.reasons.join("; ")}`),
  ];
  if (includePreview) {
    lines.push("", "Related code preview (top candidates; first lines only):");
    for (const item of related.slice(0, PREVIEW_FILES)) {
      const body = preview(cwd, ref, item.path);
      if (body) lines.push(`--- ${item.path} ---`, body);
    }
  }
  return capText(lines.join("\n"), 6_000);
}

/** Render recent file history, co-changed files, and optional historical patches. */
export function gitHistory(
  cwd: string,
  file: string,
  maxCommits = 5,
  includePatch = false,
  ref?: string | null
): string {
  const normalized = normalizeRepoPath(file);
  const commits = historyCommits(cwd, normalized, maxCommits, ref);
  if (!commits.length) return `No git history found for: ${file}`;

  const lines: string[] = [`Recent git history for ${file}:`];
  for (const commit of commits) {
    const coChanged = commit.changedFiles.filter((path) => normalizeRepoPath(path) !== normalized);
    lines.push(
      `- ${commit.shortHash} ${commit.date} ${commit.author} — ${commit.subject}`,
      `  changed together: ${summarizePaths(coChanged)}`
    );
    if (includePatch) {
      const patch = sh(
        [
          "git",
          "-c",
          "core.quotepath=false",
          "show",
          "--format=",
          "--patch",
          "--no-ext-diff",
          commit.hash,
          "--",
          file,
        ],
        cwd
      ).stdout.trim();
      if (patch) lines.push(`  Historical patch (${commit.shortHash}):`, capText(patch, 4_000));
    }
  }
  return capText(lines.join("\n"), includePatch ? 16_000 : 5_000);
}

/** Compact dossier automatically injected for each current review file.
 *
 * Cross-file related code is surfaced as a ranked PATH LIST only (no source
 * preview): a first-lines preview usually shows a file's imports, not the
 * function the code under review actually calls. Instead the model is told to
 * grep those project files for the specific symbols it uses — a targeted
 * code_search lands the real definition, and it naturally scopes to whatever
 * segment/diff is being reviewed. */
export function buildReviewEvidence(cwd: string, ref: string | null, file: string): string {
  return capText(
    [
      "## Related code",
      renderRelatedCode(cwd, ref, file, 8, false),
      "",
      "These are project files the code under review imports / co-changes with. " +
        "For any function or symbol it calls from them, run code_search(<symbol>) or " +
        "file_read on the file above to pull the real definition — do not assume behavior.",
      "",
      "## Git history",
      gitHistory(cwd, file, 5, false, ref),
    ].join("\n"),
    AUTO_EVIDENCE_MAX_CHARS
  );
}
