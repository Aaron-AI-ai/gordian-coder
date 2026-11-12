/**
 * Stage 4: set-difference gap checks (upstream design §1.4 — gaps are
 * reported, never looped back), the markdown report (spec §11), and the
 * short response the orchestrator relays. Idempotent: a second call returns
 * the stored response and never rewrites the report.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { reportScriptWarning } from "../review/contract";
import { esc, fill } from "../review/report/html";
import { htmlReportPath, reportDirName } from "../review/report/output";
import { readFileAt, renderFileContent } from "../review/tools/read";
import { localTimestamp } from "../time";
import { loadLogConfig, type LogConfig } from "./config";
import { bestSubmission } from "./judge";
import { parseStackTrace } from "./parse";
import type { LogPlan } from "./plan";
import { loadJudgments, readRunJson, readRunText, writeRunJson, type LogJudgeAttempt, type LogJudgments, type RunMeta } from "./run-store";
import type { StoredSubmission } from "./submit";
import TEMPLATE_HTML from "./report.template.html" with { type: "text" };

// Same cast as review/report/html.ts: bun-types types *.html as an HTMLBundle.
const TEMPLATE = TEMPLATE_HTML as unknown as string;

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
  /** The analyzed log file (--file); absent when pasted. */
  source?: string;
  /** KB pages the analyst saw (kbShown.json). */
  kbShown?: string[];
  /** Files the analyst read (readFiles.json). */
  readFiles?: string[];
}

const EVIDENCE_MAX_LINES = 30;
const OBS_OPEN_MAX = 5;
const FIX_LINE_MAX = 300;

/** One line for the relayed summary: what to do and where. The full resolution
 * (code included) stays in the report; the chat reader only needs the gist and
 * the files, so a missing submission yields no line at all. */
function fixLine(s: StoredSubmission): string[] {
  const summary = s.resolution.summary.replace(/\s+/g, " ").trim();
  if (!summary) return [];
  const text = summary.length > FIX_LINE_MAX ? `${summary.slice(0, FIX_LINE_MAX - 1)}…` : summary;
  const files = [...new Set(s.resolution.changes.map((c) => c.file))];
  return [`Fix (${s.resolution.kind}): ${text}${files.length ? ` [${files.join(", ")}]` : ""}`];
}
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
    run: "## 실행 정보", none: "제출 없음",
    env: "환경 원인 가능 — 코드 수정 전 설정·인프라를 먼저 확인.", mitigation: "⚠️ 원인 제거가 아닌 증상 완화(mitigation)다.",
    entry: "진입점", causeFrame: "원인 프레임",
    rounds: "라운드", tools: "툴 호출", rules: "적용 룰", kb: "주입 KB", runs: "실행 상세", terminal: "임계값 미달 — 최고점 라운드 채택",
    partial: "분석 미완 — 모델이 제출 전에 중단", forced: "강제 수락",
    target: "## 분석 대상", source: "로그 파일", pasted: "직접 붙여넣은 로그", time: "발생 시각", svc: "서비스 ID", code: "에러 코드",
    trace: "추적 ID · 사용자", where: "호스트 · 스레드", logLine: "로그 메시지", exception: "예외", logger: "기록 위치",
    materials: "근거 자료", kbRef: "참고한 프레임워크 KB", usedInFix: "수정 코드에 사용", rulesRef: "적용한 분석 룰", filesRead: "분석 중 읽은 파일",
  },
  en: {
    summary: "## Summary", raw: "## Stack trace", path: "## Entry point → cause path", cause: "## Cause and evidence", fix: "## Resolution",
    run: "## Run info", none: "no submission",
    env: "Possible environment cause — check configuration/infrastructure before changing code.", mitigation: "⚠️ This is a mitigation, not a root-cause fix.",
    entry: "entry", causeFrame: "cause frame",
    rounds: "rounds", tools: "tool calls", rules: "rules applied", kb: "KB injected", runs: "run details", terminal: "below threshold — best-scoring round adopted",
    partial: "analysis incomplete — the model stopped before submitting", forced: "force-accepted",
    target: "## Analyzed request", source: "Log file", pasted: "pasted log", time: "Occurred at", svc: "Service ID", code: "Error code",
    trace: "Trace ID · user", where: "Host · thread", logLine: "Log message", exception: "Exception", logger: "Logged by",
    materials: "Evidence materials", kbRef: "Framework KB consulted", usedInFix: "used in the fix", rulesRef: "Analysis rules applied", filesRead: "Files read during analysis",
  },
} as const;

