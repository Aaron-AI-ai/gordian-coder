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
import { basename, join } from "node:path";
import { z } from "zod";
import { MAX_ITER } from "./reader";

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
export const ReviewConfigSchema = z.object({
  exclude: field(z.array(z.string())),
  output: field(z.string()),
  language: field(z.string()), // report/findings language, e.g. "ko" (default), "en"
  frameworkGuide: field(z.string()), // path to a framework conventions md (overrides bundled default)
  failOn: field(z.string()), // CI gate: FAIL when any finding is at/above this severity ("blocker"|"major"|"minor"|"nit")
  debug: field(z.boolean()), // emit `[f-review:*]` trace logs (alternative to F_REVIEW_DEBUG env)
  deepPasses: field(z.number()), // review rounds per file/segment (clamped 1..5; 1 = single pass)
  maxIter: field(z.number()), // exploration tool calls per round before forced convergence (default MAX_ITER)
  rulesDir: field(z.string()), // project rules directory, relative to root (default "review/rules")
  judge: field(z.boolean()), // run mode: judge each file's review with an independent agent
  judgeThreshold: field(z.number()), // judge pass score 0..100 (default 70)
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/** Read `.f-review.json` from the project root, else `fcq/config/`; missing →
 * try the next location; unparseable/non-object → also fall through (an
 * invalid root file must not shadow a valid fallback); nothing valid → {}. */
export function loadConfig(cwd: string = process.cwd()): ReviewConfig {
  for (const rel of [".f-review.json", "fcq/config/.f-review.json"]) {
    const p = join(cwd, rel);
    if (!existsSync(p)) continue;
    try {
      const parsed = ReviewConfigSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
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

/** Build the deduped, exclude-filtered, sorted target file list. */
export async function collectTargets(
  input: ReviewInput,
  cwd: string = process.cwd()
): Promise<string[]> {
  const set = new Set<string>();
  const range = resolveDiffRange(input.commit, !!input.files?.length);

  if (range) for (const f of gitDiffFiles(range, cwd)) set.add(f);
  // Normalize user-supplied paths ("./x", backslashes) to git's repo-relative
  // forward-slash form, so they match diff headers and each other.
  if (input.files)
    for (const f of input.files) set.add(f.replaceAll("\\", "/").replace(/^\.\//, ""));

  const kept = [...set].filter((f) => !isDefaultExcluded(f));
  const patterns = [...(loadConfig(cwd).exclude ?? []), ...(input.exclude ?? [])];
  return applyExclude(kept, patterns).sort();
}
