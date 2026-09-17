/**
 * Stage 4: set-difference gap checks (upstream design §1.4 — gaps are
 * reported, never looped back), the markdown report (spec §11), and the
 * short response the orchestrator relays. Idempotent: a second call returns
 * the stored response and never rewrites the report.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { readFileAt, renderFileContent } from "../review/tools/read";
import { loadLogConfig, type LogConfig } from "./config";
import { bestSubmission } from "./judge";
import { parseStackTrace } from "./parse";
import type { LogPlan } from "./plan";
import { loadJudgments, readRunJson, readRunText, writeRunJson, type LogJudgeAttempt, type LogJudgments, type RunMeta } from "./run-store";
import type { StoredSubmission } from "./submit";

export interface Gaps {
  unexplainedExceptions: string[];
  unreadSuspects: string[];
  unresolvedObservations: string[];
}
export type Badge = "PASS" | "TERMINAL" | "FORCED" | "PARTIAL" | "JUDGE SKIPPED" | "UNJUDGED";
export interface FinalizeInput {
  plan: LogPlan;
  input: string;
  submission: StoredSubmission;
  judgments: LogJudgments;
  attempt?: LogJudgeAttempt;
  session: { toolCalls: number; maxToolCalls: number; rounds: number };
  cwd: string;
}

const EVIDENCE_MAX_LINES = 30;
const RAW_MAX = 6_000;

/** callLog is part of the interface contract (spec §11.1) but the read/unread
 * split only needs readFiles.json — kept as a parameter for callers that
 * already have both on hand. `injected` (injected.json) are suspects whose
 * snippet was actually shown in some round's context — the submit-gate
 * treats them as seen (submit.ts Gate 2), so the gap check must too (I-6). */
export function computeGaps(plan: LogPlan, submission: StoredSubmission, judgments: LogJudgments, callLog: Record<string, Record<string, number>>, readFiles: string[], injected: string[]): Gaps {
  void callLog;
  const explained = new Set(submission.observations.filter((o) => o.explained).map((o) => o.observation));
  const unexplainedExceptions = plan.observations
    .filter((o) => /^예외 \d+\/\d+: /.test(o) && !explained.has(o))
    .map((o) => o.replace(/^예외 \d+\/\d+: /, "").split(":")[0]);
  const seen = new Set([...readFiles, ...injected]);
  const unreadSuspects = plan.suspects.map((s) => s.path).filter((p) => !seen.has(p));
  const last = [...judgments.attempts].sort((a, b) => b.round - a.round)[0];
  const unresolvedObservations = last?.unexplained ?? [];
  return { unexplainedExceptions, unreadSuspects, unresolvedObservations };
}

export function badgeFor(submission: StoredSubmission, judgments: LogJudgments, attempt?: LogJudgeAttempt): Badge {
  if (submission.partial) return "PARTIAL";
  if (submission.forced) return "FORCED";
  if (judgments.skipped) return "JUDGE SKIPPED";
  if (attempt?.verdict === "pass") return "PASS";
  if (judgments.terminal) return "TERMINAL";
  return "UNJUDGED";
}

const L = {
  ko: {
    summary: "## 요약", raw: "## 스택 원문", path: "## 진입점 → 원인 경로", cause: "## 원인 상세와 근거", fix: "## 해결 방안",
    alts: "## 검토한 대안", gaps: "## 못 본 것", judge: "## 심사 이력", run: "## 실행 정보",
    none: "제출 없음", noGaps: "누락 없음 — 로그의 예외·용의 파일·관측이 모두 다뤄졌다.",
    gapsNote: "누락이 있어도 되돌리지 않는다. 다시 돌릴지는 읽는 사람이 정한다.",
    env: "환경 원인 가능 — 코드 수정 전 설정·인프라를 먼저 확인.", mitigation: "⚠️ 원인 제거가 아닌 증상 완화(mitigation)다.",
    confidence: "신뢰도", entry: "진입점", causeFrame: "원인 프레임", unexplained: "설명 안 된 예외", unread: "안 읽은 용의 파일", unresolved: "미해결 관측",
    rounds: "라운드", tools: "툴 호출", rules: "적용 룰", kb: "주입 KB", runs: "실행 상세", judgeNone: "심사 안 함", terminal: "임계값 미달 — 최고점 라운드 채택",
    partial: "분석 미완 — 모델이 제출 전에 중단", forced: "강제 수락", skipped: "심사 생략",
  },
  en: {
    summary: "## Summary", raw: "## Stack trace", path: "## Entry point → cause path", cause: "## Cause and evidence", fix: "## Resolution",
    alts: "## Alternatives considered", gaps: "## Not examined", judge: "## Judge history", run: "## Run info",
    none: "no submission", noGaps: "No gaps — every exception, suspect file and observation was covered.",
    gapsNote: "Gaps are reported, not looped back. Re-running is the reader's call.",
    env: "Possible environment cause — check configuration/infrastructure before changing code.", mitigation: "⚠️ This is a mitigation, not a root-cause fix.",
    confidence: "confidence", entry: "entry", causeFrame: "cause frame", unexplained: "unexplained exceptions", unread: "unread suspect files", unresolved: "unresolved observations",
    rounds: "rounds", tools: "tool calls", rules: "rules applied", kb: "KB injected", runs: "run details", judgeNone: "not judged", terminal: "below threshold — best-scoring round adopted",
    partial: "analysis incomplete — the model stopped before submitting", forced: "force-accepted", skipped: "judge skipped",
  },
} as const;

