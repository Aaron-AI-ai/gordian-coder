/**
 * f_log_submit: validate the analyst's hypothesis against the plan's
 * observations and the session's call log, store it, close the session.
 * Every rejection is counted; past MAX_FAILED_SUBMITS the last parseable
 * payload (or an empty one) is accepted as `forced` so a degenerate model
 * cannot stall the run (spec §10). The idle watchdog stores a `partial`
 * submission when the model simply stops (spec §13 #12).
 */
import { z } from "zod";
import { capped } from "../review/contract";
import { MAX_FAILED_SUBMITS, MAX_RESUMES } from "../review/pipeline/loop";
import type { LogPlan } from "./plan";
import { mergeCallLog, readRunJson, submissionCount, writeRunJson, type RunMeta } from "./run-store";
import { clearLogState, getLogState, type LogSession } from "./state";
import { NO_ACTIVE_LOG } from "./tools";

const lineRange = z.tuple([z.number().int().positive(), z.number().int().positive()]);

export const LogSubmitSchema = z.object({
  runId: z.string().min(1),
  submitToken: z.string().min(1),
  cause: z.object({
    file: capped(500),
    line: z.number().int().positive().optional(),
    summary: capped(500),
    mechanism: capped(3000),
  }),
  evidence: z.array(z.object({ file: capped(500), lines: lineRange, why: capped(500) })).min(1).max(20),
  observations: z.array(z.object({ observation: capped(500), explained: z.boolean(), how: capped(500).optional() })).max(50),
  alternatives: z.array(z.object({ hypothesis: capped(500), rejectedBecause: capped(500) })).min(1).max(10),
  resolution: z.object({
    summary: capped(1000),
    changes: z.array(z.object({ file: capped(500), description: capped(1000) })).max(20),
    kind: z.enum(["root-cause", "mitigation"]),
  }),
  confidence: z.number().min(0).max(100),
  envCause: z.boolean().optional(),
});
export type LogSubmission = z.infer<typeof LogSubmitSchema>;

export interface StoredSubmission extends LogSubmission {
  round: number;
  forced?: string;
  partial?: boolean;
  submittedAt: string;
}

export function nextStepText(runId: string, judge: boolean): string {
  return judge
    ? `Next: spawn ONE f-log-judge subagent — "Judge log run ${runId}: call f_log_judge_context with runId \\"${runId}\\", then f_log_judge."`
    : `Next: call f_log_finalize with runId ${runId}.`;
}

function emptySubmission(runId: string): LogSubmission {
  return {
    runId, submitToken: "",
    cause: { file: "", summary: "", mechanism: "" },
    evidence: [{ file: "", lines: [1, 1], why: "" }],
    observations: [], alternatives: [{ hypothesis: "", rejectedBecause: "" }],
    resolution: { summary: "", changes: [], kind: "mitigation" },
    confidence: 0,
  };
}

function store(st: LogSession, sub: LogSubmission, sessionId: string, extra: { forced?: string; partial?: boolean }): string {
  const meta = readRunJson<RunMeta>(st.runId, st.cwd, "run.json");
  const round = submissionCount(st.runId, st.cwd) + 1;
  const stored: StoredSubmission = { ...sub, submitToken: "", round, submittedAt: new Date().toISOString(), ...extra };
  writeRunJson(st.runId, st.cwd, `submission-${round}.json`, stored);
  mergeCallLog(st.runId, st.cwd, st.callLog);
  // Finalize (another session) needs which suspects were actually read.
  writeRunJson(st.runId, st.cwd, "readFiles.json", [...new Set([...(readRunJson<string[]>(st.runId, st.cwd, "readFiles.json") ?? []), ...Object.keys(st.readFiles ?? {})])]);
  st.active = false;
  st.submitted = true;
  clearLogState(sessionId);
  const badge = extra.partial ? "⚠️ Partial submission stored (analyst stopped)" : extra.forced ? `⚠️ Submission forced through${extra.forced}` : "✅ Submission recorded";
  return `${badge} for run ${st.runId}, round ${round}. ${nextStepText(st.runId, meta?.judge ?? true)}`;
}

