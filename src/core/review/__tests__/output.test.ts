import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOutputPath,
  renderReport,
  writeReport,
  renderManifest,
  defaultLabel,
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

describe("resolveOutputPath", () => {
  it("defaults to ./k-codereview/ with auto filename", () => {
    expect(resolveOutputPath(undefined, "L", tmp())).toBe("k-codereview/review-L.md");
  });

  it("treats a trailing-slash param as a directory", () => {
    expect(resolveOutputPath("reports/", "L", tmp())).toBe("reports/review-L.md");
  });

  it("uses an explicit filename as-is", () => {
    expect(resolveOutputPath("reports/pr-42.md", "L", tmp())).toBe("reports/pr-42.md");
  });

  it("reads output from config when no param", () => {
    const d = tmp();
    writeFileSync(join(d, ".k-codereview.json"), JSON.stringify({ output: "docs/rv/" }));
    expect(resolveOutputPath(undefined, "L", d)).toBe("docs/rv/review-L.md");
  });

  it("param overrides config", () => {
    const d = tmp();
    writeFileSync(join(d, ".k-codereview.json"), JSON.stringify({ output: "docs/rv/" }));
    expect(resolveOutputPath("out.md", "L", d)).toBe("out.md");
  });

  it("detects an existing directory without trailing slash", () => {
    const d = tmp();
    mkdirSync(join(d, "reports"));
    expect(resolveOutputPath("reports", "L", d)).toBe("reports/review-L.md");
  });

  it("keeps an absolute directory path absolute (not re-rooted under cwd)", () => {
    const d = tmp();
    const abs = join(d, "out") + "/";
    expect(resolveOutputPath(abs, "L", d)).toBe(join(abs, "review-L.md"));
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
    await writeReport("k-codereview/review-old.md", { "a.ts": [finding()] }, "", d);
    writeFileSync(join(d, "k-codereview/review-old-targets.md"), "# Code Review Targets");
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
      mode: "package scan (src)",
      range: null,
      excludes: ["**/*.test.ts"],
    }, "L");
    expect(md).toContain("# Code Review Targets");
    expect(md).toContain("Mode: package scan (src)");
    expect(md).toContain("Range: — (working tree)");
    expect(md).toContain("Excludes: **/*.test.ts");
    expect(md).toContain("Total: 2 file(s)");
    expect(md).toContain("- a.ts");
    expect(md).toContain("- b.ts");
  });
});

describe("writeReport", () => {
  it("creates parent dirs and writes the file", async () => {
    const d = tmp();
    const path = await writeReport("nested/dir/out.md", { "a.ts": [finding()] }, "L", d);
    expect(path).toBe("nested/dir/out.md");
    expect(existsSync(join(d, "nested/dir/out.md"))).toBe(true);
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
