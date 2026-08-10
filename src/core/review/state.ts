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
import { targetPath } from "./segment";

export interface ReviewState {
  active: boolean;
  cwd: string;
  targets: string[];
  currentIndex: number;
  categories: Category[];
  diffRange: string | null;
  ref: string | null; // afterRef(diffRange): the version code-search/read operate on
  diffMap: Record<string, string>; // per-file diff snapshot for file_read_diff
  wholeFile: boolean; // review the full file content instead of just the diff
  runId?: string; // set when this session reviews ONE file of a parallel run (Model A)
  systemRule: string;
  frameworkRules: string; // authoritative framework conventions (always injected)
  evidenceCache: Record<string, string>; // related-code + git-history dossier per target
  requirementBackground: string;
  planGuidance: string;
  findings: Record<string, Finding[]>;
  output?: string;
  failOn?: Severity; // CI gate threshold; unset = no gate
  baseline: Set<string>; // finding keys from the previous report (marks re-found issues)
  label: string;
  language: string; // findings/report language, e.g. "ko"
  iterations: number;
  callLog: Record<string, Record<string, number>>; // per-file tool-call audit: file → tool → count
  recheckCount: Record<string, number>; // per-file count of final-check reworks issued (cap MAX_FINAL_RECHECKS)
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
