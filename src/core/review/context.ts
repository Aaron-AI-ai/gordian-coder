/**
 * Review input contract + target collection.
 *
 * Builds the set of files to review from three optional inputs (commit /
 * files / package), then subtracts excludes:
 *
 *   targets = (commit diff) ∪ (files) ∪ (package glob)  −  exclude
 *
 * If commit, files and package are ALL empty, the commit defaults to the
 * latest commit (HEAD~1..HEAD).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { z } from "zod";

export const CommitSpec = z.union([
  z.string(), // single ref ("HEAD", "<sha>") or range ("A..B")
  z.object({ from: z.string(), to: z.string().default("HEAD") }),
]);
export type CommitSpec = z.infer<typeof CommitSpec>;

export const ReviewInputSchema = z.object({
  commit: CommitSpec.optional(),
  files: z.array(z.string()).optional(),
  package: z.string().optional(),
  exclude: z.array(z.string()).optional(),
  output: z.string().optional(),
  requirementBackground: z.string().optional(),
  planGuidance: z.string().optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export interface ReviewConfig {
  exclude?: string[];
  output?: string;
}

/** Read project-root `.k-codereview.json`; missing/invalid → {}. */
export function loadConfig(cwd: string = process.cwd()): ReviewConfig {
  const p = join(cwd, ".k-codereview.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ReviewConfig;
  } catch {
    return {};
  }
}

/**
 * Translate a commit spec into a `git diff` range, or null when there is no
 * commit to diff (files/package-only review).
 */
export function resolveDiffRange(
  commit: CommitSpec | undefined,
  hasFilesOrPkg: boolean
): string | null {
  if (commit === undefined) return hasFilesOrPkg ? null : "HEAD~1..HEAD";
  if (typeof commit === "object") return `${commit.from}..${commit.to ?? "HEAD"}`;
  if (commit.includes("..")) return commit;
  return `${commit}~1..${commit}`;
}

/** Always-excluded paths, regardless of user config:
 *  - any path with a segment starting with "." (.gitignore, .github/, .idea/, …)
 *  - compiled class files (*.class) */
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
  const proc = Bun.spawnSync(["git", ...args], { cwd });
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

async function scanDir(pkg: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  const base = join(cwd, pkg);
  if (!existsSync(base)) return out;
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: base, onlyFiles: true })) {
    // Normalize to forward slashes so paths match git's output on Windows.
    out.push(join(pkg, rel).replaceAll("\\", "/"));
  }
  return out;
}

/** Pre-parse the diff into a per-file snapshot (used by file_read_diff).
 * One `git diff <range>` call, split per-file — not N spawns. */
export function buildDiffMap(
  range: string | null,
  files: string[],
  cwd: string = process.cwd()
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!range) return map;
  const want = new Set(files);
  const full = git(["diff", range], cwd);
  // Each file's diff starts with a "diff --git a/<path> b/<path>" header.
  for (const chunk of full.split(/(?=^diff --git )/m)) {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk);
    if (!m) continue;
    const path = m[1].trim();
    if (want.has(path)) map[path] = chunk.trim();
  }
  return map;
}

/** Build the deduped, exclude-filtered, sorted target file list. */
export async function collectTargets(
  input: ReviewInput,
  cwd: string = process.cwd()
): Promise<string[]> {
  const set = new Set<string>();
  const hasFilesOrPkg = !!(input.files?.length || input.package);
  const range = resolveDiffRange(input.commit, hasFilesOrPkg);

  if (range) for (const f of gitDiffFiles(range, cwd)) set.add(f);
  if (input.files) for (const f of input.files) set.add(f);
  if (input.package) for (const f of await scanDir(input.package, cwd)) set.add(f);

  const kept = [...set].filter((f) => !isDefaultExcluded(f));
  const patterns = [...(loadConfig(cwd).exclude ?? []), ...(input.exclude ?? [])];
  return applyExclude(kept, patterns).sort();
}
