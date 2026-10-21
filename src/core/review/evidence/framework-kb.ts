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
import { loadConfig } from "../config";

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
  entryCache.clear();
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

// ── kb_search ────────────────────────────────────────────────────

/** Pages listed per search, and how many of those are returned in full. */
const KB_SEARCH_LISTED = 5;
const KB_SEARCH_FULL = 2;
/** Stems of navigation pages that describe no class. */
const KB_NAV_STEMS = new Set(["index", "home"]);

/** Frontmatter fields both rankers read, in the page's own case. */
const ENTRY_FIELDS = ["stem", "title", "fqcn", "tags", "description"] as const;
type EntryFields = Record<(typeof ENTRY_FIELDS)[number], string>;

interface KbEntry extends EntryFields {
  path: string;
  /** Lowercased fields and body, for the keyword ranker's substring match. */
  lower: EntryFields & { body: string };
  /** The page as written — returned in full, and tokenized for bm25. */
  text: string;
  /** bm25 view per field, built on the first bm25 search. */
  terms?: Record<Bm25Field, { tf: Map<string, number>; length: number }>;
}

/** Parsed pages by absolute path, reused while the file's mtime holds. A search
 * reads every page and prefetch searches once per clue — re-reading the KB each
 * time cost a large file thousands of reads. */
const entryCache = new Map<string, { mtimeMs: number; entry: KbEntry }>();

/** `title`, `description`, `fqcn` and the `tags` list from a page's frontmatter
 * — the only structure the generated pages reliably carry. */
function readEntry(path: string): KbEntry | null {
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    const cached = entryCache.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached.entry;
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const scalar = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
  const fields: EntryFields = {
    stem: path.split(sep).at(-1)!.slice(0, -3),
    title: scalar("title"),
    fqcn: scalar("fqcn"),
    tags: [...front.matchAll(/^\s*-\s+(.+)$/gm)].map((m) => m[1]).join(" "),
    description: scalar("description"),
  };
  const lower = Object.fromEntries(ENTRY_FIELDS.map((k) => [k, fields[k].toLowerCase()])) as EntryFields;
  const entry: KbEntry = { ...fields, path, text, lower: { ...lower, body: text.toLowerCase() } };
  entryCache.set(path, { mtimeMs, entry });
  return entry;
}

