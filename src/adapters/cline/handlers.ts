/**
 * Cline hooks adapter - request handling logic.
 *
 * Responsibilities:
 *   1. Parse and validate raw JSON from Cline's hook invocation.
 *   2. Transform the Cline wire format into a platform-independent HookEvent.
 *   3. Dispatch the event through the core HookRegistry.
 *   4. Transform the HookResult back into Cline's expected output format.
 *
 * The public entry point `handleClineHook` NEVER throws.
 * It always returns a valid JSON string that Cline can consume.
 */

import { ClineHookInputSchema } from "./types";
import type { ClineHookInput, ClineHookOutput } from "./types";
import { HookName } from "./hooks";
import type { HookEvent, HookResult } from "./hooks";
import { HookRegistry, defaultRegistry } from "./hooks";

// ── Transformation helpers ───────────────────────────────────────

/**
 * Convert a validated ClineHookInput into a platform-independent HookEvent.
 *
 * Key differences between the Cline wire format and the core format:
 *   - `timestamp` is a decimal-string of Unix ms in Cline; a number in core.
 *   - `hookName` must be one of the 8 recognised HookName literals.
 *
 * @throws {ZodError} when `input.hookName` is not a valid HookName.
 */
export function toCoreEvent(input: ClineHookInput): HookEvent {
  return {
    hookName: HookName.parse(input.hookName),
    taskId: input.taskId,
    timestamp: parseInt(input.timestamp, 10),
    workspaceRoots: input.workspaceRoots,
    taskStart: input.taskStart,
    taskResume: input.taskResume,
    taskCancel: input.taskCancel,
    taskComplete: input.taskComplete,
    preToolUse: input.preToolUse,
    postToolUse: input.postToolUse
      ? { ...input.postToolUse, result: input.postToolUse.result }
      : undefined,
    userPromptSubmit: input.userPromptSubmit,
    preCompact: input.preCompact,
  };
}

/**
 * Convert a core HookResult into the Cline wire output format.
 */
export function toClineOutput(result: HookResult): ClineHookOutput {
  return {
    cancel: result.cancel,
    contextModification: result.contextModification,
    errorMessage: result.errorMessage,
  };
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Process a raw JSON string from Cline and return a response JSON string.
 *
 * This function is the single public entry point called by `cli.ts` and
 * directly in tests. It is intentionally fail-safe:
 *   - Invalid JSON  → error output
 *   - Schema mismatch → error output with validation message
 *   - Handler error → error output (registry itself catches handler errors)
 *
 * @param rawJson  The raw stdin payload from Cline.
 * @param registry Optional registry override; defaults to `defaultRegistry`.
 * @returns        A JSON string conforming to {@link ClineHookOutput}.
 */
export async function handleClineHook(
  rawJson: string,
  registry?: HookRegistry
): Promise<string> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return JSON.stringify({
        cancel: false,
        contextModification: "",
        errorMessage: `Error: Invalid JSON input`,
      } satisfies ClineHookOutput);
    }

    const validated = ClineHookInputSchema.safeParse(parsed);
    if (!validated.success) {
      return JSON.stringify({
        cancel: false,
        contextModification: "",
        errorMessage: `Validation error: ${validated.error.message}`,
      } satisfies ClineHookOutput);
    }

    let event: HookEvent;
    try {
      event = toCoreEvent(validated.data);
    } catch (err) {
      return JSON.stringify({
        cancel: false,
        contextModification: "",
        errorMessage: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies ClineHookOutput);
    }

    const reg = registry ?? defaultRegistry;
    const result = await reg.dispatch(event);
    const output = toClineOutput(result);
    return JSON.stringify(output);
  } catch (err) {
    // Outermost safety net — should never be reached in normal operation.
    return JSON.stringify({
      cancel: false,
      contextModification: "",
      errorMessage: `Error: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies ClineHookOutput);
  }
}
