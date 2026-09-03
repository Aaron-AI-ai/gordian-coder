import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveDiffRange,
  applyExclude,
  isDefaultExcluded,
  loadConfig,
  DEFAULT_MAX_TOOL_CALLS,
  resolveMaxIter,
  resolveMaxToolCalls,
  collectTargets,
  buildDiffMap,
  ReviewInputSchema,
} from "../context";
import { MAX_ITER } from "../reader";

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

describe("loadConfig", () => {
  it("returns {} when the config file is absent", () => {
    expect(loadConfig(tmp())).toEqual({});
  });

  it("reads exclude/output from .f-review.json", () => {
    const d = tmp();
    writeFileSync(
      join(d, ".f-review.json"),
      JSON.stringify({ exclude: ["**/*.snap"], output: "reports/" })
    );
    expect(loadConfig(d)).toEqual({ exclude: ["**/*.snap"], output: "reports/" });
  });

  it("returns {} on malformed JSON", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), "{not json");
    expect(loadConfig(d)).toEqual({});
  });

  it("falls back to fcq/config/.f-review.json; root wins when both exist", () => {
    const d = tmp();
    mkdirSync(join(d, "fcq", "config"), { recursive: true });
    writeFileSync(join(d, "fcq", "config", ".f-review.json"), '{"language": "en"}');
    expect(loadConfig(d)).toEqual({ language: "en" });
    writeFileSync(join(d, ".f-review.json"), '{"language": "ko"}');
    expect(loadConfig(d)).toEqual({ language: "ko" });
  });

  it("degrades a wrong-typed field to unset instead of crashing or dropping the file", () => {
    const d = tmp();
    // "rulesDir": 5 previously reached path.join and threw on every review
    writeFileSync(join(d, ".f-review.json"), '{"rulesDir": 5, "language": "en"}');
    const cfg = loadConfig(d);
    expect(cfg.rulesDir).toBeUndefined();
    expect(cfg.language).toBe("en"); // valid siblings survive
  });

  it("an unparseable root config falls through to the fcq fallback", () => {
    const d = tmp();
    mkdirSync(join(d, "fcq", "config"), { recursive: true });
    writeFileSync(join(d, "fcq", "config", ".f-review.json"), '{"language": "en"}');
    writeFileSync(join(d, ".f-review.json"), "{not json");
    expect(loadConfig(d)).toEqual({ language: "en" });
  });
});

describe("resolveMaxIter", () => {
  it("defaults to MAX_ITER without config", () => {
    expect(resolveMaxIter(tmp())).toBe(MAX_ITER);
  });

  it("reads maxIter from .f-review.json, clamped to >=1 and truncated", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), '{"maxIter": 10}');
    expect(resolveMaxIter(d)).toBe(10);
    writeFileSync(join(d, ".f-review.json"), '{"maxIter": 0}');
    expect(resolveMaxIter(d)).toBe(1);
    writeFileSync(join(d, ".f-review.json"), '{"maxIter": 7.9}');
    expect(resolveMaxIter(d)).toBe(7);
    writeFileSync(join(d, ".f-review.json"), '{"maxIter": "lots"}');
    expect(resolveMaxIter(d)).toBe(MAX_ITER);
  });
});

