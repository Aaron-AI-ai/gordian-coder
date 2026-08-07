/**
 * CLI Adapter
 * Long-running process that communicates via stdin/stdout JSON-line protocol.
 * Designed to be spawned by Claude Code hooks or Cline scripts,
 * then receive commands via stdin and respond via stdout.
 *
 * Protocol (JSON Lines - one JSON object per line):
 *
 *   → stdin  (request):
 *     {"id": "1", "action": "call_tool", "name": "echo", "params": {"message": "hello"}}
 *     {"id": "2", "action": "list_tools"}
 *     {"id": "3", "action": "ping"}
 *     {"id": "4", "action": "shutdown"}
 *
 *   ← stdout (response):
 *     {"id": "1", "ok": true, "data": {"echoed": "hello"}}
 *     {"id": "2", "ok": true, "tools": [...]}
 *     {"id": "3", "ok": true, "pong": true}
 *
 * Lifecycle:
 *   1. Process starts → emits {"event": "ready", "version": "...", "tools": [...]}
 *   2. Reads stdin line-by-line, dispatches actions, writes responses to stdout
 *   3. On "shutdown" action or stdin close → graceful exit
 */

import { getAllTools, getTool } from "../../core";
import type { ToolDefinition } from "../../core";
import * as readline from "node:readline";
import { VERSION } from "../../version";

const PROGRAM_NAME = "gordian-coder";

// ── Protocol types ──────────────────────────────────────────────

export interface Request {
  id?: string;
  action: "call_tool" | "list_tools" | "ping" | "shutdown";
  name?: string;
  params?: Record<string, unknown>;
}

export interface Response {
  id?: string;
  ok: boolean;
  [key: string]: unknown;
}

export interface ReadyEvent {
  event: "ready";
  version: string;
  pid: number;
  tools: Array<{ name: string; description: string }>;
}

// ── Output helpers ──────────────────────────────────────────────

function send(data: Response | ReadyEvent): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function log(message: string): void {
  // stderr for logging so stdout stays clean for protocol
  process.stderr.write(`[${PROGRAM_NAME}] ${message}\n`);
}

// ── Action handlers ─────────────────────────────────────────────

async function handleCallTool(req: Request): Promise<Response> {
  const { id, name, params } = req;

  if (!name) {
    return { id, ok: false, error: "Missing 'name' field for call_tool action" };
  }

  const tool = getTool(name);
  if (!tool) {
    const available = getAllTools().map((t) => t.name);
    return { id, ok: false, error: `Tool not found: ${name}`, available };
  }

  try {
    const result = await tool.execute(params ?? {});
    if (result.success) {
      return { id, ok: true, data: result.data };
    } else {
      return { id, ok: false, error: result.error ?? "Tool execution failed" };
    }
  } catch (err) {
    return {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function handleListTools(req: Request): Response {
  const tools = getAllTools().map((t: ToolDefinition) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return { id: req.id, ok: true, tools };
}

function handlePing(req: Request): Response {
  return { id: req.id, ok: true, pong: true, timestamp: Date.now() };
}

// ── Request dispatcher ──────────────────────────────────────────

async function dispatch(req: Request): Promise<Response | null> {
  switch (req.action) {
    case "call_tool":
      return handleCallTool(req);
    case "list_tools":
      return handleListTools(req);
    case "ping":
      return handlePing(req);
    case "shutdown":
      send({ id: req.id, ok: true, message: "shutting down" });
      return null; // signal to exit
    default:
      return {
        id: req.id,
        ok: false,
        error: `Unknown action: ${String(req.action)}`,
        supported: ["call_tool", "list_tools", "ping", "shutdown"],
      };
  }
}

// ── Main loop ───────────────────────────────────────────────────

export async function startCliServer(): Promise<void> {
  const tools = getAllTools();

  log(`Starting CLI server (v${VERSION})...`);
  log(`Registered tools: ${tools.map((t) => t.name).join(", ")}`);

  // Emit ready event so the parent process knows we're alive
  send({
    event: "ready",
    version: VERSION,
    pid: process.pid,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  });

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: Request;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ ok: false, error: "Invalid JSON", raw: trimmed });
      return;
    }

    if (!req.action) {
      send({ id: req.id, ok: false, error: "Missing 'action' field" });
      return;
    }

    const response = await dispatch(req);
    if (response === null) {
      // shutdown requested
      log("Shutdown requested, exiting...");
      rl.close();
      process.exit(0);
    }

    send(response);
  });

  rl.on("close", () => {
    log("stdin closed, exiting...");
    process.exit(0);
  });

  // Handle signals for graceful shutdown
  process.on("SIGINT", () => {
    log("SIGINT received, exiting...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("SIGTERM received, exiting...");
    process.exit(0);
  });
}
