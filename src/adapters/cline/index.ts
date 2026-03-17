/**
 * Cline adapter - public API re-exports.
 *
 * Consumers can import from "gordian-coder/cline" to access all
 * Cline-specific types and the main handler function.
 */

// Main handler
export { handleClineHook, toCoreEvent, toClineOutput } from "./handlers";

// Types
export type { ClineHookInput, ClineHookOutput } from "./types";
export { ClineHookInputSchema, ClineHookOutputSchema, ClineModelSchema } from "./types";

// Init / deinit
export { initClineHooks, deinitClineHooks, resolveHooksDir, resolveCommand, generateHookScript, CLINE_HOOK_NAMES } from "./init";
export type { InitOptions, InitResult, DeinitResult } from "./init";
export { InitError, DeinitError } from "./init";
