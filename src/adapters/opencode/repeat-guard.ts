/**
 * Session-level repeat-call guard for OpenCode tools (built-ins included).
 *
 * A small/degraded model can fall into re-issuing the exact same tool call
 * forever (the same file read over and over). The f-review tools already
 * starve such loops via guardExploration, but native tools (read/grep/glob/
 * bash) can bypass it. This guard watches every call via tool.execute.before.
 * Once the SAME read-only/exploration call has run REPEAT_LIMIT times in a row,
 * the after-hook replaces its output with a short "switch to something else"
 * notice, starving the loop of fresh tokens. Mutating and control tools are
 * deliberately excluded: after they execute, their real result is part of the
 * state transition and must reach the model. Any different call resets the
 * streak, and only the LAST call per session is stored, so memory stays
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
  recentCalls: RecentCall[];
}

interface RecentCall {
  sig: string;
  tool: string;
  intent?: string;
}

export interface ReviewToolBudgetDecision {
  allow: boolean;
  abort: boolean;
  message: string;
}

/** Keep two calls available for the normal submit plus one corrected submit.
 * The initial f_review_context call is accounted for separately in state. */
export const RESERVED_SUBMIT_CALLS = 2;

/** Non-submit calls tolerated after budget exhaustion before the session is
 * hard-aborted. The window exists so an exhausted session can still emit
 * f_review_submit (the only call that turns spent exploration into a review)
 * instead of being cancelled with its findings still in the model's head. */
export const GRACE_CALLS = 3;
const RECENT_CALLS = 4;

const streaks = new Map<string, Streak>();

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

// Which arg field holds a lookup tool's search term. Add a tool here to make
// it eligible for same-intent alternating-loop detection.
const LOOKUP_ARG_FIELD: Record<string, string> = {
  code_search: "search_text",
  codesearch: "search_text",
  file_find: "query_name",
  grep: "pattern",
};

function normalizedLookupIntent(tool: string, args: unknown): string | undefined {
  const field = LOOKUP_ARG_FIELD[tool];
  if (!field || !args || typeof args !== "object") return undefined;
  const raw = (args as Record<string, unknown>)[field];
  if (typeof raw !== "string") return undefined;
  const normalized = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized ? `lookup:${normalized}` : undefined;
}

/**
 * Tools whose post-execution output is safe to suppress. Keep this an explicit
 * allowlist: unknown plugin/MCP tools and composite tools such as `batch` may
 * mutate state even when their names sound exploratory.
 *
 * Review context/plan/submit/judge/finalize tools are intentionally absent.
 * Their successful response may contain the next target or terminal report.
 */
const REPEAT_OUTPUT_ALLOWLIST = new Set([
  // OpenCode read-only/exploration tools
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "todoread",
  // Ref-scoped f-review exploration tools
  "file_read",
  "file_read_diff",
  "file_find",
  "code_search",
  "related_code",
  "git_history",
]);

/** Record a tool call (call from tool.execute.before). */
export function recordCall(sessionID: string, tool: string, args: unknown): void {
  // Hash the args so a huge payload (e.g. a write's file content) stores a few
  // bytes, never the payload itself. String values are whitespace-normalized
  // first: a degenerate model retries "the same" call with stray newlines or
  // padding, and those must count as repeats, not fresh calls.
  const sig = `${tool}:${Bun.hash(
    JSON.stringify(canonical(args)) ?? ""
  ).toString()}`;
  const prev = streaks.get(sessionID);
  const count = prev?.sig === sig ? prev.count + 1 : 1;
  const recentCalls = [
    ...(prev?.recentCalls ?? []),
    { sig, tool, intent: normalizedLookupIntent(tool, args) },
  ].slice(-RECENT_CALLS);
  streaks.delete(sessionID); // re-insert to refresh recency order
  streaks.set(sessionID, { sig, count, recentCalls });
  if (streaks.size > MAX_SESSIONS) {
    streaks.delete(streaks.keys().next().value!); // oldest-active session
  }
}

/** Detect an A-B-A-B cycle, including two lookup tools chasing the same
 * normalized symbol. Call after recordCall(). */
export function isAlternatingLoop(sessionID: string): boolean {
  const recentCalls = streaks.get(sessionID)?.recentCalls ?? [];
  if (recentCalls.length < RECENT_CALLS) return false;
  const [a, b, c, d] = recentCalls;
  if (!recentCalls.every((call) => REPEAT_OUTPUT_ALLOWLIST.has(call.tool))) return false;
  const exact = a.sig === c.sig && b.sig === d.sig && a.sig !== b.sig;
  const sameIntent =
    !!a.intent &&
    a.intent === b.intent &&
    b.intent === c.intent &&
    c.intent === d.intent &&
    a.tool === c.tool &&
    b.tool === d.tool &&
    a.tool !== b.tool;
  return exact || sameIntent;
}

