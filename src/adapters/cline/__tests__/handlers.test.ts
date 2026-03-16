/**
 * Tests for Cline hook handlers
 * Written first (TDD) - these define the expected behavior.
 */

import { describe, it, expect, mock } from "bun:test";
import { toCoreEvent, toClineOutput, handleClineHook } from "../handlers";
import type { ClineHookInput, ClineHookOutput } from "../types";
import { HookRegistry } from "../../../core/hooks";
import type { HookEvent, HookResult } from "../../../core/hooks";

// ── toCoreEvent ─────────────────────────────────────────────────

describe("toCoreEvent", () => {
  it("converts string timestamp to number", () => {
    const input: ClineHookInput = {
      taskId: "task-001",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: "1700000000000",
      taskStart: { task: "Write tests" },
    };

    const event = toCoreEvent(input);

    expect(typeof event.timestamp).toBe("number");
    expect(event.timestamp).toBe(1700000000000);
  });

  it("maps hookName from input to core event", () => {
    const input: ClineHookInput = {
      taskId: "task-002",
      hookName: "PreToolUse",
      clineVersion: "3.0.0",
      timestamp: "1700000001000",
      preToolUse: { tool: "bash", parameters: { command: "ls" } },
    };

    const event = toCoreEvent(input);

    expect(event.hookName).toBe("PreToolUse");
  });

  it("maps taskStart payload", () => {
    const input: ClineHookInput = {
      taskId: "task-003",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: "1700000002000",
      taskStart: { task: "Implement feature" },
    };

    const event = toCoreEvent(input);

    expect(event.taskStart).toEqual({ task: "Implement feature" });
  });

  it("maps taskResume payload", () => {
    const input: ClineHookInput = {
      taskId: "task-004",
      hookName: "TaskResume",
      clineVersion: "3.0.0",
      timestamp: "1700000003000",
      taskResume: { task: "Resume feature work" },
    };

    const event = toCoreEvent(input);

    expect(event.taskResume).toEqual({ task: "Resume feature work" });
  });

  it("maps taskCancel payload", () => {
    const input: ClineHookInput = {
      taskId: "task-005",
      hookName: "TaskCancel",
      clineVersion: "3.0.0",
      timestamp: "1700000004000",
      taskCancel: { task: "Cancelled task" },
    };

    const event = toCoreEvent(input);

    expect(event.taskCancel).toEqual({ task: "Cancelled task" });
  });

  it("maps taskComplete payload", () => {
    const input: ClineHookInput = {
      taskId: "task-006",
      hookName: "TaskComplete",
      clineVersion: "3.0.0",
      timestamp: "1700000005000",
      taskComplete: { task: "Completed task" },
    };

    const event = toCoreEvent(input);

    expect(event.taskComplete).toEqual({ task: "Completed task" });
  });

  it("maps preToolUse payload", () => {
    const input: ClineHookInput = {
      taskId: "task-007",
      hookName: "PreToolUse",
      clineVersion: "3.0.0",
      timestamp: "1700000006000",
      preToolUse: { tool: "read_file", parameters: { path: "/tmp/test.txt" } },
    };

    const event = toCoreEvent(input);

    expect(event.preToolUse).toEqual({ tool: "read_file", parameters: { path: "/tmp/test.txt" } });
  });

  it("maps postToolUse payload including result", () => {
    const input: ClineHookInput = {
      taskId: "task-008",
      hookName: "PostToolUse",
      clineVersion: "3.0.0",
      timestamp: "1700000007000",
      postToolUse: {
        tool: "bash",
        parameters: { command: "ls" },
        result: { stdout: "file1.txt\n" },
        success: true,
        durationMs: 55,
      },
    };

    const event = toCoreEvent(input);

    expect(event.postToolUse?.tool).toBe("bash");
    expect(event.postToolUse?.result).toEqual({ stdout: "file1.txt\n" });
    expect(event.postToolUse?.success).toBe(true);
    expect(event.postToolUse?.durationMs).toBe(55);
  });

  it("maps userPromptSubmit payload", () => {
    const input: ClineHookInput = {
      taskId: "task-009",
      hookName: "UserPromptSubmit",
      clineVersion: "3.0.0",
      timestamp: "1700000008000",
      userPromptSubmit: { prompt: "Hello, Cline!" },
    };

    const event = toCoreEvent(input);

    expect(event.userPromptSubmit).toEqual({ prompt: "Hello, Cline!" });
  });

  it("maps preCompact payload", () => {
    const input: ClineHookInput = {
      taskId: "task-010",
      hookName: "PreCompact",
      clineVersion: "3.0.0",
      timestamp: "1700000009000",
      preCompact: { conversationLength: 100, estimatedTokens: 50000 },
    };

    const event = toCoreEvent(input);

    expect(event.preCompact).toEqual({ conversationLength: 100, estimatedTokens: 50000 });
  });

  it("maps optional workspaceRoots", () => {
    const input: ClineHookInput = {
      taskId: "task-011",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: "1700000010000",
      workspaceRoots: ["/home/user/project", "/home/user/lib"],
      taskStart: { task: "Multi-root task" },
    };

    const event = toCoreEvent(input);

    expect(event.workspaceRoots).toEqual(["/home/user/project", "/home/user/lib"]);
  });

  it("leaves workspaceRoots undefined when not provided", () => {
    const input: ClineHookInput = {
      taskId: "task-012",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: "1700000011000",
      taskStart: { task: "Simple task" },
    };

    const event = toCoreEvent(input);

    expect(event.workspaceRoots).toBeUndefined();
  });

  it("throws when hookName is invalid", () => {
    const input = {
      taskId: "task-bad",
      hookName: "NotAHook",
      clineVersion: "3.0.0",
      timestamp: "1700000012000",
    } as unknown as ClineHookInput;

    expect(() => toCoreEvent(input)).toThrow();
  });
});

