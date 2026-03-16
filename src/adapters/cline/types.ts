/**
 * Cline-specific Zod schemas for the hooks adapter.
 *
 * Cline sends hook payloads as JSON over stdin to the adapter process.
 * These schemas validate and type that wire format before we transform
 * it into platform-independent core HookEvent objects.
 */

import { z } from "zod";

// ── Model info (optional, sent by Cline) ────────────────────────

export const ClineModelSchema = z
  .object({
    provider: z.string(),
    slug: z.string(),
  })
  .optional();

// ── Top-level hook input ─────────────────────────────────────────

export const ClineHookInputSchema = z.object({
  taskId: z.string(),
  hookName: z.string(),
  clineVersion: z.string(),
  /** Unix epoch in milliseconds, sent as a string by Cline */
  timestamp: z.string(),
  workspaceRoots: z.array(z.string()).optional(),
  userId: z.string().optional(),
  model: ClineModelSchema,

  // Hook-specific payloads — at most one of these is present per event
  taskStart: z.object({ task: z.string() }).optional(),
  taskResume: z.object({ task: z.string() }).optional(),
  taskCancel: z.object({ task: z.string() }).optional(),
  taskComplete: z.object({ task: z.string() }).optional(),

  preToolUse: z
    .object({ tool: z.string(), parameters: z.record(z.unknown()) })
    .optional(),

  postToolUse: z
    .object({
      tool: z.string(),
      parameters: z.record(z.unknown()),
      result: z.unknown(),
      success: z.boolean(),
      durationMs: z.number(),
    })
    .optional(),

  userPromptSubmit: z.object({ prompt: z.string() }).optional(),

  preCompact: z
    .object({
      conversationLength: z.number(),
      estimatedTokens: z.number(),
    })
    .optional(),
});

export type ClineHookInput = z.infer<typeof ClineHookInputSchema>;

// ── Output written back to Cline ────────────────────────────────

export const ClineHookOutputSchema = z.object({
  cancel: z.boolean(),
  contextModification: z.string(),
  errorMessage: z.string(),
});

export type ClineHookOutput = z.infer<typeof ClineHookOutputSchema>;
