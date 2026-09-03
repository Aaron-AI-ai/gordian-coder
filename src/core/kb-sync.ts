/**
 * Mirror git wikis into the project's knowledge base.
 *
 * A git wiki is a git repository (`<repo>.wiki.git`), so "download every md
 * page" is a shallow clone plus a copy — no host API, no HTTP client, no
 * pagination. Auth is git's job too: SSH keys and credential helpers already
 * work, and for CI-style token access the config names an ENV VAR rather than
 * carrying the secret itself.
 *
 *   ".fico/config/fico_ai.json"
 *   "wikiKb": {
 *     "fico_framework": {
 *       "url": "https://dev.example.com/gitlab/group/framework.wiki.git",
 *       "tokenEnv": "FICO_WIKI_TOKEN"
 *     }
 *   }
 *
 * Node stdlib only (no Bun.*): `gdc` ships with a node shebang, and this
 * module is reachable from it.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "./review/config";
import type { WikiKbSource } from "./review/config";

/** Clone timeout. A wiki is small; anything slower is a hung auth prompt. */
const CLONE_TIMEOUT_MS = 120_000;
/** `git ls-remote` timeout. Only a ref exchange, so far cheaper than a clone. */
const LS_REMOTE_TIMEOUT_MS = 30_000;
/** Directory entries walked while collecting pages — a runaway wiki must not
 * spin forever. */
const WALK_MAX_ENTRIES = 20_000;

/**
 * Provenance written next to the mirrored pages, so a later run can answer
 * "is this KB still current?" without re-cloning: the recorded commit is
 * compared against `git ls-remote`. Named after the `.okf-source.json` that
 * the generated KB directories already carry.
 */
export const MANIFEST_NAME = ".wiki-source.json";

export const WikiManifestSchema = z.object({
  version: z.literal(1),
  source: z.string(), // masked clone url — never carries a token
  branch: z.string().optional(),
  commit: z.string(),
  commitDate: z.string().optional(),
  files: z.number(),
  syncedAt: z.string(),
});
export type WikiManifest = z.infer<typeof WikiManifestSchema>;

export interface WikiSource {
  name: string;
  url: string;
  tokenEnv?: string;
  branch?: string;
  /** Repo-relative destination directory. */
  dest: string;
}

export interface WikiSyncResult {
  name: string;
  dest: string;
  /** Markdown pages copied (or, in dry-run, that would be copied). */
  files: number;
  /** Commit the KB now reflects. */
  commit?: string;
  /** Remote already matched the manifest — nothing was cloned or written. */
  upToDate?: boolean;
  /** Set when this source failed; the run continues with the next one. */
  error?: string;
}

export type WikiStatus = "up-to-date" | "stale" | "never-synced" | "error";

export interface WikiCheckResult {
  name: string;
  dest: string;
  status: WikiStatus;
  /** Commit recorded in the local manifest. */
  local?: string;
  /** Commit the remote currently points at. */
  remote?: string;
  syncedAt?: string;
  error?: string;
}

export interface SyncOptions {
  /** Sync only this source. */
  name?: string;
  /** Clone and count, but write nothing. */
  dryRun?: boolean;
  /** Re-clone even when the manifest already matches the remote. */
  force?: boolean;
}

// ── URL handling ────────────────────────────────────────────────

/** Replace any embedded credentials with `***` — git echoes the remote URL
 * back in its error messages, which is the usual way a token leaks into a log. */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@");
}

/**
 * The URL to hand `git clone` / `git ls-remote`.
 *
 * `tokenEnv` is an OPTIONAL override, not a requirement: when the variable
 * holds a token and the remote is http(s), it is injected as basic-auth
 * credentials. Anything else — variable unset, scp-style or ssh remote —
 * falls back to the configured URL untouched, so git uses whatever access the
 * machine already has (credential helper, keychain, ~/.netrc, SSH keys).
 *
 * Never fails: a machine with working git access must not be blocked just
 * because an env var is missing. When the fallback is taken, `hint` explains
 * why, and callers append it to a git auth failure so the cause is not a
 * mystery.
 */
