/**
 * /f-unit-test-req wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so the other commands never see it.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as wf from "../../core/f-unit-test-req/workflow";
import {
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  noteToolResult,
  type StageInput,
} from "../../core/f-unit-test-req/workflow";
import type { OpenCodeModule, ToolResultHook } from "./modules";
import { workflowHooks } from "./workflow-module";

const z = tool.schema;

export function createFUnitTestReqModule(input: PluginInput): OpenCodeModule {
  const { stopIfLooping, ...hooks } = workflowHooks(input, wf);
  const toolAfter: ToolResultHook = (toolName, sessionID, metadata, output, args) =>
    noteToolResult(sessionID, toolName, metadata, output, args);

  const strs = () => z.array(z.string());

  return {
    tools: {
      [STAGE_TOOL]: tool({
        description: STAGE_TOOL_DESCRIPTION,
        args: {
          stage: z.enum(["plan", "execute", "verify"]).describe("The stage being finished"),
          note: z.string().optional().describe("plan: the plan. verify: anything the user should know (\"none\" is fine)."),
          inputs: z
            .object({
              source: z.enum(["file", "text", "program"]).optional(),
              module: z.string().optional(),
              requirement_file: z.string().optional().describe("source=file: the requirement file"),
              program_id: z.string().optional().describe("FICO program ID from --program or the requirement"),
              group_name: z.string().optional().describe("program group, with program_id"),
              no_program: z.boolean().optional().describe("true only after the user confirmed no program applies"),
              targets: strs().optional().describe("Skeleton classes to test (project-relative, under src/main/java); they must exist"),
              files: strs().optional().describe("Every test file to create or extend (project-relative)"),
              cases: z
                .array(
                  z.object({
                    target: z.string(),
                    method: z.string(),
                    requirement: z.string().optional().describe("The requirement item (ID or one line) these cases verify"),
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
    ...hooks,
    toolAfter,
  };
}