type Labels = (typeof L)[keyof typeof L];
const LOG_LINE_MAX = 300;

/** What request the log is about, from the log itself: [label, value, monospace]. Rows the log does not carry are left out. */
function targetRows(i: FinalizeInput, t: Labels): [string, string, boolean][] {
  const p = parseStackTrace(i.input);
  const { handler: h, head } = p;
  const top = p.chain[0];
  const root = p.chain.at(-1);
  const ex = (b: NonNullable<typeof root>) => `${b.type}${b.message ? `: ${b.message.split("\n")[0]}` : ""}`;
  const line = head.message && head.message.length > LOG_LINE_MAX ? `${head.message.slice(0, LOG_LINE_MAX - 1)}…` : head.message;
  const rows: [string, string | undefined, boolean][] = [
    [t.source, i.source ?? t.pasted, !!i.source],
    [t.time, head.time, false],
    ["URI", h.uri, true],
    [t.svc, h.svcId, true],
    [t.code, h.errorCode, true],
    ["even", h.even, true],
    [t.trace, [head.traceId, head.user].filter(Boolean).join(" · "), true],
    [t.where, [head.host, head.thread].filter(Boolean).join(" · "), false],
    [t.logLine, line && head.level ? `[${head.level}] ${line}` : line, false],
    [t.exception, root && (top !== root ? `${ex(top)} → ${ex(root)}` : ex(root)), true],
    [t.logger, h.logger, true],
  ];
  return rows.filter((r): r is [string, string, boolean] => !!r[1]);
}

/** In-app frames of the root block, outermost first, each once; the entry
 * point has its own line, so its frame is not repeated here. */
function pathFrames(i: FinalizeInput, root: ReturnType<typeof parseStackTrace>["chain"][number] | undefined): string[] {
  const e = i.plan.entry;
  const seen = new Set(e ? [`${e.cls}.${e.method}:${e.line}`] : []);
  const out: string[] = [];
  for (const f of [...(root?.frames ?? [])].reverse()) {
    const key = `${f.cls}.${f.method}:${f.line}`;
    if (i.plan.kinds[f.cls] !== "app" || seen.has(key)) continue;
    seen.add(key);
    out.push(`${f.cls}.${f.method}${f.line ? `(${f.file}:${f.line})` : ""}`);
  }
  return out;
}

/** The materials the cause rests on beyond the quoted code: KB pages the
 * analyst saw (flagged when the fix code names that class), rules, files read. */
function materials(i: FinalizeInput) {
  const words = new Set(i.submission.resolution.changes.map((c) => c.code ?? "").join("\n").match(/\w+/g));
  const kb = (i.kbShown ?? []).map((path) => {
    const name = basename(path).replace(/\.md$/, "");
    return { name, path, used: words.has(name) };
  }).sort((a, b) => Number(b.used) - Number(a.used));
  return { kb, rules: i.plan.ruleFiles, files: i.readFiles ?? [] };
}

function quote(cwd: string, file: string, from: number, to: number): string {
  const content = readFileAt(cwd, null, file);
  if (content === null) return "(file not readable)";
  const end = Math.min(to, from + EVIDENCE_MAX_LINES - 1);
  return renderFileContent(file, content, from, end, EVIDENCE_MAX_LINES);
}

