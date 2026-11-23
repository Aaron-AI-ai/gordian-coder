/**
 * Platform-independent type definitions for Gordian Coder
 */

// Tool definition interface
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterDefinition>;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ParameterDefinition {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
