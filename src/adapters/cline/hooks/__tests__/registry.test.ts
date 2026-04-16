/**
 * Tests for HookRegistry
 * Written first (TDD) - these should fail until registry.ts is implemented
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { HookRegistry, defaultRegistry, registerHook } from "../registry";
import type { HookEvent, HookResult, HookHandler } from "../types";

// Helper to create a minimal valid HookEvent
function makeEvent(hookName: HookEvent["hookName"] = "TaskStart"): HookEvent {
  return {
    hookName,
    taskId: "test-task-id",
    timestamp: 1700000000000,
  };
}

// Helper to create a HookResult
function makeResult(overrides: Partial<HookResult> = {}): HookResult {
  return {
    cancel: false,
    contextModification: "",
    errorMessage: "",
    ...overrides,
  };
}

describe("HookRegistry - register and dispatch", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("calls registered handler with the correct event", async () => {
    const events: HookEvent[] = [];
    const handler: HookHandler = async (event) => {
      events.push(event);
      return makeResult();
    };

    registry.register("TaskStart", handler);

    const event = makeEvent("TaskStart");
    await registry.dispatch(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it("returns default HookResult when no handlers are registered", async () => {
    const event = makeEvent("TaskStart");
    const result = await registry.dispatch(event);

    expect(result.cancel).toBe(false);
    expect(result.contextModification).toBe("");
    expect(result.errorMessage).toBe("");
  });

  it("does not call handler registered for a different hook", async () => {
    const called: boolean[] = [];
    const handler: HookHandler = async () => {
      called.push(true);
      return makeResult();
    };

    registry.register("TaskComplete", handler);

    await registry.dispatch(makeEvent("TaskStart"));

    expect(called).toHaveLength(0);
  });

  it("merges cancel with logical OR across multiple handlers", async () => {
    const handler1: HookHandler = async () => makeResult({ cancel: false });
    const handler2: HookHandler = async () => makeResult({ cancel: true });
    const handler3: HookHandler = async () => makeResult({ cancel: false });

    registry.register("TaskStart", handler1);
    registry.register("TaskStart", handler2);
    registry.register("TaskStart", handler3);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    expect(result.cancel).toBe(true);
  });

  it("cancel stays false when no handler cancels", async () => {
    const handler1: HookHandler = async () => makeResult({ cancel: false });
    const handler2: HookHandler = async () => makeResult({ cancel: false });

    registry.register("PreToolUse", handler1);
    registry.register("PreToolUse", handler2);

    const result = await registry.dispatch(makeEvent("PreToolUse"));

    expect(result.cancel).toBe(false);
  });

  it("concatenates contextModification with newline", async () => {
    const handler1: HookHandler = async () =>
      makeResult({ contextModification: "context-a" });
    const handler2: HookHandler = async () =>
      makeResult({ contextModification: "context-b" });

    registry.register("UserPromptSubmit", handler1);
    registry.register("UserPromptSubmit", handler2);

    const result = await registry.dispatch(makeEvent("UserPromptSubmit"));

    expect(result.contextModification).toBe("context-a\ncontext-b");
  });

  it("ignores empty contextModification in concatenation", async () => {
    const handler1: HookHandler = async () =>
      makeResult({ contextModification: "" });
    const handler2: HookHandler = async () =>
      makeResult({ contextModification: "context-b" });

    registry.register("TaskStart", handler1);
    registry.register("TaskStart", handler2);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    // Implementations may differ - as long as "context-b" is included
    expect(result.contextModification).toContain("context-b");
  });

  it("last non-empty errorMessage wins", async () => {
    const handler1: HookHandler = async () =>
      makeResult({ errorMessage: "first error" });
    const handler2: HookHandler = async () =>
      makeResult({ errorMessage: "" });
    const handler3: HookHandler = async () =>
      makeResult({ errorMessage: "last error" });

    registry.register("TaskStart", handler1);
    registry.register("TaskStart", handler2);
    registry.register("TaskStart", handler3);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    expect(result.errorMessage).toBe("last error");
  });
});

describe("HookRegistry - unregister", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("unregistered handler is no longer called on dispatch", async () => {
    const calls: number[] = [];
    const handler: HookHandler = async () => {
      calls.push(1);
      return makeResult();
    };

    registry.register("TaskStart", handler);
    registry.unregister("TaskStart", handler);

    await registry.dispatch(makeEvent("TaskStart"));

    expect(calls).toHaveLength(0);
  });

  it("only removes the specified handler, others remain", async () => {
    const calls: string[] = [];
    const handlerA: HookHandler = async () => {
      calls.push("A");
      return makeResult();
    };
    const handlerB: HookHandler = async () => {
      calls.push("B");
      return makeResult();
    };

    registry.register("TaskStart", handlerA);
    registry.register("TaskStart", handlerB);
    registry.unregister("TaskStart", handlerA);

    await registry.dispatch(makeEvent("TaskStart"));

    expect(calls).not.toContain("A");
    expect(calls).toContain("B");
  });

  it("unregistering a non-existent handler does not throw", () => {
    const handler: HookHandler = async () => makeResult();
    expect(() => {
      registry.unregister("TaskStart", handler);
    }).not.toThrow();
  });
});

describe("HookRegistry - hasHandlers and getHandlerCount", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("hasHandlers returns false when no handlers registered", () => {
    expect(registry.hasHandlers("TaskStart")).toBe(false);
  });

  it("hasHandlers returns true after registering a handler", () => {
    registry.register("TaskStart", async () => makeResult());
    expect(registry.hasHandlers("TaskStart")).toBe(true);
  });

  it("hasHandlers returns false after unregistering all handlers", () => {
    const handler: HookHandler = async () => makeResult();
    registry.register("TaskStart", handler);
    registry.unregister("TaskStart", handler);
    expect(registry.hasHandlers("TaskStart")).toBe(false);
  });

  it("getHandlerCount returns 0 with no handlers", () => {
    expect(registry.getHandlerCount("TaskStart")).toBe(0);
  });

  it("getHandlerCount returns correct count after registrations", () => {
    registry.register("PreToolUse", async () => makeResult());
    registry.register("PreToolUse", async () => makeResult());
    registry.register("PreToolUse", async () => makeResult());
    expect(registry.getHandlerCount("PreToolUse")).toBe(3);
  });

  it("getHandlerCount decrements after unregister", () => {
    const handler: HookHandler = async () => makeResult();
    registry.register("PostToolUse", handler);
    registry.register("PostToolUse", async () => makeResult());
    expect(registry.getHandlerCount("PostToolUse")).toBe(2);
    registry.unregister("PostToolUse", handler);
    expect(registry.getHandlerCount("PostToolUse")).toBe(1);
  });

  it("counts are independent per hook name", () => {
    registry.register("TaskStart", async () => makeResult());
    registry.register("TaskComplete", async () => makeResult());
    registry.register("TaskComplete", async () => makeResult());

    expect(registry.getHandlerCount("TaskStart")).toBe(1);
    expect(registry.getHandlerCount("TaskComplete")).toBe(2);
  });
});

describe("HookRegistry - error handling", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("catches thrown errors from handlers and sets errorMessage", async () => {
    const handler: HookHandler = async () => {
      throw new Error("Handler exploded");
    };

    registry.register("TaskStart", handler);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    expect(result.errorMessage).toBe("Handler exploded");
    expect(result.cancel).toBe(false);
  });

  it("continues processing other handlers after one throws", async () => {
    const calls: string[] = [];

    const throwingHandler: HookHandler = async () => {
      calls.push("throwing");
      throw new Error("oops");
    };

    const goodHandler: HookHandler = async () => {
      calls.push("good");
      return makeResult({ contextModification: "good-context" });
    };

    registry.register("TaskStart", throwingHandler);
    registry.register("TaskStart", goodHandler);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    expect(calls).toContain("throwing");
    expect(calls).toContain("good");
    expect(result.contextModification).toBe("good-context");
  });

  it("handles non-Error thrown values", async () => {
    const handler: HookHandler = async () => {
      throw "string error";
    };

    registry.register("TaskStart", handler);

    const result = await registry.dispatch(makeEvent("TaskStart"));

    expect(result.errorMessage).not.toBe("");
  });
});

describe("defaultRegistry and registerHook convenience function", () => {
  it("defaultRegistry is a HookRegistry instance", () => {
    expect(defaultRegistry).toBeInstanceOf(HookRegistry);
  });

  it("registerHook adds to defaultRegistry", () => {
    const initialCount = defaultRegistry.getHandlerCount("PreCompact");
    const handler: HookHandler = async () => makeResult();
    registerHook("PreCompact", handler);

    expect(defaultRegistry.getHandlerCount("PreCompact")).toBe(
      initialCount + 1
    );

    // Cleanup
    defaultRegistry.unregister("PreCompact", handler);
  });
});
