import { describe, expect, test } from "bun:test";
import { matchesCaseSelector, parseFileFindings, resolveLineRange, scoreBugCase, scoreControlCase } from "../freview-eval";

describe("matchesCaseSelector", () => {
  test("no selector matches everything", () => {
    expect(matchesCaseSelector("case-01", undefined)).toBe(true);
  });
  test("exact id must match exactly", () => {
    expect(matchesCaseSelector("case-01", "case-01")).toBe(true);
    expect(matchesCaseSelector("case-02", "case-01")).toBe(false);
  });
  test("glob and comma list", () => {
    expect(matchesCaseSelector("case-05", "case-0*,control-*")).toBe(true);
    expect(matchesCaseSelector("control-02", "case-0*,control-*")).toBe(true);
    expect(matchesCaseSelector("case-10", "case-0*,control-*")).toBe(false);
  });
});

const SAMPLE_REPORT = `# f-review report

## src/main/java/review/AcntBalanceQueryService.java

| severity | category | line | rule | message | suggestion | source |
|---|---|---|---|---|---|---|
| major | correctness | 19 | npe-deref | row가 null일 수 있는데 체크 없이 getAcntNm 호출 | null 체크 추가 | AI |

## src/main/java/review/AcntCleanQueryService.java

(findings 없음 — clean)
`;

describe("parseFileFindings", () => {
  test("extracts the finding rows for the exact file section", () => {
    const rows = parseFileFindings(SAMPLE_REPORT, "src/main/java/review/AcntBalanceQueryService.java");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "major", category: "correctness", line: 19 });
    expect(rows[0].message).toContain("null일 수 있는데");
  });
  test("a section with no table returns empty (clean)", () => {
    expect(parseFileFindings(SAMPLE_REPORT, "src/main/java/review/AcntCleanQueryService.java")).toEqual([]);
  });
  test("a file with no section at all also returns empty", () => {
    expect(parseFileFindings(SAMPLE_REPORT, "no/such/file.java")).toEqual([]);
  });
});

describe("scoreBugCase", () => {
  const c = {
    id: "case-01", kind: "bug" as const,
    file: "src/main/java/review/AcntBalanceQueryService.java",
    category: "correctness", min_severity: "major",
    line_range: [18, 19] as [number, number],
    keywords_any: ["null", "역참조"], commit: "case-01",
  };
  test("passes when category/severity/line/keyword all line up", () => {
    const rows = parseFileFindings(SAMPLE_REPORT, c.file);
    expect(scoreBugCase(c, rows)).toBe(true);
  });
  test("fails when the line is outside tolerance", () => {
    const rows = [{ severity: "major", category: "correctness", line: 99, rule: "x", message: "null 체크", suggestion: "" }];
    expect(scoreBugCase(c, rows)).toBe(false);
  });
  test("fails when severity is weaker than min_severity", () => {
    const rows = [{ severity: "nit", category: "correctness", line: 19, rule: "x", message: "null 체크", suggestion: "" }];
    expect(scoreBugCase(c, rows)).toBe(false);
  });
});

describe("scoreControlCase", () => {
  test("passes with no findings", () => {
    expect(scoreControlCase([])).toBe(true);
  });
  test("passes when only nit-level findings exist", () => {
    expect(scoreControlCase([{ severity: "nit", category: "maintainability", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("fails on a minor-or-worse finding (false positive)", () => {
    expect(scoreControlCase([{ severity: "minor", category: "correctness", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(false);
  });
});

describe("resolveLineRange", () => {
  const base = {
    id: "case-x", kind: "bug" as const, file: "A.java",
    category: "correctness", min_severity: "major", keywords_any: ["x"], commit: "case-x",
  };
  const src = ["package a;", "class A {", "  void f() {", "    row.getName();", "  }", "}"].join("\n");

  test("finds the single line containing the anchor (1-based)", () => {
    expect(resolveLineRange({ ...base, anchor: "row.getName()" }, src)).toEqual([4, 4]);
  });
  test("throws when the anchor matches no line", () => {
    expect(() => resolveLineRange({ ...base, anchor: "nope" }, src)).toThrow(/matched 0 lines/);
  });
  test("throws when the anchor matches more than one line", () => {
    expect(() => resolveLineRange({ ...base, anchor: "a" }, src)).toThrow(/matched \d+ lines/);
  });
  test("falls back to line_range when there is no anchor", () => {
    expect(resolveLineRange({ ...base, line_range: [3, 5] }, src)).toEqual([3, 5]);
  });
  test("throws when neither anchor nor line_range is given", () => {
    expect(() => resolveLineRange(base, src)).toThrow(/needs anchor or line_range/);
  });
});

describe("scoreBugCase with category lists and explicit ranges", () => {
  const c = {
    id: "case-x", kind: "bug" as const, file: "A.java",
    category: ["performance", "maintainability"], min_severity: "minor",
    anchor: "x", keywords_any: ["누수"], commit: "case-x",
  };
  const row = (category: string, line: number) =>
    ({ severity: "major", category, line, rule: "r", message: "리소스 누수", suggestion: "" });

  test("accepts any category from the list", () => {
    expect(scoreBugCase(c, [row("performance", 10)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("maintainability", 10)], [10, 10])).toBe(true);
  });
  test("rejects a category outside the list", () => {
    expect(scoreBugCase(c, [row("security", 10)], [10, 10])).toBe(false);
  });
  test("honors the explicit range with the +-3 tolerance (boundary pass at +3, fail at +4)", () => {
    expect(scoreBugCase(c, [row("performance", 13)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("performance", 14)], [10, 10])).toBe(false);
    expect(scoreBugCase(c, [row("performance", 7)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("performance", 6)], [10, 10])).toBe(false);
  });
});

describe("scoreControlCase ignores the tests category", () => {
  test("a minor 'tests' finding alone does not count as a false positive", () => {
    expect(scoreControlCase([{ severity: "minor", category: "tests", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("a major 'tests' finding is also ignored", () => {
    expect(scoreControlCase([{ severity: "major", category: "tests", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("a minor finding in any other category still fails", () => {
    expect(scoreControlCase([{ severity: "minor", category: "maintainability", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(false);
  });
});
