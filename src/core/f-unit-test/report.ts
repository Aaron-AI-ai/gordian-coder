/** report.md for a finished /f-unit-test-code run. */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { isFullyCovered, type FailedTest } from "./coverage";
import { MAX_COVERAGE_ROUNDS, MAX_FIX_RETRIES, REPORT_DIR, interfaceTargets, measuredTargets, type FutSession, type Verification } from "./workflow";

const pct = (c: { missed: number; covered: number }): string => {
  const total = c.missed + c.covered;
  return total === 0 ? "-" : `${c.covered}/${total} (${Math.round((c.covered / total) * 100)}%)`;
};

// A function, not a table: workflow.ts imports this module, so its constants are not set yet at load time.
const verdict = (v: Verification): string =>
  ({
    pending: "측정 안 됨",
    covered: "전부 커버됨",
    gaps: `공백 남음 (보강 ${MAX_COVERAGE_ROUNDS}회 소진)`,
    incomplete: `미완료 (수정 재시도 ${MAX_FIX_RETRIES}회 초과)`,
  })[v];


const cell = (t: string): string => t.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "기대 X, 실제 Y" 로 읽히면 그렇게, 아니면 메시지 그대로. */
function describeFailure(d: FailedTest): string {
  const m = /expected:\s*<(.*?)>\s*but was:\s*<(.*?)>/s.exec(d.message);
  const text = m ? `기대 ${m[1]}, 실제 ${m[2]}` : d.message || "(메시지 없음)";
  return d.type && !m ? `${d.type.split(".").pop()}: ${text}` : text;
}

/** Whether the failing test method was already in a planned test file before this run. */
function existedBefore(session: FutSession, d: FailedTest): boolean {
  const simple = d.cls.split(".").pop()!;
  return Object.entries(session.previousMethods).some(([file, methods]) => path.posix.basename(file, ".java") === simple && methods.includes(d.method));
}

function failureSection(session: FutSession): string[] {
  if (session.failedDetails.length === 0) return ["없음"];
  const table = (rows: FailedTest[]): string[] => [
    "| 테스트 | 종류 | 원인 | 위치 |",
    "|---|---|---|---|",
    ...rows.map((d) => `| ${cell(d.cls.split(".").pop()! + "." + d.method)} | ${d.kind === "error" ? "예외" : "단언 실패"} | ${cell(describeFailure(d))} | ${d.frame || "-"} |`),
  ];
  const old = session.failedDetails.filter((d) => existedBefore(session, d));
  const made = session.failedDetails.filter((d) => !existedBefore(session, d));
  return [
    ...(old.length > 0
      ? [
          "### 기존 테스트 (이번 실행 전부터 있던 것, 수정하거나 끄지 않았다)",
          "코드 변경으로 동작이 바뀌어 낡았을 수도, 변경이 회귀일 수도 있다. 생성기는 어느 쪽인지 판단하지 않는다. 확인이 필요하다.",
          "",
          ...table(old),
          "",
        ]
      : []),
    ...(made.length > 0 ? ["### 이번에 생성한 테스트 (코드나 기대값을 다시 확인해야 한다)", "", ...table(made), ""] : []),
  ];
}

/** Writes `<runDir>/report.md` (Korean headings for the developer) and returns its path. */
export function writeReport(session: FutSession, summary: string): string {
  session.runDir ??= `${REPORT_DIR}/report-${localFileStamp()}`;
  const dir = path.join(session.cwd, session.runDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.md");
  const rows = session.coverage.map((c) =>
    c.coverage ? `| ${c.target} | ${pct(c.coverage.line)} | ${pct(c.coverage.branch)} |` : `| ${c.target} | jacoco.xml에 없음 | - |`,
  );
  const gaps = session.coverage
    .filter((c) => !isFullyCovered(c.coverage))
    .map((c) =>
      c.coverage
        ? `- ${c.target}: 미실행 줄 ${c.coverage.uncoveredLines.join(", ") || "없음"}, 분기 일부 미실행 줄 ${c.coverage.partialLines.join(", ") || "없음"}`
        : `- ${c.target}: 어떤 테스트도 실행하지 않음`,
    );
  const interfaces = interfaceTargets(session);
  const measured = new Set([...measuredTargets(session), ...session.mapperChecks.map((m) => m.target), ...interfaces]);
  const mapperLines = session.mapperChecks.flatMap((m) => [
    `- ${m.target}: 커버리지 측정 안 함 (XML SQL은 JaCoCo가 보지 않음) — 테스트 ${m.testFile ?? "없음"}`,
    ...m.methods.map((x) => `  - ${x.name}: ${x.called ? "호출함" : x.skipped ? "건너뜀 (skip_reason)" : "호출 안 함"}`),
  ]);
  const skipped = (session.inputs?.cases ?? [])
    .filter((c) => c.skip_reason?.trim())
    .map((c) => `- ${c.target}#${c.method}: ${c.skip_reason!.trim()}${measured.has(c.target) ? "" : " (대상 전체 제외, 커버리지 측정 안 함)"}`);
  const body = [
    "# f-unit-test-code 리포트",
    "",
    `- 요청: ${session.request}`,
    `- 모드: ${session.inputs?.mode ?? "-"}, 모듈: ${session.inputs?.module ?? "-"}`,
    `- 검증 결과: ${verdict(session.verification)}`,
    `- 재시도: 수정 ${session.fixRetries}회, 커버리지 보강 ${session.gapRounds}회`,
    "",
    "## 대상",
    ...(session.inputs?.targets ?? []).map((t) => `- ${t}`),
    "",
    "## 테스트 파일",
    ...[...session.touched].sort().map((f) => `- ${f}`),
    "",
    "## 커버리지",
    ...(rows.length > 0 ? ["| 대상 | 라인 | 분기 |", "|---|---|---|", ...rows] : ["측정 결과 없음"]),
    "",
    ...(mapperLines.length > 0 ? ["## Mapper (실제 DB 테스트)", ...mapperLines, ""] : []),
    ...(interfaces.length > 0 ? ["## 인터페이스", ...interfaces.map((t) => `- ${t}: 커버리지 측정 안 함 (인터페이스)`), ""] : []),
    ...(gaps.length > 0 ? ["## 남은 공백", ...gaps, ""] : []),
    ...(skipped.length > 0 ? ["## 테스트하지 않은 메서드", ...skipped, ""] : []),
    ...(session.verification === "incomplete" ? ["## 마지막 오류", ...session.lastProblems, ""] : []),
    "## 실패한 테스트",
    ...failureSection(session),
    "",
    "## 검증 메모",
    session.verifyNote ?? "",
    "",
    "## 계획",
    session.plan ?? "",
    "",
    "## 요약",
    summary,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}
