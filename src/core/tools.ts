/**
 * Common tool definitions for Gordian Coder
 * These tools are platform-independent and can be used across all adapters
 */

import type { ToolDefinition, ToolResult } from "./types";

/**
 * Example tool: Echo
 * Simple tool that echoes back the input message
 */
export const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back the input message",
  parameters: {
    message: {
      type: "string",
      description: "The message to echo back",
      required: true,
    },
  },
  execute: async (params): Promise<ToolResult> => {
    const message = params.message as string;
    return {
      success: true,
      data: { echoed: message },
    };
  },
};

/**
 * Example tool: Get Current Time
 * Returns the current timestamp
 */
export const getCurrentTimeTool: ToolDefinition = {
  name: "get_current_time",
  description: "Returns the current date and time",
  parameters: {},
  execute: async (): Promise<ToolResult> => {
    const now = new Date();
    return {
      success: true,
      data: {
        iso: now.toISOString(),
        unix: now.getTime(),
        formatted: now.toLocaleString(),
      },
    };
  },
};

/**
 * Registry of all available tools
 */
export const toolRegistry: Map<string, ToolDefinition> = new Map([
  ["echo", echoTool],
  ["get_current_time", getCurrentTimeTool],
]);

/**
 * Get a tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

/**
 * Get all registered tools
 */
export function getAllTools(): ToolDefinition[] {
  return Array.from(toolRegistry.values());
}

/**
 * Register a new tool
 */
export function registerTool(tool: ToolDefinition): void {
  toolRegistry.set(tool.name, tool);
}
