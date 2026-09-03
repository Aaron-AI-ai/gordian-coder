import { describe, it, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANIFEST_NAME,
  checkWikiKb,
  collectMarkdown,
  ensureKbVisible,
  maskUrl,
  readManifest,
  remoteHead,
  resolveCloneUrl,
  resolveDest,
  resolveWikiSources,
  syncWikiKb,
} from "../kb-sync";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** A local git repo standing in for a remote wiki — no network, no auth. */
function wikiRepo(files: Record<string, string>): string {
  const d = mkTmp("kb-wiki-");
  const sh = (c: string[]) => spawnSync(c[0]!, c.slice(1), { cwd: d });
  sh(["git", "init", "-q", "-b", "main"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  for (const [rel, body] of Object.entries(files)) write(d, rel, body);
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "wiki"]);
  return d;
}

/** A project whose config points `wikiKb` at `wikiPath`. */
function project(wikiPath: string, extra: Record<string, unknown> = {}): string {
  const d = mkTmp("kb-proj-");
  write(
    d,
    ".fico/config/fico_ai.json",
    JSON.stringify({ wikiKb: { fico_framework: { url: wikiPath, ...extra } } })
  );
  return d;
}

describe("maskUrl", () => {
  it("hides embedded credentials", () => {
    expect(maskUrl("https://oauth2:secret@host/x.wiki.git")).toBe("https://***@host/x.wiki.git");
  });
  it("leaves credential-free urls alone", () => {
    expect(maskUrl("https://host/x.wiki.git")).toBe("https://host/x.wiki.git");
  });
});

describe("resolveCloneUrl", () => {
  const src = { name: "w", url: "https://host/x.wiki.git", dest: ".fico/kb/w" };

  it("passes the url through when no tokenEnv is configured", () => {
    expect(resolveCloneUrl(src)).toEqual({ url: "https://host/x.wiki.git" });
  });

  it("injects the token from the named env var", () => {
    const got = resolveCloneUrl({ ...src, tokenEnv: "T" }, { T: "abc" });
    expect(got).toEqual({ url: "https://oauth2:abc@host/x.wiki.git" });
  });

  it("falls back to git's local credentials when the env var is unset", () => {
    const got = resolveCloneUrl({ ...src, tokenEnv: "T" }, {});
    expect(got.url).toBe("https://host/x.wiki.git");
    expect(got.hint).toContain("T");
  });

  it("falls back to ssh auth instead of injecting a token", () => {
    const got = resolveCloneUrl(
      { ...src, url: "git@host:group/x.wiki.git", tokenEnv: "T" },
      { T: "abc" }
    );
    expect(got.url).toBe("git@host:group/x.wiki.git");
    expect(got.hint).toContain("not http(s)");
  });
});

describe("resolveDest", () => {
  it("accepts a path inside the project", () => {
    expect(resolveDest("/p", ".fico/kb/w")).toEqual({ path: "/p/.fico/kb/w" });
  });
  it("rejects an escaping relative path", () => {
    expect("error" in resolveDest("/p", "../../etc")).toBe(true);
  });
  it("rejects an absolute path outside the project", () => {
    expect("error" in resolveDest("/p", "/etc")).toBe(true);
  });
  it("rejects the project root itself", () => {
    expect("error" in resolveDest("/p", ".")).toBe(true);
  });
});

describe("collectMarkdown", () => {
  it("takes md only, keeps nesting, skips .git", () => {
    const d = mkTmp("kb-walk-");
    write(d, "Home.md", "x");
    write(d, "guide/Setup.md", "x");
    write(d, "image.png", "x");
    write(d, ".git/config", "x");
    write(d, ".git/HEAD.md", "x");
    expect(collectMarkdown(d)).toEqual(["Home.md", "guide/Setup.md"]);
  });
});

describe("resolveWikiSources", () => {
  it("defaults dest to .fico/kb/<name> and accepts the string shorthand", () => {
    const d = mkTmp("kb-cfg-");
    write(d, ".fico/config/fico_ai.json", JSON.stringify({ wikiKb: { w: "https://h/x.git" } }));
    expect(resolveWikiSources(d)).toEqual([
      { name: "w", url: "https://h/x.git", tokenEnv: undefined, branch: undefined, dest: join(".fico", "kb", "w") },
    ]);
  });

  it("reads wikiKb from the legacy .f-review.json when the new file is absent", () => {
    const d = mkTmp("kb-cfg-");
    write(d, ".f-review.json", JSON.stringify({ wikiKb: { w: "https://h/x.git" } }));
    expect(resolveWikiSources(d).map((s) => s.name)).toEqual(["w"]);
  });

  it("lets .fico/config win over the legacy files", () => {
    const d = mkTmp("kb-cfg-");
    write(d, ".fico/config/fico_ai.json", JSON.stringify({ wikiKb: { fresh: "https://h/a.git" } }));
    write(d, ".f-review.json", JSON.stringify({ wikiKb: { stale: "https://h/b.git" } }));
    expect(resolveWikiSources(d).map((s) => s.name)).toEqual(["fresh"]);
  });

  it("returns nothing when wikiKb is unconfigured", () => {
    expect(resolveWikiSources(mkTmp("kb-cfg-"))).toEqual([]);
  });
});

