import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterRef,
  fileRead,
  fileReadDiff,
  fileFind,
  codeSearch,
  FILE_READ_MAX_CHARS,
  FILE_READ_MAX_LINES,
  fileLineCount,
  renderFileContent,
  sanitizeFindingLines,
} from "../reader";
import type { Finding } from "../contract";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "k-reader-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("sanitizeFindingLines", () => {
  const finding = (over: Partial<Finding>): Finding => ({
    category: "correctness",
    severity: "minor",
    file: "a.ts",
    rule: "r",
    message: "m",
    ...over,
  });

  it("drops a line past EOF but keeps the finding; valid lines untouched", () => {
    const d = tmp();
    writeFileSync(join(d, "a.ts"), "l1\nl2\nl3\n"); // 3 lines
    const fs = [finding({ line: 2 }), finding({ line: 99 })];
    expect(sanitizeFindingLines(fs, d, null)).toBe(1);
    expect(fs[0].line).toBe(2);
    expect(fs[1].line).toBeUndefined();
    expect(fs).toHaveLength(2);
  });

  it("leaves findings on unreadable files untouched", () => {
    const fs = [finding({ file: "missing.ts", line: 7 })];
    expect(sanitizeFindingLines(fs, tmp(), null)).toBe(0);
    expect(fs[0].line).toBe(7);
  });

  it("fileLineCount ignores a trailing newline", () => {
    const d = tmp();
    writeFileSync(join(d, "a.ts"), "l1\nl2\n");
    expect(fileLineCount(d, null, "a.ts")).toBe(2);
  });
});

describe("afterRef", () => {
  it("returns null for workspace mode", () => {
    expect(afterRef(null)).toBeNull();
  });
  it("takes the end of a range", () => {
    expect(afterRef("HEAD~1..HEAD")).toBe("HEAD");
    expect(afterRef("A..B")).toBe("B");
  });
  it("passes a single ref through", () => {
    expect(afterRef("abc123")).toBe("abc123");
  });
  it("handles a symmetric three-dot range", () => {
    expect(afterRef("main...feature")).toBe("feature");
  });
  it("defaults a missing end to HEAD", () => {
    expect(afterRef("A..")).toBe("HEAD");
  });
});

describe("fileRead (workspace mode)", () => {
  it("reads the whole file, line-numbered, not truncated", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "a\nb\nc");
    const out = fileRead(d, null, "f.ts");
    expect(out).toContain("File: f.ts (Total lines: 3)");
    expect(out).toContain("IS_TRUNCATED: false");
    expect(out).toContain("LINE_RANGE: 1-3");
    expect(out).toContain("1|a");
    expect(out).toContain("3|c");
  });

  it("reads a 1-based inclusive line range", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "1\n2\n3\n4\n5");
    const out = fileRead(d, null, "f.ts", 2, 4);
    expect(out).toContain("LINE_RANGE: 2-4");
    expect(out).toContain("2|2");
    expect(out).toContain("4|4");
    expect(out).not.toContain("5|5");
  });

  it("truncates past the line cap", () => {
    const d = tmp();
    writeFileSync(join(d, "big.ts"), Array.from({ length: 600 }, (_, i) => `L${i}`).join("\n"));
    const out = fileRead(d, null, "big.ts");
    expect(out).toContain("IS_TRUNCATED: true");
    expect(out).toContain(`LINE_RANGE: 1-${FILE_READ_MAX_LINES}`);
  });

  it("errors on start_line > end_line", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "a\nb");
    expect(fileRead(d, null, "f.ts", 2, 1)).toContain("Error");
  });

  it("clamps a <=0 start_line to 1 (hunk m-50 near top of file)", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "1\n2\n3");
    const out = fileRead(d, null, "f.ts", -40, 2);
    expect(out).toContain("LINE_RANGE: 1-2");
    expect(out).toContain("1|1");
    expect(out).not.toContain("Error");
  });

  it("errors on start_line beyond EOF", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "a\nb");
    expect(fileRead(d, null, "f.ts", 99)).toContain("exceeds total lines");
  });

  it("errors on missing file", () => {
    expect(fileRead(tmp(), null, "nope.ts")).toContain("file not found");
  });

  it("does not count a trailing newline as an extra line", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "a\nb\n"); // 2 lines + trailing newline
    const out = fileRead(d, null, "f.ts");
    expect(out).toContain("Total lines: 2");
    expect(out).toContain("LINE_RANGE: 1-2");
    expect(out).not.toContain("3|");
  });

  it("preserves a caller-selected large line window without a character-only cap", () => {
    const d = tmp();
    writeFileSync(
      join(d, "large-window.ts"),
      Array.from({ length: 2_000 }, (_, index) => `${index + 1}-${"x".repeat(20)}`).join("\n")
    );
    const out = fileRead(d, null, "large-window.ts", 1, undefined, 2_000);
    expect(out.length).toBeGreaterThan(FILE_READ_MAX_CHARS);
    expect(out).toContain("IS_TRUNCATED: false");
    expect(out).toContain("LINE_RANGE: 1-2000");
    expect(out).toContain("2000|2000-");
  });
});