export function submitLog(payload: unknown, sessionId: string): string {
  const st = getLogState(sessionId);
  if (!st?.active) return NO_ACTIVE_LOG;

  const reject = (msg: string): string | null => {
    st.failedSubmits++;
    return st.failedSubmits <= MAX_FAILED_SUBMITS
      ? `${msg}\n(rejected submit ${st.failedSubmits}/${MAX_FAILED_SUBMITS} — past the cap the last valid payload is force-accepted.)`
      : null;
  };

  const parsed = LogSubmitSchema.safeParse(payload);
  if (!parsed.success) {
    const bounce = reject(`Invalid submission: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (bounce) return bounce;
    const last = (st.lastValid as LogSubmission | undefined) ?? emptySubmission(st.runId);
    return store(st, last, sessionId, { forced: ` — after ${MAX_FAILED_SUBMITS} invalid submissions${st.lastValid ? " (salvaged an earlier payload)" : " (nothing valid was ever submitted)"}` });
  }
  const sub = parsed.data;
  if (sub.runId !== st.runId) return `⚠️ This session analyzes run ${st.runId}, not ${sub.runId}. Use runId ${st.runId}.`;

  if (sub.submitToken !== st.submitToken) {
    st.staleSubmits++;
    if (st.staleSubmits <= MAX_FAILED_SUBMITS) {
      return `ℹ️ Stale/duplicate f_log_submit ignored; no state changed (${st.staleSubmits}/${MAX_FAILED_SUBMITS}). Use CURRENT_SUBMIT_TOKEN=${st.submitToken}.`;
    }
    const last = (st.lastValid as LogSubmission | undefined) ?? { ...sub, submitToken: st.submitToken };
    return store(st, last, sessionId, { forced: " — after repeated stale submit-token replays" });
  }
  st.lastValid = sub;

  const plan = readRunJson<LogPlan>(st.runId, st.cwd, "plan.json");
  if (!plan) return `⚠️ Run ${st.runId} has no plan.json — call f_log_plan again.`;

  // Gate 1: every plan observation must be addressed, verbatim.
  const given = new Set(sub.observations.map((o) => o.observation));
  const missing = plan.observations.filter((o) => !given.has(o));
  if (missing.length) {
    const bounce = reject(`observations[] must address every plan observation. Missing:\n${missing.map((m) => `- ${m}`).join("\n")}`);
    if (bounce) return bounce;
    return store(st, sub, sessionId, { forced: " — after repeated incomplete observation coverage" });
  }

  // Gate 2: evidence only from files actually seen (read/blamed) or injected as a suspect snippet.
  const seen = new Set<string>(plan.suspects.map((s) => s.path));
  for (const f of Object.keys(st.readFiles ?? {})) seen.add(f);
  const unseen = sub.evidence.map((e) => e.file).filter((f) => !seen.has(f));
  if (unseen.length) {
    const bounce = reject(`evidence[] may only cite files you read with f_log_read/f_log_blame or that were injected as suspects. Not seen: ${unseen.join(", ")}`);
    if (bounce) return bounce;
    return store(st, sub, sessionId, { forced: " — after repeated evidence on unread files" });
  }

  return store(st, sub, sessionId, {});
}

/** Turn-end watchdog for an analyst session that went idle without submitting. */
export async function onLogSessionIdle(sessionId: string): Promise<{ kind: "resume" | "finalized"; text: string } | null> {
  const st = getLogState(sessionId);
  if (!st?.active || st.submitted) return null;
  const partial = () => store(st, (st.lastValid as LogSubmission | undefined) ?? emptySubmission(st.runId), sessionId, { partial: true });
  if (st.toolBudgetExhausted) return { kind: "finalized", text: partial() };
  if (st.resumes < MAX_RESUMES) {
    st.resumes++;
    return {
      kind: "resume",
      text: `Log analysis for run ${st.runId} is not submitted yet. Call f_log_submit now with what you have (CURRENT_SUBMIT_TOKEN=${st.submitToken}) — auto-resume ${st.resumes}/${MAX_RESUMES}.`,
    };
  }
  return { kind: "finalized", text: partial() };
}
