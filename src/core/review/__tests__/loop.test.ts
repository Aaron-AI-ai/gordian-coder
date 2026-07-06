import { describe, it, expect } from "bun:test";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  type ReviewState,
} from "../state";
import { MAX_ITER } from "../reader";

function baseState(over: Partial<ReviewState> = {}): ReviewState {
  return {
    active: true,
    cwd: ".",
    targets: ["a.ts", "b.ts"],
    currentIndex: 0,
    categories: ["security"],
    diffRange: null,
    ref: null,
    diffMap: {},
    systemRule: "",
    frameworkRules: "",
    requirementBackground: "",
    planGuidance: "",
    findings: {},
    baseline: new Set<string>(),
    label: "L",
    language: "ko",
    iterations: 0,
    ...over,
  };
}

describe("state", () => {
  it("stores and retrieves by sessionId", () => {
    setState("s1", baseState());
    expect(getState("s1")?.targets).toEqual(["a.ts", "b.ts"]);
    clearState("s1");
    expect(getState("s1")).toBeUndefined();
  });

  it("currentFile/otherFiles track the pointer", () => {
    const st = baseState({ currentIndex: 1 });
    expect(currentFile(st)).toBe("b.ts");
    expect(otherFiles(st)).toEqual(["a.ts"]);
  });

  it("isDone when the index runs past targets", () => {
    expect(isDone(baseState({ currentIndex: 2 }))).toBe(true);
    expect(isDone(baseState({ currentIndex: 1 }))).toBe(false);
  });

  it("MAX_ITER is a positive guard", () => {
    expect(MAX_ITER).toBeGreaterThan(0);
  });
});
