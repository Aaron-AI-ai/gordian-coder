/**
 * Review input contract + target collection.
 *
 * Builds the set of files to review from two optional inputs (commit /
 * files), then subtracts excludes:
 *
 *   targets = (commit diff) ∪ (files)  −  exclude
 *
 * If commit and files are BOTH empty, the commit defaults to the
 * latest commit (HEAD~1..HEAD).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { MAX_ITER } from "../tools/read";

export const CommitSpec = z.union([
  z.string(), // single ref ("HEAD", "<sha>") or range ("A..B")
  z.object({ from: z.string(), to: z.string().default("HEAD") }),
]);
export type CommitSpec = z.infer<typeof CommitSpec>;

export const ReviewInputSchema = z.object({
  commit: CommitSpec.optional(),
  files: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  output: z.string().optional(),
  requirementBackground: z.string().optional(),
  planGuidance: z.string().optional(),
  language: z.string().optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

// Config is external, hand-written JSON — validate at runtime (CLAUDE.md rule).
// A wrong-typed field degrades to "unset" (per-field .catch) instead of
// crashing the review (e.g. `"rulesDir": 5` reaching path.join) or silently
// dropping the whole file.
const field = <T extends z.ZodType>(t: T) => t.optional().catch(undefined);

/** One git wiki to mirror. Shorthand string = the clone URL with every other
 * field defaulted. */
export const WikiKbSourceSchema = z.union([
  z.string(),
  z.object({
    url: z.string(),
    tokenEnv: z.string().optional(), // env var NAME holding the token — never the token itself
    branch: z.string().optional(),
    dest: z.string().optional(), // repo-relative; defaults to ".fico/kb/<name>"
  }),
]);
export type WikiKbSource = z.infer<typeof WikiKbSourceSchema>;

export const ReviewConfigSchema = z.object({
  exclude: field(z.array(z.string())),
  output: field(z.string()),
  language: field(z.string()), // report/findings language, e.g. "ko" (default), "en"
  frameworkGuide: field(z.string()), // path to a framework conventions md (overrides bundled default)
  failOn: field(z.string()), // CI gate: FAIL when any finding is at/above this severity ("blocker"|"major"|"minor"|"nit")
  debug: field(z.boolean()), // emit `[f-review:*]` trace logs (alternative to F_REVIEW_DEBUG env)
  deepPasses: field(z.number()), // review rounds per file/segment (clamped 1..5; 1 = single pass)
  maxIter: field(z.number()), // exploration tool calls per round before forced convergence (default MAX_ITER)
  maxToolCalls: field(z.number()), // total tool calls per reviewer session, including context/submit
  rulesDir: field(z.string()), // project rules directory, relative to root (default "review/rules")
  frameworkKb: field(z.record(z.string())), // import prefix → KB dir map; replaces the framework_kb rule's table
  frameworkKbFile: field(z.string()), // path to an md replacing the bundled framework_kb.md entirely (frontmatter globs respected)
  judge: field(z.boolean()), // run mode: judge each file's review with an independent agent
  judgeThreshold: field(z.number()), // judge pass score 0..100 (default 70)
  judgeRounds: field(z.number()), // max rework (re-review) rounds per file (0..5, default 2; 0 = judge once, never re-review)
  fcq: field(z.boolean()), // run mode: run the fcq static analyzer at plan time and merge its report
  fcqOptions: field(z.record(z.unknown())), // fcq CLI options (see fcq.ts FcqOptionsSchema)
  fcqFix: field(z.boolean()), // make reviewers write a TO-BE fix for EVERY fcq hit, not just CRITICAL/MAJOR
  wikiKb: field(z.record(WikiKbSourceSchema)), // name -> git wiki to mirror into the KB (see kb-sync.ts)
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/**
 * Config locations, highest priority first.
 *
 * `.fico/config/fico_ai.json` is the current home: one file for every
 * gordian feature, not just review. The two `.f-review.json` paths stay for
 * back-compat — projects configured before the move keep working untouched.
 */
export const CONFIG_PATHS = [
  ".fico/config/fico_ai.json",
  ".f-review.json",
  "fcq/config/.f-review.json",
] as const;

/**
 * Flatten one config document.
 *
 * `fico_ai.json` groups settings by feature — review options live under
 * `"review"`, alongside siblings like `"wikiKb"`. The legacy `.f-review.json`
 * files are flat. Both shapes reduce to the same object here: the `review`
 * section wins over a same-named top-level key, so a half-migrated file
 * behaves the way its author intended rather than silently ignoring the
 * section.
 */
function flattenConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const section = (raw as Record<string, unknown>).review;
  if (typeof section !== "object" || section === null || Array.isArray(section)) return raw;
  return { ...(raw as Record<string, unknown>), ...(section as Record<string, unknown>) };
}

/** First config file that exists AND parses wins; missing → try the next
 * location; unparseable/non-object → also fall through (an invalid
 * higher-priority file must not shadow a valid fallback); nothing valid → {}. */
export function loadConfig(cwd: string = process.cwd()): ReviewConfig {
  for (const rel of CONFIG_PATHS) {
    const p = join(cwd, rel);
    if (!existsSync(p)) continue;
    try {
      const parsed = ReviewConfigSchema.safeParse(
        flattenConfig(JSON.parse(readFileSync(p, "utf8")))
      );
      if (parsed.success) return parsed.data;
    } catch {
      /* unparseable JSON — fall through to the next location */
    }
  }
  return {};
}

/** Hard ceiling on review rounds per target (deep-pass iteration). */
export const MAX_DEEP_PASSES = 5;

/** Total review rounds per target: arg wins, else config `deepPasses`, else 1
 * (single pass). Always clamped to [1, MAX_DEEP_PASSES] — the submit gate can
 * never loop unbounded. */
export function resolveDeepPasses(arg: number | undefined, cwd: string): number {
  const v = arg ?? loadConfig(cwd).deepPasses ?? 1;
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(MAX_DEEP_PASSES, Math.trunc(v)));
}

