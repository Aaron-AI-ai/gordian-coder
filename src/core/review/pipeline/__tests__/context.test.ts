import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "k-git-"));
  tmps.push(d);
  const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
  sh(["git", "init", "-q"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  return d;
}

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "f-review-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

import { resolveDiffRange, applyExclude, isDefaultExcluded, collectTargets, buildDiffMap, ReviewInputSchema } from "../context";

describe("resolveDiffRange", () => {
  it("defaults to latest commit when nothing is provided", () => {
    expect(resolveDiffRange(undefined, false)).toBe("HEAD~1..HEAD");
  });

  it("returns null when files are present but no commit", () => {
    expect(resolveDiffRange(undefined, true)).toBeNull();
  });

  it("expands a single ref to that commit's change range", () => {
    expect(resolveDiffRange("abc123", false)).toBe("abc123~1..abc123");
    expect(resolveDiffRange("HEAD", false)).toBe("HEAD~1..HEAD");
  });

  it("passes a range string through unchanged", () => {
    expect(resolveDiffRange("A..B", false)).toBe("A..B");
  });

  it("builds a range from {from,to}", () => {
    expect(resolveDiffRange({ from: "A", to: "B" }, false)).toBe("A..B");
  });

  it("defaults to in {from} only", () => {
    expect(resolveDiffRange({ from: "A", to: "HEAD" }, false)).toBe("A..HEAD");
  });
});

describe("applyExclude", () => {
  it("returns input unchanged with no patterns", () => {
    expect(applyExclude(["a.ts", "b.ts"], [])).toEqual(["a.ts", "b.ts"]);
  });

  it("drops files matching a glob", () => {
    const files = ["src/a.ts", "src/a.test.ts", "dist/x.js"];
    expect(applyExclude(files, ["**/*.test.ts", "dist/**"])).toEqual(["src/a.ts"]);
  });

  it("matches a slash-less pattern by basename at any depth", () => {
    const files = ["a.test.ts", "src/a.test.ts", "src/deep/b.test.ts", "src/keep.ts"];
    expect(applyExclude(files, ["*.test.ts"])).toEqual(["src/keep.ts"]);
  });

  it("still anchors a slashed pattern to the full path", () => {
    const files = ["dist/x.js", "src/dist/y.js"];
    expect(applyExclude(files, ["dist/**"])).toEqual(["src/dist/y.js"]);
  });
});

describe("isDefaultExcluded", () => {
  it("excludes dotfiles and dot-folders", () => {
    expect(isDefaultExcluded(".gitignore")).toBe(true);
    expect(isDefaultExcluded(".github/workflows/ci.yml")).toBe(true);
    expect(isDefaultExcluded("src/.hidden/x.ts")).toBe(true);
  });
  it("excludes .class files", () => {
    expect(isDefaultExcluded("build/Foo.class")).toBe(true);
  });
  it("keeps normal source files", () => {
    expect(isDefaultExcluded("src/Foo.java")).toBe(false);
    expect(isDefaultExcluded("a.config.ts")).toBe(false);
  });
});

describe("collectTargets (files-only, no git)", () => {
  /** collectTargets resolves a named file to a real path, so the fixtures have
   * to exist — a name that matches nothing is now rejected by design. */
  function withFiles(dir: string, paths: string[]): string {
    for (const rel of paths) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), "x\n");
    }
    return dir;
  }

  it("drops dot paths even when the user asked for them explicitly", async () => {
    // Documented in the spec (§3.2): the default exclusion is not overridable,
    // so CI/config files under a dot path are never reviewable. Silent by
    // design — if this ever becomes an opt-in, this test is the contract.
    const d = withFiles(tmp(), [".github/workflows/ci.yml", "src/a.ts", ".f-review.json"]);
    expect(
      await collectTargets({ files: [".github/workflows/ci.yml", "src/a.ts"] }, d)
    ).toEqual(["src/a.ts"]);
    expect(await collectTargets({ files: [".f-review.json"] }, d)).toEqual([]);
  });

  it("unions files and applies config + param excludes", async () => {
    const d = withFiles(tmp(), ["src/a.ts", "src/a.test.ts", "src/b.ts"]);
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ exclude: ["**/*.test.ts"] }));
    const targets = await collectTargets(
      { files: ["src/a.ts", "src/a.test.ts", "src/b.ts"], exclude: ["src/b.ts"] },
      d
    );
    expect(targets).toEqual(["src/a.ts"]);
  });

  it("drops dot-paths and .class files by default", async () => {
    const targets = await collectTargets(
      { files: ["src/Foo.java", ".gitignore", ".github/ci.yml", "build/Foo.class"] },
      withFiles(tmp(), ["src/Foo.java", ".gitignore", ".github/ci.yml", "build/Foo.class"])
    );
    expect(targets).toEqual(["src/Foo.java"]);
  });

  it("normalizes './' prefixes and backslashes in explicit files", async () => {
    const targets = await collectTargets(
      { files: ["./src/a.ts", "src\\b.ts", "src/a.ts"] },
      withFiles(tmp(), ["src/a.ts", "src/b.ts"])
    );
    expect(targets).toEqual(["src/a.ts", "src/b.ts"]); // deduped + normalized
  });

  it("rebases absolute paths inside cwd onto the repo root", async () => {
    // Every consumer joins the target against cwd, so an absolute target reads
    // as <cwd>/<cwd>/… and the judge scores 0 on a file it cannot open.
    const d = withFiles(tmp(), ["src/a.ts", "src/b.ts"]);
    const targets = await collectTargets(
      { files: [join(d, "src/a.ts"), "src/a.ts", join(d, "src/b.ts")] },
      d
    );
    expect(targets).toEqual(["src/a.ts", "src/b.ts"]); // deduped against the relative form
  });

  it("rejects a target that is not in this repository", async () => {
    // Previously an absolute path outside cwd was carried through untouched,
    // and every later read missed — the reviewer then reported the file as
    // missing context instead of the run failing at plan time.
    const d = withFiles(tmp(), ["src/a.ts"]);
    expect(collectTargets({ files: ["/elsewhere/src/a.ts"] }, d)).rejects.toThrow(
      /no file matching/
    );
    expect(collectTargets({ files: ["nope.ts"] }, d)).rejects.toThrow(/no file matching/);
  });

  it("resolves a bare filename, and names the candidates when several match", async () => {
    // An orchestrator that says "SONAQ002Service.java" is doing the obvious
    // thing; resolving it is the difference between a review and a run whose
    // every read misses.
    const d = withFiles(tmp(), ["src/deep/Only.java", "a/Dup.java", "b/Dup.java"]);
    expect(await collectTargets({ files: ["Only.java"] }, d)).toEqual(["src/deep/Only.java"]);
    expect(await collectTargets({ files: ["deep/Only.java"] }, d)).toEqual(["src/deep/Only.java"]);
    expect(collectTargets({ files: ["Dup.java"] }, d)).rejects.toThrow(/matches 2 files/);
    expect(await collectTargets({ files: ["a/Dup.java"] }, d)).toEqual(["a/Dup.java"]);
  });
});

