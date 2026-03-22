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
 *   "command": "gdc"
 */

import { handleClineHook } from "./handlers";
import { registerHook } from "../../core/hooks";
import type { HookName } from "../../core/hooks";
import { initClineHooks, deinitClineHooks } from "./init";
import * as tty from "node:tty";

const VERSION = "0.1.0";

function printHelp(): void {
  const help = `
gdc - Gordian Coder Cline Hooks Adapter v${VERSION}

Usage:
  gdc                        Cline hook 이벤트 처리 (stdin으로 JSON 수신)
  gdc --init [options]       Hook 스크립트 설치
  gdc --deinit [options]     Hook 스크립트 제거
  gdc --help, -h             도움말 표시
  gdc --version, -v          버전 표시

Options:
  --global                   글로벌 hooks 디렉토리 사용 (~/Documents/Cline/Hooks/)
  --force                    기존 hook 스크립트 덮어쓰기

Examples:
  gdc --init                 프로젝트 로컬 hooks 설치 (.clinerules/hooks/)
  gdc --init --global        글로벌 hooks 설치
  gdc --init --force         기존 hooks 덮어쓰기
  gdc --deinit               프로젝트 로컬 hooks 제거
  gdc --deinit --global      글로벌 hooks 제거

Documentation:
  https://github.com/gordian-coder/gordian-coder
`.trimStart();
  process.stderr.write(help);
}

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

    // UserPromptSubmit: echo the user's prompt back as contextModification
    if (event.hookName === "UserPromptSubmit" && event.userPromptSubmit) {
      return {
        cancel: false,
        contextModification: event.userPromptSubmit.prompt,
        errorMessage: "",
      };
    }

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
  // ── Arg parsing ────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const hasInit = args.includes("--init");
  const hasDeinit = args.includes("--deinit");
  const isGlobal = args.includes("--global");
  const isForce = args.includes("--force");

  const hasHelp = args.includes("--help") || args.includes("-h");
  const hasVersion = args.includes("--version") || args.includes("-v");

  if (hasHelp) {
    printHelp();
    process.exit(0);
  }

  if (hasVersion) {
    process.stderr.write(`gdc v${VERSION}\n`);
    process.exit(0);
  }

  if (hasInit && hasDeinit) {
    process.stderr.write(
      "[gordian-coder:cline] Error: cannot use --init and --deinit together.\n"
    );
    process.exit(1);
  }

  if (hasInit) {
    const result = await initClineHooks({ global: isGlobal, force: isForce });
    process.stderr.write(
      `[gordian-coder:cline] Hooks initialized in ${result.hooksDir}\n`
    );
    for (const f of result.created) process.stderr.write(`  + ${f}\n`);
    for (const f of result.skipped)
      process.stderr.write(`  ~ ${f} (skipped, use --force to overwrite)\n`);
    process.exit(0);
  }

  if (hasDeinit) {
    const result = await deinitClineHooks({ global: isGlobal, force: false });
    process.stderr.write(
      `[gordian-coder:cline] Hooks removed from ${result.hooksDir}\n`
    );
    for (const f of result.removed) process.stderr.write(`  - ${f}\n`);
    process.exit(0);
  }

  // ── Interactive mode: no args + TTY stdin → show help ──────────
  if (args.length === 0 && tty.isatty(0)) {
    printHelp();
    process.exit(0);
  }

  // ── Existing stdin / stdout flow (unchanged) ───────────────────
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