/** Whether the session's current call is the REPEAT_LIMIT-th (or later)
 * consecutive identical one. Stays true until a different call resets it. */
export function isLooping(sessionID: string): boolean {
  return (streaks.get(sessionID)?.count ?? 0) >= REPEAT_LIMIT;
}

/** Whether an already-executed tool's output may be replaced by loop notice. */
export function isRepeatOutputSuppressible(tool: string): boolean {
  return REPEAT_OUTPUT_ALLOWLIST.has(tool);
}

/** Whether the current call is both repeating and safe to suppress. */
export function shouldSuppressRepeatOutput(sessionID: string, tool: string): boolean {
  return isRepeatOutputSuppressible(tool) && isLooping(sessionID);
}

// Which output pattern marks a control tool's response as a no-op/idempotent
// replay (the core already said "ignored, nothing changed"). Add a tool here
// to make its replies eligible for suppression.
const IDEMPOTENT_REPLAY_PATTERN: Record<string, RegExp> = {
  f_review_submit: /Stale\/duplicate f_review_submit ignored|No active review/,
  f_review_judge: /already recorded|Judge INCOMPLETE|already hit the judge rework cap/,
  f_review_plan: /Refusing to create another run|still being created by another process/,
  f_review_context:
    /Duplicate f_review_context ignored|already has (?:a submitted|a terminal) review artifact/,
};

/** A control tool's result may be shortened only when the core explicitly says
 * this invocation was a no-op/idempotent replay. Fresh transition output is
 * never eligible, preserving next-target/report instructions. */
export function shouldSuppressIdempotentReplay(
  sessionID: string,
  tool: string,
  output: string
): boolean {
  if (!isLooping(sessionID)) return false;
  return IDEMPOTENT_REPLAY_PATTERN[tool]?.test(output) ?? false;
}

/**
 * Hard-loop escalation (call after loopNotice): past HARD_LIMIT, if this
 * session has an active f-review, exhaust its exploration budget so EVERY
 * f-review exploration tool now force-converges ("submit now") — including
 * calls different enough to reset the streak here. f_review_submit becomes the
 * only productive move. The session-total budget remains sealed across rounds.
 * Returns the sentence to append to the notice, or "" when not escalating.
 */
export function escalateLoop(sessionID: string): string {
  if ((streaks.get(sessionID)?.count ?? 0) < HARD_LIMIT) return "";
  const st = getState(sessionID);
  if (!st?.active) return "";
  st.iterations = Math.max(st.iterations, st.maxIter ?? MAX_ITER);
  st.explorationSealed = true;
  return (
    " A review is active in this session: STOP exploring — call f_review_submit " +
    "NOW with the findings you already have."
  );
}

/** Native read-only explorers that bypass the f-review tool wrappers (and so
 * their guards) entirely. `bash` is deliberately absent: it may mutate state,
 * so its already-executed result must never be replaced. f-review tools are not
 * here because they guard themselves. */
const NATIVE_EXPLORERS = new Set([
  "glob",
  "grep",
  "read",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
]);

const REVIEW_EXPLORERS = new Set([
  ...NATIVE_EXPLORERS,
  "file_read",
  "file_read_diff",
  "file_find",
  "code_search",
  "related_code",
  "git_history",
]);

/** Tools exempt from every budget/exhaustion guard below (exact-limit,
 * reserved-slot, post-exhaustion grace window). Today this is only the tool
 * that turns spent exploration into a review; add a tool here only once it
 * needs the same full exemption — a tool needing a *partial* exemption
 * belongs in its own check, not this set. */
const ALWAYS_ALLOWED_TOOLS = new Set(["f_review_submit"]);

function budgetDecision(
  allow: boolean,
  abort: boolean,
  message = ""
): ReviewToolBudgetDecision {
  return { allow, abort, message };
}

// budgetDecision shorthands: name the intent instead of repeating true/false
// pairs at every return site.
const allow = () => budgetDecision(true, false);
const deny = (message: string) => budgetDecision(false, false, message);
const abort = (message: string) => budgetDecision(false, true, message);

/** Session-total preflight for OpenCode tool calls. The context call seeds
 * toolCalls=1; every later call is consumed here before the operation runs. */
