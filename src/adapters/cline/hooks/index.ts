/**
 * Core hooks module - public API
 */

export {
  HookName,
  HookEventSchema,
  HookResultSchema,
  TaskPayloadSchema,
  PreToolUsePayloadSchema,
  PostToolUsePayloadSchema,
  UserPromptSubmitPayloadSchema,
  PreCompactPayloadSchema,
} from "./types";

export type { HookEvent, HookResult, HookHandler } from "./types";

export {
  HookRegistry,
  defaultRegistry,
  registerHook,
} from "./registry";
