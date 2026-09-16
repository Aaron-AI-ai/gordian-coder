/**
 * The judge: an independent subagent scores the latest submission on three
 * axes (spec §10, upstream design §1.1). The verdict is computed HERE from the
 * threshold, never trusted from the model. A rework verdict appends the
 * rejected hypothesis to the run so the next analyst round is told every
 * dead end so far (upstream §1.2); past `judgeRounds` the run is terminal.
 */
import { z } from "zod";
import { capped } from "../review/contract";
import { DEFAULT_JUDGE_THRESHOLD, MAX_INVALID_JUDGE_SUBMISSIONS } from "../review/pipeline/judge-store";
import { loadLogConfig } from "./config";
import type { LogPlan } from "./plan";
import { loadJudgments, readRunJson, readRunText, saveJudgments, submissionCount, type LogJudgeAttempt, type RunMeta } from "./run-store";
import type { StoredSubmission } from "./submit";

export const LogJudgeSchema = z.object({
  runId: z.string().min(1),
  judgeToken: z.string().min(1),
  scores: z.object({
    observation: z.number().min(0).max(40),
    alternatives: z.number().min(0).max(30),
    rootCause: z.number().min(0).max(30),
  }),
  unexplained: z.array(capped(300)).max(50),
  feedback: capped(3000),
});

export function latestSubmission(runId: string, cwd: string): StoredSubmission | null {
  const n = submissionCount(runId, cwd);
  return n ? readRunJson<StoredSubmission>(runId, cwd, `submission-${n}.json`) : null;
}

/** The submission finalize should report: a passed one, else the highest
 * judged total, else the latest (unjudged / forced / partial). */
export function bestSubmission(runId: string, cwd: string): { submission: StoredSubmission; attempt?: LogJudgeAttempt } | null {
  const j = loadJudgments(runId, cwd);
  const pick = j.attempts.find((a) => a.verdict === "pass") ?? [...j.attempts].sort((a, b) => b.total - a.total)[0];
  if (pick) {
    const s = readRunJson<StoredSubmission>(runId, cwd, `submission-${pick.round}.json`);
    if (s) return { submission: s, attempt: pick };
  }
  const latest = latestSubmission(runId, cwd);
  return latest ? { submission: latest } : null;
}

export function logJudgeContext(runId: string, cwd: string): string {
  const plan = readRunJson<LogPlan>(runId, cwd, "plan.json");
  const raw = readRunText(runId, cwd, "input.log");
  if (!plan || raw === null) return `⚠️ Unknown run ${runId}.`;
  const sub = latestSubmission(runId, cwd);
  if (!sub) return `⚠️ Run ${runId} has no submission yet — the analyst must call f_log_submit first.`;
  const j = loadJudgments(runId, cwd);
  if (j.attempts.some((a) => a.round === sub.round)) {
    return `ℹ️ Round ${sub.round} of run ${runId} is already judged (${j.attempts.find((a) => a.round === sub.round)!.verdict}). Nothing to do — follow the earlier verdict.`;
  }
  j.pendingToken = crypto.randomUUID();
  saveJudgments(runId, cwd, j);
  const cfg = loadLogConfig(cwd);
  return [
    `# f-log 심사 — run ${runId}, 라운드 ${sub.round}`,
    "## 로그", "```", raw.length > 6000 ? `${raw.slice(0, 6000)}\n… (truncated)` : raw, "```",
    "## 관측 (분석자가 각각 설명했는가)", ...plan.observations.map((o) => `- ${o}`),
    "## 제출된 원인", `- 위치: ${sub.cause.file}${sub.cause.line ? `:${sub.cause.line}` : ""}`, `- 요약: ${sub.cause.summary}`, `- 기전: ${sub.cause.mechanism}`,
    "## 근거", ...sub.evidence.map((e) => `- ${e.file}:${e.lines[0]}-${e.lines[1]} — ${e.why}`),
    "## 관측 대조 (제출자 주장)", ...sub.observations.map((o) => `- [${o.explained ? "설명함" : "미설명"}] ${o.observation}${o.how ? ` — ${o.how}` : ""}`),
    "## 검토한 대안", ...sub.alternatives.map((a) => `- ${a.hypothesis} — 기각: ${a.rejectedBecause}`),
    "## 해결안", `- (${sub.resolution.kind}) ${sub.resolution.summary}`, ...sub.resolution.changes.map((c) => `  - ${c.file}: ${c.description}`),
    `- 신뢰도 ${sub.confidence}${sub.envCause ? " · 환경 원인 가능" : ""}`,
    j.rejected.length ? `## 이전 라운드에서 기각된 가설\n${j.rejected.map((r) => `- (R${r.round}) ${r.cause} — ${r.feedback}`).join("\n")}` : "",
    "## 채점 — 세 축, 합계 100",
    "- observation (0–40): 로그의 관측(스택 순서, 메시지 값, 반복, 에러코드)을 원인이 각각 설명하는가. 설명 못 한 관측은 unexplained[]에 그대로 적는다.",
    "- alternatives (0–30): 다른 가능성을 실제로 검토하고 근거로 배제했는가.",
    "- rootCause (0–30): 해결안이 원인을 없애는가, 증상만 덮는가.",
    `합계 ≥ ${cfg.judgeThreshold} 이면 통과. 판정은 코드가 한다 — 점수와 feedback만 낸다. feedback은 다음 분석자가 **다른 가설로 가도록** 무엇이 틀렸는지 구체적으로.`,
    `JUDGE_TOKEN=${j.pendingToken}`,
    "Call f_log_judge now.",
  ].filter((l) => l !== "").join("\n");
}