export function renderLogReport(i: FinalizeInput, badge: Badge, lang: "ko" | "en", now: Date): string {
  const t = L[lang];
  const s = i.submission;
  const empty = !s.cause.summary;
  const parsed = parseStackTrace(i.input);
  const root = parsed.chain.at(-1);
  const out: string[] = [];

  out.push(`# f-log ${i.plan.runId} — **${badge}**`, `${localTimestamp(now)} · ${i.cwd.split(/[\\/]/).at(-1)}`, "");
  out.push(t.target, ...targetRows(i, t).map(([k, v, mono]) => `- **${k}**: ${mono ? `\`${v}\`` : v}`), "");
  out.push(t.summary, empty ? `_${t.none}_` : `**${s.cause.summary}**`);
  if (s.envCause) out.push(`- ${t.env}`);
  if (s.resolution.kind === "mitigation" && !empty) out.push(`- ${t.mitigation}`);
  if (badge === "TERMINAL") out.push(`- ${t.terminal}`);
  if (badge === "PARTIAL") out.push(`- ${t.partial}`);
  if (badge === "FORCED") out.push(`- ${t.forced}${s.forced ?? ""}`);
  out.push("");

  const raw = i.input.length > RAW_MAX ? `${i.input.slice(0, RAW_MAX)}\n… (${i.input.length} chars; runs/${i.plan.runId}/input.log)` : i.input;
  out.push(t.raw, "```", raw.trimEnd(), "```", "");

  out.push(t.path);
  const chain = pathFrames(i, root);
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
  const m = materials(i);
  out.push("", `### ${t.materials}`, `- ${t.kbRef}:${m.kb.length ? "" : " —"}`, ...m.kb.map((k) => `  - ${k.name} — ${k.path}${k.used ? ` (${t.usedInFix})` : ""}`));
  out.push(`- ${t.rulesRef}: ${m.rules.join(", ") || "—"}`, `- ${t.filesRead}:${m.files.length ? "" : " —"}`, ...m.files.map((f) => `  - ${f}`));
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

  out.push(t.run);
  out.push(`- runId: ${i.plan.runId}`, `- ${t.tools}: ${i.session.toolCalls}/${i.session.maxToolCalls}`, `- ${t.rounds}: ${i.session.rounds}`);
  out.push(`- ${t.rules}: ${i.plan.ruleFiles.join(", ") || "—"}`, `- ${t.kb}: ${i.plan.kbDocs.map((d) => d.path).join(", ") || "—"}`, `- ${t.runs}: runs/${i.plan.runId}/`);
  return out.join("\n");
}

/** HTML-only labels; section names reuse L without the markdown "## ". */
const H = {
  ko: {
    title: "로그 분석 리포트", project: "프로젝트", analysis: "로그 분석", causeTitle: "원인", fixTitle: "해결 방안",
    verdict: "판정", observations: "로그 관측", explained: "설명됨", notExplained: "설명 안 됨", evidence: "근거 코드",
    copy: "복사", copyAll: "해결 방안 전체 복사", copied: "복사됨", copyFail: "복사 실패", exceptions: "예외",
    noChanges: "구체적인 코드 변경 없음",
  },
  en: {
    title: "Log Analysis Report", project: "Project", analysis: "Log analysis", causeTitle: "Cause", fixTitle: "Resolution",
    verdict: "Verdict", observations: "Log observations", explained: "explained", notExplained: "not explained", evidence: "Evidence",
    copy: "Copy", copyAll: "Copy whole resolution", copied: "Copied", copyFail: "Copy failed", exceptions: "exceptions",
    noChanges: "no concrete code change",
  },
} as const;

/** PASS reads as settled, an unjudged/terminal answer as "check it", a
 * forced or partial one as "do not trust as-is". */
const BADGE_TONE: Record<Badge, "pass" | "warn" | "fail"> = { PASS: "pass", "JUDGE SKIPPED": "warn", UNJUDGED: "warn", TERMINAL: "warn", FORCED: "fail", PARTIAL: "fail" };

/** Evidence lines with a line-number gutter (not selectable, so a copy grabs
 * code only); lines inside the cited range are highlighted. */
function quoteHtml(cwd: string, file: string, from: number, to: number, hitLine?: number): string {
  const content = readFileAt(cwd, null, file);
  if (content === null) return `<pre>(file not readable)</pre>`;
  const lines = content.replace(/\n$/, "").split("\n");
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to, start + EVIDENCE_MAX_LINES - 1);
  const rows = [];
  for (let n = start; n <= end; n++) {
    const row = `<span class="ln">${n}</span>${esc(lines[n - 1])}`;
    rows.push(n === hitLine ? `<span class="hit">${row}</span>` : row);
  }
  return `<pre>${rows.join("\n")}</pre>`;
}

