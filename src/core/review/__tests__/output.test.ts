import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOutputPath,
  resolveManifestPath,
  renderReport,
  writeReport,
  renderManifest,
  defaultLabel,
  manifestTimestamp,
  baselineKey,
  parseReportKeys,
  loadBaseline,
} from "../output";
import type { Finding } from "../contract";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "k-out-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  category: "security",
  severity: "major",
  file: "src/a.ts",
  line: 3,
  rule: "no-secret",
  message: "hardcoded token",
  ...over,
});

const DATE = new Date("2026-07-27T09:30:05Z"); // ymd → 20260727

describe("resolveOutputPath", () => {
  it("defaults to fcq/report/f-review/ with dated auto filename", () => {
    expect(resolveOutputPath(undefined, "L", tmp(), DATE)).toBe(
      "fcq/report/f-review/review-L-20260727.md"
    );
  });

  it("treats a trailing-slash param as a directory", () => {
    expect(resolveOutputPath("reports/", "L", tmp(), DATE)).toBe("reports/review-L-20260727.md");
  });

  it("uses an explicit filename as-is (no date appended)", () => {
    expect(resolveOutputPath("reports/pr-42.md", "L", tmp(), DATE)).toBe("reports/pr-42.md");
  });

  it("reads output from config when no param", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ output: "docs/rv/" }));
    expect(resolveOutputPath(undefined, "L", d, DATE)).toBe("docs/rv/review-L-20260727.md");
  });

  it("param overrides config", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ output: "docs/rv/" }));
    expect(resolveOutputPath("out.md", "L", d, DATE)).toBe("out.md");
  });

  it("detects an existing directory without trailing slash", () => {
    const d = tmp();
    mkdirSync(join(d, "reports"));
    expect(resolveOutputPath("reports", "L", d, DATE)).toBe("reports/review-L-20260727.md");
  });

  it("keeps an absolute directory path absolute (not re-rooted under cwd)", () => {
    const d = tmp();
    const abs = join(d, "out") + "/";
    expect(resolveOutputPath(abs, "L", d, DATE)).toBe(join(abs, "review-L-20260727.md"));
  });
});

describe("resolveManifestPath", () => {
  it("puts manifests in their own fixed tree, no date in the name", () => {
    expect(resolveManifestPath("L")).toBe("fcq/f-review/manifest/review-L-targets.md");
  });
});

describe("defaultLabel", () => {
  it("is filesystem-safe (no colons or dots)", () => {
    const l = defaultLabel(new Date("2026-06-30T12:34:56.789Z"));
    expect(l).not.toContain(":");
    expect(l).not.toContain(".");
    expect(l).toBe("2026-06-30_12-34-56");
  });
});

describe("renderReport", () => {
  it("renders findings per file with a count", () => {
    const md = renderReport({ "src/a.ts": [finding()] });
    expect(md).toContain("# Code Review Report");
    expect(md).toContain("**1 finding(s)**");
    expect(md).toContain("## src/a.ts");
    expect(md).toContain("hardcoded token");
  });

  it("shows _No issues._ for a clean file", () => {
    const md = renderReport({ "src/clean.ts": [] });
    expect(md).toContain("## src/clean.ts");
    expect(md).toContain("_No issues._");
  });

  it("escapes pipes in messages", () => {
    const md = renderReport({ "a.ts": [finding({ message: "a | b" })] });
    expect(md).toContain("a \\| b");
  });

  it("escapes newlines in cells so the table survives multi-line messages", () => {
    const md = renderReport({ "a.ts": [finding({ message: "line1\nline2" })] });
    expect(md).toContain("line1<br>line2");
  });

  it("renders the suggestion column ('-' when absent)", () => {
    const md = renderReport({
      "a.ts": [finding({ suggestion: "use env var\nnot a literal" }), finding()],
    });
    expect(md).toContain("| use env var<br>not a literal |");
    expect(md).toMatch(/hardcoded token \| - \|/);
  });

  it("renders a FAIL verdict when findings reach the failOn threshold", () => {
    const md = renderReport({ "a.ts": [finding({ severity: "major" })] }, "", "en", "major");
    expect(md).toContain("**Verdict: FAIL**");
    expect(md).toContain("1 finding(s) at or above `major`");
  });

  it("renders a PASS verdict when no finding reaches the threshold", () => {
    const md = renderReport({ "a.ts": [finding({ severity: "minor" })] }, "", "en", "blocker");
    expect(md).toContain("**Verdict: PASS**");
  });

  it("omits the verdict line when failOn is not set", () => {
    const md = renderReport({ "a.ts": [finding()] });
    expect(md).not.toContain("Verdict:");
  });

  it("renders Korean labels when language is ko", () => {
    const md = renderReport({ "a.ts": [finding()], "clean.ts": [] }, "L", "ko");
    expect(md).toContain("# 코드 리뷰 리포트");
    expect(md).toContain("1건 발견");
    expect(md).toContain("_이슈 없음._");
    expect(md).toContain("| 심각도 | 분류 | 라인 | 규칙 | 내용 |");
  });

  it("renders Japanese labels when language is ja", () => {
    const md = renderReport({ "a.ts": [finding()] }, "", "ja");
    expect(md).toContain("# コードレビューレポート");
    expect(md).toContain("1件検出");
  });

  it("summarizes counts per category", () => {
    const md = renderReport({
      "a.ts": [finding(), finding({ category: "tests", severity: "nit" }), finding()],
    });
    expect(md).toContain("security 2, tests 1");
  });
});

