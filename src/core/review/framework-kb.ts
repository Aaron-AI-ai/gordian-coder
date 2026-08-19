/**
 * Framework knowledge-base lookup for imports that resolve to no repository
 * file.
 *
 * A reviewer cannot judge a call into the in-house framework without knowing
 * what that call does, and asking the model to go find it does not work: a
 * small model submits with zero lookups, and the KB lives under a dot path the
 * review's own target rules exclude. So the mapping is configured, and the docs
 * are injected as evidence rather than fetched on demand.
 *
 *   ".f-review.json"
 *   "frameworkKb": {
 *     "kr.co.openlabs.fico.framework.extension.*": ".fico/kb/fico-fwk-extension/",
 *     "kr.co.openlabs.fico.framework.*":           ".fico/kb/fico-fwk-core/"
 *   }
 *
 * The two patterns above overlap, so the LONGEST matching prefix wins — an
 * `...framework.extension.Foo` import must reach the extension KB, never the
 * core one that also matches it.
 *
 * Docs are read from the WORKING TREE, not the review's git ref: like rule
 * files they are review inputs, and a ref-scoped read would miss an untracked
 * or freshly updated KB.
 *
 * Anything that matches no configured prefix is skipped silently — that is what
 * keeps `java.*`, `org.springframework.*`, and third-party jars out: they are
 * not fetched because nothing claims them, not because a blocklist enumerates
 * them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { loadConfig } from "./context";

/** Per-document cap. KB pages are hand-written prose; a runaway one must not
 * crowd out the code under review. */
export const KB_DOC_MAX_CHARS = 6_000;
/** Documents injected per reviewed file, most specific import first. */
export const KB_MAX_DOCS = 6;
/** Directory entries walked when falling back to a name search. */
const KB_WALK_MAX_FILES = 2_000;

export interface KbDoc {
  /** The import that pulled this document in. */
  specifier: string;
  /** Repo-relative path of the markdown file, for the audit line. */
  path: string;
  content: string;
}

interface KbPattern {
  /** Dotted prefix an import must start with (always ends with "."). */
  prefix: string;
  /** Repo-relative KB directory. */
  dir: string;
}

/**
 * Config patterns as prefixes, longest first so specificity wins.
 * `a.b.*` and bare `a.b` both mean "a.b and everything under it".
 */
function kbPatterns(cwd: string): KbPattern[] {
  const configured = loadConfig(cwd).frameworkKb;
  if (!configured) return [];
  return Object.entries(configured)
    .filter(([, dir]) => typeof dir === "string" && dir.length > 0)
    .map(([pattern, dir]) => ({
      prefix: pattern.endsWith(".*")
        ? pattern.slice(0, -1) // "a.b.*" → "a.b."
        : pattern.endsWith(".")
          ? pattern
          : `${pattern}.`,
      dir: dir.replace(/\/+$/, ""),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/** The KB directory claiming `specifier`, or null when none does. */
function matchPattern(patterns: KbPattern[], specifier: string): KbPattern | null {
  return patterns.find((p) => specifier.startsWith(p.prefix)) ?? null;
}

/** Markdown files under `dir`, keyed by lowercased basename stem. Bounded walk;
 * a KB is a doc tree, not a source tree, so nesting stays shallow. */
function indexDocs(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < KB_WALK_MAX_FILES) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory — treat as empty, never throw into a review
    }
    for (const entry of entries) {
      if (seen++ >= KB_WALK_MAX_FILES) break;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        stack.push(full);
      } else if (entry.toLowerCase().endsWith(".md")) {
        const stem = entry.slice(0, -3).toLowerCase();
        // First match wins: a shallower path is the more canonical page for a
        // name, and the stack pops deepest-last.
        if (!index.has(stem)) index.set(stem, full);
      }
    }
  }
  return index;
}

const docIndexCache = new Map<string, Map<string, string>>();

function docIndex(absoluteDir: string): Map<string, string> {
  const cached = docIndexCache.get(absoluteDir);
  if (cached) return cached;
  const index = existsSync(absoluteDir) ? indexDocs(absoluteDir) : new Map<string, string>();
  docIndexCache.set(absoluteDir, index);
  return index;
}

/** Drop the memoized directory scans (tests, long-lived processes). */
export function clearKbCache(): void {
  docIndexCache.clear();
}

/**
 * Absolute path of the KB document for `specifier`, or null to skip.
 *
 * The package tail mirrors the KB layout, so
 * `kr.co...site.ext.utils.PBCommonUtils` under `.fico/kb/framework-site-ext/`
 * is `utils/PBCommonUtils.md`. When that exact path is missing the class name
 * is looked up anywhere in the tree, because a KB is hand-maintained and its
 * folders drift from the packages they document.
 */
export function resolveKbDoc(cwd: string, specifier: string): string | null {
  const pattern = matchPattern(kbPatterns(cwd), specifier);
  if (!pattern) return null;

  const base = join(cwd, pattern.dir);
  const tail = specifier.slice(pattern.prefix.length);
  if (!tail) return null;

  const direct = join(base, ...tail.split("."));
  if (existsSync(`${direct}.md`)) return `${direct}.md`;

  const simpleName = tail.split(".").at(-1);
  if (!simpleName) return null;
  return docIndex(base).get(simpleName.toLowerCase()) ?? null;
}

/**
 * Framework KB documents for `specifiers`, in input order, deduped by path and
 * bounded by KB_MAX_DOCS. Imports with no configured prefix — or with one whose
 * directory holds no matching page — are skipped without comment: a missing
 * page is a gap in the KB, not a review error.
 */
export function frameworkKbDocs(cwd: string, specifiers: string[]): KbDoc[] {
  const docs: KbDoc[] = [];
  const seen = new Set<string>();
  for (const specifier of specifiers) {
    if (docs.length >= KB_MAX_DOCS) break;
    const path = resolveKbDoc(cwd, specifier);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue; // vanished between the scan and the read
    }
    if (!content.trim()) continue;
    docs.push({
      specifier,
      path: relative(cwd, path).split(sep).join(posix.sep),
      content:
        content.length > KB_DOC_MAX_CHARS
          ? `${content.slice(0, KB_DOC_MAX_CHARS)}\n… (doc truncated)`
          : content,
    });
  }
  return docs;
}
