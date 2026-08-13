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
  ".d.ts",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the JSON-with-comments/trailing-commas commonly used by tsconfig. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  let withoutComments = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
    } else if (char === "/" && next === "/") {
      while (i + 1 < content.length && content[i + 1] !== "\n") i++;
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        if (content[i] === "\n") withoutComments += "\n";
        i++;
      }
      i++;
    } else {
      withoutComments += char;
    }
  }

  let normalized = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === ",") {
      let lookahead = i + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead++;
      if (withoutComments[lookahead] === "}" || withoutComments[lookahead] === "]") continue;
    }
    normalized += char;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonObject(
  cwd: string,
  ref: string | null,
  path: string
): Record<string, unknown> | null {
  const content = readFileAt(cwd, ref, path);
  return content === null ? null : parseJsonObject(content);
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

function importSpecifiers(content: string, file: string): string[] {
  const out = new Set<string>();
  const quoted = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(quoted)) out.add(match[1]);

  const extension = extname(file).toLowerCase();
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) {
    const sideEffectImport = /^\s*import\s*["']([^"']+)["']/gm;
    for (const match of content.matchAll(sideEffectImport)) out.add(match[1]);
  } else if (extension === ".py") {
    const pythonImport = /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([.\w]+))/gm;
    for (const match of content.matchAll(pythonImport)) {
      const specifier = match[1] ?? match[2];
      if (specifier && !/^\.+$/.test(specifier)) out.add(specifier);
    }
  } else if ([".java", ".kt", ".kts"].includes(extension)) {
    const languageImport = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?\s*$/gm;
    for (const match of content.matchAll(languageImport)) {
      if (!match[0].includes(".*")) out.add(match[1]);
    }
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

function moduleCandidates(base: string, all: Set<string>): string[] {
  const normalized = normalizeRepoPath(base).replace(/\/$/, "");
  const candidates = new Set<string>();
  if (all.has(normalized)) candidates.add(normalized);

  if (!extname(normalized)) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = `${normalized}${extension}`;
      const index = `${normalized}/index${extension}`;
      if (all.has(file)) candidates.add(file);
      if (all.has(index)) candidates.add(index);
    }
  } else if (/\.(?:m?js|cjs|jsx)$/.test(normalized)) {
    // TypeScript NodeNext projects commonly write the emitted `.js` extension
    // in source imports even though the repository contains a `.ts`/`.tsx` file.
    const stem = normalized.replace(/\.(?:m?js|cjs|jsx)$/, "");
    for (const extension of [".ts", ".tsx", ".d.ts"]) {
      const file = `${stem}${extension}`;
      if (all.has(file)) candidates.add(file);
    }
  }
  return [...candidates];
}

function pathIsWithin(directory: string, file: string): boolean {
  return directory === "." || file === directory || file.startsWith(`${directory}/`);
}

function matchPathPattern(pattern: string, specifier: string): string[] | null {
  if (!pattern.includes("*")) return pattern === specifier ? [] : null;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(.*)");
  const match = new RegExp(`^${expression}$`).exec(specifier);
  return match ? match.slice(1) : null;
}

function applyPathCaptures(target: string, captures: string[]): string {
  let index = 0;
  return target.replace(/\*/g, () => captures[index++] ?? captures.at(-1) ?? "");
}

function jsConfigCandidates(
  cwd: string,
  ref: string | null,
  specifier: string,
  fromFile: string,
  all: Set<string>
): string[] {
  const candidates = new Set<string>();
  const configs = [...all]
    .filter((path) => /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(path))
    .filter((path) => pathIsWithin(posix.dirname(path), fromFile))
    .sort((a, b) => posix.dirname(b).split("/").length - posix.dirname(a).split("/").length)
    .slice(0, 12);

  for (const configPath of configs) {
    const config = readJsonObject(cwd, ref, configPath);
    const compilerOptions = config && isRecord(config.compilerOptions) ? config.compilerOptions : null;
    if (!compilerOptions) continue;
    const configDir = posix.dirname(configPath);
    const baseUrl =
      typeof compilerOptions.baseUrl === "string"
        ? normalizeRepoPath(posix.join(configDir, compilerOptions.baseUrl))
        : configDir;

    if (isRecord(compilerOptions.paths)) {
      for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths)) {
        const captures = matchPathPattern(pattern, specifier);
        if (captures === null || !Array.isArray(rawTargets)) continue;
        for (const rawTarget of rawTargets) {
          if (typeof rawTarget !== "string") continue;
          const target = applyPathCaptures(rawTarget, captures);
          for (const path of moduleCandidates(posix.join(baseUrl, target), all)) {
            candidates.add(path);
          }
        }
      }
    }

    // `baseUrl` itself permits non-relative imports even without a `paths` map.
    if (typeof compilerOptions.baseUrl === "string") {
      for (const path of moduleCandidates(posix.join(baseUrl, specifier), all)) {
        candidates.add(path);
      }
    }
  }
  return [...candidates];
}

