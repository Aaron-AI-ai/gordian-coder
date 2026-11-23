/**
 * /pb-online-code wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so f-review and f-log never see it.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as wf from "../../core/pb-online/workflow";
import {
  COMMAND_NAME,
  KB_TOOL,
  KB_TOOL_DESCRIPTION,
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  getSession,
  noteToolResult,
  type StageInput,
} from "../../core/pb-online/workflow";
import { kbSearch } from "../../core/kb/framework-kb";
import type { OpenCodeModule, ToolResultHook } from "./modules";
import { workflowHooks } from "./workflow-module";

const z = tool.schema;

export function createPbOnlineModule(input: PluginInput): OpenCodeModule {
  const { stopIfLooping, ...hooks } = workflowHooks(input, wf, { keepOnOtherCommand: true });
  const toolAfter: ToolResultHook = (toolName, sessionID, metadata, output, args) =>
    noteToolResult(sessionID, toolName, metadata, output, args);

  return {
    tools: {
      [STAGE_TOOL]: tool({
        description: STAGE_TOOL_DESCRIPTION,
        args: {
          stage: z.enum(["plan", "execute", "verify", "report", "cleanup"]).describe("The stage being finished"),
          note: z.string().optional().describe("plan: the plan. verify: findings per rule. report: the summary."),
          inputs: z
            .object({
              program_id: z.string().optional(),
              group_name: z.string().optional(),
              target_controller: z.string().optional(),
              method_name: z.string().optional(),
              package_path: z.string().optional(),
              files: z.array(z.string()).optional().describe("Every file to create or modify (project-relative)"),
            })
            .optional()
            .describe("plan only: the required inputs, submitted with the plan"),
          user_approved: z.boolean().optional().describe("plan only: true once the user has approved the plan"),
          result: z.enum(["pass", "fail"]).optional().describe("verify only"),
        },
        execute: async (args, ctx) => {
          const result = completeStage(ctx.sessionID, args as StageInput);
          stopIfLooping(ctx.sessionID);
          return result;
        },
      }),
      [KB_TOOL]: tool({
        description: KB_TOOL_DESCRIPTION,
        args: { query: z.string().min(1).describe("Keywords or identifiers, e.g. 'PBRequest' or 'FixedData'") },
        execute: async (args, ctx) => {
          const session = getSession(ctx.sessionID);
          return session ? kbSearch(session.cwd, args.query) : `No /${COMMAND_NAME} workflow is active in this session.`;
        },
      }),
    },
    ...hooks,
    toolAfter,
  };
}
