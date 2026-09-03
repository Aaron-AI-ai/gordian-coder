import { describe, expect, test } from "bun:test";
import {
  recordCall,
  isLooping,
  isRepeatOutputSuppressible,
  shouldSuppressRepeatOutput,
  shouldSuppressIdempotentReplay,
  loopNotice,
  escalateLoop,
  guardNativeCall,
  isAlternatingLoop,
  REPEAT_LIMIT,
  HARD_LIMIT,
  MAX_SESSIONS,
} from "../repeat-guard";
import { setState, getState, clearState, type ReviewState } from "../../../core/review/pipeline/state";
import { guardExploration, MAX_DUP_CALLS } from "../../../core/review/pipeline/loop";
import { MAX_ITER } from "../../../core/review/tools/read";

/** Minimal active-review state — escalateLoop touches active/iterations,
 * guardExploration additionally needs the loop-bookkeeping fields. */
function reviewState(): ReviewState {
  return {
    active: true,
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 10,
    explorationSealed: false,
    toolBudgetExhausted: false,
    targets: [],
    currentIndex: 0,
    submitToken: "test-token",
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

  test("detects an alternating A-B-A-B lookup loop even though the streak resets", () => {
    const s = "s-alternating";
    recordCall(s, "code_search", {
      search_text: "RequiredArgsConstructor",
      file_patterns: ["**/*.java"],
    });
    recordCall(s, "file_find", { query_name: "RequiredArgsConstructor" });
    recordCall(s, "code_search", {
      search_text: "RequiredArgsConstructor",
      file_patterns: ["**/*.java"],
    });
    expect(isAlternatingLoop(s)).toBe(false);
    recordCall(s, "file_find", { query_name: "RequiredArgsConstructor" });

    expect(isLooping(s)).toBe(false); // neither exact call was consecutive
    expect(isAlternatingLoop(s)).toBe(true);
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

  test("suppresses only an explicit read-only/exploration allowlist", () => {
    const s = "s-output-policy";
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      recordCall(s, "f_review_submit", { findings: [] });
    }
    expect(isLooping(s)).toBe(true);
    expect(isRepeatOutputSuppressible("f_review_submit")).toBe(false);
    expect(shouldSuppressRepeatOutput(s, "f_review_submit")).toBe(false);

    for (const control of [
      "f_review_judge",
      "f_review_plan",
      "f_review_context",
      "f_review_judge_context",
      "f_review_finalize",
      "bash",
      "batch",
      "unknown_plugin_tool",
    ]) {
      expect(isRepeatOutputSuppressible(control)).toBe(false);
    }

    for (let i = 0; i < REPEAT_LIMIT; i++) recordCall(s, "file_read", { file_path: "a.ts" });
    expect(shouldSuppressRepeatOutput(s, "file_read")).toBe(true);
    for (const explorer of ["read", "glob", "grep", "lsp", "code_search", "git_history"]) {
      expect(isRepeatOutputSuppressible(explorer)).toBe(true);
    }
  });

  test("suppresses control output only after core reports an idempotent replay", () => {
    const s = "s-control-replay";
    for (let i = 0; i < REPEAT_LIMIT; i++) recordCall(s, "f_review_submit", { same: true });
    expect(shouldSuppressIdempotentReplay(s, "f_review_submit", "✅ Review complete")).toBe(false);
    expect(
      shouldSuppressIdempotentReplay(
        s,
        "f_review_submit",
        "ℹ️ Stale/duplicate f_review_submit ignored"
      )
    ).toBe(true);

    const planSession = "s-plan-replay";
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      recordCall(planSession, "f_review_plan", { files: ["a.ts"] });
    }
    expect(
      shouldSuppressIdempotentReplay(
        planSession,
        "f_review_plan",
        "⚠️ Refusing to create another run: 3 unfinished runs already exist"
      )
    ).toBe(true);

    const contextSession = "s-context-replay";
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      recordCall(contextSession, "f_review_context", { files: ["a.ts"] });
    }
    expect(
      shouldSuppressIdempotentReplay(
        contextSession,
        "f_review_context",
        "ℹ️ Duplicate f_review_context ignored; progress was preserved"
      )
    ).toBe(true);
  });

  test("does not treat bash as a native read-only explorer", () => {
    const s = "s-native-bash";
    setState(s, reviewState());
    recordCall(s, "bash", { command: "touch changed" });
    expect(guardNativeCall(s, "bash")).toBe("");
    expect(getState(s)!.iterations).toBe(0);
    clearState(s);
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
      "Exploration is sealed"
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
