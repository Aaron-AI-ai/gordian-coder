/**
 * Tests for hook system types
 * Written first (TDD) - these should fail until types.ts is implemented
 */

import { describe, it, expect } from "bun:test";
import {
  HookName,
  HookEventSchema,
  HookResultSchema,
  TaskPayloadSchema,
  PreToolUsePayloadSchema,
  PostToolUsePayloadSchema,
  UserPromptSubmitPayloadSchema,
  PreCompactPayloadSchema,
} from "../types";

describe("HookName", () => {
  it("accepts all 8 valid hook names", () => {
    const validNames = [
      "TaskStart",
      "TaskResume",
      "TaskCancel",
      "TaskComplete",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "PreCompact",
    ];

    for (const name of validNames) {
      const result = HookName.safeParse(name);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid hook names", () => {
    const invalidNames = ["InvalidHook", "taskstart", "TASKSTART", "", "foo"];

    for (const name of invalidNames) {
      const result = HookName.safeParse(name);
      expect(result.success).toBe(false);
    }
  });
});

describe("HookEventSchema", () => {
  it("parses a valid TaskStart event", () => {
    const event = {
      hookName: "TaskStart",
      taskId: "task-123",
      timestamp: Date.now(),
      taskStart: { task: "Implement feature X" },
    };

    const result = HookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hookName).toBe("TaskStart");
      expect(result.data.taskId).toBe("task-123");
      expect(result.data.taskStart?.task).toBe("Implement feature X");
    }
  });

  it("parses a valid PreToolUse event", () => {
    const event = {
      hookName: "PreToolUse",
      taskId: "task-456",
      timestamp: 1700000000000,
      workspaceRoots: ["/home/user/project"],
      preToolUse: {
        tool: "bash",
        parameters: { command: "ls -la" },
      },
    };

    const result = HookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hookName).toBe("PreToolUse");
      expect(result.data.workspaceRoots).toEqual(["/home/user/project"]);
      expect(result.data.preToolUse?.tool).toBe("bash");
      expect(result.data.preToolUse?.parameters).toEqual({ command: "ls -la" });
    }
  });

  it("parses a valid PostToolUse event", () => {
    const event = {
      hookName: "PostToolUse",
      taskId: "task-789",
      timestamp: 1700000000000,
      postToolUse: {
        tool: "read_file",
        parameters: { path: "/tmp/test.txt" },
        result: { content: "file contents" },
        success: true,
        durationMs: 42,
      },
    };

    const result = HookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.postToolUse?.success).toBe(true);
      expect(result.data.postToolUse?.durationMs).toBe(42);
    }
  });

  it("rejects an event with an invalid hookName", () => {
    const event = {
      hookName: "NotAHook",
      taskId: "task-123",
      timestamp: Date.now(),
    };

    const result = HookEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects an event missing required fields", () => {
    const eventMissingTaskId = {
      hookName: "TaskStart",
      timestamp: Date.now(),
    };

    const result = HookEventSchema.safeParse(eventMissingTaskId);
    expect(result.success).toBe(false);
  });

  it("parses an event with optional workspaceRoots omitted", () => {
    const event = {
      hookName: "TaskComplete",
      taskId: "task-abc",
      timestamp: Date.now(),
      taskComplete: { task: "Done" },
    };

    const result = HookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceRoots).toBeUndefined();
    }
  });
});

describe("HookResultSchema", () => {
  it("applies default values when fields are omitted", () => {
    const result = HookResultSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cancel).toBe(false);
      expect(result.data.contextModification).toBe("");
      expect(result.data.errorMessage).toBe("");
    }
  });

  it("accepts explicit values for all fields", () => {
    const result = HookResultSchema.safeParse({
      cancel: true,
      contextModification: "Added context",
      errorMessage: "Something went wrong",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cancel).toBe(true);
      expect(result.data.contextModification).toBe("Added context");
      expect(result.data.errorMessage).toBe("Something went wrong");
    }
  });
});

describe("Payload schemas", () => {
  it("TaskPayloadSchema rejects missing task field", () => {
    const result = TaskPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("TaskPayloadSchema rejects non-string task", () => {
    const result = TaskPayloadSchema.safeParse({ task: 123 });
    expect(result.success).toBe(false);
  });

  it("PreToolUsePayloadSchema rejects missing tool field", () => {
    const result = PreToolUsePayloadSchema.safeParse({
      parameters: {},
    });
    expect(result.success).toBe(false);
  });

  it("PreToolUsePayloadSchema rejects missing parameters field", () => {
    const result = PreToolUsePayloadSchema.safeParse({
      tool: "bash",
    });
    expect(result.success).toBe(false);
  });

  it("PostToolUsePayloadSchema rejects missing success field", () => {
    const result = PostToolUsePayloadSchema.safeParse({
      tool: "bash",
      parameters: {},
      result: null,
      durationMs: 10,
    });
    expect(result.success).toBe(false);
  });

  it("PostToolUsePayloadSchema rejects non-number durationMs", () => {
    const result = PostToolUsePayloadSchema.safeParse({
      tool: "bash",
      parameters: {},
      result: null,
      success: true,
      durationMs: "fast",
    });
    expect(result.success).toBe(false);
  });

  it("UserPromptSubmitPayloadSchema rejects missing prompt field", () => {
    const result = UserPromptSubmitPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("PreCompactPayloadSchema rejects missing conversationLength", () => {
    const result = PreCompactPayloadSchema.safeParse({
      estimatedTokens: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("PreCompactPayloadSchema rejects non-number estimatedTokens", () => {
    const result = PreCompactPayloadSchema.safeParse({
      conversationLength: 10,
      estimatedTokens: "lots",
    });
    expect(result.success).toBe(false);
  });
});
