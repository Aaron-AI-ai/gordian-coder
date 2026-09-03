import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "f-review-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

import { loadConfig, DEFAULT_MAX_TOOL_CALLS, resolveMaxIter, resolveMaxToolCalls } from "../config";
import { MAX_ITER } from "../tools/read";

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
