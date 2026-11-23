/** report.md / report.html of a green /f-unittest-analysis run. Written by the plugin, never by the model. */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp, localTimestamp } from "../time";
import { esc, fill } from "../review/report/html";
import type { TestRun } from "../f-unit-test/coverage";
import TEMPLATE_HTML from "./report.template.html" with { type: "text" };

const TEMPLATE = TEMPLATE_HTML as unknown as string;
export const REPORT_DIR = ".fico/report/f-unittest-analysis";

export interface ReportData {
  cwd: string;
  /** The command arguments exactly as the user typed them. */
  request: string;
  module: string;
  /** Selected tests (class or class.method, full names); empty = all. */
  selection: string[];
  command: string | null;
  run: TestRun;
  startedAt: number;
}

const STATUS = { passed: "통과", failed: "단언 실패", error: "예외", skipped: "건너뜀" } as const;
const cell = (t: string): string => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const secs = (n: number): string => n.toFixed(2);

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
};

function when(startedAt: number, end: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const at = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return `${at(new Date(startedAt))} ~ ${at(end)} (${fmtDuration(end.getTime() - startedAt)})`;
}

/** Class → its cases, in run order. */
function byClass(run: TestRun): Map<string, TestRun["tests"]> {
  const out = new Map<string, TestRun["tests"]>();
  for (const t of run.tests) (out.get(t.cls) ?? out.set(t.cls, []).get(t.cls)!).push(t);
  return out;
}

const input = (d: ReportData): Array<[string, string]> => [
  ["입력", d.request.trim() || "(없음)"],
  ["모듈", d.module],
  ["실행 대상", d.selection.length > 0 ? d.selection.join(", ") : "전체 (입력 없음)"],
];

function renderHtml(d: ReportData, end: Date): string {
  const r = d.run;
  const stats = [
    ["", String(r.total), "실행한 테스트"],
    ["good", String(r.passed), "통과"],
    ["", String(r.skipped), "건너뜀"],
    ["", `${secs(r.seconds)}초`, "테스트 시간"],
  ]
    .map(([c, n, l]) => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join("");
  const info = [["작업 일시", when(d.startedAt, end)], ...input(d)].map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join("");
  const inputHtml = `<div class="card"><dl class="runinfo">${input(d).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${d.command ? `<div class="codebox"><pre>${esc(d.command)}</pre></div>` : ""}</div>`;
  const tests = [...byClass(r)]
    .map(([cls, ts]) => `<div class="card"><h3>${esc(cls.split(".").pop()!)} · ${ts.length}개 <span class="dim">${esc(cls)}</span></h3><table class="t"><tr><th>테스트</th><th>결과</th><th class="num">시간(초)</th></tr>${ts
      .map((t) => `<tr><td><code>${esc(t.method)}</code></td><td class="st-${t.status === "skipped" ? "skipped" : "passed"}">${STATUS[t.status]}</td><td class="num">${secs(t.seconds)}</td></tr>`)
      .join("")}</table></div>`)
    .join("\n");
  const skipped = r.tests.filter((t) => t.status === "skipped");
  const attention = skipped.length > 0 ? `<section class="step" id="check"><h2><span class="no">!</span>확인 필요</h2><div class="card"><ul>${skipped.map((t) => `<li>건너뜀: ${esc(t.cls.split(".").pop()!)}.${esc(t.method)}</li>`).join("")}</ul></div></section>` : "";
  return fill(TEMPLATE, {
    TITLE: "f-unittest-analysis 리포트",
    STAMP: esc(localTimestamp(end)),
    HEADING: "단위 테스트 실행 리포트",
    RUNINFO: `<dl class="runinfo">${info}</dl>`,
    VERDICT: `<div class="verdict pass"><div class="head"><span class="badge pass">PASS</span></div><p class="cause">전체 ${r.total}개 통과 (건너뜀 ${r.skipped})</p></div>`,
    STATS: stats,
    TOC: `<a href="#input">실행 입력</a><a href="#tests">테스트 결과</a>${attention ? '<a href="#check">확인 필요</a>' : ""}`,
    INPUT: inputHtml,
    TESTS: tests,
    ATTENTION: attention,
    APPENDIX: "",
    FOOTER: "f-unittest-analysis · report.md와 같은 내용",
  });
}

/** Writes `<REPORT_DIR>/report-<time>/report.md` and `report.html`; returns the project-relative .md path. */
export function writeReport(d: ReportData): string {
  const rel = `${REPORT_DIR}/report-${localFileStamp()}`;
  const dir = path.join(d.cwd, rel);
  fs.mkdirSync(dir, { recursive: true });
  const end = new Date();
  const r = d.run;
  const body = [
    "# f-unittest-analysis 리포트",
    "",
    `- 작업 일시: ${when(d.startedAt, end)}`,
    `- 결과: PASS · 전체 ${r.total}개 통과 (건너뜀 ${r.skipped}, ${secs(r.seconds)}초)`,
    "",
    "## 실행 입력",
    ...input(d).map(([k, v]) => `- ${k}: ${v}`),
    ...(d.command ? ["", "```", d.command, "```"] : []),
    "",
    "## 테스트 결과",
    ...[...byClass(r)].flatMap(([cls, ts]) => [`### ${cls.split(".").pop()} (${ts.length}개)`, `클래스: ${cls}`, "", "| 테스트 | 결과 | 시간(초) |", "|---|---|---|", ...ts.map((t) => `| ${cell(t.method)} | ${STATUS[t.status]} | ${secs(t.seconds)} |`), ""]),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), body, "utf-8");
  fs.writeFileSync(path.join(dir, "report.html"), renderHtml(d, end), "utf-8");
  return `${rel}/report.md`;
}