function quote(cwd: string, file: string, from: number, to: number): string {
  const content = readFileAt(cwd, null, file);
  if (content === null) return "(file not readable)";
  const end = Math.min(to, from + EVIDENCE_MAX_LINES - 1);
  return renderFileContent(file, content, from, end, EVIDENCE_MAX_LINES);
}

export function renderLogReport(i: FinalizeInput, gaps: Gaps, badge: Badge, lang: "ko" | "en", now: Date): string {
  const t = L[lang];
  const s = i.submission;
  const empty = !s.cause.summary;
  const parsed = parseStackTrace(i.input);
  const root = parsed.chain.at(-1);
  const out: string[] = [];

  out.push(`# f-log ${i.plan.runId} — **${badge}**`, `${now.toISOString().slice(0, 19).replace("T", " ")} UTC · ${i.cwd.split(/[\\/]/).at(-1)}`, "");
  out.push(t.summary, empty ? `_${t.none}_` : `**${s.cause.summary}** (${t.confidence} ${s.confidence})`);
  if (s.envCause) out.push(`- ${t.env}`);
  if (s.resolution.kind === "mitigation" && !empty) out.push(`- ${t.mitigation}`);
  if (badge === "TERMINAL") out.push(`- ${t.terminal}`);
  if (badge === "PARTIAL") out.push(`- ${t.partial}`);
  if (badge === "FORCED") out.push(`- ${t.forced}${s.forced ?? ""}`);
  out.push("");

  const raw = i.input.length > RAW_MAX ? `${i.input.slice(0, RAW_MAX)}\n… (${i.input.length} chars; runs/${i.plan.runId}/input.log)` : i.input;
  out.push(t.raw, "```", raw.trimEnd(), "```", "");

  out.push(t.path);
  const inApp = (root?.frames ?? []).filter((f) => i.plan.kinds[f.cls] === "app");
  const chain = [...inApp].reverse().map((f) => `${f.cls}.${f.method}${f.line ? `(${f.file}:${f.line})` : ""}`);
  if (i.plan.entry) out.push(`- ${t.entry}: ${i.plan.entry.cls}.${i.plan.entry.method}${i.plan.entry.line ? `:${i.plan.entry.line}` : ""}`);
  if (chain.length) out.push(`- ${chain.join(" → ")}`);
  if (!empty) out.push(`- **${t.causeFrame}: ${s.cause.file}${s.cause.line ? `:${s.cause.line}` : ""}**`);
  if (!i.plan.entry && !chain.length) out.push(`- ${i.plan.suspects.map((x) => `${x.path} [${x.source}]`).join(", ") || "(none)"}`);
  out.push("");

  out.push(t.cause);
  if (empty) out.push(`_${t.none}_`);
  else {
    out.push(s.cause.mechanism, "");
    for (const e of s.evidence) {
      if (!e.file) continue;
      out.push(`**${e.file}:${e.lines[0]}-${e.lines[1]}** — ${e.why}`, "```", quote(i.cwd, e.file, e.lines[0], e.lines[1]), "```");
    }
  }
  out.push("");

  out.push(t.fix, empty ? `_${t.none}_` : s.resolution.summary);
  for (const c of s.resolution.changes) {
    out.push(`- ${c.file}: ${c.description}`);
    if (c.code) {
      const code = c.code.trimEnd();
      const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      out.push("", fence + extname(c.file).slice(1), code, fence, "");
    }
  }
  out.push("");

  out.push(t.alts);
  for (const a of s.alternatives) if (a.hypothesis) out.push(`- ${a.hypothesis} — ${a.rejectedBecause}`);
  for (const r of i.judgments.rejected) out.push(`- (R${r.round}, judge) ${r.cause} — ${r.feedback}`);
  if (!s.alternatives.some((a) => a.hypothesis) && !i.judgments.rejected.length) out.push("- —");
  out.push("");

  out.push(t.gaps);
  const anyGap = gaps.unexplainedExceptions.length + gaps.unreadSuspects.length + gaps.unresolvedObservations.length > 0;
  if (!anyGap) out.push(t.noGaps);
  else {
    if (gaps.unexplainedExceptions.length) out.push(`- ${t.unexplained}: ${gaps.unexplainedExceptions.join(", ")}`);
    if (gaps.unreadSuspects.length) out.push(`- ${t.unread}: ${gaps.unreadSuspects.join(", ")}`);
    if (gaps.unresolvedObservations.length) out.push(`- ${t.unresolved}: ${gaps.unresolvedObservations.join("; ")}`);
    out.push(`- _${t.gapsNote}_`);
  }
  out.push("");

  out.push(t.judge);
  if (i.judgments.skipped) out.push(`- ${t.skipped}: ${i.judgments.skipped}`);
  else if (!i.judgments.attempts.length) out.push(`- ${t.judgeNone}`);
  for (const a of i.judgments.attempts) {
    out.push(`- R${a.round}: ${a.total} (obs ${a.scores.observation} / alt ${a.scores.alternatives} / root ${a.scores.rootCause}) → ${a.verdict}${a.unexplained.length ? ` · unexplained: ${a.unexplained.join("; ")}` : ""}`);
  }
  out.push("");

  out.push(t.run);
  out.push(`- runId: ${i.plan.runId}`, `- ${t.tools}: ${i.session.toolCalls}/${i.session.maxToolCalls}`, `- ${t.rounds}: ${i.session.rounds}`);
  out.push(`- ${t.rules}: ${i.plan.ruleFiles.join(", ") || "—"}`, `- ${t.kb}: ${i.plan.kbDocs.map((d) => d.path).join(", ") || "—"}`, `- ${t.runs}: runs/${i.plan.runId}/`);
  return out.join("\n");
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function reportPath(cwd: string, cfg: LogConfig, runId: string, override?: string): string {
  const opt = override ?? cfg.output;
  const full = isAbsolute(opt) ? opt : join(cwd, opt);
  return opt.endsWith("/") || isDir(full) ? join(full, `log-${runId}.md`) : full;
}

interface FinalizeRecord { response: string; reportPath: string; badge: Badge; gaps: Gaps }

export function finalizeRun(runId: string, cwd: string): string {
  const prior = readRunJson<FinalizeRecord>(runId, cwd, "finalize.json");
  if (prior) return prior.response;
  const plan = readRunJson<LogPlan>(runId, cwd, "plan.json");
  const meta = readRunJson<RunMeta>(runId, cwd, "run.json");
  const input = readRunText(runId, cwd, "input.log");
  if (!plan || !meta || input === null) return `⚠️ Unknown run ${runId}.`;
  const best = bestSubmission(runId, cwd);
  if (!best) return `⚠️ Run ${runId} has no submission — spawn the f-log-analyst first (it must call f_log_submit).`;

  const judgments = loadJudgments(runId, cwd);
  const callLog = readRunJson<Record<string, Record<string, number>>>(runId, cwd, "callLog.json") ?? {};
  const readFiles = readRunJson<string[]>(runId, cwd, "readFiles.json") ?? [];
  const injected = readRunJson<string[]>(runId, cwd, "injected.json") ?? [];
  const gaps = computeGaps(plan, best.submission, judgments, callLog, readFiles, injected);
  const badge = badgeFor(best.submission, judgments, best.attempt);
  const cfg = loadLogConfig(cwd);
  const toolCalls = Object.values(callLog[runId] ?? {}).reduce((a, b) => a + b, 0);
  const md = renderLogReport(
    { plan, input, submission: best.submission, judgments, attempt: best.attempt, session: { toolCalls, maxToolCalls: cfg.maxToolCalls, rounds: Math.max(1, judgments.attempts.length, best.submission.round) }, cwd },
    gaps, badge, meta.language === "en" ? "en" : "ko", new Date()
  );
  const requested = reportPath(cwd, cfg, runId, meta.output);
  mkdirSync(dirname(requested), { recursive: true });
  // This run has never finalized before (the `prior` check above returned
  // early otherwise) — an existing file at `requested` belongs to a different
  // run (typically a fixed --output path reused across runs). Redirect
  // rather than silently keep pointing at someone else's report (I-5).
  const relOf = (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p);
  let path = requested;
  let collisionNote: string | undefined;
  if (existsSync(requested)) {
    path = join(dirname(requested), `log-${runId}.md`);
    collisionNote = `Note: ${relOf(requested)} already existed; wrote ${relOf(path)}`;
  }
  writeFileSync(path, md);
  const rel = relOf(path);
  const g = `${gaps.unexplainedExceptions.length} / ${gaps.unreadSuspects.length} / ${gaps.unresolvedObservations.length}`;
  const response = [
    `✅ f-log finished — ${badge}`,
    `Report: ${rel}`,
    `Cause: ${best.submission.cause.summary || "(no submission)"} (confidence ${best.submission.confidence})`,
    `Gaps: ${g === "0 / 0 / 0" ? "none" : `${g} (unexplained exceptions / unread suspects / unresolved observations)`}`,
    ...(collisionNote ? [collisionNote] : []),
  ].join("\n");
  writeRunJson(runId, cwd, "finalize.json", { response, reportPath: rel, badge, gaps } satisfies FinalizeRecord);
  return response;
}
