/**
 * /pb-online-code wiring for the OpenCode plugin: the workflow command plus the
 * guide tool it calls to load the pb-fixed-online-code skill.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  PB_ONLINE_COMMAND_NAME,
  PB_ONLINE_COMMAND_DESCRIPTION,
  PB_ONLINE_COMMAND_TEMPLATE,
  PB_ONLINE_GUIDE,
  PB_ONLINE_GUIDE_DESCRIPTION,
  PB_ONLINE_GUIDE_TOOL,
} from "../../core/pb-online";
import type { OpenCodeModule } from "./modules";

export function createPbOnlineModule(_input: PluginInput): OpenCodeModule {
  // `??=` keeps a project/global md command of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    (cfg.command ??= {})[PB_ONLINE_COMMAND_NAME] ??= {
      description: PB_ONLINE_COMMAND_DESCRIPTION,
      template: PB_ONLINE_COMMAND_TEMPLATE,
    };
  };

  return {
    tools: {
      [PB_ONLINE_GUIDE_TOOL]: tool({
        description: PB_ONLINE_GUIDE_DESCRIPTION,
        args: {},
        execute: async () => PB_ONLINE_GUIDE,
      }),
    },
    config,
  };
}