describe("resolveMaxToolCalls", () => {
  it("defaults to the hard reviewer-session limit", () => {
    expect(resolveMaxToolCalls(tmp())).toBe(DEFAULT_MAX_TOOL_CALLS);
  });

  it("reads maxToolCalls from .f-review.json, clamped to a usable minimum", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), '{"maxToolCalls": 10}');
    expect(resolveMaxToolCalls(d)).toBe(10);
    writeFileSync(join(d, ".f-review.json"), '{"maxToolCalls": 2}');
    expect(resolveMaxToolCalls(d)).toBe(3);
    writeFileSync(join(d, ".f-review.json"), '{"maxToolCalls": 7.9}');
    expect(resolveMaxToolCalls(d)).toBe(7);
    writeFileSync(join(d, ".f-review.json"), '{"maxToolCalls": "many"}');
    expect(resolveMaxToolCalls(d)).toBe(DEFAULT_MAX_TOOL_CALLS);
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
  it("drops dot paths even when the user asked for them explicitly", async () => {
    // Documented in the spec (§3.2): the default exclusion is not overridable,
    // so CI/config files under a dot path are never reviewable. Silent by
    // design — if this ever becomes an opt-in, this test is the contract.
    const d = tmp();
    expect(
      await collectTargets({ files: [".github/workflows/ci.yml", "src/a.ts"] }, d)
    ).toEqual(["src/a.ts"]);
    expect(await collectTargets({ files: [".f-review.json"] }, d)).toEqual([]);
  });

  it("unions files and applies config + param excludes", async () => {
    const d = tmp();
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
      tmp()
    );
    expect(targets).toEqual(["src/Foo.java"]);
  });

  it("normalizes './' prefixes and backslashes in explicit files", async () => {
    const targets = await collectTargets(
      { files: ["./src/a.ts", "src\\b.ts", "src/a.ts"] },
      tmp()
    );
    expect(targets).toEqual(["src/a.ts", "src/b.ts"]); // deduped + normalized
  });

  it("rebases absolute paths inside cwd onto the repo root", async () => {
    // Every consumer joins the target against cwd, so an absolute target reads
    // as <cwd>/<cwd>/… and the judge scores 0 on a file it cannot open.
    const d = tmp();
    const targets = await collectTargets(
      { files: [join(d, "src/a.ts"), "src/a.ts", join(d, "src/b.ts")] },
      d
    );
    expect(targets).toEqual(["src/a.ts", "src/b.ts"]); // deduped against the relative form
  });

  it("leaves absolute paths outside cwd alone", async () => {
    const targets = await collectTargets({ files: ["/elsewhere/src/a.ts"] }, tmp());
    expect(targets).toEqual(["/elsewhere/src/a.ts"]); // ../ would be dropped by the dot rule
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

describe("loadConfig sections", () => {
  function proj(rel: string, body: unknown): string {
    const d = mkdtempSync(join(tmpdir(), "cfg-sec-"));
    tmps.push(d);
    const p = join(d, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body));
    return d;
  }

  it("reads review settings from the `review` section of fico_ai.json", () => {
    const d = proj(".fico/config/fico_ai.json", {
      review: { rulesDir: "fcq/rules", language: "ko", deepPasses: 2 },
      wikiKb: { fico_framework: "http://h/x" },
    });
    const c = loadConfig(d);
    expect(c.rulesDir).toBe("fcq/rules");
    expect(c.language).toBe("ko");
    expect(c.deepPasses).toBe(2);
    expect(c.wikiKb).toEqual({ fico_framework: "http://h/x" });
  });

  it("still reads a flat fico_ai.json", () => {
    const d = proj(".fico/config/fico_ai.json", { language: "en", judge: true });
    expect(loadConfig(d)).toMatchObject({ language: "en", judge: true });
  });

  it("lets the `review` section win over a same-named top-level key", () => {
    const d = proj(".fico/config/fico_ai.json", {
      language: "en",
      review: { language: "ko" },
    });
    expect(loadConfig(d).language).toBe("ko");
  });

  it("ignores a non-object `review` value instead of dropping the file", () => {
    const d = proj(".fico/config/fico_ai.json", { language: "ko", review: "nope" });
    expect(loadConfig(d).language).toBe("ko");
  });

  it("keeps the legacy flat .f-review.json working", () => {
    const d = proj(".f-review.json", { rulesDir: "review/rules", judgeRounds: 3 });
    expect(loadConfig(d)).toMatchObject({ rulesDir: "review/rules", judgeRounds: 3 });
  });
});
