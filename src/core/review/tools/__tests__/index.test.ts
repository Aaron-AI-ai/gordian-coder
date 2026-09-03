import { describe, it, expect } from "bun:test";
import { REVIEW_TOOLS, runReviewTool } from "../index";
import type { ReviewState } from "../../pipeline/state";

const NAMES = ["file_read", "file_read_diff", "file_find", "code_search", "related_code", "git_history"];

describe("REVIEW_TOOLS", () => {
  it("declares every exploration tool exactly once", () => {
    expect(REVIEW_TOOLS.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("tells the model how to target a hunk from file_read", () => {
    // The hint is why read.ts clamps a non-positive start line. It was present
    // in one adapter and missing from the other before the table existed.
    const spec = REVIEW_TOOLS.find((t) => t.name === "file_read")!;
    expect(spec.description).toContain("@@ -x,y +m,n @@");
    expect(spec.description).toContain("start=m-50");
  });

  it("leaves start_line unbounded so the documented m-50 target is accepted", () => {
    // A `min` here would reject the very value file_read's description asks
    // for; read.ts clamps it instead.
    const args = REVIEW_TOOLS.find((t) => t.name === "file_read")!.args;
    expect(args.start_line.min).toBeUndefined();
    expect(args.end_line.min).toBe(1);
  });

  it("bounds the count arguments the way the adapters used to", () => {
    const related = REVIEW_TOOLS.find((t) => t.name === "related_code")!.args;
    const history = REVIEW_TOOLS.find((t) => t.name === "git_history")!.args;
    expect([related.max_results.min, related.max_results.max]).toEqual([1, 30]);
    expect([history.max_commits.min, history.max_commits.max]).toEqual([1, 10]);
  });

  it("describes every argument", () => {
    for (const spec of REVIEW_TOOLS) {
      for (const [name, arg] of Object.entries(spec.args)) {
        expect(arg.description, `${spec.name}.${name}`).toBeTruthy();
      }
    }
  });
});

describe("runReviewTool", () => {
  it("refuses every tool when no review is active", () => {
    for (const name of NAMES) {
      expect(runReviewTool(undefined, name, {})).toContain("No active review");
    }
  });

  it("reports an unknown tool instead of throwing", () => {
    const st = { active: true } as ReviewState;
    expect(runReviewTool(st, "nope", {})).toContain("Unknown review tool");
  });

  it("does not spend exploration budget when there is no file to act on", () => {
    // related_code / git_history default to the file under review; with none,
    // the call must not count against the iteration budget.
    const st = {
      active: true,
      cwd: process.cwd(),
      ref: null,
      iterations: 0,
      toolCalls: 0,
      callLog: {},
      targets: [],
      currentIndex: 0,
      extraRules: [],
    } as unknown as ReviewState;
    expect(runReviewTool(st, "related_code", {})).toBe("No current file under review.");
    expect(st.iterations).toBe(0);
  });
});
