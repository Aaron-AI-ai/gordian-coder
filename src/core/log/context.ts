/**
 * What the analyst receives per round, assembled under a total budget with a
 * fixed priority (spec §8): the log, the observations (never cut), the primary
 * suspect's code, the rules, the KB pages, the other suspects' code, the
 * instructions. Rework rounds drop rules and KB to a pointer line.
 */
import { readFileAt, renderFileContent } from "../review/tools/read";
import { loadLogConfig } from "./config";
import { parseStackTrace, type ParsedLog } from "./parse";
import type { LogPlan, Suspect } from "./plan";
import { analystInstructions } from "./prompt";
import { loadLogRules, matchLogRules, renderLogRules, type MatchedRule } from "./rules";
import { loadJudgments, readRunJson, readRunText, writeRunText, type LogJudgments, type RunMeta } from "./run-store";
import { getLogState, newLogSession, setLogState } from "./state";

export const RAW_MAX_CHARS = 6_000;
export const OBS_MAX_CHARS = 3_000;
export const PRIMARY_SNIPPET_MAX_CHARS = 4_000;
export const RULES_MAX_CHARS = 6_000;
export const KB_MAX_DOCS = 3;
export const KB_DOC_MAX_CHARS = 3_000;
export const OTHER_SNIPPETS_MAX_CHARS = 8_000;
export const PRIMARY_RADIUS = 40;
export const OTHER_RADIUS = 10;

export interface ContextInput {
  plan: LogPlan;
  parsed: ParsedLog;
  raw: string;
  rules: MatchedRule[];
  rejected: LogJudgments["rejected"];
  round: number;
  submitToken: string;
  language: string;
  cwd: string;
  maxChars: number;
}

function cut(text: string, max: number, note: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… ${note}`;
}

function rawSection(i: ContextInput): string {
  const truncated = i.raw.length > RAW_MAX_CHARS;
  let body = i.raw;
  if (truncated) {
    const root = i.parsed.chain.at(-1);
    if (root) {
      // Keep the root-cause block whole, then the head of the rest.
      const rootText = [`${root.type}${root.message ? `: ${root.message}` : ""}`, ...root.frames.map((f) => `\tat ${f.raw.replace(/^at\s+/, "")}`)].join("\n");
      body = `${rootText}\n\n--- 원문 앞부분 ---\n${i.raw.slice(0, Math.max(0, RAW_MAX_CHARS - rootText.length - 80))}`;
    }
    body = body.length > RAW_MAX_CHARS ? body.slice(0, RAW_MAX_CHARS) : body;
  }
  // The pointer note must survive even when the reconstructed body already
  // fits under RAW_MAX_CHARS — it is how the analyst finds the full text,
  // not just a truncation marker.
  const note = truncated ? `\n… (${i.raw.length}자 중 일부. 전문: runs/${i.plan.runId}/input.log)` : "";
  return `## 로그\n\`\`\`\n${body}${note}\n\`\`\``;
}

function observationsSection(i: ContextInput): string {
  const head = ["## 관측 — 제출의 observations[] 는 이 목록 각각에 대응해야 한다", ...i.plan.observations.map((o) => `- ${o}`)].join("\n");
  if (!i.rejected.length) return head;
  const rejectedLines = i.rejected.map((r) => `- (라운드 ${r.round}) ${r.cause} — 기각 사유: ${r.feedback}`);
  let block = `${head}\n\n### 기각된 가설 — 같은 결론으로 돌아오지 마라\n`;
  for (const line of rejectedLines) {
    if (block.length + line.length + 1 > OBS_MAX_CHARS) { block += "- … (이하 생략)"; break; }
    block += `${line}\n`;
  }
  return block.trimEnd();
}

function snippet(cwd: string, s: Suspect, radius: number, maxChars: number): string {
  const content = readFileAt(cwd, null, s.path);
  if (content === null) return `### ${s.path}\n(파일을 읽을 수 없음)`;
  const line = s.frame?.line ?? 1;
  const start = Math.max(1, line - radius);
  const end = line + radius;
  const rendered = renderFileContent(s.path, content, start, end, radius * 2 + 1, maxChars);
  const why = s.source === "frame" ? `프레임 ${s.frame!.cls}.${s.frame!.method}:${line}` : s.source === "svcId" ? "URI/svcId 검색" : "errorCode 검색";
  return `### ${s.path} — ${why}\n${rendered}`;
}

