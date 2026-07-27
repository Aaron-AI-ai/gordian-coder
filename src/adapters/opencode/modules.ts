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

export interface OpenCodeModule {
  tools: Record<string, ReturnType<typeof tool>>;
  systemTransform?: NonNullable<Hooks["experimental.chat.system.transform"]>;
  event?: NonNullable<Hooks["event"]>;
}

/** Registered module factories — the single place to add a new module. */
const factories: Array<(input: PluginInput) => OpenCodeModule> = [
  createReviewModule,
];

export function createModules(input: PluginInput): OpenCodeModule[] {
  return factories.map((factory) => factory(input));
}