/** Copy target + button. The text lives in its own element so the button
 * copies exactly the code, never the gutter or the button label. */
function copyBtn(id: string, label: string, h: (typeof H)[keyof typeof H]): string {
  return `<button class="copy" type="button" data-copy="${id}" data-done="${esc(h.copied)}" data-fail="${esc(h.copyFail)}">${esc(label)}</button>`;
}

export function renderLogHtml(i: FinalizeInput, badge: Badge, lang: "ko" | "en", now: Date): string {
  const t = L[lang];
  const h = H[lang];
  const sec = (s: string) => s.slice(3);
  const s = i.submission;
  const empty = !s.cause.summary;
  const root = parseStackTrace(i.input).chain.at(-1);
  const tone = BADGE_TONE[badge];
  const stamp = localTimestamp(now);
  const project = i.cwd.split(/[\\/]/).at(-1) ?? "";
  const exceptionCount = i.plan.observations.filter((o) => /^예외 \d+\/\d+: /.test(o)).length;
  const causeAt = s.cause.file ? `${s.cause.file}${s.cause.line ? `:${s.cause.line}` : ""}` : "";

  const notes = [
    s.envCause && t.env,
    s.resolution.kind === "mitigation" && !empty && t.mitigation,
    badge === "TERMINAL" && t.terminal,
    badge === "PARTIAL" && t.partial,
    badge === "FORCED" && `${t.forced}${s.forced ?? ""}`,
  ].filter((n): n is string => !!n);
  const verdict = [
    `<div class="verdict ${tone}" role="status">`,
    `<div class="head"><span class="badge ${tone}">${esc(badge)}</span>${causeAt ? ` <code>${esc(causeAt)}</code>` : ""}</div>`,
    `<div class="cause">${empty ? esc(t.none) : esc(s.cause.summary)}</div>`,
    notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "",
    `</div>`,
  ].join("\n  ");

  const stats = [
    `<div class="stat"><div class="n">${exceptionCount}</div><div class="l">${esc(h.exceptions)}</div></div>`,
    `<div class="stat"><div class="n">${s.resolution.changes.length}</div><div class="l">${esc(h.fixTitle)}</div></div>`,
  ].join("\n    ");

  // 1. Log analysis: where the failure travelled, and what the log showed.
  const pathItems = [
    ...(i.plan.entry ? [`${t.entry}: ${i.plan.entry.cls}.${i.plan.entry.method}${i.plan.entry.line ? `:${i.plan.entry.line}` : ""}`] : []),
    ...pathFrames(i, root),
  ];
  const pathHtml = pathItems.length || causeAt
    ? `<div class="card"><h3>${esc(sec(t.path))}</h3><ul class="path">${pathItems.map((p) => `<li>${esc(p)}</li>`).join("")}${causeAt ? `<li class="root">${esc(t.causeFrame)}: ${esc(causeAt)}</li>` : ""}</ul></div>`
    : `<div class="card"><ul class="path">${i.plan.suspects.map((x) => `<li>${esc(`${x.path} [${x.source}]`)}</li>`).join("") || "<li>(none)</li>"}</ul></div>`;
  // Long frame-repeat lists would bury the cause, so more than a handful folds;
  // the summary still says how many the analysis left unexplained.
  const obsItems = s.observations
    .map((o) => `<li><span class="${o.explained ? "ok" : "no"}" title="${esc(o.explained ? h.explained : h.notExplained)}">${o.explained ? "&#10003;" : "&#10007;"}</span><span>${esc(o.observation)}${o.how ? ` <span class="dim">&mdash; ${esc(o.how)}</span>` : ""}</span></li>`)
    .join("");
  const unexplainedObs = s.observations.filter((o) => !o.explained).length;
  const obsHtml = s.observations.length
    ? `<details class="more"${s.observations.length <= OBS_OPEN_MAX ? " open" : ""}><summary>${esc(h.observations)} <span class="dim">(${s.observations.length} &middot; ${esc(h.notExplained)} ${unexplainedObs})</span></summary><div class="body"><ul class="obs">${obsItems}</ul></div></details>`
    : "";
  const raw = i.input.length > RAW_MAX ? `${i.input.slice(0, RAW_MAX)}\n… (${i.input.length} chars; runs/${i.plan.runId}/input.log)` : i.input;
  const rawHtml = `<details class="more"><summary>${esc(sec(t.raw))}</summary><div class="codebox"><pre>${esc(raw.trimEnd())}</pre></div></details>`;

  // 2. Cause: mechanism, then the code it rests on.
  const causeHtml = empty
    ? `<div class="card"><p>${esc(t.none)}</p></div>`
    : [
        `<div class="card"><p><b>${esc(s.cause.summary)}</b></p><p>${esc(s.cause.mechanism)}</p></div>`,
        ...s.evidence.filter((e) => e.file).map((e) =>
          `<div class="card"><h3>${esc(h.evidence)} &middot; <code>${esc(`${e.file}:${e.lines[0]}-${e.lines[1]}`)}</code></h3><p>${esc(e.why)}</p><div class="codebox">${quoteHtml(i.cwd, e.file, e.lines[0], e.lines[1], e.file === s.cause.file ? s.cause.line : undefined)}</div></div>`),
      ].join("\n    ");
  const m = materials(i);
  const refList = (xs: string[]) => `<ul class="refs">${xs.map((x) => `<li>${x}</li>`).join("") || "<li>&mdash;</li>"}</ul>`;
  const materialsHtml = [
    `<div class="card"><h3>${esc(t.materials)}</h3>`,
    `<p class="dim">${esc(t.kbRef)}</p>`,
    refList(m.kb.map((k) => `<code>${esc(k.name)}</code> <span class="dim">${esc(k.path)}</span>${k.used ? `<span class="badge pass">${esc(t.usedInFix)}</span>` : ""}`)),
    `<p class="dim">${esc(t.rulesRef)}</p>`,
    refList(m.rules.map((r) => `<code>${esc(r)}</code>`)),
    `<p class="dim">${esc(t.filesRead)}</p>`,
    refList(m.files.map((f) => `<code>${esc(f)}</code>`)),
    `</div>`,
  ].join("");

  // 3. Resolution: each change copyable on its own, plus the whole thing as markdown.
  const allText = [s.resolution.summary, ...s.resolution.changes.flatMap((c) => [`- ${c.file}: ${c.description}`, ...(c.code ? ["```" + extname(c.file).slice(1), c.code.trimEnd(), "```"] : [])])].join("\n");
  const changes = s.resolution.changes.map((c, n) => [
    `<div class="change">`,
    `<div class="file">${esc(c.file)}</div>`,
    `<p>${esc(c.description)}</p>`,
    c.code ? `<div class="codebox fix"><pre id="fix-${n}">${esc(c.code.trimEnd())}</pre>${copyBtn(`fix-${n}`, h.copy, h)}</div>` : "",
    `</div>`,
  ].join(""));
  const fixHtml = empty
    ? `<div class="card"><p>${esc(t.none)}</p></div>`
    : [
        `<div class="card"><div class="fixhead"><p><span class="badge kind">${esc(s.resolution.kind)}</span> ${esc(s.resolution.summary)}</p>${copyBtn("fix-all", h.copyAll, h)}</div><pre id="fix-all" hidden>${esc(allText)}</pre></div>`,
        `<div class="card">${changes.join("") || `<p class="dim">${esc(h.noChanges)}</p>`}</div>`,
      ].join("\n    ");

  // Appendix: everything the reader may want to audit, collapsed.
  const li = (xs: string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const more = (title: string, body: string, count?: number) =>
    `<details class="more"><summary>${esc(title)}${count !== undefined ? ` <span class="dim">(${count})</span>` : ""}</summary><div class="body">${body}</div></details>`;
  const appendix = [
    more(sec(t.run), li([
      `runId: ${i.plan.runId}`, `${t.tools}: ${i.session.toolCalls}/${i.session.maxToolCalls}`, `${t.rounds}: ${i.session.rounds}`,
      `${t.rules}: ${i.plan.ruleFiles.join(", ") || "—"}`, `${t.kb}: ${i.plan.kbDocs.map((d) => d.path).join(", ") || "—"}`, `${t.runs}: runs/${i.plan.runId}/`,
    ])),
  ].join("\n    ");

  return fill(TEMPLATE, {
    LANG: lang,
    TITLE: `${esc(h.title)} &middot; ${esc(i.plan.runId)}`,
    HEADING: esc(h.title),
    STAMP: esc(stamp),
    RUNINFO: [
      `<dl class="runinfo">`,
      `<dt>${esc(h.project)}</dt><dd><b>${esc(project)}</b></dd>`,
      `<dt>runId</dt><dd><code>${esc(i.plan.runId)}</code></dd>`,
      `<dt>${esc(t.tools)}</dt><dd>${i.session.toolCalls}/${i.session.maxToolCalls} <span class="dim">&middot; ${esc(t.rounds)} ${i.session.rounds}</span></dd>`,
      `</dl>`,
    ].join("\n    "),
    TARGET: [
      `<section class="target" aria-label="${esc(sec(t.target))}"><span class="eyebrow">${esc(sec(t.target))}</span><dl class="runinfo">`,
      ...targetRows(i, t).map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd>${mono ? `<code>${esc(v)}</code>` : esc(v)}</dd>`),
      `</dl></section>`,
    ].join("\n    "),
    VERDICT: verdict,
    STATS: stats,
    TOC: [["analysis", h.analysis], ["cause", h.causeTitle], ["fix", h.fixTitle]].map(([id, label], n) => `<a href="#${id}">${n + 1}. ${esc(label)}</a>`).join(""),
    ANALYSIS_TITLE: esc(h.analysis),
    ANALYSIS: [pathHtml, obsHtml, rawHtml].filter(Boolean).join("\n    "),
    CAUSE_TITLE: esc(h.causeTitle),
    CAUSE: `${causeHtml}\n    ${materialsHtml}`,
    FIX_TITLE: esc(h.fixTitle),
    FIX: fixHtml,
    APPENDIX: appendix,
    FOOTER: `f-log &middot; ${esc(stamp)}`,
  });
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function reportPath(cwd: string, cfg: LogConfig, runId: string, override?: string): string {
  const opt = override ?? cfg.output;
  const full = isAbsolute(opt) ? opt : join(cwd, opt);
  return opt.endsWith("/") || isDir(full) ? join(full, reportDirName(runId), "log.md") : full;
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
  const reportInput: FinalizeInput = { plan, input, submission: best.submission, judgments, attempt: best.attempt, session: { toolCalls, maxToolCalls: cfg.maxToolCalls, rounds: Math.max(1, judgments.attempts.length, best.submission.round) }, cwd,
    source: meta.source, kbShown: readRunJson<string[]>(runId, cwd, "kbShown.json") ?? [], readFiles };
  const lang = meta.language === "en" ? "en" : "ko";
  const now = new Date();
  const md = renderLogReport(reportInput, badge, lang, now);
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
    path = join(dirname(requested), reportDirName(runId), "log.md");
    mkdirSync(dirname(path), { recursive: true });
    collisionNote = `Note: ${relOf(requested)} already existed; wrote ${relOf(path)}`;
  }
  writeFileSync(path, md);
  const html = htmlReportPath(path);
  writeFileSync(html, renderLogHtml(reportInput, badge, lang, now));
  const rel = relOf(path);
  const g = `${gaps.unexplainedExceptions.length} / ${gaps.unreadSuspects.length} / ${gaps.unresolvedObservations.length}`;
  const response = [
    `✅ f-log finished — ${badge}`,
    `Report: ${rel}`,
    `HTML: ${relOf(html)}`,
    `Cause: ${best.submission.cause.summary || "(no submission)"}`,
    ...fixLine(best.submission),
    `Gaps: ${g === "0 / 0 / 0" ? "none" : `${g} (unexplained exceptions / unread suspects / unresolved observations)`}`,
    ...(collisionNote ? [collisionNote] : []),
    // Post-write check: Gate 3 bounces foreign-script words, but past its cap
    // they are stored as written — the reader must hear about it here.
    ...[reportScriptWarning(md, lang)].filter(Boolean),
  ].join("\n");
  writeRunJson(runId, cwd, "finalize.json", { response, reportPath: rel, badge, gaps } satisfies FinalizeRecord);
  return response;
}
