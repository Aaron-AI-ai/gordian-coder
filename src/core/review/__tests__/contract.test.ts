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
  dedupeFindings,
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

describe("dedupeFindings", () => {
  // The case this exists for: a file over SEGMENT_THRESHOLD is reviewed as
  // overlapping segments, so an issue in an overlap band is submitted twice.

  it("collapses byte-identical repeats", () => {
    const f = finding({ line: 450 });
    expect(dedupeFindings([f, f, f])).toEqual([f]);
  });

  it("collapses two segments wording the same rule differently", () => {
    const a = finding({ line: 450, rule: "no-secret", message: "토큰이 하드코딩되어 있습니다" });
    const b = finding({ line: 450, rule: "  No-Secret  ", message: "하드코딩된 토큰 사용" });
    expect(dedupeFindings([a, b])).toEqual([a]);
  });

  it("collapses on an identical message even when the rule text drifted", () => {
    const a = finding({ line: 450, rule: "no-secret", message: "hardcoded token" });
    const b = finding({ line: 450, rule: "secrets/no-hardcoded", message: "Hardcoded token." });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it("ignores case, whitespace and punctuation when matching", () => {
    const a = finding({ line: 12, rule: "N+1 query", message: "loop issues one query per row" });
    const b = finding({ line: 12, rule: "n+1  QUERY!", message: "Loop issues one query, per row." });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it("collapses a chain: A matches B by rule, B matches C by message", () => {
    const a = finding({ line: 7, rule: "npe", message: "first phrasing" });
    const b = finding({ line: 7, rule: "npe", message: "second phrasing" });
    const c = finding({ line: 7, rule: "null-check", message: "second phrasing" });
    expect(dedupeFindings([a, b, c])).toHaveLength(1);
  });

  it("collapses file-level (line-less) repeats", () => {
    const a = finding({ rule: "missing-tests", message: "no test file" });
    const b = finding({ rule: "missing-tests", message: "there is no test file" });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  // ── must NOT collapse: distinct issues that merely share an anchor ──

  it("keeps two unrelated issues on the same line of the same file", () => {
    const a = finding({ line: 450, rule: "no-secret", message: "hardcoded token" });
    const b = finding({ line: 450, rule: "naming", message: "variable name is not descriptive" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps the same rule reported in different categories on one line", () => {
    const a = finding({ line: 450, category: "security", rule: "unvalidated input" });
    const b = finding({ line: 450, category: "correctness", rule: "unvalidated input" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps the same rule and message on different lines", () => {
    const a = finding({ line: 450, rule: "no-secret", message: "hardcoded token" });
    const b = finding({ line: 902, rule: "no-secret", message: "hardcoded token" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps a line-anchored finding apart from the file-level one", () => {
    const a = finding({ line: 450, rule: "no-secret", message: "hardcoded token" });
    const b = finding({ rule: "no-secret", message: "hardcoded token" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps the same rule and message reported against different files", () => {
    const a = finding({ file: "src/a.ts", line: 5 });
    const b = finding({ file: "src/b.ts", line: 5 });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps findings whose rule and message are both empty rather than folding them", () => {
    const a = finding({ line: 1, rule: "", message: "" });
    const b = finding({ line: 1, rule: "", message: "" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps everything when nothing repeats, in order", () => {
    const fs = [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 3 })];
    expect(dedupeFindings(fs)).toEqual(fs);
  });

  it("returns an empty array for no findings", () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  // ── what survives a collapse ──

  it("keeps the copy carrying the corrected code", () => {
    const bare = finding({ line: 450, rule: "npe", message: "possible NPE" });
    const rich = finding({ line: 450, rule: "npe", message: "NPE", toBe: "if (x != null) {}" });
    expect(dedupeFindings([bare, rich])[0]).toEqual(rich);
    expect(dedupeFindings([rich, bare])[0]).toEqual(rich);
  });

  it("prefers AS-IS + TO-BE over TO-BE alone", () => {
    const half = finding({ line: 3, rule: "npe", toBe: "b" });
    const full = finding({ line: 3, rule: "npe", asIs: "a", toBe: "b" });
    expect(dedupeFindings([half, full])[0]).toEqual(full);
  });

  it("reads a fix out of the legacy suggestion field too", () => {
    const bare = finding({ line: 3, rule: "npe" });
    const legacy = finding({ line: 3, rule: "npe", suggestion: "AS-IS:\na\nTO-BE:\nb" });
    expect(dedupeFindings([bare, legacy])[0]).toEqual(legacy);
  });

  it("falls back to the fuller message when neither copy has a fix", () => {
    const short = finding({ line: 8, rule: "npe", message: "NPE" });
    const long = finding({ line: 8, rule: "npe", message: "NPE when the cache misses" });
    expect(dedupeFindings([short, long])[0]).toEqual(long);
  });

  it("never softens the severity, whichever copy wins the merge", () => {
    const minor = finding({ line: 9, severity: "minor", rule: "npe", toBe: "guard()" });
    const blocker = finding({ line: 9, severity: "blocker", rule: "npe", message: "crashes" });
    // The `minor` copy wins on fix detail but must not downgrade the gate.
    expect(dedupeFindings([blocker, minor])[0]).toEqual({ ...minor, severity: "blocker" });
    expect(dedupeFindings([minor, blocker])[0]).toEqual({ ...minor, severity: "blocker" });
  });

  it("keeps the CI gate counting a collapsed issue once", () => {
    const f = finding({ line: 450, severity: "blocker" });
    expect(verdict(dedupeFindings([f, f]), "major")).toEqual({ pass: false, failing: 1 });
  });

  it("preserves first-seen order when a later duplicate wins", () => {
    const a = finding({ line: 1, rule: "a" });
    const b = finding({ line: 2, rule: "b" });
    const bRich = finding({ line: 2, rule: "b", toBe: "fix" });
    expect(dedupeFindings([a, b, bRich]).map((f) => f.rule)).toEqual(["a", "b"]);
    expect(dedupeFindings([a, b, bRich])[1]).toEqual(bRich);
  });

  it("does not mutate the input array or its findings", () => {
    const a = finding({ line: 5, severity: "minor", rule: "npe" });
    const b = finding({ line: 5, severity: "blocker", rule: "npe" });
    const input = [a, b];
    dedupeFindings(input);
    expect(input).toHaveLength(2);
    expect(a.severity).toBe("minor");
  });
});