// ── toClineOutput ───────────────────────────────────────────────

describe("toClineOutput", () => {
  it("maps HookResult to ClineHookOutput", () => {
    const result: HookResult = {
      cancel: false,
      contextModification: "",
      errorMessage: "",
    };

    const output = toClineOutput(result);

    expect(output).toEqual({
      cancel: false,
      contextModification: "",
      errorMessage: "",
    });
  });

  it("maps cancel=true from HookResult", () => {
    const result: HookResult = {
      cancel: true,
      contextModification: "Added some context",
      errorMessage: "",
    };

    const output = toClineOutput(result);

    expect(output.cancel).toBe(true);
    expect(output.contextModification).toBe("Added some context");
  });

  it("maps errorMessage from HookResult", () => {
    const result: HookResult = {
      cancel: false,
      contextModification: "",
      errorMessage: "Something went wrong",
    };

    const output = toClineOutput(result);

    expect(output.errorMessage).toBe("Something went wrong");
  });
});

// ── handleClineHook ─────────────────────────────────────────────

describe("handleClineHook", () => {
  it("processes a valid PreToolUse input and returns {cancel: false, ...}", async () => {
    const registry = new HookRegistry();
    const input = JSON.stringify({
      taskId: "task-handler-001",
      hookName: "PreToolUse",
      clineVersion: "3.0.0",
      timestamp: "1700000000000",
      preToolUse: { tool: "bash", parameters: { command: "echo hello" } },
    });

    const outputJson = await handleClineHook(input, registry);
    const output = JSON.parse(outputJson) as ClineHookOutput;

    expect(output.cancel).toBe(false);
    expect(output.contextModification).toBe("");
    expect(output.errorMessage).toBe("");
  });

  it("processes a valid TaskStart input", async () => {
    const registry = new HookRegistry();
    const input = JSON.stringify({
      taskId: "task-handler-002",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: "1700000001000",
      taskStart: { task: "Build new feature" },
    });

    const outputJson = await handleClineHook(input, registry);
    const output = JSON.parse(outputJson) as ClineHookOutput;

    expect(output).toHaveProperty("cancel");
    expect(output).toHaveProperty("contextModification");
    expect(output).toHaveProperty("errorMessage");
  });

  it("calls registered handler and returns its result", async () => {
    const registry = new HookRegistry();
    registry.register("PreToolUse", async (_event: HookEvent) => ({
      cancel: true,
      contextModification: "blocked",
      errorMessage: "tool not allowed",
    }));

    const input = JSON.stringify({
      taskId: "task-handler-003",
      hookName: "PreToolUse",
      clineVersion: "3.0.0",
      timestamp: "1700000002000",
      preToolUse: { tool: "rm", parameters: { path: "/" } },
    });

    const outputJson = await handleClineHook(input, registry);
    const output = JSON.parse(outputJson) as ClineHookOutput;

    expect(output.cancel).toBe(true);
    expect(output.contextModification).toBe("blocked");
    expect(output.errorMessage).toBe("tool not allowed");
  });

  it("returns error output when given invalid JSON (does NOT throw)", async () => {
    const registry = new HookRegistry();
    const invalidJson = "this is not json {{{";

    const outputJson = await handleClineHook(invalidJson, registry);

    // Must not throw - should always return valid JSON string
    expect(() => JSON.parse(outputJson)).not.toThrow();

    const output = JSON.parse(outputJson) as ClineHookOutput;
    expect(output.cancel).toBe(false);
    expect(output.errorMessage).toContain("Error:");
  });

  it("returns error output when hookName is unknown/invalid (does NOT throw)", async () => {
    const registry = new HookRegistry();
    const input = JSON.stringify({
      taskId: "task-handler-004",
      hookName: "UnknownHookName",
      clineVersion: "3.0.0",
      timestamp: "1700000003000",
    });

    const outputJson = await handleClineHook(input, registry);

    expect(() => JSON.parse(outputJson)).not.toThrow();

    const output = JSON.parse(outputJson) as ClineHookOutput;
    expect(output.cancel).toBe(false);
    expect(output.errorMessage.length).toBeGreaterThan(0);
  });

  it("returns error output when required fields are missing (does NOT throw)", async () => {
    const registry = new HookRegistry();
    const input = JSON.stringify({
      // missing taskId, hookName
      clineVersion: "3.0.0",
      timestamp: "1700000004000",
    });

    const outputJson = await handleClineHook(input, registry);

    expect(() => JSON.parse(outputJson)).not.toThrow();

    const output = JSON.parse(outputJson) as ClineHookOutput;
    expect(output.cancel).toBe(false);
    expect(output.errorMessage).toContain("Validation error:");
  });

  it("returns valid JSON even when handler throws", async () => {
    const registry = new HookRegistry();
    registry.register("TaskCancel", async () => {
      throw new Error("handler exploded!");
    });

    const input = JSON.stringify({
      taskId: "task-handler-005",
      hookName: "TaskCancel",
      clineVersion: "3.0.0",
      timestamp: "1700000005000",
      taskCancel: { task: "cancelled" },
    });

    // handleClineHook should NOT throw
    let outputJson: string;
    expect(async () => {
      outputJson = await handleClineHook(input, registry);
    }).not.toThrow();

    outputJson = await handleClineHook(input, registry);
    expect(() => JSON.parse(outputJson)).not.toThrow();

    const output = JSON.parse(outputJson) as ClineHookOutput;
    expect(output.cancel).toBe(false);
  });

  it("always returns a JSON object with all three required fields", async () => {
    const registry = new HookRegistry();
    const inputs = [
      JSON.stringify({ taskId: "t1", hookName: "TaskStart", clineVersion: "3.0.0", timestamp: "1000" }),
      "bad json",
      JSON.stringify({ hookName: "Bad" }),
    ];

    for (const input of inputs) {
      const outputJson = await handleClineHook(input, registry);
      const output = JSON.parse(outputJson) as Record<string, unknown>;
      expect(output).toHaveProperty("cancel");
      expect(output).toHaveProperty("contextModification");
      expect(output).toHaveProperty("errorMessage");
    }
  });
});
