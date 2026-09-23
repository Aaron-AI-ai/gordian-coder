/**
 * Session-level exploration guard shared by every feature module (f-review,
 * f-log). A small model in a tool loop is starved, not argued with: past the
 * budget the output is withheld entirely, an exact duplicate is answered at
 * most MAX_DUP_CALLS times, and a run of consecutive misses is cut off.
 *
 * `GuardState` is structural — ReviewState satisfies it as-is, and a new
 * module's session state only has to carry these fields.
 */

import { MAX_ITER } from "./review/tools/read";

export interface GuardState {
  active: boolean;
  iterations: number;
  maxIter?: number; // per-round exploration budget (unset = MAX_ITER)
  toolCalls: number; // session-total calls, never reset
  explorationCalls: number; // session-total exploration attempts, never reset
  maxToolCalls: number; // hard ceiling for the session
  explorationSealed: boolean; // true once only the submit tool may make progress
  toolBudgetExhausted: boolean; // terminal: watchdog must finalize partial, never auto-resume
  graceCalls?: number; // non-submit calls seen after exhaustion
  callLog: Record<string, Record<string, number>>; // scope → tool → count
  dupCalls: Record<string, number>; // scope+tool+args hash → count
  missStreak: number; // consecutive not-found results
}

/** Max times the SAME tool call (identical args) is answered per scope/round;
 * past this, the output is withheld — a looping model gets no new content. */
export const MAX_DUP_CALLS = 2;

/** Max CONSECUTIVE not-found exploration results; past this, output is
 * withheld. Catches the "hunt an external symbol with endless pattern
 * variations" loop that exact-duplicate detection cannot see. */
export const MAX_MISS_STREAK = 4;

/** Not-found openings of the reader ops. Both modules' tools share read.ts /
 * related.ts, so the prefixes are the same for both. */
export const MISS_PREFIXES: readonly string[] = [
  "No matches for:", // code_search
  "// No file matches", // file_find
  "Error: file not found", // file_read
  "Error: diff not found", // file_read_diff
  "No related code candidates", // related_code
  "No git history found", // git_history
  "No blame available", // git_blame (f-log)
  "No callers found", // find_callers (f-log)
];

/**
 * Count an exploration call under `scope` (review: current file; log: runId)
 * and guard against degenerate loops. The op itself still runs — it's local
 * and cheap; the defense is starving the loop of fresh tokens. `submitTool`
 * names the only productive next move in every notice.
 */
export function guardExploration(
  st: GuardState,
  scope: string | undefined,
  tool: string,
  out: string,
  args?: unknown,
  submitTool = "f_review_submit"
): string {
  if (st.explorationSealed) {
    return (
      `⚠️ Exploration is sealed for this session (${st.toolCalls}/${st.maxToolCalls} ` +
      `tool calls used). Output withheld. Call ${submitTool} now.`
    );
  }
  if (scope) {
    const log = (st.callLog[scope] ??= {});
    log[tool] = (log[tool] ?? 0) + 1;
  }
  st.iterations++;
  const budget = st.maxIter ?? MAX_ITER;
  if (st.iterations > budget) {
    return `⚠️ Exploration limit reached (${budget} calls this round) — output withheld. Finish with what you have and call ${submitTool} now. Do not fetch more context through any other tool.`;
  }
  if (args !== undefined) {
    const key = JSON.stringify([scope ?? "", tool, Bun.hash(JSON.stringify(args)).toString()]);
    const n = (st.dupCalls[key] = (st.dupCalls[key] ?? 0) + 1);
    if (n > MAX_DUP_CALLS) {
      return (
        `⚠️ Duplicate call — this exact ${tool} call already ran ${MAX_DUP_CALLS} times and its result does not change; output withheld. ` +
        `Explore something different or call ${submitTool} for ${scope ?? "the current target"} — do not re-fetch this content through any other tool.`
      );
    }
  }
  const miss = MISS_PREFIXES.some((p) => out.startsWith(p));
  st.missStreak = miss ? st.missStreak + 1 : 0;
  if (miss && st.missStreak >= MAX_MISS_STREAK) {
    return (
      `⚠️ ${st.missStreak} consecutive lookups found NOTHING — output withheld. What you are ` +
      `hunting was not resolved by the allowed targeted lookups; it may be external, generated, ` +
      `or a local alias the resolver cannot map. STOP retrying path/name variations with any tool. ` +
      `Conclude with the evidence you already have and call ${submitTool}.`
    );
  }
  return out;
}
