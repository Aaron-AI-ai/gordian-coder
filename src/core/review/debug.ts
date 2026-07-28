/**
 * Opt-in trace logging for verifying review internals (segmentation, injected
 * evidence, per-target prompt composition). Off unless `F_REVIEW_DEBUG` is set
 * to a non-empty value; then `[f-review:*]` lines go to stderr — visible in the
 * OpenCode / MCP server log without touching the model-facing output.
 */

// Set from config at review start (see startReview). The env var still works
// on its own; either source turns tracing on. ponytail: a single process-wide
// flag — concurrent reviews with different debug settings share it (last write
// wins), which is fine for a debug toggle.
let configOverride = false;

/** Turn tracing on/off from a source other than the env var (e.g. config). */
export function setReviewDebug(on: boolean): void {
  configOverride = on;
}

export function reviewDebugEnabled(): boolean {
  return configOverride || !!process.env.F_REVIEW_DEBUG;
}

export function dbg(section: string, message: string): void {
  if (reviewDebugEnabled()) console.error(`[f-review:${section}] ${message}`);
}

const dumped = new Set<string>();

/**
 * Emit at most once per `key`. system.transform re-renders the prompt every
 * turn, so a plain dbg() would repeat the same target's dump on each turn;
 * keying by target logs it once when the target is first composed.
 */
export function dbgOnce(key: string, section: string, message: string): void {
  if (!reviewDebugEnabled() || dumped.has(key)) return;
  dumped.add(key);
  dbg(section, message);
}