/** Exploration budget per round: config `maxIter`, else MAX_ITER. Clamped to
 * >=1 — 0 would withhold every exploration result from the first call. */
export function resolveMaxIter(cwd: string): number {
  const v = loadConfig(cwd).maxIter;
  if (typeof v !== "number" || !Number.isFinite(v)) return MAX_ITER;
  return Math.max(1, Math.trunc(v));
}

/** Hard reviewer-session tool-call ceiling. Three is the smallest useful
 * value: one context call plus two submit/recovery slots. Unlike maxIter this
 * budget never resets between files, deep passes, or final-check retries. */
export const DEFAULT_MAX_TOOL_CALLS = 10;
export const MIN_MAX_TOOL_CALLS = 3;

export function resolveMaxToolCalls(cwd: string): number {
  const v = loadConfig(cwd).maxToolCalls;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_TOOL_CALLS;
  return Math.max(MIN_MAX_TOOL_CALLS, Math.trunc(v));
}

/**
 * Translate a commit spec into a `git diff` range, or null when there is no
 * commit to diff (files-only review).
 */
export function resolveDiffRange(
  commit: CommitSpec | undefined,
  hasFiles: boolean
): string | null {
  if (commit === undefined) return hasFiles ? null : "HEAD~1..HEAD";
  if (typeof commit === "object") return `${commit.from}..${commit.to ?? "HEAD"}`;
  if (commit.includes("..")) return commit;
  return `${commit}~1..${commit}`;
}

/**
 * Always-excluded paths, regardless of user config:
 *  - any path with a segment starting with "." (.gitignore, .github/, .idea/, …)
 *  - compiled class files (*.class)
 *
 * INTENTIONAL and non-overridable, including for explicitly-passed `files`:
 * collectTargets applies this before the user's exclude globs, so
 * `--files=.github/workflows/ci.yml` is silently dropped and CI/tool config
 * under a dot path is never reviewed. The rubric is a source-code checklist
 * (correctness / security / performance / maintainability / tests / framework), and the dot namespace is
 * dominated by editor state, VCS metadata, and build caches that produce noise.
 *
 * Reviewing CI workflows is a real need this deliberately does not serve. If it
 * becomes one, add an opt-in (e.g. `.f-review.json` "includeDotPaths") rather
 * than loosening this predicate — the noise it blocks is the reason it exists.
 */
export function isDefaultExcluded(path: string): boolean {
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  if (path.endsWith(".class")) return true;
  return false;
}

/** Drop files matching any exclude glob.
 * A pattern without "/" matches by basename at any depth (gitignore-like),
 * because Bun.Glob's "*" does not cross "/" — so "*.test.ts" still excludes
 * "src/a.test.ts". Patterns containing "/" match against the full path. */
