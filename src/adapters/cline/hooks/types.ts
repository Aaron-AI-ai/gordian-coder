/**
 * Type definitions for the Gordian Coder hook system
 */

import { z } from "zod";

export const HookName = z.enum([
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "TaskComplete",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
]);

export type HookName = z.infer<typeof HookName>;

export const TaskPayloadSchema = z.object({
  task: z.string(),
});

export const PreToolUsePayloadSchema = z.object({
  tool: z.string(),
  parameters: z.record(z.unknown()),
});

export const PostToolUsePayloadSchema = z.object({
  tool: z.string(),
  parameters: z.record(z.unknown()),
  result: z.unknown(),
  success: z.boolean(),
  durationMs: z.number(),
});

export const UserPromptSubmitPayloadSchema = z.object({
  prompt: z.string(),
});

export const PreCompactPayloadSchema = z.object({
  conversationLength: z.number(),
  estimatedTokens: z.number(),
});

export const HookEventSchema = z.object({
  hookName: HookName,
  taskId: z.string(),
  timestamp: z.number(),
  workspaceRoots: z.array(z.string()).optional(),
  taskStart: TaskPayloadSchema.optional(),
  taskResume: TaskPayloadSchema.optional(),
  taskCancel: TaskPayloadSchema.optional(),
  taskComplete: TaskPayloadSchema.optional(),
  preToolUse: PreToolUsePayloadSchema.optional(),
  postToolUse: PostToolUsePayloadSchema.optional(),
  userPromptSubmit: UserPromptSubmitPayloadSchema.optional(),
  preCompact: PreCompactPayloadSchema.optional(),
});

export type HookEvent = z.infer<typeof HookEventSchema>;

export const HookResultSchema = z.object({
  cancel: z.boolean().default(false),
  contextModification: z.string().default(""),
  errorMessage: z.string().default(""),
});

export type HookResult = z.infer<typeof HookResultSchema>;

// The handler function type
export type HookHandler = (event: HookEvent) => Promise<HookResult>;
