import { describe, expect, it } from "bun:test";
import { createReviewTools } from "../review";

describe("MCP review tools", () => {
  it("exposes deterministic related-code and git-history exploration", () => {
    const names = createReviewTools().map((tool) => tool.name);
    expect(names).toContain("related_code");
    expect(names).toContain("git_history");
    expect(names.at(-1)).toBe("f_review_submit");
  });

  it("keeps evidence tools inside an active review session", async () => {
    const related = createReviewTools().find((tool) => tool.name === "related_code")!;
    const result = await related.execute({});
    expect(result.success).toBe(true);
    expect(result.data).toContain("No active review");
  });
});