export function applyExclude(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return files;
  const globs = patterns.map((p) => ({
    glob: new Bun.Glob(p),
    basenameOnly: !p.includes("/"),
  }));
  return files.filter(
    (f) => !globs.some((g) => g.glob.match(g.basenameOnly ? basename(f) : f))
  );
}

// ── git / fs helpers (subprocess; thin by design) ────────────────

function git(args: string[], cwd: string): string {
  // ponytail: shell out to git rather than depend on a git library
  // quotepath=false: emit non-ASCII paths (한글 등) raw instead of quoted
  // octal escapes, so diff headers / --name-only match our path strings.
  const proc = Bun.spawnSync(["git", "-c", "core.quotepath=false", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

/** Repo-relative file paths changed in `range`. */
export function gitDiffFiles(range: string, cwd: string = process.cwd()): string[] {
  return git(["diff", "--name-only", range], cwd)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Unified diff for a single file within `range` ("" when range is null). */
export function gitDiffForFile(
  file: string,
  range: string | null,
  cwd: string = process.cwd()
): string {
  if (!range) return "";
  return git(["diff", range, "--", file], cwd).trim();
}

/** Split a `git diff` output into per-file chunks, keyed by the wanted paths. */
function parseDiffPerFile(full: string, want: Set<string>): Record<string, string> {
  const map: Record<string, string> = {};
  // Each file's diff starts with a "diff --git a/<path> b/<path>" header.
  for (const chunk of full.split(/(?=^diff --git )/m)) {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk);
    if (!m) continue;
    const path = m[1].trim();
    if (want.has(path)) map[path] = chunk.trim();
  }
  return map;
}

/** Pre-parse the review diff into a per-file snapshot (used by file_read_diff).
 * One `git diff` call, split per-file — not N spawns.
 * range given → diff of that commit range; range null (files mode) →
 * working tree (staged + unstaged) vs HEAD, so uncommitted local changes are
 * still shown as a diff. Safe on a non-git dir or a repo without HEAD ({}).
 * ponytail: targets passed as pathspec — fine up to thousands of files;
 * chunk the args if ARG_MAX ever bites. */
export function buildDiffMap(
  range: string | null,
  files: string[],
  cwd: string = process.cwd()
): Record<string, string> {
  try {
    return parseDiffPerFile(
      git(["diff", range ?? "HEAD", "--", ...files], cwd),
      new Set(files)
    );
  } catch {
    return {};
  }
}

/**
 * A user-supplied path in git's repo-relative forward-slash form.
 *
 * An ABSOLUTE path must be rebased onto `cwd`: every consumer joins the target
 * against cwd (`readFileAt` → `join(cwd, path)`, `git show <ref>:<path>`,
 * evidence, judge), so an absolute target resolves to `<cwd>/<cwd>/…` and every
 * read returns "file not found" — the reviewer survives only because the model
 * happens to pass relative paths to file_read, while the judge reads the stored
 * target verbatim and scores 0 on a file it believes does not exist.
 *
 * A path outside the repo is left as-is: `relative()` would yield `../…`, which
 * matches no diff header and is silently dropped by isDefaultExcluded's leading
 * dot rule. Keeping it absolute fails the same way but visibly.
 */
function normalizeTarget(file: string, cwd: string): string {
  const path = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path).replaceAll("\\", "/");
  return rel && !rel.startsWith("../") ? rel : path;
}

/** Build the deduped, exclude-filtered, sorted target file list. */
export async function collectTargets(
  input: ReviewInput,
  cwd: string = process.cwd()
): Promise<string[]> {
  const set = new Set<string>();
  const range = resolveDiffRange(input.commit, !!input.files?.length);

  if (range) for (const f of gitDiffFiles(range, cwd)) set.add(f);
  // Normalize user-supplied paths ("./x", backslashes, absolute) to git's
  // repo-relative forward-slash form, so they match diff headers and each other.
  if (input.files) for (const f of input.files) set.add(normalizeTarget(f, cwd));

  const kept = [...set].filter((f) => !isDefaultExcluded(f));
  const patterns = [...(loadConfig(cwd).exclude ?? []), ...(input.exclude ?? [])];
  return applyExclude(kept, patterns).sort();
}