export function resolveCloneUrl(
  src: WikiSource,
  env: NodeJS.ProcessEnv = process.env
): { url: string; hint?: string } {
  if (!src.tokenEnv) return { url: src.url };

  const token = env[src.tokenEnv];
  if (!token) {
    return {
      url: src.url,
      hint: `env ${src.tokenEnv} is unset — used git's local credentials`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(src.url);
  } catch {
    // scp-style ("git@host:path") — not a URL; git handles auth via SSH.
    return { url: src.url, hint: `${src.tokenEnv} ignored — remote is not http(s)` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: src.url, hint: `${src.tokenEnv} ignored — remote is not http(s)` };
  }
  parsed.username = "oauth2";
  parsed.password = token;
  return { url: parsed.toString() };
}

// ── Config → sources ────────────────────────────────────────────

/**
 * Normalize the `wikiKb` config into sources. A bad entry is dropped rather
 * than failing the whole run; `dest` defaults to `.fico/kb/<name>`.
 */
export function resolveWikiSources(cwd: string = process.cwd()): WikiSource[] {
  const configured = loadConfig(cwd).wikiKb;
  if (!configured) return [];

  const out: WikiSource[] = [];
  for (const [name, raw] of Object.entries(configured)) {
    const entry: Exclude<WikiKbSource, string> =
      typeof raw === "string" ? { url: raw } : raw;
    if (!entry?.url) continue;
    out.push({
      name,
      url: entry.url,
      tokenEnv: entry.tokenEnv,
      branch: entry.branch,
      dest: entry.dest?.replace(/\/+$/, "") || join(".fico", "kb", name),
    });
  }
  return out;
}

/**
 * Absolute destination, or an error when it escapes the project.
 * The sync MIRRORS (it deletes `dest` before copying), so an unchecked
 * `"dest": "../.."` from a typo would wipe a directory outside the repo.
 */
export function resolveDest(cwd: string, dest: string): { path: string } | { error: string } {
  const abs = isAbsolute(dest) ? dest : resolve(cwd, dest);
  const rel = relative(resolve(cwd), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `dest "${dest}" escapes the project root` };
  }
  return { path: abs };
}

// ── Markdown collection ─────────────────────────────────────────

/** Repo-relative paths of every `.md` under `root`, `.git` excluded. */
export function collectMarkdown(root: string): string[] {
  const found: string[] = [];
  const queue: string[] = [""];
  let seen = 0;

  while (queue.length > 0) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) return found;
      if (e.name === ".git") continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(child);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) found.push(child);
    }
  }
  return found.sort();
}

// ── Provenance ──────────────────────────────────────────────────

/** The manifest in `destAbs`, or null when absent/corrupt (both mean
 * "never synced" — a corrupt manifest must not claim freshness). */
