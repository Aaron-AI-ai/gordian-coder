/**
 * Session-level repeat-call guard for ALL OpenCode tools (built-ins included).
 *
 * A small/degraded model can fall into re-issuing the exact same tool call
 * forever (the same file read over and over). The f-review tools already
 * starve such loops via guardExploration, but native tools (read/grep/glob/
 * bash) bypass it. This guard watches every call via tool.execute.before and,
 * once the SAME call (tool + args) has run REPEAT_LIMIT times in a row, the
 * after-hook replaces the tool output with a short "switch to something else"
 * notice — starving the loop of fresh tokens. Any different call resets the
 * streak, and only the LAST call per session is ever stored, so memory stays
 * O(sessions) with tiny entries, capped by MAX_SESSIONS eviction.
 */

import { getState } from "../../core/review/state";
import { MAX_ITER } from "../../core/review/reader";
import { guardExploration } from "../../core/review/loop";

// ponytail: streak of IDENTICAL calls only — legit polling (same bash command
// 3× while waiting on a build) trips it too; raise REPEAT_LIMIT if that bites.
export const REPEAT_LIMIT = 3;

/** Streak length at which suppression escalates to forced convergence —
 * suppression alone never ENDS a loop, a degraded model can re-issue the
 * suppressed call forever. */
export const HARD_LIMIT = REPEAT_LIMIT * 2;

/** Sessions tracked at once; past this the least-recently-active session is
 * evicted, so the map can never grow without bound. */
export const MAX_SESSIONS = 256;

interface Streak {
  sig: string;
  count: number;
}

const streaks = new Map<string, Streak>();

/** Record a tool call (call from tool.execute.before). */
export function recordCall(sessionID: string, tool: string, args: unknown): void {
  // Hash the args so a huge payload (e.g. a write's file content) stores a few
  // bytes, never the payload itself. String values are whitespace-normalized
  // first: a degenerate model retries "the same" call with stray newlines or
  // padding, and those must count as repeats, not fresh calls.
  const sig = `${tool}:${Bun.hash(
    JSON.stringify(args, (_k, v) =>
      typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v
    ) ?? ""
  ).toString()}`;
  const prev = streaks.get(sessionID);
  const count = prev?.sig === sig ? prev.count + 1 : 1;
  streaks.delete(sessionID); // re-insert to refresh recency order
  streaks.set(sessionID, { sig, count });
  if (streaks.size > MAX_SESSIONS) {
    streaks.delete(streaks.keys().next().value!); // oldest-active session
  }
}

/** Whether the session's current call is the REPEAT_LIMIT-th (or later)
 * consecutive identical one. Stays true until a different call resets it. */
export function isLooping(sessionID: string): boolean {
  return (streaks.get(sessionID)?.count ?? 0) >= REPEAT_LIMIT;
}

/**
 * Hard-loop escalation (call after loopNotice): past HARD_LIMIT, if this
 * session has an active f-review, exhaust its exploration budget so EVERY
 * f-review exploration tool now force-converges ("submit now") — including
 * calls different enough to reset the streak here. f_review_submit becomes the
 * only productive move, and it resets the budget, so recovery is automatic.
 * Returns the sentence to append to the notice, or "" when not escalating.
 */
export function escalateLoop(sessionID: string): string {
  if ((streaks.get(sessionID)?.count ?? 0) < HARD_LIMIT) return "";
  const st = getState(sessionID);
  if (!st?.active) return "";
  st.iterations = Math.max(st.iterations, st.maxIter ?? MAX_ITER);
  return (
    " A review is active in this session: STOP exploring — call f_review_submit " +
    "NOW with the findings you already have."
  );
}

/** Native explorers that bypass the f-review tool wrappers (and so their
 * guards) entirely. f-review tools are NOT here — they guard themselves. */
const NATIVE_EXPLORERS = new Set(["glob", "grep", "read", "bash"]);

/**
 * Count a native exploration call against the active review's guards
 * (budget + exact-duplicate) — a natively-issued Glob/Grep storm otherwise
 * bypasses every f-review guard. Output text is NOT inspected (miss-streak
 * stays f-review-only; the streak is preserved around the call), and the
 * call's identity is the streak signature recordCall just stored — call this
 * AFTER recordCall. Returns the guard notice to replace the tool output
 * with, or "" to leave the output alone.
 */
export function guardNativeCall(sessionID: string, tool: string): string {
  if (!NATIVE_EXPLORERS.has(tool)) return "";
  const st = getState(sessionID);
  if (!st?.active) return "";
  const sig = streaks.get(sessionID)?.sig ?? "";
  const missStreak = st.missStreak;
  const notice = guardExploration(st, tool, "", sig);
  st.missStreak = missStreak; // "" is never a miss — undo the reset
  return notice;
}

/** Replacement output for a suppressed call. */
export function loopNotice(sessionID: string): string {
  const n = streaks.get(sessionID)?.count ?? REPEAT_LIMIT;
  return (
    `⚠️ Loop detected: this exact tool call has now run ${n} times in a row — output withheld. ` +
    `Repeating it again returns nothing new. Switch to a DIFFERENT action (different tool or ` +
    `different arguments), or finish the task with what you already have.`
  );
}
