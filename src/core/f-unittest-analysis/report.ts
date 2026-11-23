/** report.md / report.html of a green /f-unittest-analysis run. Written by the plugin, never by the model. */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp, localTimestamp } from "../time";
import { esc, fill } from "../review/report/html";
import type { FailedTest, OverallCoverage, TestRun } from "../f-unit-test/coverage";
import TEMPLATE_HTML from "./report.template.html" with { type: "text" };

/** SKIP: tests ran but none passed or failed (all @Disabled / assumption-skipped), so nothing was verified. */
export const verdictOf = (r: TestRun): "PASS" | "FAIL" | "SKIP" => (r.failed + r.errored > 0 ? "FAIL" : r.passed === 0 ? "SKIP" : "PASS");
const ALL_SKIPPED = (r: TestRun): string => `전체 ${r.total}개 모두 건너뜀 — 실행된 테스트 없음`;

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
  /** Details of any failing/erroring test in `run`; empty on a clean run. */
  failures: FailedTest[];
  /** Overall JaCoCo line/branch totals for the run, or null when coverage could not be measured. */
  coverage: OverallCoverage | null;
  startedAt: number;
}

const STATUS = { passed: "통과", failed: "단언 실패", error: "예외", skipped: "건너뜀" } as const;
/** "기대 X, 실제 Y" 로 읽히면 그렇게, 아니면 메시지 그대로 (f-unit-test/report.ts 의 같은 이름 함수와 동일한 규칙). */
function describeFailure(d: FailedTest): string {
  const m = /expected:\s*<(.*?)>\s*but was:\s*<(.*?)>/s.exec(d.message);
  const text = m ? `기대 ${m[1]}, 실제 ${m[2]}` : d.message || "(메시지 없음)";
  return d.type && !m ? `${d.type.split(".").pop()}: ${text}` : text;
}
const cell = (t: string): string => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const secs = (n: number): string => n.toFixed(2);
const pct = (c: { missed: number; covered: number }): string => {
  const total = c.missed + c.covered;
  return total === 0 ? "-" : `${Math.round((c.covered / total) * 100)}%`;
};

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
};

function when(startedAt: number, end: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const at = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return `${at(new Date(startedAt))} ~ ${at(end)} (${fmtDuration(end.getTime() - startedAt)})`;
}

/** Source-file class → its cases, in run order. A @Nested class (`FooTest$Bar`) belongs to FooTest.java; its
 * methods are shown as `Bar.method` so same-named methods of different nested classes stay apart. */
function byClass(run: TestRun): Map<string, TestRun["tests"]> {
  const out = new Map<string, TestRun["tests"]>();
  for (const t of run.tests) {
    const [outer, ...nested] = t.cls.split("$");
    const row = nested.length > 0 ? { ...t, method: `${nested.join(".")}.${t.method}` } : t;
    (out.get(outer!) ?? out.set(outer!, []).get(outer!)!).push(row);
  }
  return out;
}

const input = (d: ReportData): Array<[string, string]> => [
  ["입력", d.request.trim() || "(없음)"],
  ["모듈", d.module],
  ["실행 대상", d.selection.length > 0 ? d.selection.join(", ") : "전체 (입력 없음)"],
];

/** One row per executed file (= test class, by Java convention one public class per file). */
function fileRow(cls: string, ts: TestRun["tests"]): { name: string; passed: number; bad: number; skipped: number } {
  return { name: `${cls.split(".").pop()}.java`, passed: ts.filter((t) => t.status === "passed").length, bad: ts.filter((t) => t.status === "failed" || t.status === "error").length, skipped: ts.filter((t) => t.status === "skipped").length };
}

