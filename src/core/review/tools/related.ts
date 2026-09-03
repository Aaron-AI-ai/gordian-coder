/**
 * The `related_code` and `git_history` tools.
 *
 * Both answer "what else should I look at?" deterministically, for models that
 * are unreliable at deciding which tools to call: related_code ranks nearby
 * files by import edges, reverse symbol references, test naming, and
 * co-change; git_history summarizes recent commits touching the file.
 *
 * The dossier (evidence/dossier.ts) calls these directly so a reviewer starts
 * with the answer instead of spending turns discovering it.
 */

import { extname, posix } from "node:path";
import { codeSearch, capText, isGitRepo, listFilesAt, readFileAt, sh } from "./read";
import {
  importBindings,
  importSpecifiers,
  isSourceFile,
  normalizeRepoPath,
  resolveImport,
  usedCalls,
} from "../imports";

const RELATED_MAX = 12;

const HISTORY_MAX = 10;

const PREVIEW_FILES = 3;

const PREVIEW_LINES = 24;

const PREVIEW_CHARS = 1_600;

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

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value!)));
}

function summarizePaths(paths: string[], max = 12): string {
  if (!paths.length) return "none";
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, … and ${paths.length - max} more` : shown;
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

export function preview(cwd: string, ref: string | null, path: string): string {
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
  for (const specifier of importSpecifiers(content, normalized)) {
    // Which imported names the file actually calls (bounded — it is prompt text).
    const uses = (bindings.get(specifier) ?? []).flatMap((n) => usedCalls(content, n)).slice(0, 6);
    const detail = uses.length ? ` (uses: ${uses.join(", ")})` : "";
    for (const path of resolveImport(cwd, ref, specifier, normalized, all)) {
      add(path, 100, `direct import: ${specifier}${detail}`);
    }
  }

  for (const symbol of declaredSymbols(content).slice(0, 4)) {
    const result = codeSearch(cwd, ref, symbol, [], true, false);
    for (const path of pathsFromCodeSearch(result)) {
      // Source only: this project's own review artifacts (fcq/f-review/runs/…)
      // embed the reviewed class name, and matching them made a run's previous
      // review outrank real callers as "related code".
      const normalized = normalizeRepoPath(path);
      if (!isSourceFile(normalized)) continue;
      add(normalized, 65, `references symbol: ${symbol}`);
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
/** Render a ranked candidate list. Separate from discovery so the evidence
 * build can reuse its ranking instead of computing it twice. */
export function renderRelatedList(
  cwd: string,
  ref: string | null,
  file: string,
  related: RelatedFile[],
  includePreview: boolean
): string {
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

export function renderRelatedCode(
  cwd: string,
  ref: string | null,
  file: string,
  maxResults: number = RELATED_MAX,
  includePreview = true
): string {
  return renderRelatedList(
    cwd,
    ref,
    file,
    discoverRelatedFiles(cwd, ref, file, maxResults),
    includePreview
  );
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
