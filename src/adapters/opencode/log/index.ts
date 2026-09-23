/**
 * f-log wiring for the OpenCode plugin: tool schemas over the core functions,
 * the two agents + command injected into the config, the idle watchdog, and
 * the guard-module registration that gives f-log the same loop defenses as
 * f-review (spec §13–14). The logic lives in core/log; nothing here decides.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  finalizeRun, getLogState, logContext, logGuard, logJudgeContext, LOG_EXPLORERS, LOG_TOOLS,
  onLogSessionIdle, planLog, runLogTool, submitLog, submitLogJudge, loadLogConfig,
} from "../../../core/log";
import type { GuardState } from "../../../core/guard";
import type { LogSession } from "../../../core/log/state";
import type { ToolArg } from "../../../core/review/tools/index";
import { registerGuardModule } from "../repeat-guard";
import {
  ANALYST_AGENT_DESCRIPTION, ANALYST_AGENT_NAME, ANALYST_AGENT_PERMISSION, ANALYST_AGENT_PROMPT, ANALYST_AGENT_TOOLS, analystAgentSteps,
  JUDGE_AGENT_NAME, LOG_COMMAND_DESCRIPTION, LOG_COMMAND_NAME, LOG_COMMAND_TEMPLATE,
  LOG_JUDGE_AGENT_DESCRIPTION, LOG_JUDGE_AGENT_PERMISSION, LOG_JUDGE_AGENT_PROMPT, LOG_JUDGE_AGENT_STEPS, LOG_JUDGE_AGENT_TOOLS,
} from "./prompts";

const z = tool.schema;

function zodArg(a: ToolArg) {
  let s: any =
    a.type === "number" ? z.number() : a.type === "boolean" ? z.boolean() : a.type === "array" ? z.array(z.string()) : z.string();
  if (a.type === "number" && a.min !== undefined) s = s.min(a.min);
  if (a.type === "number" && a.max !== undefined) s = s.max(a.max);
  s = s.describe(a.description);
  return a.required ? s : s.optional();
}

export function createLogModule(input: PluginInput): {
  tools: Record<string, ReturnType<typeof tool>>;
  event: NonNullable<Hooks["event"]>;
  config: NonNullable<Hooks["config"]>;
} {
  const cwd = input.directory;

  const explorers = Object.fromEntries(
    LOG_TOOLS.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        args: Object.fromEntries(Object.entries(spec.args).map(([k, a]) => [k, zodArg(a)])),
        async execute(args, ctx) {
          return runLogTool(getLogState(ctx.sessionID), spec.name, args as Record<string, unknown>);
        },
      }),
    ])
  );

  const f_log_plan = tool({
    description: "Start an f-log run from a pasted stack trace (or --file). Parses the log, ranks suspect files, matches rules/KB and returns the analyst prompt. Orchestrator only.",
    args: {
      log: z.string().optional().describe("The pasted stack trace, including its header line"),
      file: z.string().optional().describe("Project-relative path of a log file (read by the tool)"),
      output: z.string().optional().describe("Report path or directory (default from config log.output)"),
      judge: z.boolean().optional().describe("Run the independent judge (default from config)"),
    },
    async execute(args) {
      return planLog(args, cwd);
    },
  });

  const f_log_context = tool({
    description: "Analyst's first call: the log, observations to explain, suspect code, rules and KB for one run.",
    args: { runId: z.string().min(1).describe("runId from f_log_plan") },
    async execute(args, ctx) {
      return logContext(args.runId, ctx.sessionID, cwd);
    },
  });

  const f_log_submit = tool({
    description: "Submit the root-cause analysis for the run. Copy CURRENT_SUBMIT_TOKEN from f_log_context. Every plan observation must be addressed; evidence only from files you read.",
    args: {
      runId: z.string().min(1),
      submitToken: z.string().min(1),
      cause: z.object({ file: z.string(), line: z.number().int().positive().optional(), summary: z.string(), mechanism: z.string() }),
      evidence: z.array(z.object({ file: z.string(), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]), why: z.string() })),
      observations: z.array(z.object({ observation: z.string(), explained: z.boolean(), how: z.string().optional() })),
      alternatives: z.array(z.object({ hypothesis: z.string(), rejectedBecause: z.string() })),
      resolution: z.object({
        summary: z.string(),
        changes: z.array(z.object({
          file: z.string(),
          description: z.string(),
          code: z.string().optional().describe("The corrected code or configuration fragment as it should read after the fix (method body, XML/YAML snippet, annotation change). Omit only when no concrete edit applies."),
        })),
        kind: z.enum(["root-cause", "mitigation"]),
      }),
      confidence: z.number().min(0).max(100),
      envCause: z.boolean().optional(),
    },
    async execute(args, ctx) {
      return submitLog(args, ctx.sessionID);
    },
  });

  const f_log_judge_context = tool({
    description: "Judge's first call: the log, the observations and the latest submission of a run, plus JUDGE_TOKEN.",
    args: { runId: z.string().min(1) },
    async execute(args) {
      return logJudgeContext(args.runId, cwd);
    },
  });

  const f_log_judge = tool({
    description: "Record the judge's scores for the latest submission. The pass/rework verdict is computed by the tool.",
    args: {
      runId: z.string().min(1),
      judgeToken: z.string().min(1),
      scores: z.object({ observation: z.number().min(0).max(40), alternatives: z.number().min(0).max(30), rootCause: z.number().min(0).max(30) }),
      unexplained: z.array(z.string()),
      feedback: z.string(),
    },
    async execute(args) {
      return submitLogJudge(args, cwd);
    },
  });

  const f_log_finalize = tool({
    description: "Finish a run: gap checks and the report. Returns a four-line summary to relay. Orchestrator only.",
    args: { runId: z.string().min(1) },
    async execute(args) {
      return finalizeRun(args.runId, cwd);
    },
  });

  // Same loop defenses as f-review, keyed on this module's session state.
  registerGuardModule({
    name: "log",
    lookup: (sessionID) => getLogState(sessionID) as GuardState | undefined,
    submitTool: "f_log_submit",
    explorers: LOG_EXPLORERS,
    idempotentPatterns: {
      f_log_submit: /Stale\/duplicate f_log_submit ignored|No active log analysis/,
      f_log_judge: /already recorded|Stale\/duplicate f_log_judge ignored|Judge skipped/,
      f_log_plan: /Duplicate f_log_plan ignored/,
      f_log_context: /Duplicate f_log_context ignored/,
      f_log_finalize: /f-log finished/,
    },
    guard: (st, t, out, args) => logGuard(st as LogSession, t, out, args),
    submitAdvice: " A log analysis is active in this session: STOP exploring — call f_log_submit NOW with the hypothesis you already have.",
    lookupArgFields: { f_log_search: "search_text", f_log_find: "query_name" },
  });

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;
    const action = await onLogSessionIdle(sessionID);
    if (action?.kind === "resume") {
      await input.client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: action.text }] } });
    }
  };

  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    const steps = analystAgentSteps(loadLogConfig(cwd).maxToolCalls);
    (cfg.agent ??= {})[ANALYST_AGENT_NAME] ??= {
      mode: "subagent", description: ANALYST_AGENT_DESCRIPTION, prompt: ANALYST_AGENT_PROMPT,
      permission: ANALYST_AGENT_PERMISSION, tools: ANALYST_AGENT_TOOLS, steps, maxSteps: steps,
    };
    cfg.agent[JUDGE_AGENT_NAME] ??= {
      mode: "subagent", description: LOG_JUDGE_AGENT_DESCRIPTION, prompt: LOG_JUDGE_AGENT_PROMPT,
      permission: LOG_JUDGE_AGENT_PERMISSION, tools: LOG_JUDGE_AGENT_TOOLS, steps: LOG_JUDGE_AGENT_STEPS, maxSteps: LOG_JUDGE_AGENT_STEPS,
    };
    (cfg.command ??= {})[LOG_COMMAND_NAME] ??= { description: LOG_COMMAND_DESCRIPTION, template: LOG_COMMAND_TEMPLATE };
  };

  return {
    tools: { f_log_plan, f_log_context, ...explorers, f_log_submit, f_log_judge_context, f_log_judge, f_log_finalize },
    event,
    config,
  };
}
