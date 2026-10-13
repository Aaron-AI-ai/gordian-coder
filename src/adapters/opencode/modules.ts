/**
 * Feature-module registry for the OpenCode adapter.
 *
 * A module contributes tools and (optionally) a system-prompt transform.
 * To add a module: write its factory, then append it to `factories` below.
 * index.ts consumes the registry and never changes.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { tool } from "@opencode-ai/plugin";
import { createReviewModule } from "./review";
import { createLogModule } from "./log";

/** OpenCode's `command.execute.before` (raw slash-command arguments; `parts`
 * is what the model receives). Declared here because the pinned plugin SDK
 * predates it — the runtime has fired it since 1.1.x. */
export type CommandBeforeHook = (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: Array<{ type: string; text?: string }> }
) => Promise<void>;

export interface OpenCodeModule {
  tools: Record<string, ReturnType<typeof tool>>;
  systemTransform?: NonNullable<Hooks["experimental.chat.system.transform"]>;
  event?: NonNullable<Hooks["event"]>;
  /** Inject agents/commands into the OpenCode config (bundled definitions). */
  config?: NonNullable<Hooks["config"]>;
  commandBefore?: CommandBeforeHook;
}

/** Registered module factories — the single place to add a new module. */
const factories: Array<(input: PluginInput) => OpenCodeModule> = [
  createReviewModule,
  createLogModule,
];

export function createModules(input: PluginInput): OpenCodeModule[] {
  return factories.map((factory) => factory(input));
}
