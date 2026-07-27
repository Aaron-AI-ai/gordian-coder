/**
 * OpenCode Plugin Adapter
 * Bridges core logic with OpenCode's plugin interface
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { VERSION } from "../../version";
import { createModules } from "./modules";
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
  // Printed to the OpenCode server log on load — lets you verify which build is
  // actually deployed (the plugin path points at a local dist bundle).
  console.error(`[gordian-coder] opencode plugin v${VERSION} loaded`);

  const context: GordianContext = {
    sessionId: undefined,
    workingDirectory: input.directory,
    config: {},
  };

  // Feature modules come from the registry (modules.ts) — register new
  // modules there; this file stays untouched.
  const modules = createModules(input);

  const moduleTools = Object.assign({}, ...modules.map((m) => m.tools));
  const moduleTransforms = modules
    .map((m) => m.systemTransform)
    .filter((t) => t != null);
  const moduleEvents = modules.map((m) => m.event).filter((e) => e != null);

  return {
    // Register tools from core + feature-module tools
    tool: { ...createOpenCodeTools(), ...moduleTools },

    // Run every module's system-prompt transform in order
    "experimental.chat.system.transform": async (hookInput, output) => {
      for (const transform of moduleTransforms) {
        await transform(hookInput, output);
      }
    },

    // Event handler
    event: async (hookInput) => {
      const { event } = hookInput;
      await handleEvent(
        {
          type: event.type as "session.created" | "session.ended",
          timestamp: Date.now(),
          data: event as unknown as Record<string, unknown>,
        },
        context
      );
      // Let feature modules react to raw events (e.g. review's idle watchdog).
      for (const ev of moduleEvents) await ev(hookInput);
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

    // Hook: config loaded — placeholder, no-op for now.
    // Use to read/react to opencode.json settings (e.g. plugin options).
    config: async (_config) => {},

    // Hook: modify LLM call parameters (temperature, topP, topK, options)
    // — placeholder, no-op for now. Mutate `output` fields to override.
    "chat.params": async (_hookInput, _output) => {},

    // Hook: before session compaction — placeholder, no-op for now.
    // Push to output.context to add compaction hints, or set output.prompt
    // to replace the compaction prompt (e.g. preserve review state).
    "experimental.session.compacting": async (_hookInput, _output) => {},

    // Hook: after a text part completes — placeholder, no-op for now.
    // Use to inspect/post-process completed assistant text.
    "experimental.text.complete": async (_hookInput, _output) => {},

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