/** Every page in the configured KB directories, navigation pages skipped. */
function kbEntries(cwd: string): KbEntry[] {
  const dirs = [...new Set(kbPatterns(cwd).map((p) => p.dir))]
    .map((dir) => join(cwd, dir))
    .filter((dir) => existsSync(dir));
  const seen = new Set<string>();
  const entries: KbEntry[] = [];
  for (const dir of dirs) {
    for (const [stem, path] of docIndex(dir)) {
      if (KB_NAV_STEMS.has(stem) || seen.has(path)) continue;
      seen.add(path);
      const entry = readEntry(path);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** Lowercased words of a query, camelCase split ("extTransactionManager" →
 * ext, transaction, manager) so a code identifier finds a prose page. */
function queryWords(query: string): string[] {
  const words = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  return [...new Set(words)];
}

/** Occurrences of `word` in `text`, counted up to `cap`. */
function countUpTo(text: string, word: string, cap: number): number {
  let n = 0;
  for (let at = text.indexOf(word); at !== -1 && n < cap; at = text.indexOf(word, at + word.length)) n++;
  return n;
}

interface RankedDoc {
  entry: KbEntry;
  /** Points from the name/title/fqcn/tags/description — a page ABOUT the term. */
  meta: number;
  /** Points from body mentions (capped) — a page that merely uses the term. */
  body: number;
}

/** `entries` matching `query` by substring overlap, best first. */
function rankKbDocs(entries: KbEntry[], query: string, exact = false): RankedDoc[] {
  // `exact`: the query is one identifier (a clue read off source) and must match
  // whole — splitting "CommonRequest" into common+request ranks every request
  // class above the one page that actually uses it.
  const words = exact ? [query.toLowerCase()] : queryWords(query);
  const bodyCap = exact ? 15 : 5;
  if (words.length === 0) return [];

  const ranked: RankedDoc[] = [];
  for (const entry of entries) {
    const e = entry.lower;
    let meta = 0;
    let body = 0;
    for (const w of words) {
      if (e.stem.includes(w)) meta += 5;
      if (e.title.includes(w) || e.fqcn.includes(w)) meta += 4;
      if (e.tags.includes(w)) meta += 3;
      if (e.description.includes(w)) meta += 2;
      body += countUpTo(e.body, w, bodyCap);
    }
    if (meta + body > 0) ranked.push({ entry, meta, body });
  }
  return ranked.sort(
    (a, b) => b.meta + b.body - (a.meta + a.body) || a.entry.path.localeCompare(b.entry.path)
  );
}

// ── bm25 ──

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Per-field weights, the keyword ranker's order of trust. Each field saturates
 * on its own before weighting: folded into one frequency, a page's name match
 * drowned under its own body mentions, and long pages that used several common
 * query words outvoted the page named for the rare one (live A/B, case-95). */
const BM25_WEIGHTS = {
  stem: 5,
  title: 4,
  fqcn: 4,
  tags: 3,
  description: 2,
  body: 1,
} as const;
type Bm25Field = keyof typeof BM25_WEIGHTS;
const BM25_FIELDS = Object.keys(BM25_WEIGHTS) as Bm25Field[];

/**
 * Lowercased tokens of `text`: each identifier whole AND, when camelCase, its
 * parts, acronym prefixes included (PBTransactionAspect → pb, transaction,
 * aspect) — "SimpleDateFormat" meets both the identifier and prose about dates,
 * while "format" no longer matches inside "FormatterUtils". Hangul words also
 * yield bigrams so 트랜잭션 meets 트랜잭션을.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const whole = raw.toLowerCase();
    if (whole.length >= 2) out.push(whole);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") // acronym prefix: PBTransaction → PB Transaction
      .toLowerCase()
      .split(" ");
    if (parts.length > 1) for (const p of parts) if (p.length >= 2) out.push(p);
    if (whole.length > 2 && /\p{Script=Hangul}/u.test(whole)) {
      for (let i = 0; i + 2 <= whole.length; i++) out.push(whole.slice(i, i + 2));
    }
  }
  return out;
}

function bm25Terms(entry: KbEntry): NonNullable<KbEntry["terms"]> {
  if (entry.terms) return entry.terms;
  // body without the frontmatter, so a name is counted in its own field only
  const body = entry.text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const terms = {} as NonNullable<KbEntry["terms"]>;
  for (const field of BM25_FIELDS) {
    const list = tokens(field === "body" ? body : entry[field]);
    const tf = new Map<string, number>();
    for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
    terms[field] = { tf, length: list.length };
  }
  return (entry.terms = terms);
}

/** `entries` ranked by per-field Okapi BM25 over whole tokens, best first. */
function rankBm25(entries: KbEntry[], query: string): KbEntry[] {
  const words = [...new Set(tokens(query))];
  if (words.length === 0 || entries.length === 0) return [];
  const docs = entries.map((entry) => ({ entry, terms: bm25Terms(entry) }));
  const avgLength = Object.fromEntries(
    BM25_FIELDS.map((f) => [f, docs.reduce((sum, d) => sum + d.terms[f].length, 0) / docs.length || 1])
  ) as Record<Bm25Field, number>;
  // a page "has" a word when any field does
  const idf = new Map(
    words.map((w) => {
      const n = docs.filter((d) => BM25_FIELDS.some((f) => d.terms[f].tf.has(w))).length;
      return [w, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))] as const;
    })
  );
  const scored: { entry: KbEntry; score: number }[] = [];
  for (const { entry, terms } of docs) {
    let score = 0;
    for (const field of BM25_FIELDS) {
      const { tf, length } = terms[field];
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength[field]);
      for (const w of words) {
        const f = tf.get(w);
        if (f) score += BM25_WEIGHTS[field] * idf.get(w)! * ((f * (BM25_K1 + 1)) / (f + norm));
      }
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .map((s) => s.entry);
}

/**
 * Search the configured framework KB directories and return the best pages.
 *
 * Injection (frameworkKbDocs) only reaches a page when the reviewed file
 * IMPORTS the class it documents. A violation of the form "used the generic
 * Spring/JDK facility where the house wrapper is required" has no such import,
 * so the reviewer needs a way to ask "is there a framework class for this?".
 * The KB sits outside git, so code_search/file_find cannot reach it.
 *
 * Ranking follows config `kbSearch`: "keyword" (default) is substring overlap —
 * filename, then title/fqcn, tags, description, body; "bm25" scores whole
 * tokens weighted by how rare they are across the KB. Neither needs setup for a
 * few hundred pages. The top pages are returned in full (each capped), the rest
 * as path + summary.
 */
export function kbSearch(cwd: string, query: string): string {
  const configured = kbPatterns(cwd).some((p) => existsSync(join(cwd, p.dir)));
  if (!configured) return "No framework KB is configured for this project.";
  if (queryWords(query).length === 0) return "No KB documents match: give at least one keyword.";

  const entries = kbEntries(cwd);
  const ranked =
    loadConfig(cwd).kbSearch === "bm25"
      ? rankBm25(entries, query)
      : rankKbDocs(entries, query).map((r) => r.entry);
  if (ranked.length === 0) return `No KB documents match "${query}". Do NOT retry variations; move on.`;

  const rel = (p: string) => relative(cwd, p).split(sep).join(posix.sep);
  return ranked
    .slice(0, KB_SEARCH_LISTED)
    .map((entry, i) => {
      // `lower` keeps the listing line in the casing it has always had
      const head = `==== ${rel(entry.path)} — ${entry.lower.title || entry.lower.stem}: ${entry.lower.description}`;
      if (i >= KB_SEARCH_FULL) return head;
      const { text } = entry;
      const body = text.length > KB_DOC_MAX_CHARS ? `${text.slice(0, KB_DOC_MAX_CHARS)}\n… (doc truncated)` : text;
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

// ── prefetch ─────────────────────────────────────────────────────

/** Extra pages injected per file, and what a page must score to qualify. */
export const KB_PREFETCH_MAX = 3;
/** Clues searched per file. Each is a full pass over the KB; a large file's
 * vocabulary must not turn evidence building into hundreds of passes. Clues
 * come imports-first, so the cap drops the noisiest kinds (literals) first. */
const KB_PREFETCH_MAX_CLUES = 40;
const PREFETCH_MIN_META = 5; // the page is ABOUT the clue (name/title/fqcn/tags hit)
const PREFETCH_MIN_BODY = 6;
const PREFETCH_RARE_PAGES = 3; // a clue found on this few pages points straight at them // …or mentions it often enough to describe its use

/** Annotations that say nothing about framework usage. */
const NOISE_ANNOTATIONS = new Set([
  "Override", "Deprecated", "SuppressWarnings", "FunctionalInterface", "SafeVarargs",
  "Test", "Data", "Getter", "Setter", "Builder", "Slf4j", "NoArgsConstructor",
  "AllArgsConstructor", "RequiredArgsConstructor", "Service", "Component", "Autowired",
]);

/**
 * Search terms a reviewer would need the KB for, read off the source itself:
 * imported framework class names, annotations, constructed types, and
 * identifier-like string literals (error codes, bean names).
 *
 * Injection by import misses the case where the page that matters belongs to a
 * class the file does NOT import — the house wrapper it should have used, or the
 * aspect that its method signature defeats. The file's own vocabulary is the
 * only handle on those, and a small model asked to search for them itself
 * either skips the search or searches by Spring annotation.
 */
export function kbClues(source: string): string[] {
  const clues = new Set<string>();
  for (const m of source.matchAll(/^import\s+(?:static\s+)?([\w.]+);/gm)) {
    const fqcn = m[1];
    if (fqcn.startsWith("kr.co.openlabs.") || fqcn.startsWith("kr.co.koscom.pb.framework.")) {
      clues.add(fqcn.split(".").at(-1)!);
    }
  }
  for (const m of source.matchAll(/@([A-Z]\w+)/g)) if (!NOISE_ANNOTATIONS.has(m[1])) clues.add(m[1]);
  for (const m of source.matchAll(/\bnew\s+([A-Z]\w+)\s*[(<]/g)) clues.add(m[1]);
  for (const m of source.matchAll(/"([A-Za-z][\w.-]{3,40})"/g)) {
    // identifier-like only: a code or bean name carries a digit or an inner capital
    if (/\d/.test(m[1]) || /[a-z][A-Z]/.test(m[1]) || /^[A-Z]{4,}$/.test(m[1])) clues.add(m[1]);
  }
  return [...clues];
}

/**
 * Pages the file's own vocabulary points at, beyond what its imports already
 * delivered. `have` is the repo-relative paths already injected. Each clue is
 * searched on its own so one noisy term cannot crowd out a precise one.
 */
export function kbPrefetch(cwd: string, source: string, have: Set<string>, max = KB_PREFETCH_MAX): KbDoc[] {
  const picked = new Map<string, { score: number; clue: string; doc: KbDoc }>();
  const entries = kbEntries(cwd);
  if (entries.length === 0) return [];
  for (const clue of kbClues(source).slice(0, KB_PREFETCH_MAX_CLUES)) {
    const ranked = rankKbDocs(entries, clue, true);
    // A term that only a handful of pages mention is a pointer to them, however
    // few times they say it (an error code lives in one constants page);
    // a term every page mentions has to clear the bar on its own merits.
    const rare = ranked.length <= PREFETCH_RARE_PAGES;
    for (const r of ranked.slice(0, 3)) {
      if (!rare && r.meta < PREFETCH_MIN_META && r.body < PREFETCH_MIN_BODY) continue;
      const path = relative(cwd, r.entry.path).split(sep).join(posix.sep);
      if (have.has(path)) continue;
      const score = r.meta * 2 + r.body + (rare ? 20 : 0);
      if ((picked.get(path)?.score ?? -1) >= score) continue;
      let content: string;
      try {
        content = readFileSync(r.entry.path, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      picked.set(path, {
        score,
        clue,
        doc: {
          specifier: `search: ${clue}`,
          path,
          content: content.length > KB_DOC_MAX_CHARS ? `${content.slice(0, KB_DOC_MAX_CHARS)}\n… (doc truncated)` : content,
        },
      });
    }
  }
  return [...picked.values()].sort((a, b) => b.score - a.score).slice(0, max).map((p) => p.doc);
}
