import { describe, it, expect } from "bun:test";
import { mergeSystemPrompts } from "../system-merge";

describe("mergeSystemPrompts", () => {
  it("merges multiple entries into one for openai-compatible providers", () => {
    const system = ["header", "review prompt", "language: ko"];
    mergeSystemPrompts(
      { sessionID: "s", model: { providerID: "openrouter", modelID: "qwen/qwen3-27b" } },
      system
    );
    expect(system).toEqual(["header\n\nreview prompt\n\nlanguage: ko"]);
  });

  it("merges when no model info is present (older runtimes)", () => {
    const system = ["a", "b"];
    mergeSystemPrompts({ sessionID: "s" }, system);
    expect(system).toEqual(["a\n\nb"]);
  });

  it("keeps the multi-entry form for anthropic/claude models (prompt caching)", () => {
    for (const model of [
      { providerID: "anthropic", modelID: "claude-sonnet-4" },
      { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
    ]) {
      const system = ["header", "rest"];
      mergeSystemPrompts({ sessionID: "s", model }, system);
      expect(system).toEqual(["header", "rest"]);
    }
  });

  it("leaves single-entry and empty arrays untouched", () => {
    const one = ["only"];
    mergeSystemPrompts({ sessionID: "s" }, one);
    expect(one).toEqual(["only"]);
    const none: string[] = [];
    mergeSystemPrompts({ sessionID: "s" }, none);
    expect(none).toEqual([]);
  });

  it("drops empty entries while merging", () => {
    const system = ["a", "", "b"];
    mergeSystemPrompts({ sessionID: "s", model: { providerID: "chutes" } }, system);
    expect(system).toEqual(["a\n\nb"]);
  });
});
