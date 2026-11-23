/**
 * /f-unittest-analysis wiring for the OpenCode plugin. Every hook is a no-op unless
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
  noteUserMessage,
  renderStageGuide,
  runExecute,
  startSession,
  type StageInput,
} from "../../core/f-unittest-analysis/workflow";
import type { CommandBeforeHook, OpenCodeModule, ToolGate } from "./modules";

const z = tool.schema;

export function createFUnittestAnalysisModule(input: PluginInput): OpenCodeModule {
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

  const toolBefore: ToolGate = (toolName, sessionID, args) => {
    const rejection = gateTool(sessionID, toolName, args);
    if (rejection) throw new Error(rejection);
  };

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (hookInput, output) => {
    const session = getSession(hookInput.sessionID);
    if (session) output.system.push(renderStageGuide(session.stage, session));
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "message.updated" || event.properties.info.role !== "user") return;
    noteUserMessage(event.properties.info.sessionID, event.properties.info.time.created);
  };

  return {
    tools: {
      [STAGE_TOOL]: tool({
        description: STAGE_TOOL_DESCRIPTION,
        args: {
          stage: z.enum(["plan", "execute"]).describe("The stage being finished"),
          note: z.string().optional().describe("plan only: the short plan for the user (Korean)"),
          inputs: z
            .object({
              module: z.string().optional().describe("Gradle module directory, e.g. on-test-lab/on-test-lab-unit"),
              tests: z
                .array(
                  z.object({
                    file: z.string().describe("Test file under src/test/java (project-relative)"),
                    methods: z.array(z.string()).optional().describe("Only these @Test methods; omit for the whole class"),
                  })
                )
                .optional()
                .describe("Selected tests; an empty list runs every test of the module"),
            })
            .optional()
            .describe("plan only"),
        },
        execute: async (args, ctx) => {
          if (args.stage === "execute") return runExecute(ctx.sessionID, (title) => ctx.metadata({ title }), ctx.abort);
          return completeStage(ctx.sessionID, args as StageInput);
        },
      }),
    },
    config,
    commandBefore,
    toolBefore,
    systemTransform,
    event,
  };
}
