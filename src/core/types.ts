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

// Message handling interface
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

// Event types
export type EventType =
  | "session.created"
  | "session.ended"
  | "message.received"
  | "tool.executed";

export interface GordianEvent {
  type: EventType;
  timestamp: number;
  data?: Record<string, unknown>;
}

// Plugin context interface (platform-agnostic)
export interface GordianContext {
  sessionId?: string;
  workingDirectory?: string;
  config?: Record<string, unknown>;
}
