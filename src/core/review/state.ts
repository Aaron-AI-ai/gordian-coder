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

export interface ReviewState {
  active: boolean;
  cwd: string;
  targets: string[];
  currentIndex: number;
  categories: Category[];
  diffRange: string | null;
  ref: string | null; // afterRef(diffRange): the version code-search/read operate on
  diffMap: Record<string, string>; // per-file diff snapshot for file_read_diff
  systemRule: string;
  frameworkRules: string; // authoritative framework conventions (always injected)
  requirementBackground: string;
  planGuidance: string;
  findings: Record<string, Finding[]>;
  output?: string;
  failOn?: Severity; // CI gate threshold; unset = no gate
  label: string;
  language: string; // findings/report language, e.g. "ko"
  iterations: number;
}

const store = new Map<string, ReviewState>();

export function setState(sessionId: string, state: ReviewState): void {
  store.set(sessionId, state);
}

export function getState(sessionId: string): ReviewState | undefined {
  return store.get(sessionId);
}

export function clearState(sessionId: string): void {
  store.delete(sessionId);
}

/** File currently under review, or undefined when the loop is exhausted. */
export function currentFile(state: ReviewState): string | undefined {
  return state.targets[state.currentIndex];
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
