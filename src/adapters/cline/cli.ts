#!/usr/bin/env node
/**
 * Cline hooks adapter - one-shot CLI entry point.
 *
 * Cline invokes this process once per hook event:
 *   1. Writes a JSON payload to this process's stdin.
 *   2. Reads back the JSON response from stdout.
 *   3. The process exits with code 0 on success, non-zero on fatal error.
 *
 * Logging goes to stderr so that stdout stays clean for the JSON protocol.
 *
 * Usage (configured in .cline/hooks.json):
 *   "command": "gordian-coder-cline"
 */

import { handleClineHook } from "./handlers";
import { registerHook } from "../../core/hooks";
import type { HookName } from "../../core/hooks";

// ── Default handlers ─────────────────────────────────────────────
// Register a log-only handler for every hook type so that Cline always
// gets a valid response even before the user configures custom handlers.

const hookNames: HookName[] = [
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "TaskComplete",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
];

for (const name of hookNames) {
  registerHook(name, async (event) => {
    // Retrieve the hook-specific payload using the camelCase key convention.
    const hookData = (event as Record<string, unknown>)[camelCase(event.hookName)];
    process.stderr.write(
      `[gordian-coder:cline] ${event.hookName} | task=${event.taskId} | data=${JSON.stringify(hookData ?? {})}\n`
    );
    return { cancel: false, contextModification: "", errorMessage: "" };
  });
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Convert a PascalCase hook name to the camelCase property key used on
 * HookEvent (e.g. "TaskStart" → "taskStart", "PreToolUse" → "preToolUse").
 */
function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Read all bytes from stdin and return them as a UTF-8 string.
 * Returns an empty string when stdin is empty or closed immediately.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdin();
  const output = await handleClineHook(input);
  process.stdout.write(output);
}

main().catch((err) => {
  process.stderr.write(`[gordian-coder:cline] Fatal: ${err}\n`);
  process.stdout.write(
    JSON.stringify({ cancel: false, contextModification: "", errorMessage: String(err) })
  );
  process.exit(1);
});