export function submitLogJudge(payload: unknown, cwd: string): string {
  const runIdGuess = (payload as { runId?: unknown })?.runId;
  const runId = typeof runIdGuess === "string" ? runIdGuess : "";
  if (!runId || !readRunJson<RunMeta>(runId, cwd, "run.json")) return `⚠️ Unknown run ${runId || "(missing runId)"}.`;
  const j = loadJudgments(runId, cwd);
  const sub = latestSubmission(runId, cwd);
  if (!sub) return `⚠️ Run ${runId} has no submission to judge.`;
  if (j.attempts.some((a) => a.round === sub.round)) return `ℹ️ Round ${sub.round} already recorded — nothing changed.`;

  const parsed = LogJudgeSchema.safeParse(payload);
  if (!parsed.success) {
    j.invalid++;
    if (j.invalid >= MAX_INVALID_JUDGE_SUBMISSIONS) {
      j.skipped = `judge skipped after ${j.invalid} malformed submissions`;
      saveJudgments(runId, cwd, j);
      return `⚠️ Judge skipped for run ${runId}: ${j.invalid} malformed f_log_judge payloads. Call f_log_finalize with runId ${runId}.`;
    }
    saveJudgments(runId, cwd, j);
    return `Invalid judge submission (${j.invalid}/${MAX_INVALID_JUDGE_SUBMISSIONS}): ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Retry with the exact schema.`;
  }
  const data = parsed.data;
  if (data.judgeToken !== j.pendingToken) {
    return `ℹ️ Stale/duplicate f_log_judge ignored — use JUDGE_TOKEN from the latest f_log_judge_context.`;
  }

  const cfg = loadLogConfig(cwd);
  const threshold = cfg.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  const total = data.scores.observation + data.scores.alternatives + data.scores.rootCause;
  const verdict: LogJudgeAttempt["verdict"] = total >= threshold ? "pass" : "rework";
  j.attempts.push({ round: sub.round, scores: data.scores, total, verdict, unexplained: data.unexplained, feedback: data.feedback });
  j.pendingToken = undefined;

  if (verdict === "pass") {
    saveJudgments(runId, cwd, j);
    return `✅ Judge PASS for run ${runId} round ${sub.round} (score ${total} ≥ ${threshold}). Call f_log_finalize with runId ${runId}.`;
  }
  j.rejected.push({ round: sub.round, cause: sub.cause.summary, feedback: data.feedback });
  const reworks = j.attempts.filter((a) => a.verdict === "rework").length;
  if (reworks > cfg.judgeRounds) {
    j.terminal = true;
    saveJudgments(runId, cwd, j);
    return `⚠️ Judge TERMINAL for run ${runId}: score ${total} < ${threshold} and the rework cap (${cfg.judgeRounds}) is spent. Call f_log_finalize with runId ${runId} — it reports the best-scoring round.`;
  }
  saveJudgments(runId, cwd, j);
  return [
    `🔁 Judge REWORK for run ${runId} round ${sub.round} (score ${total} < ${threshold}, rework ${reworks}/${cfg.judgeRounds}).`,
    `Spawn a NEW f-log-analyst subagent in a fresh session: "Analyze log run ${runId}. First call f_log_context with runId \\"${runId}\\", then investigate with the f_log_* tools and finish with f_log_submit." It will receive every rejected hypothesis so far.`,
  ].join("\n");
}
