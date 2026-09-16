import { describe, expect, test } from "bun:test";
import { guardExploration, MAX_DUP_CALLS, MAX_MISS_STREAK, type GuardState } from "../guard";
import { MAX_ITER } from "../review/tools/read";

function state(over: Partial<GuardState> = {}): GuardState {
  return {
    active: true,
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 10,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
    ...over,
  };
}

describe("core guard", () => {
  test("passes fresh output through and logs the call under the scope", () => {
    const st = state();
    expect(guardExploration(st, "run-1", "f_log_read", "content", { p: 1 })).toBe("content");
    expect(st.iterations).toBe(1);
    expect(st.callLog["run-1"]).toEqual({ f_log_read: 1 });
  });

  test("withholds output past the per-round budget and names the submit tool", () => {
    const st = state({ iterations: MAX_ITER });
    const out = guardExploration(st, "run-1", "f_log_read", "content", undefined, "f_log_submit");
    expect(out).toContain("Exploration limit reached");
    expect(out).toContain("f_log_submit");
    expect(out).not.toContain("content");
  });

  test("withholds an exact duplicate past MAX_DUP_CALLS", () => {
    const st = state();
    for (let i = 0; i < MAX_DUP_CALLS; i++) {
      expect(guardExploration(st, "s", "t", "x", { a: 1 })).toBe("x");
    }
    expect(guardExploration(st, "s", "t", "x", { a: 1 })).toContain("Duplicate call");
  });

  test("withholds after MAX_MISS_STREAK consecutive misses and resets on a hit", () => {
    const st = state();
    for (let i = 0; i < MAX_MISS_STREAK - 1; i++) {
      guardExploration(st, "s", "code_search", "No matches for: x" + i);
    }
    expect(guardExploration(st, "s", "code_search", "No matches for: y")).toContain("found NOTHING");
    guardExploration(st, "s", "code_search", "hit");
    expect(st.missStreak).toBe(0);
  });

  test("sealed exploration withholds regardless of budget", () => {
    const st = state({ explorationSealed: true });
    expect(guardExploration(st, "s", "t", "x")).toContain("Exploration is sealed");
  });
});
