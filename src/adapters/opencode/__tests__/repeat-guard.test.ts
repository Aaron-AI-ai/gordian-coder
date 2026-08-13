import { describe, expect, test } from "bun:test";
import {
  recordCall,
  isLooping,
  loopNotice,
  escalateLoop,
  guardNativeCall,
  REPEAT_LIMIT,
  HARD_LIMIT,
  MAX_SESSIONS,
} from "../repeat-guard";
import { setState, getState, clearState, type ReviewState } from "../../../core/review/state";
import { guardExploration, MAX_DUP_CALLS } from "../../../core/review/loop";
import { MAX_ITER } from "../../../core/review/reader";

/** Minimal active-review state — escalateLoop touches active/iterations,
 * guardExploration additionally needs the loop-bookkeeping fields. */
function reviewState(): ReviewState {
  return {
    active: true,
    iterations: 0,
    targets: [],
    currentIndex: 0,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
  } as unknown as ReviewState;
}

// Each test uses its own session ids — the module map is shared, streaks are not.

describe("repeat-guard", () => {
  test("trips on the REPEAT_LIMIT-th consecutive identical call and stays tripped", () => {
    const s = "s-trip";
    for (let i = 1; i < REPEAT_LIMIT; i++) {
      recordCall(s, "read", { filePath: "a.ts" });
      expect(isLooping(s)).toBe(false);
    }
    recordCall(s, "read", { filePath: "a.ts" });
    expect(isLooping(s)).toBe(true);
    recordCall(s, "read", { filePath: "a.ts" }); // 6th — still suppressed
    expect(isLooping(s)).toBe(true);
    expect(loopNotice(s)).toContain(`${REPEAT_LIMIT + 1} times`);
  });

  test("a different call resets the streak (args or tool)", () => {
    const s = "s-reset";
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) recordCall(s, "read", { filePath: "a.ts" });
    recordCall(s, "read", { filePath: "b.ts" }); // different args → streak cleared
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) {
      recordCall(s, "read", { filePath: "a.ts" });
      expect(isLooping(s)).toBe(false); // restarted from 1
    }
    recordCall(s, "grep", { filePath: "a.ts" }); // same args, different tool → reset
    expect(isLooping(s)).toBe(false);
  });

  test("whitespace-varied args count as the same call", () => {
    const s = "s-ws";
    recordCall(s, "code_search", { file_patterns: ["**/pb/**/*.java"] });
    recordCall(s, "code_search", { file_patterns: ["\n**/pb/**/*.java\n"] });
    recordCall(s, "code_search", { file_patterns: ["  **/pb/**/*.java  "] });
    expect(isLooping(s)).toBe(true); // 3 near-identical calls = one streak
  });

  test("sessions are independent", () => {
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      recordCall("s-ind-1", "read", { p: 1 });
      recordCall("s-ind-2", "read", { p: 2 });
    }
    expect(isLooping("s-ind-1")).toBe(true);
    expect(isLooping("s-ind-2")).toBe(true);
    expect(isLooping("s-ind-3")).toBe(false);
  });

  test("hard loop with an active review exhausts the exploration budget and names the exit", () => {
    const s = "s-hard";
    setState(s, reviewState());
    for (let i = 0; i < HARD_LIMIT - 1; i++) recordCall(s, "read", { p: 1 });
    expect(escalateLoop(s)).toBe(""); // soft zone: suppression only, budget untouched
    expect(getState(s)!.iterations).toBe(0);

    recordCall(s, "read", { p: 1 }); // HARD_LIMIT-th identical call
    expect(escalateLoop(s)).toContain("f_review_submit");
    // Budget poisoned: ANY further exploration call now force-converges,
    // even ones that would reset the repeat-guard streak.
    expect(guardExploration(getState(s)!, "file_read", "fresh content")).toContain(
      "Exploration limit reached"
    );
    clearState(s);
  });

  test("hard loop without an active review stays a plain suppression", () => {
    const s = "s-hard-none";
    for (let i = 0; i < HARD_LIMIT; i++) recordCall(s, "read", { p: 1 });
    expect(escalateLoop(s)).toBe("");

    const s2 = "s-hard-inactive";
    setState(s2, { ...reviewState(), active: false } as ReviewState);
    for (let i = 0; i < HARD_LIMIT; i++) recordCall(s2, "read", { p: 1 });
    expect(escalateLoop(s2)).toBe("");
    expect(getState(s2)!.iterations).toBe(0);
    clearState(s2);
  });

  test("native explorer calls consume the review exploration budget", () => {
    const s = "s-native-budget";
    setState(s, reviewState());
    recordCall(s, "glob", { pattern: "**/*.java" });
    expect(guardNativeCall(s, "glob")).toBe(""); // within budget → output untouched
    expect(getState(s)!.iterations).toBe(1);

    getState(s)!.iterations = MAX_ITER; // budget spent
    recordCall(s, "grep", { pattern: "PBOnlineException" });
    expect(guardNativeCall(s, "grep")).toContain("Exploration limit reached");
    clearState(s);
  });

  test("identical native calls trip the duplicate guard even NON-consecutively", () => {
    const s = "s-native-dup";
    setState(s, reviewState());
    let last = "";
    for (let i = 0; i <= MAX_DUP_CALLS; i++) {
      // Interleave a different call each round — repeat-guard's consecutive
      // streak resets every time, but dupCalls keys on the call itself.
      recordCall(s, "grep", { pattern: `other-${i}` });
      guardNativeCall(s, "grep");
      recordCall(s, "glob", { pattern: "**/pb/framework/site/ext/**/*.java" });
      last = guardNativeCall(s, "glob");
    }
    expect(last).toContain("Duplicate call");
    clearState(s);
  });

  test("native guard is inert for f-review tools, inactive reviews, and non-review sessions", () => {
    const s = "s-native-inert";
    setState(s, reviewState());
    recordCall(s, "code_search", { search_text: "x" }); // f-review tool guards itself
    expect(guardNativeCall(s, "code_search")).toBe("");
    expect(getState(s)!.iterations).toBe(0);

    getState(s)!.missStreak = 2; // native calls must not reset the f-review miss streak
    recordCall(s, "glob", { pattern: "**/*.ts" });
    expect(guardNativeCall(s, "glob")).toBe("");
    expect(getState(s)!.missStreak).toBe(2);
    clearState(s);

    recordCall("s-no-review", "glob", { pattern: "**/*.ts" });
    expect(guardNativeCall("s-no-review", "glob")).toBe("");
  });

  test("evicts the oldest session past MAX_SESSIONS (bounded memory)", () => {
    const old = "s-old";
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) recordCall(old, "read", { p: 0 });
    // Flood with fresh sessions until `old` is evicted.
    for (let i = 0; i < MAX_SESSIONS + 1; i++) recordCall(`s-flood-${i}`, "read", { p: i });
    // Its streak restarted, so the would-be REPEAT_LIMIT-th call counts as 1.
    recordCall(old, "read", { p: 0 });
    expect(isLooping(old)).toBe(false);
  });
});