describe("renderFileContent", () => {
  it("renders an already-loaded text range with file_read line numbering", () => {
    const out = renderFileContent("rules/guide.md", "one\ntwo\nthree\nfour", 2, 3);
    expect(out).toContain("File: rules/guide.md (Total lines: 4)");
    expect(out).toContain("LINE_RANGE: 2-3");
    expect(out).toContain("2|two");
    expect(out).toContain("3|three");
    expect(out).not.toContain("4|four");
  });

  it("enforces the 500-line default cap without reading from disk", () => {
    const content = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n");
    const out = renderFileContent("rules/large.md", content);
    expect(out).toContain("IS_TRUNCATED: true");
    expect(out).toContain(`LINE_RANGE: 1-${FILE_READ_MAX_LINES}`);
    expect(out).toContain("500|line 500");
    expect(out).not.toContain("501|line 501");
  });

  it("enforces the 16k character default cap", () => {
    const out = renderFileContent("rules/wide.md", "x".repeat(FILE_READ_MAX_CHARS * 2));
    expect(out.length).toBeLessThanOrEqual(FILE_READ_MAX_CHARS);
    expect(out).toContain("IS_TRUNCATED: true");
    expect(out).toEndWith("… (truncated)");
  });
});

describe("fileReadDiff", () => {
  const map = { "a.ts": "diff-A", "b.ts": "diff-B" };

  it("returns diffs for found paths and skips the rest", () => {
    const out = fileReadDiff(map, ["a.ts", "c.ts"]);
    expect(out).toContain("==== FILE: a.ts ====");
    expect(out).toContain("diff-A");
    expect(out).not.toContain("c.ts");
  });

  it("errors when none of the paths are in the change set", () => {
    expect(fileReadDiff(map, ["c.ts"])).toContain("diff not found");
  });

  it("caps oversized diff output", () => {
    const big = { "a.ts": Array.from({ length: 2000 }, (_, i) => `+L${i}`).join("\n") };
    expect(fileReadDiff(big, ["a.ts"])).toContain("(truncated)");
  });
});

describe("fileFind (non-git walk)", () => {
  function fixture(): string {
    const d = tmp();
    writeFileSync(join(d, "UserService.ts"), "x");
    writeFileSync(join(d, "UserServiceTest.ts"), "x");
    writeFileSync(join(d, "other.ts"), "x");
    writeFileSync(join(d, "Makefile"), "x");
    writeFileSync(join(d, "binblob"), "x"); // extensionless, not allowlisted
    return d;
  }

  it("matches filename substring case-insensitively", () => {
    const out = fileFind(fixture(), null, "userservice");
    expect(out).toContain("UserService.ts");
    expect(out).toContain("UserServiceTest.ts");
    expect(out).not.toContain("other.ts");
  });

  it("respects case_sensitive", () => {
    const d = fixture();
    expect(fileFind(d, null, "user", true)).toContain("No file matches");
    expect(fileFind(d, null, "User", true)).toContain("UserService.ts");
  });

  it("finds extensionless files (README/Makefile/etc. are not skipped)", () => {
    const d = fixture();
    expect(fileFind(d, null, "Makefile")).toContain("Makefile");
    expect(fileFind(d, null, "binblob")).toContain("binblob");
  });

  it("reports not found", () => {
    expect(fileFind(tmp(), null, "zzz")).toContain("No file matches");
  });
});

describe("codeSearch (non-git fallback)", () => {
  it("groups matches by file with line numbers", () => {
    const d = tmp();
    writeFileSync(join(d, "x.ts"), "const widget = 1;\nuse(widget);");
    const out = codeSearch(d, null, "widget");
    expect(out).toContain("File: x.ts");
    expect(out).toContain("Match lines: 2");
    expect(out).toContain("1|const widget = 1;");
  });

  it("reports no matches", () => {
    const d = tmp();
    writeFileSync(join(d, "x.ts"), "nothing here");
    expect(codeSearch(d, null, "widget")).toContain("No matches");
  });
});
