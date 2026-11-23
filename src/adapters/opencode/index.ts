/**
 * OpenCode Plugin Adapter
 * Bridges core logic with OpenCode's plugin interface
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { VERSION } from "../../version";
import { createModules, type CommandBeforeHook } from "./modules";
import { mergeSystemPrompts } from "./system-merge";
import {
  recordCall,
  shouldSuppressRepeatOutput,
  shouldSuppressIdempotentReplay,
  loopNotice,
  escalateLoop,
  guardNativeCall,
  beforeReviewToolCall,
  afterReviewToolCall,
} from "./repeat-guard";
/**
 * OpenCode Plugin implementation
 */
const OpenCodeAdapter: Plugin = async (input) => {
  // Printed to the OpenCode server log on load — lets you verify which build is
  // actually deployed (the plugin path points at a local dist bundle).
  console.error(`[gordian-coder] opencode plugin v${VERSION} loaded`);

  // Feature modules come from the registry (modules.ts) — register new
  // modules there; this file stays untouched.
  const modules = createModules(input);

  const moduleTools = Object.assign({}, ...modules.map((m) => m.tools));
  const moduleTransforms = modules
    .map((m) => m.systemTransform)
    .filter((t) => t != null);
  const moduleEvents = modules.map((m) => m.event).filter((e) => e != null);
  const moduleConfigs = modules.map((m) => m.config).filter((c) => c != null);
  const moduleCommandHooks = modules.map((m) => m.commandBefore).filter((h) => h != null);
  const moduleToolGates = modules.map((m) => m.toolBefore).filter((g) => g != null);
  const moduleToolResults = modules.map((m) => m.toolAfter).filter((h) => h != null);
  // Spread in, not written in the literal: the pinned SDK's Hooks type lacks this key.
  const commandHooks = {
    "command.execute.before": async (...args: Parameters<CommandBeforeHook>) => {
      for (const h of moduleCommandHooks) await h(...args);
    },
  };

  const abortSession = async (sessionID: string): Promise<void> => {
    try {
      await input.client.session.abort({ path: { id: sessionID } });
    } catch (err) {
      // `steps` remains the fallback hard stop. The state stays marked
      // exhausted so session.idle finalizes instead of re-driving the model.
      console.error(
        `[gordian-coder] session.abort(${sessionID}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return {
    ...commandHooks,

    tool: moduleTools,

    // Let modules inject bundled agents/commands into the OpenCode config
    config: async (cfg) => {
      for (const c of moduleConfigs) await c(cfg);
    },

    // Run every module's system-prompt transform in order, then collapse the
    // array to one entry for providers that reject multiple system messages.
    "experimental.chat.system.transform": async (hookInput, output) => {
      for (const transform of moduleTransforms) {
        await transform(hookInput, output);
      }
      mergeSystemPrompts(hookInput, output.system);
    },

    // Event handler
    event: async (hookInput) => {
      // Let feature modules react to raw events (e.g. review's idle watchdog).
      for (const ev of moduleEvents) await ev(hookInput);
    },

    // Hook: before tool execution
    "tool.execute.before": async (hookInput, output) => {
      const sessionID = hookInput.sessionID ?? "";
      recordCall(sessionID, hookInput.tool, output.args);
      const budget = beforeReviewToolCall(sessionID, hookInput.tool);
      if (!budget.allow) {
        if (budget.abort) await abortSession(sessionID);
        throw new Error(budget.message);
      }
      for (const gate of moduleToolGates) gate(hookInput.tool, sessionID, output.args as Record<string, unknown>);
    },

    // Hook: after tool execution
    "tool.execute.after": async (hookInput, hookOutput) => {
      for (const h of moduleToolResults) {
        // The runtime passes `args` here; the pinned SDK type does not declare it yet.
        const args = (hookInput as { args?: Record<string, unknown> }).args ?? {};
        h(hookInput.tool, hookInput.sessionID ?? "", (hookOutput.metadata ?? {}) as Record<string, unknown>, hookOutput.output, args);
      }
      // Native read-only explorers (glob/grep/read/lsp/…) bypass the f-review tool
      // wrappers — when a review is active, count them against the same
      // exploration budget / duplicate guards the f-review tools use.
      const nativeNotice = guardNativeCall(hookInput.sessionID ?? "", hookInput.tool);
      if (nativeNotice) {
        hookOutput.output = nativeNotice;
      }
      // Identical read-only-call loop: starve it by replacing the output in
      // place. Mutating/control tools are excluded even when repeated: once
      // executed, their actual state-transition response must reach the model.
      if (shouldSuppressRepeatOutput(hookInput.sessionID ?? "", hookInput.tool)) {
        // Core exploration guards carry more specific Qwen recovery advice
        // (notably "submit now"). Preserve it instead of replacing it with the
        // generic session-level notice.
        const alreadyGuarded = /Duplicate call|Exploration limit reached|Consecutive misses/.test(
          hookOutput.output
        );
        if (!alreadyGuarded) {
          hookOutput.output =
            loopNotice(hookInput.sessionID ?? "") + escalateLoop(hookInput.sessionID ?? "");
        }
      }
      if (
        shouldSuppressIdempotentReplay(
          hookInput.sessionID ?? "",
          hookInput.tool,
          hookOutput.output
        )
      ) {
        hookOutput.output = `${hookOutput.output}\n${loopNotice(hookInput.sessionID ?? "")} STOP calling this control tool; its state is already terminal/unchanged.`;
      }
      const budget = afterReviewToolCall(hookInput.sessionID ?? "", hookInput.tool);
      if (!budget.allow && budget.message) {
        hookOutput.output = `${hookOutput.output}\n⚠️ ${budget.message}`;
      }
      if (budget.abort) await abortSession(hookInput.sessionID ?? "");
    },
  };
};

export default OpenCodeAdapter;

// Named export so OpenCode's plugin loader discovers it by name when this file
// is referenced directly from `opencode.json`'s `plugin` array.
export const GordianCodereview = OpenCodeAdapter;
