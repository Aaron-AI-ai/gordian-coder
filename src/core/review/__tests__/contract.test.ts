import { describe, it, expect } from "bun:test";
import {
  REQUIRED_CATEGORIES,
  FindingSchema,
  SubmitSchema,
  coverage,
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

describe("SubmitSchema", () => {
  it("accepts assessed with empty findings", () => {
    const r = SubmitSchema.safeParse({ assessed: [...REQUIRED_CATEGORIES], findings: [] });
    expect(r.success).toBe(true);
  });

  it("rejects missing assessed field", () => {
    expect(SubmitSchema.safeParse({ findings: [] }).success).toBe(false);
  });
});
