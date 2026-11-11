/**
 * /pb-online-code wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so f-review and f-log never see it.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  COMMAND_TEMPLATE,
  KB_TOOL,
  KB_TOOL_DESCRIPTION,
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  gateTool,
  getSession,
  noteToolResult,
  noteUserMessage,
  renderStageGuide,
  startSession,
  takeAbortRequest,
  type StageInput,
} from "../../core/pb-online/workflow";
import { kbSearch } from "../../core/kb/framework-kb";
import type { CommandBeforeHook, OpenCodeModule, ToolGate, ToolResultHook } from "./modules";

const z = tool.schema;

export function createPbOnlineModule(input: PluginInput): OpenCodeModule {
  // `??=` keeps a project/global md command of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    (cfg.command ??= {})[COMMAND_NAME] ??= {
      description: COMMAND_DESCRIPTION,
      template: COMMAND_TEMPLATE,
    };
  };

  const commandBefore: CommandBeforeHook = async ({ command, sessionID, arguments: raw }) => {
    if (command === COMMAND_NAME) startSession(sessionID, raw, input.directory);
  };

  // A model that ignores "END YOUR TURN" loops until its step limit; abort the turn instead.
  const stopIfLooping = (sessionID: string): void => {
    if (!takeAbortRequest(sessionID)) return;
    void input.client?.session.abort({ path: { id: sessionID } }).catch((err: unknown) => {
      console.error(`[gordian-coder] pb-online abort(${sessionID}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const toolBefore: ToolGate = (toolName, sessionID, args) => {
    const rejection = gateTool(sessionID, toolName, args);
    if (!rejection) return;
    stopIfLooping(sessionID);
    throw new Error(rejection);
  };

  const toolAfter: ToolResultHook = (toolName, sessionID, metadata, output, args) =>
    noteToolResult(sessionID, toolName, metadata, output, args);

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (hookInput, output) => {
    const session = getSession(hookInput.sessionID);
    if (session) output.system.push(renderStageGuide(session.stage));
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "message.updated" || event.properties.info.role !== "user") return;
    const { sessionID, time } = event.properties.info;
    noteUserMessage(sessionID, time.created);
  };

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
    config,
    commandBefore,
    toolBefore,
    toolAfter,
    systemTransform,
    event,
  };
}
