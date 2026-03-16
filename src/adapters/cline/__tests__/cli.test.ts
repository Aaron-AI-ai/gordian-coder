/**
 * End-to-end tests for the Cline CLI adapter.
 *
 * Each test spawns the cli.ts script as a subprocess, pipes JSON on stdin,
 * and asserts on the JSON written to stdout.
 *
 * Written first (TDD) - tests define the expected behaviour.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import path from "path";

const CLI_PATH = path.resolve(
  __dirname,
  "../cli.ts"
);

/**
 * Spawn the CLI script synchronously with the given stdin payload.
 * Returns { stdout, stderr, exitCode }.
 */
function runCli(stdinPayload: string): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync("bun", ["run", CLI_PATH], {
    input: stdinPayload,
    encoding: "utf-8",
    timeout: 10_000,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

/**
 * Parse stdout as JSON. Throws a clear error if it isn't valid JSON.
 */
function parseOutput(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`CLI stdout is not valid JSON:\n${stdout}`);
  }
}

// ── Helper payloads ──────────────────────────────────────────────

function makePayload(hookName: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskId: `test-task-${Date.now()}`,
    hookName,
    clineVersion: "3.0.0",
    timestamp: String(Date.now()),
    ...extra,
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("CLI adapter - end-to-end", () => {
  it("exits with code 0 for a valid TaskStart payload", () => {
    const { exitCode } = runCli(
      makePayload("TaskStart", { taskStart: { task: "Write unit tests" } })
    );
    expect(exitCode).toBe(0);
  });

  it("outputs valid JSON for TaskStart", () => {
    const { stdout } = runCli(
      makePayload("TaskStart", { taskStart: { task: "Write unit tests" } })
    );
    expect(() => parseOutput(stdout)).not.toThrow();
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
    expect(output).toHaveProperty("contextModification");
    expect(output).toHaveProperty("errorMessage");
  });

  it("outputs valid JSON for TaskResume", () => {
    const { stdout } = runCli(
      makePayload("TaskResume", { taskResume: { task: "Resumed task" } })
    );
    const output = parseOutput(stdout);
    expect(output.cancel).toBe(false);
    expect(typeof output.contextModification).toBe("string");
  });

  it("outputs valid JSON for TaskCancel", () => {
    const { stdout } = runCli(
      makePayload("TaskCancel", { taskCancel: { task: "Cancelled task" } })
    );
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
  });

  it("outputs valid JSON for TaskComplete", () => {
    const { stdout } = runCli(
      makePayload("TaskComplete", { taskComplete: { task: "Completed task" } })
    );
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
  });

  it("outputs valid JSON for PreToolUse", () => {
    const { stdout } = runCli(
      makePayload("PreToolUse", {
        preToolUse: { tool: "bash", parameters: { command: "echo hello" } },
      })
    );
    const output = parseOutput(stdout);
    expect(output.cancel).toBe(false);
  });

  it("outputs valid JSON for PostToolUse", () => {
    const { stdout } = runCli(
      makePayload("PostToolUse", {
        postToolUse: {
          tool: "read_file",
          parameters: { path: "/tmp/test.txt" },
          result: "file contents",
          success: true,
          durationMs: 12,
        },
      })
    );
    const output = parseOutput(stdout);
    expect(output.cancel).toBe(false);
  });

  it("outputs valid JSON for UserPromptSubmit", () => {
    const { stdout } = runCli(
      makePayload("UserPromptSubmit", {
        userPromptSubmit: { prompt: "Explain this code" },
      })
    );
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
  });

  it("outputs valid JSON for PreCompact", () => {
    const { stdout } = runCli(
      makePayload("PreCompact", {
        preCompact: { conversationLength: 200, estimatedTokens: 80000 },
      })
    );
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
  });

  it("outputs valid JSON and does NOT crash on malformed (non-JSON) stdin", () => {
    const { stdout, exitCode } = runCli("this is definitely not json ~~~");
    // Must produce parseable JSON output
    expect(() => parseOutput(stdout)).not.toThrow();
    const output = parseOutput(stdout);
    expect(output.cancel).toBe(false);
    expect(typeof output.errorMessage).toBe("string");
    expect((output.errorMessage as string).length).toBeGreaterThan(0);
    // Exit code should be 0 (handled error, not fatal crash)
    expect(exitCode).toBe(0);
  });

  it("outputs valid JSON for empty string stdin", () => {
    const { stdout } = runCli("");
    expect(() => parseOutput(stdout)).not.toThrow();
    const output = parseOutput(stdout);
    expect(output).toHaveProperty("cancel");
    expect(output).toHaveProperty("errorMessage");
  });

  it("outputs valid JSON for unknown hookName", () => {
    const { stdout, exitCode } = runCli(
      makePayload("SomeFutureHook")
    );
    expect(() => parseOutput(stdout)).not.toThrow();
    const output = parseOutput(stdout);
    expect(output.cancel).toBe(false);
    expect(typeof output.errorMessage).toBe("string");
    expect(exitCode).toBe(0);
  });

  it("logs to stderr (not stdout) for valid hooks", () => {
    const { stdout, stderr } = runCli(
      makePayload("TaskStart", { taskStart: { task: "Log test" } })
    );
    // stdout must be pure JSON (no log lines mixed in)
    expect(() => parseOutput(stdout)).not.toThrow();
    // stderr should contain a log line from the default handler
    expect(stderr).toContain("[gordian-coder:cline]");
  });

  it("all three output fields have the correct types", () => {
    const { stdout } = runCli(
      makePayload("PreToolUse", {
        preToolUse: { tool: "bash", parameters: { command: "pwd" } },
      })
    );
    const output = parseOutput(stdout);
    expect(typeof output.cancel).toBe("boolean");
    expect(typeof output.contextModification).toBe("string");
    expect(typeof output.errorMessage).toBe("string");
  });
});