function packageEntryCandidates(
  cwd: string,
  ref: string | null,
  specifier: string,
  all: Set<string>
): string[] {
  const candidates = new Set<string>();
  const manifests = [...all].filter((path) => posix.basename(path) === "package.json").slice(0, 80);
  for (const manifestPath of manifests) {
    const manifest = readJsonObject(cwd, ref, manifestPath);
    if (!manifest || typeof manifest.name !== "string") continue;
    const packageName = manifest.name;
    if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;

    const packageDir = posix.dirname(manifestPath);
    const subpath = specifier === packageName ? "" : specifier.slice(packageName.length + 1);
    const bases = subpath
      ? [posix.join(packageDir, subpath), posix.join(packageDir, "src", subpath)]
      : [posix.join(packageDir, "src/index"), posix.join(packageDir, "index")];
    if (!subpath) {
      for (const field of [manifest.source, manifest.module, manifest.main, manifest.types]) {
        if (typeof field === "string") bases.unshift(posix.join(packageDir, field));
      }
    }
    for (const base of bases) {
      for (const path of moduleCandidates(base, all)) candidates.add(path);
    }
  }
  return [...candidates];
}

function pythonCandidates(specifier: string, fromFile: string, all: Set<string>): string[] {
  const candidates = new Set<string>();
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const modulePath = specifier.slice(leadingDots).replaceAll(".", "/");
  const roots = new Set<string>();

  if (leadingDots) {
    let base = posix.dirname(fromFile);
    for (let i = 1; i < leadingDots; i++) base = posix.dirname(base);
    roots.add(base);
  } else {
    roots.add(".");
    for (const conventional of ["src", "lib"]) {
      if ([...all].some((path) => path.startsWith(`${conventional}/`))) roots.add(conventional);
    }

    // The parent of the outermost package containing the importing file is a
    // Python import root (for example `src` in `src/shop/service.py`).
    let packageDir = posix.dirname(fromFile);
    while (all.has(posix.join(packageDir, "__init__.py"))) {
      roots.add(posix.dirname(packageDir));
      packageDir = posix.dirname(packageDir);
    }
  }

  for (const root of roots) {
    const base = normalizeRepoPath(posix.join(root, modulePath));
    for (const path of [`${base}.py`, `${base}/__init__.py`]) {
      if (all.has(path)) candidates.add(path);
    }
  }
  return [...candidates];
}

function javaCandidates(specifier: string, all: Set<string>): string[] {
  const candidates = new Set<string>();
  const parts = specifier.split(".").filter(Boolean);

  // Progressively remove a possible static member (`Util.create` → `Util`) and
  // match the remaining fully qualified class beneath any Java source root.
  for (let end = parts.length; end > 0 && candidates.size === 0; end--) {
    const suffix = `${parts.slice(0, end).join("/")}.java`;
    for (const path of all) {
      if (path === suffix || path.endsWith(`/${suffix}`)) candidates.add(path);
    }
  }

  // Some small/legacy repositories omit package-shaped source directories.
  // An exact class basename is still useful evidence, but only for a segment
  // that looks like a Java type (not a lowercase package or static method).
  if (!candidates.size) {
    const className = [...parts].reverse().find((part) => /^[A-Z]/.test(part));
    if (className) {
      for (const path of all) {
        if (posix.basename(path) === `${className}.java`) candidates.add(path);
      }
    }
  }
  return [...candidates];
}

function resolveImport(
  cwd: string,
  ref: string | null,
  specifier: string,
  fromFile: string,
  all: Set<string>
): string[] {
  const extension = extname(fromFile).toLowerCase();
  if (extension === ".py") return pythonCandidates(specifier, fromFile, all);
  if ([".java", ".kt", ".kts"].includes(extension)) return javaCandidates(specifier, all);

  if (specifier.startsWith(".")) {
    return moduleCandidates(posix.join(posix.dirname(fromFile), specifier), all);
  }

  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) {
    return [
      ...new Set([
        ...jsConfigCandidates(cwd, ref, specifier, fromFile, all),
        ...packageEntryCandidates(cwd, ref, specifier, all),
      ]),
    ];
  }
  return [];
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

/** Import specifiers that the conservative resolver could not map to a file.
 * They may be third-party dependencies, generated sources, or local aliases
 * the resolver does not understand. JDK imports are dropped as noise. */
export function unresolvedImports(cwd: string, ref: string | null, file: string): string[] {
  const normalized = normalizeRepoPath(file);
  const all = new Set(listFilesAt(cwd, ref).map(normalizeRepoPath));
  const content = readFileAt(cwd, ref, normalized) ?? "";
  return importSpecifiers(content, normalized)
    .filter((s) => !/^javax?\./.test(s))
    .filter((s) => resolveImport(cwd, ref, s, normalized, all).length === 0)
    .slice(0, 20);
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
  const unresolved = unresolvedImports(cwd, ref, file);
  return capText(
    [
      "## Related code",
      renderRelatedCode(cwd, ref, file, 8, false),
      "",
      "These are project files the code under review imports / co-changes with. " +
        "For any function or symbol it calls from them, run code_search(<symbol>) or " +
        "file_read on the file above to pull the real definition — do not assume behavior.",
      ...(unresolved.length
        ? [
            "",
            "## Unresolved imports (not confirmed external)",
            ...unresolved.map((s) => `- ${s}`),
            "The conservative resolver could not map these imports to repository files. If their " +
              "behavior matters, make one targeted code_search(<symbol>) or file_find lookup, then " +
              "move on rather than retrying path variations.",
          ]
        : []),
      "",
      "## Git history",
      gitHistory(cwd, file, 5, false, ref),
    ].join("\n"),
    AUTO_EVIDENCE_MAX_CHARS
  );
}