describe("buildDiffMap", () => {
  it("maps per-file diffs from a single git diff parse", () => {
    const d = gitRepo();
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    writeFileSync(join(d, "a.ts"), "a1\n");
    writeFileSync(join(d, "b.ts"), "b1\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    writeFileSync(join(d, "a.ts"), "a2\n");
    writeFileSync(join(d, "b.ts"), "b2\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "change"]);

    const map = buildDiffMap("HEAD~1..HEAD", ["a.ts", "b.ts"], d);
    expect(Object.keys(map).sort()).toEqual(["a.ts", "b.ts"]);
    expect(map["a.ts"]).toContain("+a2");
    expect(map["a.ts"]).not.toContain("+b2"); // each file's diff is isolated
    expect(map["b.ts"]).toContain("+b2");
  });

  it("maps non-ASCII filenames despite git's default path quoting", () => {
    const d = gitRepo();
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    writeFileSync(join(d, "한글파일.ts"), "a1\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    writeFileSync(join(d, "한글파일.ts"), "a2\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "change"]);

    const map = buildDiffMap("HEAD~1..HEAD", ["한글파일.ts"], d);
    expect(map["한글파일.ts"]).toContain("+a2");
  });

  it("null range → diffs uncommitted local changes vs HEAD per file", () => {
    const d = gitRepo();
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    writeFileSync(join(d, "a.ts"), "a1\n");
    writeFileSync(join(d, "b.ts"), "b1\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    // local edit, NOT committed
    writeFileSync(join(d, "a.ts"), "a2\n");

    const map = buildDiffMap(null, ["a.ts", "b.ts"], d);
    expect(Object.keys(map)).toEqual(["a.ts"]); // only the locally-changed file
    expect(map["a.ts"]).toContain("+a2");
    expect(map["a.ts"]).toContain("-a1");
  });

  it("returns {} on a non-git directory", () => {
    expect(buildDiffMap(null, ["a.ts"], tmp())).toEqual({});
  });
});

describe("ReviewInputSchema", () => {
  it("accepts all-optional empty input", () => {
    expect(ReviewInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a {from,to} commit", () => {
    expect(ReviewInputSchema.safeParse({ commit: { from: "A", to: "B" } }).success).toBe(true);
  });
});
