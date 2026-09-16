import { describe, expect, test } from "bun:test";
import {
  registerGuardModule,
  recordCall,
  beforeReviewToolCall,
  afterReviewToolCall,
  escalateLoop,
  guardNativeCall,
  shouldSuppressRepeatOutput,
  shouldSuppressIdempotentReplay,
  isRepeatOutputSuppressible,
  HARD_LIMIT,
  RESERVED_SUBMIT_CALLS,
  type GuardModule,
} from "../repeat-guard";
import { guardExploration, type GuardState } from "../../../core/guard";

// A second feature module with its own session store — nothing from review.
const store = new Map<string, GuardState>();
function fakeState(): GuardState {
  return {
    active: true,
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 6,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
  };
}
const fake: GuardModule = {
  name: "fake",
  lookup: (id) => store.get(id),
  submitTool: "fake_submit",
  explorers: new Set(["fake_read", "fake_search"]),
  idempotentPatterns: { fake_submit: /already recorded/ },
  guard: (st, tool, out, args) => guardExploration(st, "fake-run", tool, out, args, "fake_submit"),
  submitAdvice: " A fake run is active: call fake_submit NOW.",
};
registerGuardModule(fake);

describe("repeat-guard module registry", () => {
  test("a registered module's submit tool is always allowed after exhaustion", () => {
    const s = "reg-1";
    store.set(s, { ...fakeState(), toolBudgetExhausted: true });
    expect(beforeReviewToolCall(s, "fake_submit").allow).toBe(true);
    expect(beforeReviewToolCall(s, "fake_read").allow).toBe(false);
  });

  test("reserved slots are announced with the module's submit tool", () => {
    const s = "reg-2";
    const st = fakeState();
    st.toolCalls = st.maxToolCalls - RESERVED_SUBMIT_CALLS; // next call lands in the reserved zone
    store.set(s, st);
    const d = beforeReviewToolCall(s, "fake_read");
    expect(d.allow).toBe(false);
    expect(d.message).toContain("fake_submit");
    expect(d.message).not.toContain("f_review_submit");
  });

  test("the module's explorers count against exploration, unknown tools do not", () => {
    const s = "reg-3";
    store.set(s, fakeState());
    beforeReviewToolCall(s, "fake_search");
    expect(store.get(s)!.explorationCalls).toBe(1);
    beforeReviewToolCall(s, "some_control_tool");
    expect(store.get(s)!.explorationCalls).toBe(1);
  });

  test("escalateLoop seals the module's state and appends its advice", () => {
    const s = "reg-4";
    store.set(s, fakeState());
    for (let i = 0; i < HARD_LIMIT; i++) recordCall(s, "fake_read", { p: "same" });
    const tail = escalateLoop(s);
    expect(tail).toBe(fake.submitAdvice);
    expect(store.get(s)!.explorationSealed).toBe(true);
  });

  test("native explorers are guarded through the module's guard", () => {
    const s = "reg-5";
    store.set(s, { ...fakeState(), explorationSealed: true });
    recordCall(s, "grep", { pattern: "x" });
    expect(guardNativeCall(s, "grep")).toContain("fake_submit");
  });

  test("repeat suppression covers the module's explorers and its idempotent replays", () => {
    const s = "reg-6";
    store.set(s, fakeState());
    for (let i = 0; i < 3; i++) recordCall(s, "fake_read", { p: 1 });
    expect(shouldSuppressRepeatOutput(s, "fake_read")).toBe(true);
    for (let i = 0; i < 3; i++) recordCall(s, "fake_submit", { p: 1 });
    expect(shouldSuppressIdempotentReplay(s, "fake_submit", "ℹ️ already recorded")).toBe(true);
  });

  test("afterReviewToolCall exhausts the module's budget at the limit", () => {
    const s = "reg-7";
    const st = fakeState();
    st.toolCalls = st.maxToolCalls;
    store.set(s, st);
    const d = afterReviewToolCall(s, "fake_read");
    expect(d.allow).toBe(false);
    expect(d.message).toContain("fake_submit");
    expect(store.get(s)!.toolBudgetExhausted).toBe(true);
  });

  test("a session with no active module is not gated", () => {
    expect(beforeReviewToolCall("reg-none", "anything").allow).toBe(true);
    expect(escalateLoop("reg-none")).toBe("");
  });

  test("todoread output stays repeat-suppressible after the registry refactor", () => {
    const s = "reg-8";
    for (let i = 0; i < 3; i++) recordCall(s, "todoread", {});
    expect(isRepeatOutputSuppressible("todoread")).toBe(true);
    expect(shouldSuppressRepeatOutput(s, "todoread")).toBe(true);
  });
});
