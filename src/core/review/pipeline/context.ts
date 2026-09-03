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
import { loadConfig } from "../config";

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