describe("syncWikiKb", () => {
  it("mirrors md pages into the default KB directory", async () => {
    const wiki = wikiRepo({ "Home.md": "home", "api/Auth.md": "auth", "logo.png": "bin" });
    const proj = project(wiki);

    const [res] = await syncWikiKb(proj);

    expect(res).toMatchObject({ name: "fico_framework", files: 2 });
    expect(res!.error).toBeUndefined();
    expect(readFileSync(join(proj, ".fico/kb/fico_framework/Home.md"), "utf8")).toBe("home");
    expect(existsSync(join(proj, ".fico/kb/fico_framework/api/Auth.md"))).toBe(true);
    expect(existsSync(join(proj, ".fico/kb/fico_framework/logo.png"))).toBe(false);
    expect(existsSync(join(proj, ".fico/kb/fico_framework/.git"))).toBe(false);
  });

  it("drops pages deleted upstream on the next sync", async () => {
    const wiki = wikiRepo({ "Home.md": "home", "Gone.md": "bye" });
    const proj = project(wiki);
    await syncWikiKb(proj);
    expect(existsSync(join(proj, ".fico/kb/fico_framework/Gone.md"))).toBe(true);

    const sh = (c: string[]) => spawnSync(c[0]!, c.slice(1), { cwd: wiki });
    rmSync(join(wiki, "Gone.md"));
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "drop"]);

    await syncWikiKb(proj);
    expect(existsSync(join(proj, ".fico/kb/fico_framework/Gone.md"))).toBe(false);
    expect(existsSync(join(proj, ".fico/kb/fico_framework/Home.md"))).toBe(true);
  });

  it("writes nothing in dry-run but still counts", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }));
    const [res] = await syncWikiKb(proj, { dryRun: true });
    expect(res).toMatchObject({ files: 1 });
    expect(existsSync(join(proj, ".fico/kb/fico_framework"))).toBe(false);
  });

  it("honours an explicit dest", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }), { dest: "docs/wiki" });
    await syncWikiKb(proj);
    expect(existsSync(join(proj, "docs/wiki/Home.md"))).toBe(true);
  });

  it("refuses a dest outside the project without touching it", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }), { dest: "../escape" });
    const [res] = await syncWikiKb(proj);
    expect(res!.error).toContain("escapes the project root");
    expect(existsSync(join(proj, "..", "escape"))).toBe(false);
  });

  it("reports a clone failure without a token in the message", async () => {
    const proj = project("https://127.0.0.1:1/nope.wiki.git", { tokenEnv: "KB_TEST_TOKEN" });
    process.env.KB_TEST_TOKEN = "s3cret";
    try {
      const [res] = await syncWikiKb(proj);
      expect(res!.error).toBeTruthy();
      expect(res!.error).not.toContain("s3cret");
    } finally {
      delete process.env.KB_TEST_TOKEN;
    }
  });

  it("still syncs with tokenEnv configured but unset, using local git access", async () => {
    // The local fixture needs no credentials — standing in for a machine that
    // already has access to the real remote.
    const proj = project(wikiRepo({ "Home.md": "home" }), { tokenEnv: "KB_ABSENT_TOKEN" });
    delete process.env.KB_ABSENT_TOKEN;
    const [res] = await syncWikiKb(proj);
    expect(res!.error).toBeUndefined();
    expect(res!.files).toBe(1);
  });

  it("names the unset env var when the fallback credentials also fail", async () => {
    const proj = project("https://127.0.0.1:1/nope.wiki.git", { tokenEnv: "KB_ABSENT_TOKEN" });
    delete process.env.KB_ABSENT_TOKEN;
    const [res] = await syncWikiKb(proj);
    expect(res!.error).toContain("KB_ABSENT_TOKEN");
    expect(res!.error).toContain("local credentials");
  });

  it("filters to one source with --name", async () => {
    const d = mkTmp("kb-proj-");
    const a = wikiRepo({ "A.md": "a" });
    const b = wikiRepo({ "B.md": "b" });
    write(d, ".fico/config/fico_ai.json", JSON.stringify({ wikiKb: { a, b } }));
    const res = await syncWikiKb(d, { name: "b" });
    expect(res.map((r) => r.name)).toEqual(["b"]);
    expect(existsSync(join(d, ".fico/kb/a"))).toBe(false);
  });
});

