/**
 * /f-unittest-analysis wiring for the OpenCode plugin. Every hook is a no-op unless
 * the session started this workflow, so the other commands never see it.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as wf from "../../core/f-unittest-analysis/workflow";
import {
  STAGE_TOOL,
  STAGE_TOOL_DESCRIPTION,
  completeStage,
  runExecute,
  type StageInput,
} from "../../core/f-unittest-analysis/workflow";
import type { OpenCodeModule } from "./modules";
import { workflowHooks } from "./workflow-module";

const z = tool.schema;

export function createFUnittestAnalysisModule(input: PluginInput): OpenCodeModule {
  const { stopIfLooping: _, ...hooks } = workflowHooks(input, wf);

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
    ...hooks,
  };
}
