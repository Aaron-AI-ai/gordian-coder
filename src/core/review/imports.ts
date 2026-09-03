/**
 * Import parsing and resolution: which files a source file pulls in, and where
 * each specifier actually lives in this repository.
 *
 * It sits at the root rather than under evidence/ or tools/ because both
 * depend on it — related_code ranks files by their import edges, and the
 * injected dossier reports the specifiers that resolved to nothing.
 *
 * Resolution is per-language and best-effort: tsconfig path aliases and
 * workspace packages for JS/TS, package `__init__` for Python, package-path
 * lookup under source roots for Java. A specifier nothing resolves is left
 * unresolved rather than guessed at.
 */

import { extname, posix } from "node:path";
import { listFilesAt, readFileAt } from "./tools/read";

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

export function normalizeRepoPath(path: string): string {
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

export function importSpecifiers(content: string, file: string): string[] {
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
export function importBindings(content: string): Map<string, string[]> {
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
export function usedCalls(content: string, name: string): string[] {
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

/** Whether a path is code this review could meaningfully cite. */
export function isSourceFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return (SOURCE_EXTENSIONS as readonly string[]).includes(extension);
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

export function resolveImport(
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

/**
 * Namespaces never worth fetching: the JDK, the language runtime, and the
 * ubiquitous third-party frameworks. Nothing in the repository defines them and
 * no project KB documents them, so a lookup burns a tool call to learn what the
 * model already knows.
 *
 * A heuristic list, deliberately: the alternative is listing every import that
 * resolves to nothing, which is what sent reviewers grepping for
 * `org.springframework.stereotype.Service`. Add namespaces here as they show up.
 */
const EXTERNAL_IMPORT_PREFIXES = [
  "java.",
  "javax.",
  "jakarta.",
  "kotlin.",
  "kotlinx.",
  "scala.",
  "android.",
  "org.springframework.",
  "org.slf4j.",
  "org.apache.",
  "org.junit.",
  "org.mockito.",
  "org.hibernate.",
  "org.assertj.",
  "org.testcontainers.",
  "lombok.",
  "com.fasterxml.",
  "com.google.",
  "io.swagger.",
  "io.micrometer.",
  "reactor.",
];

/** Whether an import is a well-known external dependency (see the list above). */
export function isExternalImport(specifier: string): boolean {
  return EXTERNAL_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/** Every import specifier declared by `file`. */
export function fileImports(cwd: string, ref: string | null, file: string): string[] {
  const normalized = normalizeRepoPath(file);
  return importSpecifiers(readFileAt(cwd, ref, normalized) ?? "", normalized);
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
