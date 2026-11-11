/** Plan wait gate shared by the plan-then-execute workflows. */

/** Refused calls while the plan waits for the user before the turn is aborted. */
export const MAX_WAIT_CALLS = 3;

export interface PlanGateState {
  stage: string;
  planAt?: number;
  userRepliedAt?: number;
  /** Tool calls refused while the plan waits for the user. */
  awaitingCalls: number;
}

/** A recorded plan the user has not answered yet. */
export function awaitingReply(s: PlanGateState): boolean {
  if (s.stage !== "plan" || s.planAt === undefined) return false;
  return s.userRepliedAt === undefined || s.userRepliedAt <= s.planAt;
}

/** A real user turn: the only thing that can unlock plan approval. */
export function noteReply(s: PlanGateState, createdAt: number): void {
  // A late update to an older message must not move the reply back before the plan.
  s.userRepliedAt = Math.max(s.userRepliedAt ?? 0, createdAt);
  s.awaitingCalls = 0;
}

/**
 * True once when the model keeps calling tools while the plan waits. A model
 * that ignores "END YOUR TURN" otherwise loops until its step limit, so the
 * adapter aborts the turn instead.
 */
export function takeAbort(s: PlanGateState): boolean {
  if (s.awaitingCalls < MAX_WAIT_CALLS) return false;
  s.awaitingCalls = 0;
  return true;
}