function renderHtml(d: ReportData, end: Date): string {
  const r = d.run;
  const bad = r.failed + r.errored;
  const byCls = [...byClass(r)];
  const stats = [
    ["", String(r.total), "실행한 테스트"],
    ["good", String(r.passed), "통과"],
    [bad > 0 ? "bad" : "", String(bad), "실패"],
    ["", String(r.skipped), "건너뜀"],
    ["", `${secs(r.seconds)}초`, "테스트 시간"],
    ["", d.coverage ? pct(d.coverage.line) : "-", "라인 커버리지"],
    ["", d.coverage ? pct(d.coverage.branch) : "-", "분기 커버리지"],
  ]
    .map(([c, n, l]) => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join("");
  const info = [["작업 일시", when(d.startedAt, end)], ...input(d)].map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join("");
  const inputHtml = `<div class="card"><dl class="runinfo">${input(d).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${d.command ? `<div class="codebox"><pre>${esc(d.command)}</pre></div>` : ""}</div>`;
  const filesHtml = `<details class="more"><summary>테스트 파일 ${byCls.length}개</summary><div class="body"><ul class="refs">${byCls
    .map(([cls, ts]) => {
      const f = fileRow(cls, ts);
      return `<li>${esc(f.name)} — ${ts.length}개 (통과 ${f.passed}${f.bad > 0 ? `, 실패 ${f.bad}` : ""}${f.skipped > 0 ? `, 건너뜀 ${f.skipped}` : ""})</li>`;
    })
    .join("")}</ul></div></details>`;
  const tests = byCls
    .map(([cls, ts]) => {
      const name = `${cls.split(".").pop()!}.java`;
      const f = fileRow(cls, ts);
      return `<details class="more" data-name="${esc(`${name} ${cls}`.toLowerCase())}"${f.bad > 0 ? " open" : ""}><summary>${esc(name)} · ${ts.length}개${f.bad > 0 ? ` <span class="badge fail">실패 ${f.bad}</span>` : ""} <span class="dim">${esc(cls)}</span></summary><div class="body"><table class="t"><tr><th>테스트</th><th>결과</th><th class="num">시간(초)</th></tr>${ts
        .map((t) => `<tr><td><code>${esc(t.method)}</code></td><td class="st-${t.status}">${STATUS[t.status]}</td><td class="num">${secs(t.seconds)}</td></tr>`)
        .join("")}</table></div></details>`;
    })
    .join("\n");
  const failuresHtml =
    d.failures.length > 0
      ? `<section class="step" id="failures"><h2><span class="no">!</span>실패 내역</h2><div class="card"><table class="t"><tr><th>테스트</th><th>종류</th><th>원인</th><th>위치</th></tr>${d.failures
          .map((f) => `<tr><td><code>${esc(f.cls.split(".").pop()!)}.${esc(f.method)}</code></td><td>${f.kind === "error" ? "예외" : "단언 실패"}</td><td>${esc(describeFailure(f))}</td><td>${esc(f.frame || "-")}</td></tr>`)
          .join("")}</table></div></section>`
      : "";
  const skipped = r.tests.filter((t) => t.status === "skipped");
  const attention = skipped.length > 0 ? `<section class="step" id="check"><h2><span class="no">!</span>확인 필요</h2><div class="card"><ul>${skipped.map((t) => `<li>건너뜀: ${esc(t.cls.split(".").pop()!)}.${esc(t.method)}</li>`).join("")}</ul></div></section>` : "";
  const v = verdictOf(r);
  const verdict = v === "FAIL" ? "fail" : v === "SKIP" ? "warn" : "pass";
  return fill(TEMPLATE, {
    TITLE: "f-unittest-analysis 리포트",
    STAMP: esc(localTimestamp(end)),
    HEADING: "단위 테스트 실행 리포트",
    RUNINFO: `<dl class="runinfo">${info}</dl>`,
    VERDICT: `<div class="verdict ${verdict}"><div class="head"><span class="badge ${verdict}">${v}</span></div><p class="cause">${v === "SKIP" ? ALL_SKIPPED(r) : `전체 ${r.total}개 중 통과 ${r.passed}${bad > 0 ? `, 실패 ${bad}` : ""} (건너뜀 ${r.skipped})`}</p></div>`,
    STATS: stats,
    TOC: `<a href="#input">실행 입력</a><a href="#files">실행한 파일</a><a href="#tests">상세 결과</a>${d.failures.length > 0 ? '<a href="#failures">실패 내역</a>' : ""}${attention ? '<a href="#check">확인 필요</a>' : ""}`,
    INPUT: inputHtml,
    FILES: filesHtml,
    TESTS: tests,
    ATTENTION: [failuresHtml, attention].filter(Boolean).join("\n"),
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
  const bad = r.failed + r.errored;
  const byCls = [...byClass(r)];
  const body = [
    "# f-unittest-analysis 리포트",
    "",
    `- 작업 일시: ${when(d.startedAt, end)}`,
    verdictOf(r) === "SKIP"
      ? `- 결과: SKIP · ${ALL_SKIPPED(r)} (${secs(r.seconds)}초)`
      : `- 결과: ${bad > 0 ? "FAIL" : "PASS"} · 전체 ${r.total}개 중 통과 ${r.passed}${bad > 0 ? `, 실패 ${bad}` : ""} (건너뜀 ${r.skipped}, ${secs(r.seconds)}초)`,
    `- 커버리지: 라인 ${d.coverage ? pct(d.coverage.line) : "-"}, 분기 ${d.coverage ? pct(d.coverage.branch) : "-"}`,
    "",
    "## 실행 입력",
    ...input(d).map(([k, v]) => `- ${k}: ${v}`),
    ...(d.command ? ["", "```", d.command, "```"] : []),
    "",
    `## 실행한 파일 (${byCls.length}개)`,
    ...byCls.map(([cls, ts]) => {
      const f = fileRow(cls, ts);
      return `- ${f.name} — ${ts.length}개 (통과 ${f.passed}${f.bad > 0 ? `, 실패 ${f.bad}` : ""}${f.skipped > 0 ? `, 건너뜀 ${f.skipped}` : ""})`;
    }),
    "",
    "## 상세 결과",
    ...byCls.flatMap(([cls, ts]) => [`### ${cls.split(".").pop()}.java (${ts.length}개)`, `클래스: ${cls}`, "", "| 테스트 | 결과 | 시간(초) |", "|---|---|---|", ...ts.map((t) => `| ${cell(t.method)} | ${STATUS[t.status]} | ${secs(t.seconds)} |`), ""]),
    ...(d.failures.length > 0
      ? ["## 실패 내역", "", "| 테스트 | 종류 | 원인 | 위치 |", "|---|---|---|---|", ...d.failures.map((f) => `| ${cell(`${f.cls.split(".").pop()}.${f.method}`)} | ${f.kind === "error" ? "예외" : "단언 실패"} | ${cell(describeFailure(f))} | ${f.frame || "-"} |`), ""]
      : []),
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), body, "utf-8");
  fs.writeFileSync(path.join(dir, "report.html"), renderHtml(d, end), "utf-8");
  return `${rel}/report.md`;
}
