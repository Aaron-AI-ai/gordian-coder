/**
 * /f-unit-test-code wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so the other commands never see it.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  COMMAND_TEMPLATE,
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  endSession,
  gateTool,
  getSession,
  noteToolResult,
  noteUserMessage,
  renderStageGuide,
  startSession,
  takeAbortRequest,
  type StageInput,
} from "../../core/f-unit-test/workflow";
import type { CommandBeforeHook, OpenCodeModule, ToolGate, ToolResultHook } from "./modules";

const z = tool.schema;

export function createFUnitTestModule(input: PluginInput): OpenCodeModule {
  // `??=` keeps a project/global md command of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    (cfg.command ??= {})[COMMAND_NAME] ??= {
      description: COMMAND_DESCRIPTION,
      template: COMMAND_TEMPLATE,
    };
  };

  const commandBefore: CommandBeforeHook = async ({ command, sessionID, arguments: raw }) => {
    if (command === COMMAND_NAME) startSession(sessionID, raw, input.directory);
    // Another slash command in the same session leaves this workflow; otherwise its gate would keep refusing.
    else if (getSession(sessionID)) endSession(sessionID);
  };

  // A model that ignores "END YOUR TURN" loops until its step limit; abort the turn instead.
  const stopIfLooping = (sessionID: string): void => {
    if (!takeAbortRequest(sessionID)) return;
    void input.client?.session.abort({ path: { id: sessionID } }).catch((err: unknown) => {
      console.error(`[gordian-coder] f-unit-test abort(${sessionID}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const toolBefore: ToolGate = (toolName, sessionID, args) => {
    const rejection = gateTool(sessionID, toolName, args);
    if (!rejection) return;
    stopIfLooping(sessionID);
    throw new Error(rejection);
  };

  const toolAfter: ToolResultHook = (toolName, sessionID, _metadata, _output, args) =>
    noteToolResult(sessionID, toolName, args);

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (hookInput, output) => {
    const session = getSession(hookInput.sessionID);
    if (session) output.system.push(renderStageGuide(session.stage, session));
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "message.updated" || event.properties.info.role !== "user") return;
    const { sessionID, time } = event.properties.info;
    noteUserMessage(sessionID, time.created);
  };

  const strs = () => z.array(z.string());

  return {
    tools: {
      [STAGE_TOOL]: tool({
        description: STAGE_TOOL_DESCRIPTION,
        args: {
          stage: z.enum(["plan", "execute", "verify", "report"]).describe("The stage being finished"),
          note: z.string().optional().describe("plan: the plan. verify: findings. report: the summary."),
          inputs: z
            .object({
              mode: z.enum(["files", "program", "git"]).optional(),
              module: z.string().optional(),
              targets: strs().optional().describe("Classes to test (project-relative, under src/main/java)"),
              files: strs().optional().describe("Every test file to create or modify (project-relative)"),
              cases: z
                .array(
                  z.object({
                    target: z.string(),
                    method: z.string(),
                    normal: strs().optional(),
                    boundary: strs().optional(),
                    exception: strs().optional(),
                    mocks: strs().optional().describe("Class names to mock (simple or fully qualified), nothing else"),
                    skip_reason: z.string().optional().describe("Instead of cases: why this method needs no test"),
                  })
                )
                .optional(),
            })
            .optional()
            .describe("plan only: the test plan inputs, submitted with the plan"),
          user_approved: z.boolean().optional().describe("plan only: true once the user has approved the plan"),
        },
        execute: async (args, ctx) => {
          const result = completeStage(ctx.sessionID, args as StageInput);
          stopIfLooping(ctx.sessionID);
          return result;
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
