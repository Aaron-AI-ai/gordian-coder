import { describe, it, expect } from "bun:test";
import {
  REQUIRED_CATEGORIES,
  FindingSchema,
  SubmitSchema,
  coverage,
  atLeast,
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
    expect(coverage(["security", "nfr"])).toEqual(["correctness", "tests", "framework"]);
  });

  it("treats an assessed-but-clean category as covered (no findings needed)", () => {
    // assessed everything, found nothing → loop may finish
    expect(coverage([...REQUIRED_CATEGORIES])).toEqual([]);
  });

  it("ignores duplicate assessments", () => {
    expect(coverage(["security", "security", "nfr", "correctness", "tests", "framework"])).toEqual(
      []
    );
  });

  it("honors a custom required set", () => {
    expect(coverage(["security"], ["security", "tests"])).toEqual(["tests"]);
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
});
