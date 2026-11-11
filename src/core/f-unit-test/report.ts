/** report.md for a finished /f-unit-test-code run. */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { isFullyCovered } from "./coverage";
import { MAX_COVERAGE_ROUNDS, MAX_FIX_RETRIES, REPORT_DIR, type FutSession, type Verification } from "./workflow";

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
    ...(gaps.length > 0 ? ["## 남은 공백", ...gaps, ""] : []),
    ...(session.verification === "incomplete" ? ["## 마지막 오류", ...session.lastProblems, ""] : []),
    "## 실패한 테스트",
    ...(session.failedTests.length > 0 ? session.failedTests.map((t) => `- ${t}`) : ["없음"]),
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