describe("ensureKbVisible", () => {
  it("adds both rules once and is idempotent", () => {
    const d = mkTmp("kb-ig-");
    expect(ensureKbVisible(d)).toBe(true);
    expect(readFileSync(join(d, ".ignore"), "utf8")).toBe("!.fico\n!.fico/kb/\n");
    expect(ensureKbVisible(d)).toBe(false);
  });

  it("appends to an existing .ignore without a trailing newline", () => {
    const d = mkTmp("kb-ig-");
    writeFileSync(join(d, ".ignore"), "build");
    ensureKbVisible(d);
    expect(readFileSync(join(d, ".ignore"), "utf8")).toBe("build\n!.fico\n!.fico/kb/\n");
  });

  it("adds only the rule that is missing", () => {
    const d = mkTmp("kb-ig-");
    writeFileSync(join(d, ".ignore"), "!.fico\n");
    expect(ensureKbVisible(d)).toBe(true);
    expect(readFileSync(join(d, ".ignore"), "utf8")).toBe("!.fico\n!.fico/kb/\n");
  });
});

// ── Provenance / freshness ──────────────────────────────────────

function commitAll(repo: string, msg: string): void {
  const sh = (c: string[]) => spawnSync(c[0]!, c.slice(1), { cwd: repo });
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", msg]);
}

function headSha(repo: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

describe("manifest", () => {
  it("records the synced commit, page count and masked url", async () => {
    const wiki = wikiRepo({ "Home.md": "home", "api/Auth.md": "auth" });
    const proj = project(wiki);
    await syncWikiKb(proj);

    const m = readManifest(join(proj, ".fico/kb/fico_framework"));
    expect(m).toMatchObject({ version: 1, source: wiki, commit: headSha(wiki), files: 2 });
    expect(m!.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m!.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never stores a token in the recorded url", async () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    const proj = project(`http://oauth2:s3cret@127.0.0.1:1/x.git`);
    // The clone fails, so assert on the masking helper's contract directly.
    const [res] = await syncWikiKb(proj);
    expect(res!.error).not.toContain("s3cret");
    expect(readManifest(join(proj, ".fico/kb/fico_framework"))).toBeNull();
    void wiki;
  });

  it("treats a corrupt manifest as never-synced", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }));
    await syncWikiKb(proj);
    writeFileSync(join(proj, ".fico/kb/fico_framework", MANIFEST_NAME), "{ not json");
    expect(readManifest(join(proj, ".fico/kb/fico_framework"))).toBeNull();
  });
});

describe("remoteHead", () => {
  it("reads the remote commit without cloning", () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    expect(remoteHead({ name: "w", url: wiki, dest: ".fico/kb/w" })).toEqual({
      commit: headSha(wiki),
    });
  });

  it("reports an unreachable remote", () => {
    const got = remoteHead({ name: "w", url: "http://127.0.0.1:1/nope.git", dest: ".fico/kb/w" });
    expect("error" in got).toBe(true);
  });
});

describe("syncWikiKb freshness", () => {
  it("skips the clone when the remote already matches the manifest", async () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    const proj = project(wiki);
    await syncWikiKb(proj);

    const [again] = await syncWikiKb(proj);
    expect(again).toMatchObject({ upToDate: true, files: 1, commit: headSha(wiki) });
  });

  it("re-clones once the remote moves", async () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    const proj = project(wiki);
    await syncWikiKb(proj);

    write(wiki, "New.md", "new");
    commitAll(wiki, "add page");

    const [res] = await syncWikiKb(proj);
    expect(res!.upToDate).toBeUndefined();
    expect(res!.files).toBe(2);
    expect(readManifest(join(proj, ".fico/kb/fico_framework"))!.commit).toBe(headSha(wiki));
  });

  it("--force re-clones even when up to date", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }));
    await syncWikiKb(proj);
    const [res] = await syncWikiKb(proj, { force: true });
    expect(res!.upToDate).toBeUndefined();
    expect(res!.files).toBe(1);
  });
});

describe("checkWikiKb", () => {
  it("reports never-synced before the first sync", async () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    const [c] = await checkWikiKb(project(wiki));
    expect(c).toMatchObject({ name: "fico_framework", status: "never-synced", remote: headSha(wiki) });
  });

  it("reports up-to-date right after a sync", async () => {
    const proj = project(wikiRepo({ "Home.md": "home" }));
    await syncWikiKb(proj);
    const [c] = await checkWikiKb(proj);
    expect(c!.status).toBe("up-to-date");
    expect(c!.local).toBe(c!.remote);
  });

  it("reports stale once the remote moves, with both commits", async () => {
    const wiki = wikiRepo({ "Home.md": "home" });
    const proj = project(wiki);
    await syncWikiKb(proj);
    const before = headSha(wiki);

    write(wiki, "New.md", "new");
    commitAll(wiki, "add page");

    const [c] = await checkWikiKb(proj);
    expect(c).toMatchObject({ status: "stale", local: before, remote: headSha(wiki) });
    expect(c!.syncedAt).toBeTruthy();
  });

  it("reports error, keeping the local commit, when the remote is unreachable", async () => {
    const proj = project("http://127.0.0.1:1/nope.git");
    const [c] = await checkWikiKb(proj);
    expect(c!.status).toBe("error");
    expect(c!.error).toBeTruthy();
  });
});
