/**
 * Collapse the system-prompt array to a single entry after all plugin
 * transforms ran.
 *
 * OpenCode turns each entry into its own `role:"system"` message at the head
 * of the request. Anthropic-style APIs accept that (and use the split for
 * prompt caching), but strict OpenAI-compatible backends — e.g. Chutes, also
 * reachable via OpenRouter's routing — reject any request whose second system
 * message is "not at the beginning". Joining the entries is semantically
 * identical for every provider and required for the strict ones, so we merge
 * for everyone EXCEPT models that benefit from the multi-entry form
 * (Claude/Anthropic prompt caching).
 */
const MULTI_SYSTEM_SAFE = /anthropic|claude/i;

export function mergeSystemPrompts(hookInput: unknown, system: string[]): void {
  if (system.length <= 1) return;
  // The runtime passes {sessionID, model} but the local SDK types lag behind —
  // scan whatever identifying info is present (providerID/modelID/…).
  let id = "";
  try {
    id = JSON.stringify((hookInput as { model?: unknown })?.model ?? "");
  } catch {
    /* circular/exotic model object: treat as unidentified and merge */
  }
  if (MULTI_SYSTEM_SAFE.test(id)) return;
  const merged = system.filter(Boolean).join("\n\n");
  system.length = 0;
  system.push(merged);
}
