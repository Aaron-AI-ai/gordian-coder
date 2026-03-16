/**
 * Core module exports
 * Platform-independent business logic for Gordian Coder
 */

// Types
export * from "./types";

// Tools
export {
  echoTool,
  getCurrentTimeTool,
  toolRegistry,
  getTool,
  getAllTools,
  registerTool,
} from "./tools";

// Handlers
export {
  processMessage,
  handleEvent,
  beforeToolExecute,
  afterToolExecute,
} from "./handlers";

// Hook system
export * from "./hooks";