describe("baseline", () => {
  it("round-trips: keys parsed from a rendered report match baselineKey", () => {
    const md = renderReport({ "src/a.ts": [finding()], "src/clean.ts": [] });
    const keys = parseReportKeys(md);
    expect(keys.has(baselineKey("src/a.ts", "no-secret"))).toBe(true);
    expect(keys.size).toBe(1);
  });

  it("round-trips a rule containing a pipe", () => {
    const md = renderReport({ "a.ts": [finding({ rule: "no|pipe" })] });
    expect(parseReportKeys(md).has(baselineKey("a.ts", "no|pipe"))).toBe(true);
  });

  it("marks re-found findings as existing in the next report", () => {
    const prev = renderReport({ "a.ts": [finding()] });
    const next = renderReport(
      { "a.ts": [finding(), finding({ rule: "new-rule" })] },
      "",
      "en",
      undefined,
      parseReportKeys(prev)
    );
    expect(next).toContain("**[existing]** hardcoded token");
    expect(next.match(/\*\*\[existing\]\*\*/g)).toHaveLength(1);
  });

  it("loadBaseline picks the latest report in the output dir, ignoring manifests", async () => {
    const d = tmp();
    await writeReport("fcq/report/f-review/review-old.md", { "a.ts": [finding()] }, "", d);
    writeFileSync(join(d, "fcq/report/f-review/review-old-targets.md"), "# Code Review Targets");
    const keys = loadBaseline(undefined, d);
    expect(keys.has(baselineKey("a.ts", "no-secret"))).toBe(true);
  });

  it("loadBaseline returns an empty set when nothing exists", () => {
    expect(loadBaseline(undefined, tmp()).size).toBe(0);
  });
});

describe("renderManifest", () => {
  it("lists targets with mode/range/excludes and count", () => {
    const md = renderManifest(["a.ts", "b.ts"], {
      mode: "explicit files",
      range: null,
      excludes: ["**/*.test.ts"],
    }, "L");
    expect(md).toContain("# Code Review Targets");
    expect(md).toContain("Mode: explicit files");
    expect(md).toContain("Range: — (working tree)");
    expect(md).toContain("Excludes: **/*.test.ts");
    expect(md).toContain("Total: 2 file(s)");
  });

  it("records rubric sources when provided", () => {
    const md = renderManifest(["a.ts"], {
      mode: "explicit files",
      range: null,
      excludes: [],
      rubricSources: { security: "security-baseline.md", nfr: "built-in defaults" },
    });
    expect(md).toContain("Rubric: security ← security-baseline.md, nfr ← built-in defaults");
  });

  it("records the generated timestamp in the body when provided", () => {
    const md = renderManifest(["a.ts"], {
      mode: "explicit files",
      range: null,
      excludes: [],
      generatedAt: manifestTimestamp(DATE),
    });
    expect(md).toContain("Generated: 2026-07-27 09:30:05 UTC");
  });
});

describe("writeReport", () => {
  it("creates parent dirs and writes the file", async () => {
    const d = tmp();
    const path = await writeReport("nested/dir/out.md", { "a.ts": [finding()] }, "L", d);
    expect(path).toBe("nested/dir/out.md");
    expect(existsSync(join(d, "nested/dir/out.md"))).toBe(true);
  });

  it("archives an existing f-review report folder before writing anew", async () => {
    const d = tmp();
    const dir = "fcq/report/f-review";
    await writeReport(join(dir, "review-A-20260726.md"), { "a.ts": [finding()] }, "A", d);
    // second review the next day: old folder is backed up, new report written fresh
    await writeReport(join(dir, "review-B-20260727.md"), { "b.ts": [finding()] }, "B", d, "en", undefined, undefined, DATE);
    expect(existsSync(join(d, dir, "review-A-20260726.md"))).toBe(false); // moved out
    expect(existsSync(join(d, dir, "review-B-20260727.md"))).toBe(true); // fresh
    expect(existsSync(join(d, `${dir}.20260727-093005`, "review-A-20260726.md"))).toBe(true); // archived
  });

  it("never renames an arbitrary --output directory (only f-review)", async () => {
    const d = tmp();
    await writeReport("nested/dir/first.md", { "a.ts": [finding()] }, "A", d);
    await writeReport("nested/dir/second.md", { "b.ts": [finding()] }, "B", d);
    expect(existsSync(join(d, "nested/dir/first.md"))).toBe(true); // untouched
    expect(existsSync(join(d, "nested/dir/second.md"))).toBe(true);
  });

  it("writes an absolute path to that absolute location (not under cwd)", async () => {
    const d = tmp();
    const cwd = tmp();
    const abs = join(d, "report.md");
    await writeReport(abs, { "a.ts": [finding()] }, "L", cwd);
    expect(existsSync(abs)).toBe(true);
    expect(existsSync(join(cwd, abs))).toBe(false);
  });
});
