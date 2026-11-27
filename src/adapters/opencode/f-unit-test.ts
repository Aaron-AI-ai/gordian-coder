/**
 * /f-unit-test-code wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so the other commands never see it.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as wf from "../../core/f-unit-test/workflow";
import {
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  noteToolResult,
  type StageInput,
} from "../../core/f-unit-test/workflow";
import type { OpenCodeModule, ToolResultHook } from "./modules";
import { workflowHooks } from "./workflow-module";

const z = tool.schema;

export function createFUnitTestModule(input: PluginInput): OpenCodeModule {
  const { stopIfLooping, ...hooks } = workflowHooks(input, wf);
  const toolAfter: ToolResultHook = (toolName, sessionID, _metadata, _output, args) =>
    noteToolResult(sessionID, toolName, args);

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
                    boundary: z
                      .array(z.union([z.object({ input: z.string(), expected: z.string() }), z.string()]))
                      .optional()
                      .describe("Boundary cases as { input, expected }: the exact input value(s) and the expected result or exception"),
                    exception: strs().optional(),
                    mocks: strs().optional().describe("Class names to mock (simple or fully qualified), nothing else"),
                    skip_reason: z.string().optional().describe("Instead of cases: why this method needs no test"),
                  })
                )
                .optional(),
              update_existing: z
                .array(z.object({ file: z.string(), test: z.string(), reason: z.string() }))
                .optional()
                .describe("Existing @Test methods this change breaks, approved to update their expected values"),
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
