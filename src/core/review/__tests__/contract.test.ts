import { describe, it, expect } from "bun:test";
import {
  REQUIRED_CATEGORIES,
  FindingSchema,
  splitFix,
  hasFix,
  SubmitSchema,
  coverage,
  atLeast,
  degenerateReason,
  repetitiveText,
  scriptMismatch,
  verdict,
  type Finding,
} from "../contract";

const finding = (over: Partial<Finding> = {}): Finding => ({
  category: "security",
  severity: "major",
  file: "src/a.ts",
  rule: "no-secret",
  message: "hardcoded token",
  ...over,
});

describe("coverage", () => {
  it("returns empty when all required categories are assessed", () => {
    expect(coverage([...REQUIRED_CATEGORIES])).toEqual([]);
  });

  it("returns the missing categories", () => {
    expect(coverage(["security", "performance"])).toEqual([
      "correctness",
      "maintainability",
      "tests",
      "framework",
    ]);
  });

  it("treats an assessed-but-clean category as covered (no findings needed)", () => {
    // assessed everything, found nothing → loop may finish
    expect(coverage([...REQUIRED_CATEGORIES])).toEqual([]);
  });

  it("ignores duplicate assessments", () => {
    expect(
      coverage([
        "security",
        "security",
        "performance",
        "maintainability",
        "correctness",
        "tests",
        "framework",
      ])
    ).toEqual([]);
  });

  it("honors a custom required set", () => {
    expect(coverage(["security"], ["security", "tests"])).toEqual(["tests"]);
  });
});

describe("splitFix", () => {
  it("splits the markers models actually write", () => {
    // Every shape below came out of a real review: fenced fcq output, bare
    // LLM code, bold markers, and the spaced/hyphenless spellings.
    expect(splitFix({ suggestion: "AS-IS:\n```\nint a;\n```\nTO-BE: use long" }))
      .toEqual({ asIs: "```\nint a;\n```", toBe: "use long" });
    expect(splitFix({ suggestion: "**AS-IS:**\nfoo()\n**TO-BE:**\nbar()" }))
      .toEqual({ asIs: "foo()", toBe: "bar()" });
    expect(splitFix({ suggestion: "as is:\nfoo()\nto be:\nbar()" }))
      .toEqual({ asIs: "foo()", toBe: "bar()" });
  });

  it("treats an unmarked suggestion as the corrected code", () => {
    // A bare suggestion has always read as "do this", never as "here is the bug".
    expect(splitFix({ suggestion: "wrap it in a try/catch" })).toEqual({
      toBe: "wrap it in a try/catch",
    });
    expect(splitFix({ suggestion: "TO-BE: use Optional" })).toEqual({ toBe: "use Optional" });
  });

  it("does not match the markers inside code or prose", () => {
    // The words must start a line: `String toBe = ...` is code, not a marker.
    const code = "int x;\nString toBe = compute();";
    expect(splitFix({ suggestion: code })).toEqual({ toBe: code });
  });

  it("prefers the explicit fields over the legacy one", () => {
    expect(splitFix({ asIs: "a", toBe: "b", suggestion: "AS-IS: x\nTO-BE: y" }))
      .toEqual({ asIs: "a", toBe: "b" });
  });

  it("reports whether a finding carries any fix at all", () => {
    expect(hasFix({})).toBe(false);
    expect(hasFix({ suggestion: "   " })).toBe(false);
    expect(hasFix({ toBe: "x" })).toBe(true);
    expect(hasFix({ suggestion: "AS-IS: x" })).toBe(true);
  });
});

