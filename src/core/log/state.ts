/**
 * Per-session analyst state: the guard counters (spec §13) plus what the
 * submit path needs to bound retries. Everything durable is in run-store.
 *
 * ponytail: in-memory LRU map, same shape and cap as review's state.ts.
 */
import type { GuardState } from "../guard";

export interface LogSession extends GuardState {
  cwd: string;
  runId: string;
  round: number;
  submitToken: string;
  failedSubmits: number;
  staleSubmits: number;
  lastValid?: unknown; // last schema-valid LogSubmission (narrowed in submit.ts)
  resumes: number;
  submitted: boolean;
  readFiles?: Record<string, true>; // repo-relative paths seen via f_log_read/f_log_blame
}

const MAX_SESSIONS = 50;
const store = new Map<string, LogSession>();

export function newLogSession(cwd: string, runId: string, round: number, maxToolCalls: number, maxIter: number): LogSession {
  return {
    active: true,
    cwd,
    runId,
    round,
    submitToken: crypto.randomUUID(),
    failedSubmits: 0,
    staleSubmits: 0,
    resumes: 0,
    submitted: false,
    iterations: 0,
    maxIter,
    toolCalls: 1, // the f_log_context call itself, as f-review counts f_review_context
    explorationCalls: 0,
    maxToolCalls,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
  };
}

export function setLogState(sessionId: string, st: LogSession): void {
  store.delete(sessionId);
  store.set(sessionId, st);
  while (store.size > MAX_SESSIONS) store.delete(store.keys().next().value as string);
}

export function getLogState(sessionId: string): LogSession | undefined {
  const st = store.get(sessionId);
  if (st) {
    store.delete(sessionId);
    store.set(sessionId, st);
  }
  return st;
}

export function clearLogState(sessionId: string): void {
  store.delete(sessionId);
}
