/**
 * Gordian Coder - Multi-platform AI Coding Assistant Plugin
 *
 * Supported platforms:
 * - OpenCode (via plugin interface)
 * - Claude Code (via MCP server)
 * - Cline (via MCP server)
 */

// Core exports (for library usage)
export * from "./core";

// Adapter exports
export { default as OpenCodePlugin } from "./adapters/opencode";
export { createMcpServer, startMcpServer } from "./adapters/mcp";
export { startCliServer } from "./adapters/cli";
export { handleClineHook } from "./adapters/cline";

// Default export: OpenCode plugin (for backward compatibility)
export { default } from "./adapters/opencode";
