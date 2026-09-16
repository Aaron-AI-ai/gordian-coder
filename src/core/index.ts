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

// f-review
export * from "./review";

// f-log (namespaced: "runDir"/"RunMeta" collide with f-review's own)
export * as log from "./log";

// wiki -> KB sync
export * from "./kb-sync";
