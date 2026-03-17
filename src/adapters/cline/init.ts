/**
 * Cline hook init/deinit utilities.
 *
 * Provides functions to install and remove Gordian Coder hook scripts
 * into Cline's hooks directory (local .clinerules/hooks or global).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

export const CLINE_HOOK_NAMES = [
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "TaskComplete",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
] as const;

// Marker comment to identify generated hooks (used by deinit)
const MARKER = "# [gordian-coder:cline] auto-generated hook";

export interface InitOptions {
  global: boolean;
  force: boolean;
  cwd?: string; // override for testing
}

export interface InitResult {
  hooksDir: string;
  created: string[];
  skipped: string[];
}

export interface DeinitResult {
  hooksDir: string;
  removed: string[];
  notFound: string[];
}

export class InitError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InitError";
  }
}

export class DeinitError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeinitError";
  }
}

// Resolve hooks directory
export function resolveHooksDir(options: InitOptions): string {
  if (options.global) {
    return path.join(os.homedir(), "Documents", "Cline", "Hooks");
  }
  return path.join(options.cwd ?? process.cwd(), ".clinerules", "hooks");
}

// Resolve command to embed in hook scripts.
// Always use the absolute path so hooks work in non-interactive shells
// (e.g. Cline) where ~/.bun/bin may not be on PATH.
export function resolveCommand(): string {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, ["gdc"], { encoding: "utf-8" });
  if (result.status === 0) {
    const resolved = result.stdout.trim();
    // Use the absolute path from `which` output
    return resolved || "gdc";
  }
  return "bun run gdc";
}

// Generate hook script content
export function generateHookScript(
  hookName: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      `${MARKER} — do not edit`,
      `# Hook: ${hookName}`,
      `$input = [Console]::In.ReadToEnd()`,
      `$input | ${command}`,
      "",
    ].join("\n");
  }
  // macOS / Linux
  return [
    "#!/usr/bin/env bash",
    `${MARKER} — do not edit`,
    `# Hook: ${hookName}`,
    `exec ${command} <&0`,
    "",
  ].join("\n");
}

// Init: create hook scripts
export async function initClineHooks(options: InitOptions): Promise<InitResult> {
  const hooksDir = resolveHooksDir(options);
  const command = resolveCommand();
  const platform = process.platform;
  const created: string[] = [];
  const skipped: string[] = [];

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err) {
    throw new InitError(`Failed to create directory: ${hooksDir}`, err);
  }

  for (const hookName of CLINE_HOOK_NAMES) {
    const ext = platform === "win32" ? ".ps1" : "";
    const filePath = path.join(hooksDir, `${hookName}${ext}`);

    if (fs.existsSync(filePath) && !options.force) {
      skipped.push(filePath);
      continue;
    }

    try {
      const content = generateHookScript(hookName, command, platform);
      fs.writeFileSync(filePath, content, { mode: platform === "win32" ? 0o644 : 0o755 });
      created.push(filePath);
    } catch (err) {
      throw new InitError(`Failed to write hook: ${filePath}`, err);
    }
  }

  return { hooksDir, created, skipped };
}

// Deinit: remove only our generated hooks (identified by marker)
export async function deinitClineHooks(options: InitOptions): Promise<DeinitResult> {
  const hooksDir = resolveHooksDir(options);
  const platform = process.platform;
  const removed: string[] = [];
  const notFound: string[] = [];

  for (const hookName of CLINE_HOOK_NAMES) {
    const ext = platform === "win32" ? ".ps1" : "";
    const filePath = path.join(hooksDir, `${hookName}${ext}`);

    if (!fs.existsSync(filePath)) {
      notFound.push(filePath);
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes(MARKER)) {
        notFound.push(filePath); // not our file
        continue;
      }
      fs.unlinkSync(filePath);
      removed.push(filePath);
    } catch (err) {
      throw new DeinitError(`Failed to remove hook: ${filePath}`, err);
    }
  }

  return { hooksDir, removed, notFound };
}
