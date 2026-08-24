/**
 * Per-session review state, kept in an in-memory map keyed by sessionID.
 *
 * The state drives the file-by-file loop: `currentIndex` points at the file
 * being reviewed; when its submit passes the coverage gate the index advances.
 * When the index runs past `targets`, the review is done.
 *
 * ponytail: in-memory Map — review sessions are short-lived and single-process.
 */

import type { Category, Finding, Severity } from "./contract";
import type { ExtraRule } from "./rubric";
import { targetPath } from "./segment";

export interface ReviewState {
  active: boolean;
  cwd: string;
  targets: string[];
  currentIndex: number;
  /** Opaque identity of the current target/round, copied into submit. Rotated
   * after every accepted transition so replayed state-changing calls are stale. */
  submitToken: string;
  categories: Category[];
  diffRange: string | null;
  ref: string | null; // afterRef(diffRange): the version code-search/read operate on
  diffMap: Record<string, string>; // per-file diff snapshot for file_read_diff
  wholeFile: boolean; // review the full file content instead of just the diff
  runId?: string; // set when this session reviews ONE file of a parallel run (Model A)
  systemRule: string;
  frameworkRules: string; // authoritative framework conventions (always injected)
  extraRules: ExtraRule[]; // review/rules/*.md; glob-gated per file at prompt render
  evidenceCache: Record<string, string>; // related-code + git-history dossier per target
  requirementBackground: string;
  planGuidance: string;
  findings: Record<string, Finding[]>;
  output?: string;
  failOn?: Severity; // CI gate threshold; unset = no gate
  baseline: Set<string>; // finding keys from the previous report (marks re-found issues)
  reportContext?: string; // "## Review Context" appendix (params + criteria sources), built at start
  label: string;
  language: string; // findings/report language, e.g. "ko"
  iterations: number;
  maxIter?: number; // per-round exploration budget (config `maxIter`; unset = MAX_ITER)
  toolCalls: number; // session-total calls, including the initial context and submits; never reset
  explorationCalls: number; // session-total exploration attempts; never reset
  maxToolCalls: number; // config `maxToolCalls`; hard ceiling for the reviewer session
  explorationSealed: boolean; // true once only f_review_submit may make progress
  toolBudgetExhausted: boolean; // terminal: watchdog must finalize partial, never auto-resume
  graceCalls?: number; // non-submit calls seen after exhaustion; past GRACE_CALLS the session is aborted
  callLog: Record<string, Record<string, number>>; // per-file tool-call audit: file → tool → count
  dupCalls: Record<string, number>; // exact-duplicate exploration calls (file+tool+args hash); reset per target/round
  missStreak: number; // consecutive not-found exploration results; reset on any hit and per target/round
  recheckCount: Record<string, number>; // per-file count of final-check reworks issued (cap MAX_FINAL_RECHECKS)
  failedSubmits: Record<string, number>; // per-file rejected submits (invalid/incomplete/degenerate; cap MAX_FAILED_SUBMITS)
  staleSubmits: Record<string, number>; // stale submit-token replays per target; bounded to prevent an ignored-call loop
  lastSubmitHash: Record<string, string>; // per-file hash of the last submit the FINAL CHECK bounced — an identical resubmission means re-bouncing is pointless
  lastValidFindings: Record<string, Finding[]>; // per-file findings of the last parseable submit — salvaged if invalid submits later hit the cap
  forcedNotes: Record<string, string>; // per-target force-advance note — propagated into the report/run result so a salvaged review is never mistaken for a clean one
  assessedByTarget: Record<string, Category[]>; // actual categories reported by the accepted/forced submit; forced coverage must not be rewritten as complete
  deepPasses: number; // total review rounds per target (1 = single pass; clamped 1..5)
  deepPassDone: Record<string, number>; // per-target completed rounds (submit gate driver)
  resumes: number; // times the idle watchdog re-drove an incomplete review (cap MAX_RESUMES)
}

// LRU cap: a completed review clears itself, so every lingering entry is an
// in-progress or abandoned (active:true) review. Bound the store and evict the
// least-recently-touched first — the review currently under review is bumped on
// every getState, so it's always newest and never the eviction target.
// ponytail: fixed cap, no TTL — raise if concurrent OpenCode sessions exceed it.
const MAX_SESSIONS = 50;

const store = new Map<string, ReviewState>();

export function setState(sessionId: string, state: ReviewState): void {
  store.delete(sessionId); // re-insert at the tail = most recently touched
  store.set(sessionId, state);
  while (store.size > MAX_SESSIONS) {
    store.delete(store.keys().next().value as string); // head = oldest
  }
}

export function getState(sessionId: string): ReviewState | undefined {
  const state = store.get(sessionId);
  if (state) {
    store.delete(sessionId); // bump recency so the active review is never evicted
    store.set(sessionId, state);
  }
  return state;
}

export function clearState(sessionId: string): void {
  store.delete(sessionId);
}

/** Currently-active review states (for cross-session output-path collision checks). */
export function activeStates(): ReviewState[] {
  return [...store.values()].filter((s) => s.active);
}

/** File currently under review, or undefined when the loop is exhausted. */
export function currentFile(state: ReviewState): string | undefined {
  return state.targets[state.currentIndex];
}

export function rotateSubmitToken(state: ReviewState): void {
  state.submitToken = crypto.randomUUID();
}

/**
 * REAL file path of the current target — a segment target (`path#start-end`)
 * is stripped back to `path`. Anything that touches the filesystem or git
 * (related_code, git_history, …) must use this, never the raw target id:
 * `git log -- src/a.ts#1-500` matches nothing and returns empty evidence.
 */
export function currentFilePath(state: ReviewState): string | undefined {
  const target = currentFile(state);
  return target === undefined ? undefined : targetPath(target);
}

/** Target files other than the current one (for {{change_files}}). */
export function otherFiles(state: ReviewState): string[] {
  const cur = currentFile(state);
  return state.targets.filter((f) => f !== cur);
}

/** True when every target file has been reviewed. */
export function isDone(state: ReviewState): boolean {
  return state.currentIndex >= state.targets.length;
}
