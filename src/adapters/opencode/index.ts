/**
 * OpenCode Plugin Adapter
 * Bridges core logic with OpenCode's plugin interface
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createReviewModule } from "./review";
import {
  getAllTools,
  processMessage,
  handleEvent,
  beforeToolExecute,
  afterToolExecute,
  type GordianContext,
  type Message,
  type ToolDefinition as CoreToolDefinition,
} from "../../core";

const z = tool.schema;

/**
 * Convert core tool to OpenCode tool format
 */
function convertTool(coreTool: CoreToolDefinition) {
  // Build zod schema from core parameters
  const zodShape: Record<string, unknown> = {};

  for (const [key, param] of Object.entries(coreTool.parameters)) {
    switch (param.type) {
      case "string":
        zodShape[key] = param.required
          ? z.string().describe(param.description)
          : z.string().optional().describe(param.description);
        break;
      case "number":
        zodShape[key] = param.required
          ? z.number().describe(param.description)
          : z.number().optional().describe(param.description);
        break;
      case "boolean":
        zodShape[key] = param.required
          ? z.boolean().describe(param.description)
          : z.boolean().optional().describe(param.description);
        break;
      default:
        zodShape[key] = param.required
          ? z.string().describe(param.description)
          : z.string().optional().describe(param.description);
    }
  }

  return tool({
    description: coreTool.description,
    args: zodShape as Parameters<typeof tool>[0]["args"],
    execute: async (args, _ctx) => {
      const result = await coreTool.execute(args as Record<string, unknown>);
      if (result.success) {
        return JSON.stringify(result.data);
      }
      return result.error || "Error executing tool";
    },
  });
}

/**
 * Convert all core tools to OpenCode tool format
 */
function createOpenCodeTools() {
  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const coreTool of getAllTools()) {
    tools[coreTool.name] = convertTool(coreTool);
  }

  return tools;
}

/**
 * OpenCode Plugin implementation
 */
const OpenCodeAdapter: Plugin = async (input) => {
  const context: GordianContext = {
    sessionId: undefined,
    workingDirectory: input.directory,
    config: {},
  };

  const review = createReviewModule(input);

  return {
    // Register tools from core + k-codereview tools
    tool: { ...createOpenCodeTools(), ...review.tools },

    // k-codereview: inject the per-file review template into the system prompt
    "experimental.chat.system.transform": review.systemTransform,

    // Event handler
    event: async ({ event }) => {
      await handleEvent(
        {
          type: event.type as "session.created" | "session.ended",
          timestamp: Date.now(),
          data: event as unknown as Record<string, unknown>,
        },
        context
      );
    },

    // Hook: before tool execution
    "tool.execute.before": async (hookInput, output) => {
      await beforeToolExecute(
        hookInput.tool,
        output.args as Record<string, unknown>,
        { ...context, sessionId: hookInput.sessionID }
      );
    },

    // Hook: after tool execution
    "tool.execute.after": async (hookInput, hookOutput) => {
      await afterToolExecute(
        hookInput.tool,
        hookOutput,
        { ...context, sessionId: hookInput.sessionID }
      );
    },

    // Hook: chat message interceptor
    "chat.message": async (hookInput, output) => {
      const messageText =
        output.parts
          ?.filter((p) => p.type === "text" && "text" in p)
          .map((p) => ("text" in p ? p.text : ""))
          .join("\n")
          .trim() || "";

      const message: Message = {
        role: "user",
        content: messageText,
      };

      await processMessage(message, {
        ...context,
        sessionId: hookInput.sessionID,
      });
    },
  };
};

export default OpenCodeAdapter;

// Named export so OpenCode's plugin loader discovers it by name when this file
// is referenced directly from `opencode.json`'s `plugin` array.
export const GordianCodereview = OpenCodeAdapter;
