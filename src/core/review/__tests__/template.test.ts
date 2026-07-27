import { describe, it, expect } from "bun:test";
import { render, buildReviewPrompt, targetVars, TEMPLATE } from "../template";

const full = {
  change_files: "src/b.ts\nsrc/c.ts",
  current_file_path: "src/a.ts",
  ...targetVars("diff", "@@ -1 +1 @@\n-old\n+new"),
  current_system_date_time: "2026-06-30T00:00:00Z",
  requirement_background: "ticket FOO-1",
  system_rule: "- security\n- tests",
  framework_rules: "- project convention",
  review_evidence: "- src/dependency.ts\n- abc123 previous fix",
  plan_guidance: "focus on auth",
};

describe("render", () => {
  it("substitutes every provided variable", () => {
    const out = render(TEMPLATE, full);
    expect(out).toContain("src/a.ts");
    expect(out).toContain("@@ -1 +1 @@");
    expect(out).toContain("ticket FOO-1");
    expect(out).toContain("- security");
    expect(out).toContain("src/dependency.ts");
    expect(out).toContain("abc123 previous fix");
    expect(out).toContain("focus on auth");
    expect(out).not.toContain("{{");
  });

  it("replaces unknown tokens with empty string", () => {
    expect(render("x {{nope}} y", {})).toBe("x  y");
  });

  it("drops the requirement-background section when empty", () => {
    const out = buildReviewPrompt({ ...full, requirement_background: "" });
    expect(out).not.toContain("Requirement Background");
    expect(out).toContain("Review Plan"); // other optional kept
  });

  it("drops the plan section when whitespace-only", () => {
    const out = buildReviewPrompt({ ...full, plan_guidance: "   " });
    expect(out).not.toContain("Review Plan");
  });

  it("keeps optional sections when present", () => {
    const out = buildReviewPrompt(full);
    expect(out).toContain("Requirement Background");
    expect(out).toContain("Review Plan");
  });

  it("always keeps the checklist section", () => {
    const out = buildReviewPrompt({ ...full, requirement_background: "", plan_guidance: "" });
    expect(out).toContain("### Review Checklist");
    expect(out).toContain("- security");
  });
});

describe("targetVars", () => {
  it("frames diff mode around the diff block", () => {
    const out = buildReviewPrompt({ ...full, ...targetVars("diff", "@@ diff @@") });
    expect(out).toContain("<current_file_diff>");
    expect(out).toContain("Review the change in <current_file_diff>");
    expect(out).not.toContain("<current_file>\n");
  });

  it("frames whole-file mode around the full file content", () => {
    const out = buildReviewPrompt({ ...full, ...targetVars("whole", "1|const x = 1") });
    expect(out).toContain("<current_file>");
    expect(out).toContain("1|const x = 1");
    expect(out).toContain("Review the full contents of <current_file>");
    expect(out).not.toContain("<current_file_diff>");
  });

  it("frames segment mode with the line range", () => {
    const out = buildReviewPrompt({
      ...full,
      ...targetVars("segment", "800|const x = 1", { start: 800, end: 1500 }),
    });
    expect(out).toContain("<current_file>");
    expect(out).toContain("lines 800-1500");
    expect(out).toContain("one segment of a large file");
    expect(out).not.toContain("<current_file_diff>");
  });
});
