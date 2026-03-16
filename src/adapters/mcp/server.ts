#!/usr/bin/env node
/**
 * MCP Server Entry Point
 * Run this file directly to start the MCP server for Claude Code or Cline
 *
 * Usage:
 *   node dist/adapters/mcp/server.js
 *   # or
 *   bun run src/adapters/mcp/server.ts
 */

import { startMcpServer } from "./index";

startMcpServer().catch((error) => {
  console.error("[gordian-coder] Failed to start MCP server:", error);
  process.exit(1);
});