function kbSection(i: ContextInput): string {
  const docs = i.plan.kbDocs.slice(0, KB_MAX_DOCS);
  if (!docs.length) return "";
  return ["## 프레임워크 KB (이미 주입됨 — 다시 읽지 마라)", ...docs.map((d) => `### ${d.specifier} (${d.path})\n${cut(d.content, KB_DOC_MAX_CHARS, "(KB 문서 일부)")}`)].join("\n\n");
}

export function renderContext(i: ContextInput): string {
  const rework = i.round > 1;
  const entry = i.plan.entry ? `진입점: ${i.plan.entry.cls}.${i.plan.entry.method}${i.plan.entry.line ? `:${i.plan.entry.line}` : ""}` : "진입점: (없음 — 스택 없는 입력)";
  const header = `# f-log 분석 — run ${i.plan.runId}, 라운드 ${i.round}\n${entry}`;
  const [primary, ...others] = i.plan.suspects;

  const rulesText = rework ? "## 분석 규칙 / KB\n이전 라운드와 동일 — 필요하면 f_log_read 로 다시 읽는다." : renderLogRules(i.rules, RULES_MAX_CHARS);
  const kbText = rework ? "" : kbSection(i);
  const othersText = others.length
    ? `## 나머지 용의 파일\n${cut(others.map((s) => snippet(i.cwd, s, OTHER_RADIUS, OTHER_SNIPPETS_MAX_CHARS)).join("\n\n"), OTHER_SNIPPETS_MAX_CHARS, "(나머지는 f_log_read)")}`
    : "";

  // Priority order; each entry knows whether it may be dropped.
  const sections: Array<{ text: string; droppable: boolean }> = [
    { text: header, droppable: false },
    { text: rawSection(i), droppable: false },
    { text: observationsSection(i), droppable: false },
    { text: primary ? `## 1순위 용의 코드\n${snippet(i.cwd, primary, PRIMARY_RADIUS, PRIMARY_SNIPPET_MAX_CHARS)}` : "## 1순위 용의 코드\n(저장소에서 해석된 프레임 없음)", droppable: false },
    { text: rulesText, droppable: true },
    { text: kbText, droppable: true },
    { text: othersText, droppable: true },
    { text: analystInstructions(i.submitToken, i.language, true), droppable: false },
  ].filter((s) => s.text);

  // Fill from the top; once over budget (by actual assembled size), drop
  // droppable sections from the bottom up (others → KB → rules).
  let total = sections.reduce((n, s) => n + s.text.length + 2, 0);
  for (let k = sections.length - 1; k >= 0 && total > i.maxChars; k--) {
    if (!sections[k].droppable) continue;
    total -= sections[k].text.length + 2;
    sections[k].text = "";
  }
  return sections.map((s) => s.text).filter(Boolean).join("\n\n");
}

/** `f_log_context` — the analyst's first call. Seeds its session (round =
 * rejections so far + 1), renders the context, records it on disk. */
export function logContext(runId: string, sessionId: string, cwd: string): string {
  const existing = getLogState(sessionId);
  if (existing?.active && existing.runId === runId) {
    return `ℹ️ Duplicate f_log_context ignored — this session already holds run ${runId} (round ${existing.round}). Continue investigating, then call f_log_submit with CURRENT_SUBMIT_TOKEN=${existing.submitToken}.`;
  }
  const plan = readRunJson<LogPlan>(runId, cwd, "plan.json");
  const meta = readRunJson<RunMeta>(runId, cwd, "run.json");
  const raw = readRunText(runId, cwd, "input.log");
  if (!plan || !meta || raw === null) return `⚠️ Unknown run ${runId}. Call f_log_plan first.`;

  const cfg = loadLogConfig(cwd);
  const judgments = loadJudgments(runId, cwd);
  const round = judgments.rejected.length + 1;
  const st = newLogSession(cwd, runId, round, cfg.maxToolCalls, cfg.maxIter);
  setLogState(sessionId, st);

  const parsed = parseStackTrace(raw);
  const types = [...parsed.chain, ...parsed.suppressed].map((b) => b.type);
  const rules = matchLogRules(loadLogRules(cwd), types, plan.suspects.map((s) => s.path), parsed.handler);
  const text = renderContext({
    plan, parsed, raw, rules, rejected: judgments.rejected, round,
    submitToken: st.submitToken, language: meta.language, cwd, maxChars: cfg.contextMaxChars,
  });
  writeRunText(runId, cwd, `context-${round}.md`, text);
  return text;
}