describe("FindingSchema", () => {
  it("accepts a valid finding", () => {
    expect(FindingSchema.safeParse(finding()).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    expect(FindingSchema.safeParse(finding({ category: "style" as never })).success).toBe(false);
  });

  it("rejects a non-positive line", () => {
    expect(FindingSchema.safeParse(finding({ line: 0 })).success).toBe(false);
  });

  it("allows line to be omitted", () => {
    const { line, ...rest } = finding();
    expect(FindingSchema.safeParse(rest).success).toBe(true);
  });

  it("truncates runaway-length text instead of rejecting the finding", () => {
    const r = FindingSchema.safeParse(
      finding({
        message: "x".repeat(2001),
        rule: "x".repeat(501),
        asIs: "x".repeat(3001),
        toBe: "x".repeat(4001),
        suggestion: "x".repeat(7001),
      })
    );
    expect(r.success).toBe(true);
    expect(r.data!.message).toHaveLength(2000);
    expect(r.data!.rule).toHaveLength(500);
    // asIs and toBe are budgeted separately: a long AS-IS must never be able
    // to eat into the corrected code.
    expect(r.data!.asIs).toHaveLength(3000);
    expect(r.data!.toBe).toHaveLength(4000);
    expect(r.data!.suggestion).toHaveLength(7000);
  });
});

describe("degenerate-output detection", () => {
  it("repetitiveText flags a phrase looping past the length floor", () => {
    expect(repetitiveText("this code has an issue. ".repeat(20))).toBe(true);
    expect(repetitiveText("this code has an issue.")).toBe(false); // short = never flagged
  });

  it("repetitiveText passes normal long prose", () => {
    const prose =
      "The cache key omits the tenant id, so two tenants requesting the same resource " +
      "share one entry. The first tenant's response is then served to the second, which " +
      "leaks data across tenant boundaries and must be fixed before release.";
    expect(repetitiveText(prose)).toBe(false);
  });

  it("scriptMismatch flags Chinese output in a ko/en review but not in ja", () => {
    const zh = "这个代码存在严重的安全问题，需要立即修复。这个函数没有验证输入参数。";
    expect(scriptMismatch(zh, "ko")).toBe(true);
    expect(scriptMismatch(zh, "en")).toBe(true);
    expect(scriptMismatch(zh, "ja")).toBe(false); // kanji is legitimate Japanese
    expect(scriptMismatch("이 코드는 입력 검증이 누락되어 보안 문제가 있습니다.", "ko")).toBe(false);
    expect(scriptMismatch("短い", "ko")).toBe(false); // under the judgment floor
  });

  it("degenerateReason checks rule/message but not suggestion", () => {
    expect(degenerateReason(finding(), "ko")).toBeNull();
    expect(degenerateReason(finding({ message: "loop ".repeat(50) }), "ko")).toContain("repetitive");
    expect(
      degenerateReason(finding({ message: "这个代码存在严重的安全问题需要立即修复没有验证输入" }), "ko")
    ).toContain("script");
    // code in `suggestion` may repeat legitimately — never flagged
    expect(degenerateReason(finding({ suggestion: "await retry(); ".repeat(30) }), "ko")).toBeNull();
  });
});

describe("atLeast", () => {
  it("orders severities most-severe-first", () => {
    expect(atLeast("blocker", "major")).toBe(true);
    expect(atLeast("major", "major")).toBe(true);
    expect(atLeast("minor", "major")).toBe(false);
    expect(atLeast("nit", "blocker")).toBe(false);
  });
});

describe("verdict", () => {
  it("passes when no finding reaches the threshold", () => {
    expect(verdict([finding({ severity: "minor" })], "major")).toEqual({
      pass: true,
      failing: 0,
    });
  });

  it("fails and counts findings at or above the threshold", () => {
    const fs = [
      finding({ severity: "blocker" }),
      finding({ severity: "major" }),
      finding({ severity: "nit" }),
    ];
    expect(verdict(fs, "major")).toEqual({ pass: false, failing: 2 });
  });

  it("passes on an empty finding list", () => {
    expect(verdict([], "nit")).toEqual({ pass: true, failing: 0 });
  });
});

describe("SubmitSchema", () => {
  it("accepts assessed with empty findings", () => {
    const r = SubmitSchema.safeParse({ assessed: [...REQUIRED_CATEGORIES], findings: [] });
    expect(r.success).toBe(true);
  });

  it("rejects missing assessed field", () => {
    expect(SubmitSchema.safeParse({ findings: [] }).success).toBe(false);
  });

  it("keeps the first 50 findings instead of rejecting an oversized submit", () => {
    const findings = Array.from({ length: 51 }, () => finding());
    const r = SubmitSchema.safeParse({ assessed: [...REQUIRED_CATEGORIES], findings });
    expect(r.success).toBe(true);
    expect(r.data!.findings).toHaveLength(50);
  });
});
