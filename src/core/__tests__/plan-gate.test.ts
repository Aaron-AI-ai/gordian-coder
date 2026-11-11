import { describe, expect, test } from "bun:test";
import { MAX_WAIT_CALLS, awaitingReply, noteReply, takeAbort, type PlanGateState } from "../plan-gate";

const fresh = (): PlanGateState => ({ stage: "plan", awaitingCalls: 0 });

describe("plan-gate", () => {
  test("not awaiting before a plan is recorded", () => {
    expect(awaitingReply(fresh())).toBe(false);
  });
  test("awaiting once planned with no user reply", () => {
    expect(awaitingReply({ ...fresh(), planAt: 10 })).toBe(true);
  });
  test("a newer reply releases the gate and resets the counter", () => {
    const s = { ...fresh(), planAt: 10, awaitingCalls: 2 };
    noteReply(s, 11);
    expect(awaitingReply(s)).toBe(false);
    expect(s.awaitingCalls).toBe(0);
  });
  test("an older createdAt never moves userRepliedAt back", () => {
    const s = { ...fresh(), planAt: 10, userRepliedAt: 11 };
    noteReply(s, 5);
    expect(s.userRepliedAt).toBe(11);
  });
  test("takeAbort fires once at the limit", () => {
    const s = { ...fresh(), awaitingCalls: MAX_WAIT_CALLS };
    expect(takeAbort(s)).toBe(true);
    expect(takeAbort(s)).toBe(false);
  });
});
