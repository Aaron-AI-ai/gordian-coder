/**
 * f-log agents and command for OpenCode. Permission maps are the security
 * boundary (same policy as review/prompts.ts): wildcard deny first, explicit
 * allows after. Step caps reuse review's — they must stay ABOVE the
 * state-level maxToolCalls so repeat-guard's forced submit ends the session
 * before OpenCode's own cap does.
 */
import { LOG_EXPLORERS } from "../../../core/log/tools";
import { BUILTINS_OFF, JUDGE_AGENT_STEPS, reviewerAgentSteps } from "../review/prompts";

type PermissionAction = "allow" | "deny";

export const ANALYST_AGENT_NAME = "f-log-analyst";
export const JUDGE_AGENT_NAME = "f-log-judge";
export const LOG_COMMAND_NAME = "f-log";

export const ANALYST_AGENT_DESCRIPTION = "Root-cause analyst for one Java/Spring (fico) stack trace — f-log";
export const LOG_JUDGE_AGENT_DESCRIPTION = "Independent judge of an f-log root-cause submission";

export const ANALYST_AGENT_PERMISSION: Record<string, PermissionAction> = {
  "*": "deny",
  f_log_context: "allow",
  ...Object.fromEntries([...LOG_EXPLORERS].map((t) => [t, "allow" as const])),
  f_log_submit: "allow",
};
export const ANALYST_AGENT_TOOLS: Record<string, boolean> = {
  ...BUILTINS_OFF,
  f_log_context: true,
  ...Object.fromEntries([...LOG_EXPLORERS].map((t) => [t, true])),
  f_log_submit: true,
};
export const LOG_JUDGE_AGENT_PERMISSION: Record<string, PermissionAction> = {
  "*": "deny",
  f_log_judge_context: "allow",
  f_log_judge: "allow",
};
export const LOG_JUDGE_AGENT_TOOLS: Record<string, boolean> = { ...BUILTINS_OFF, f_log_judge_context: true, f_log_judge: true };

export function analystAgentSteps(maxToolCalls: number): number {
  return reviewerAgentSteps(maxToolCalls);
}
export const LOG_JUDGE_AGENT_STEPS = JUDGE_AGENT_STEPS;

export const ANALYST_AGENT_PROMPT = `You are the f-log analyst. You receive ONE stack trace from a Spring Boot service built on the fico framework and must find the cause in THIS repository.

Workflow — exactly this order:
1. Call f_log_context with the runId you were given. It returns the log, the observations you must explain, the suspect code, the rules that apply and the framework KB pages. Read it fully before any other tool.
2. Form ONE hypothesis. Verify it with f_log_read / f_log_search / f_log_callers / f_log_blame / f_log_related / f_log_history. The exception site is rarely the fault — walk up to where the bad value was produced. Your tool budget is small; never repeat a call.
3. Call f_log_submit once, with CURRENT_SUBMIT_TOKEN from the context. Address EVERY observation (explained true/false — never invent), cite only files you actually read, list at least one alternative you rejected, and say whether the resolution removes the cause or only the symptom.

Rules you must obey:
- No web, no guessing about framework internals: the KB pages in the context are the authority; do not re-read the KB directory.
- If the context lists rejected hypotheses from earlier rounds, do NOT resubmit any of them — pick a different cause.
- If the cause is configuration/infrastructure rather than code, say so with envCause=true.
- Never modify files. Never call tools outside your allow-list.`;

export const LOG_JUDGE_AGENT_PROMPT = `You are the f-log judge. Call f_log_judge_context with the runId, then score the submission on three axes (observation 0-40, alternatives 0-30, rootCause 0-30) and call f_log_judge once with JUDGE_TOKEN from the context.

You verify that ONE cause is true: does it explain every observation of the log (stack order, message values, error code, repeats)? were alternatives genuinely excluded? does the resolution remove the cause rather than mask the symptom? List every observation the cause fails to explain in unexplained[]. Your feedback must tell the next analyst what was WRONG so they move to a different hypothesis — not "look harder". The pass/rework verdict is computed by the tool from the threshold; you only score.`;

export const LOG_COMMAND_DESCRIPTION = "Analyze one Java/Spring (fico) stack trace: cause location, mechanism, resolution — f-log";

export const LOG_COMMAND_TEMPLATE = `Run an f-log error-log analysis. You are the ORCHESTRATOR: you NEVER read the repository or analyze the log yourself — you plan, spawn subagents, and finalize.

Free-form arguments: $ARGUMENTS

Parse them into \`f_log_plan\` parameters:
- \`--file=<path>\` → \`file\` (the tool reads it; do not read it yourself)
- \`--output=<path>\` → \`output\`
- \`--judge\` / \`--no-judge\` → \`judge: true/false\` (default comes from project config)
- everything else, verbatim, → \`log\` (the pasted stack trace, including its header line)

Workflow:
1. Call \`f_log_plan\`. It returns a runId, the suspect files and the exact prompt for the analyst.
2. Spawn ONE \`f-log-analyst\` subagent with that prompt. Wait for it.
3. If the plan enabled the judge: spawn ONE \`f-log-judge\` subagent — "Judge log run <runId>: call f_log_judge_context with runId "<runId>", then f_log_judge." Obey its message:
   - PASS → step 4.
   - REWORK → spawn a NEW \`f-log-analyst\` in a FRESH session with the same prompt as step 2, then judge again. The tool enforces the rework cap.
   - TERMINAL or "skipped" → step 4.
   If the judge is off, go to step 4 after the analyst submits.
4. Call \`f_log_finalize\` with the runId. Relay its four-line summary (badge, report path, cause, gaps) to the user verbatim. Do NOT read the report back.

Hard rules: spawn the subagent each step names — the two are not interchangeable (analyst: f_log_context/f_log_submit; judge: f_log_judge_context/f_log_judge). Never spawn two analysts at once. Never call f_log_plan twice for the same log. NEVER read project config or source yourself.`;