export function readManifest(destAbs: string): WikiManifest | null {
  const p = join(destAbs, MANIFEST_NAME);
  if (!existsSync(p)) return null;
  try {
    const parsed = WikiManifestSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeManifest(destAbs: string, m: WikiManifest): void {
  mkdirSync(destAbs, { recursive: true });
  writeFileSync(join(destAbs, MANIFEST_NAME), `${JSON.stringify(m, null, 2)}\n`);
}

function git(args: string[], timeoutMs: number, cwd?: string) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    // A sync must never stop on an interactive credential prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Append the credential-fallback explanation to a git failure, so an auth
 * error names the reason instead of leaving the user guessing. */
function withHint(message: string, hint?: string): string {
  return hint ? `${message} (${hint})` : message;
}

/** Trim git's stderr into one masked, log-safe line. */
function gitError(proc: ReturnType<typeof git>, what: string): string {
  if (proc.error) {
    return (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? `${what} timed out`
      : `cannot run git: ${proc.error.message}`;
  }
  const detail = maskUrl((proc.stderr || "").trim())
    .split("\n")
    .slice(-2)
    .join(" | ")
    .slice(0, 300);
  return `${what} exited ${proc.status}${detail ? `: ${detail}` : ""}`;
}

/**
 * The commit the remote's branch (or HEAD) points at, without cloning.
 * This is what makes the freshness check cheap enough to run every time.
 */
export function remoteHead(src: WikiSource): { commit: string } | { error: string } {
  const url = resolveCloneUrl(src);
  const ref = src.branch ? `refs/heads/${src.branch}` : "HEAD";
  const proc = git(["ls-remote", "--", url.url, ref], LS_REMOTE_TIMEOUT_MS);
  if (proc.error || proc.status !== 0) {
    return { error: withHint(gitError(proc, "git ls-remote"), url.hint) };
  }

  const sha = (proc.stdout || "").trim().split(/\s+/)[0];
  if (!sha) return { error: `remote has no ${ref}` };
  return { commit: sha };
}

/** Compare the mirrored KB against the remote. Network cost is one ls-remote. */
export async function checkWikiKb(
  cwd: string = process.cwd(),
  opts: Pick<SyncOptions, "name"> = {}
): Promise<WikiCheckResult[]> {
  const all = resolveWikiSources(cwd);
  const sources = opts.name ? all.filter((s) => s.name === opts.name) : all;

  return sources.map((src) => {
    const base = { name: src.name, dest: src.dest };
    const dest = resolveDest(cwd, src.dest);
    if ("error" in dest) return { ...base, status: "error" as const, error: dest.error };

    const manifest = readManifest(dest.path);
    const remote = remoteHead(src);
    if ("error" in remote) {
      return {
        ...base,
        status: "error" as const,
        local: manifest?.commit,
        syncedAt: manifest?.syncedAt,
        error: remote.error,
      };
    }
    if (!manifest) return { ...base, status: "never-synced" as const, remote: remote.commit };

    return {
      ...base,
      status: manifest.commit === remote.commit ? ("up-to-date" as const) : ("stale" as const),
      local: manifest.commit,
      remote: remote.commit,
      syncedAt: manifest.syncedAt,
    };
  });
}

// ── Sync ────────────────────────────────────────────────────────

function cloneInto(src: WikiSource, url: string, target: string): string | null {
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (src.branch) args.push("--branch", src.branch);
  args.push("--", url, target);

  const proc = git(args, CLONE_TIMEOUT_MS);
  if (proc.error || proc.status !== 0) return gitError(proc, "git clone");
  return null;
}

/** `git log -1 --format=<fmt>` in the checkout; "" when git says nothing. */
function head(checkout: string, fmt: string): string {
  const proc = git(["log", "-1", `--format=${fmt}`], LS_REMOTE_TIMEOUT_MS, checkout);
  return proc.status === 0 ? (proc.stdout || "").trim() : "";
}

/** Mirror one wiki. Never throws — failures come back on the result. */
export async function syncWikiSource(
  src: WikiSource,
  cwd: string = process.cwd(),
  opts: SyncOptions = {}
): Promise<WikiSyncResult> {
  const base: WikiSyncResult = { name: src.name, dest: src.dest, files: 0 };

  const dest = resolveDest(cwd, src.dest);
  if ("error" in dest) return { ...base, error: dest.error };

  const cloneUrl = resolveCloneUrl(src);

  // Cheap freshness gate: one ref exchange decides whether a clone is needed
  // at all. A failed ls-remote is NOT fatal — fall through and let the clone
  // produce the real error.
  const manifest = readManifest(dest.path);
  if (manifest && !opts.force && !opts.dryRun) {
    const remote = remoteHead(src);
    if ("commit" in remote && remote.commit === manifest.commit) {
      return { ...base, files: manifest.files, commit: manifest.commit, upToDate: true };
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "gordian-wiki-"));
  const checkout = join(tmp, "wiki");
  try {
    const failure = cloneInto(src, cloneUrl.url, checkout);
    if (failure) return { ...base, error: withHint(failure, cloneUrl.hint) };

    const commit = head(checkout, "%H");
    const pages = collectMarkdown(checkout);
    if (opts.dryRun) return { ...base, files: pages.length, commit };

    // Mirror: a page deleted upstream must not linger in the KB.
    rmSync(dest.path, { recursive: true, force: true });
    for (const rel of pages) {
      const target = join(dest.path, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(checkout, rel), target);
    }
    writeManifest(dest.path, {
      version: 1,
      source: maskUrl(src.url),
      branch: src.branch,
      commit,
      commitDate: head(checkout, "%cI") || undefined,
      files: pages.length,
      syncedAt: new Date().toISOString(),
    });
    return { ...base, files: pages.length, commit };
  } finally {
    // The clone URL may carry a token; the temp checkout holds it in
    // .git/config, so it never outlives this call.
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Mirror every configured wiki (or just `opts.name`). */
export async function syncWikiKb(
  cwd: string = process.cwd(),
  opts: SyncOptions = {}
): Promise<WikiSyncResult[]> {
  const all = resolveWikiSources(cwd);
  const sources = opts.name ? all.filter((s) => s.name === opts.name) : all;
  const results: WikiSyncResult[] = [];
  for (const src of sources) {
    results.push(await syncWikiSource(src, cwd, opts));
  }
  return results;
}

/**
 * `.ignore` entries that keep the KB searchable.
 *
 * Two rules, because two different filters hide it:
 *   "!.fico"      — ripgrep skips dot-paths unless `--hidden` is passed, and
 *                   opencode's glob tool does not pass it.
 *   "!.fico/kb/"  — a project that gitignores the generated KB (it is
 *                   reproducible, so it usually should) would otherwise have
 *                   it excluded by the gitignore filter as well, which hides
 *                   it even from `--hidden` searches. `.ignore` outranks
 *                   `.gitignore` in ripgrep, so this re-includes it for
 *                   search while git still leaves it uncommitted.
 */
export const KB_IGNORE_LINES = ["!.fico", "!.fico/kb/"] as const;

/** Ensure the project's `.ignore` un-hides the KB. Returns true when written. */
export function ensureKbVisible(cwd: string = process.cwd()): boolean {
  const path = join(cwd, ".ignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = KB_IGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return false;

  const next = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  writeFileSync(path, `${next}${missing.join("\n")}\n`);
  return true;
}