export function beforeReviewToolCall(
  sessionID: string,
  tool: string
): ReviewToolBudgetDecision {
  // No active review, or no budget configured — nothing to gate.
  const st = getState(sessionID);
  if (!st?.active) return allow();

  const max = st.maxToolCalls;
  if (!Number.isFinite(max)) return allow();

  // Budget already exhausted: only f_review_submit may still run, and only
  // GRACE_CALLS more non-submit attempts are tolerated before hard-abort.
  if (st.toolBudgetExhausted) {
    // The review only exists once f_review_submit runs, so submit stays
    // callable after exhaustion — killing the session before it can submit
    // throws away everything the exploration budget just paid for.
    if (ALWAYS_ALLOWED_TOOLS.has(tool)) return allow();
    st.graceCalls = (st.graceCalls ?? 0) + 1;
    if (st.graceCalls > GRACE_CALLS) {
      return abort(
        `Review tool-call budget exhausted (maxToolCalls=${max}) and the ` +
          `${GRACE_CALLS}-call submit grace window is spent; aborting the session.`
      );
    }
    return deny(
      `Review tool-call budget exhausted (maxToolCalls=${max}). Only f_review_submit ` +
        `may be called now — submit the review with what you have already seen.`
    );
  }

  // Spend this call against the session-total and (if applicable) the
  // exploration-only counters before any of the checks below run.
  st.toolCalls++;
  const isSubmit = ALWAYS_ALLOWED_TOOLS.has(tool);
  const isExplorer = REVIEW_EXPLORERS.has(tool);
  if (isExplorer) st.explorationCalls++;

  // Last slot check: the exact limit may run only when it is the submit that can finish the
  // review. Later attempts remain pinned to max instead of growing forever.
  // Exhaustion opens the submit-only grace window instead of aborting:
  // the next GRACE_CALLS non-submit calls are refused with a "submit now"
  // notice, and only past that is the session hard-aborted.
  if (st.toolCalls > max || (st.toolCalls === max && !isSubmit)) {
    st.toolCalls = max;
    st.explorationSealed = true;
    st.toolBudgetExhausted = true;
    return deny(
      `Review stopped exploring: maxToolCalls=${max} reached and call ${max} was ${tool}, ` +
        `not f_review_submit. Only f_review_submit may be called now — submit the review ` +
        `with what you have already seen.`
    );
  }

  // Seal exploration (flag only, no return yet) if this call trips an
  // alternating-loop or the tally-based exploration allowance.
  const alternatingLoop = isExplorer && isAlternatingLoop(sessionID);
  if (alternatingLoop) st.explorationSealed = true;

  const explorationLimit = Math.max(0, max - RESERVED_SUBMIT_CALLS - 1);
  if (isExplorer && st.explorationCalls > explorationLimit) st.explorationSealed = true;

  // Reserved slots: the last RESERVED_SUBMIT_CALLS calls are off-limits to
  // anything but submit, regardless of the exploration seal above.
  if (!isSubmit && st.toolCalls > max - RESERVED_SUBMIT_CALLS) {
    st.explorationSealed = true;
    return deny(
      `Tool call ${st.toolCalls}/${max} blocked before execution because this slot was reserved ` +
        `for f_review_submit/recovery. ${max - st.toolCalls} call(s) remain; call ` +
        `f_review_submit now.`
    );
  }

  // Final gate: deny any exploration call while sealed, whether the seal was
  // just set above or persisted from an earlier call in this session.
  if (isExplorer && st.explorationSealed) {
    const reason = alternatingLoop
      ? "an alternating lookup loop was detected"
      : `the ${explorationLimit}-call exploration allowance was consumed`;
    return deny(
      `Exploration blocked before execution because ${reason}. ` +
        `Tool budget: ${st.toolCalls}/${max}; call f_review_submit now.`
    );
  }

  // Nothing blocked this call.
  return allow();
}

/** Reaching the exact limit is terminal unless the permitted submit completed
 * the review, in which case submitReview already cleared the state. No abort
 * here: submit must stay reachable through the grace window so the session
 * can still turn its exploration into a review; the idle watchdog finalizes
 * a partial report if it never does. */
export function afterReviewToolCall(
  sessionID: string,
  tool: string
): ReviewToolBudgetDecision {
  const st = getState(sessionID);
  if (!st?.active || st.toolCalls < st.maxToolCalls) return allow();
  st.explorationSealed = true;
  st.toolBudgetExhausted = true;
  return deny(
    `Review tool-call budget exhausted after ${tool} (${st.toolCalls}/${st.maxToolCalls}). ` +
      `Only f_review_submit may be called now — submit the review with what you have.`
  );
}

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
