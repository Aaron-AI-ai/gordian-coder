import { describe, expect, test } from "bun:test";
import { matchesCaseSelector, score, splitSections, type GoldenCase } from "../flog-eval";

const REPORT = `# f-log 리포트

## 요약
NullPointerException — TLABQ001Service.tlabq001에서 매퍼 결과 null 역참조.

## 스택 원문
\`\`\`
java.lang.NullPointerException: Cannot invoke ...
\`\`\`

## 진입점 → 원인 경로
- 진입점: Case01NpeTest.serviceDereferencesNullMapperResult
- 원인 프레임: src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java tlabq001

## 원인 상세와 근거
selectAcnt가 null을 반환했는데 row.getAcntNo()를 호출.

## 해결 방안
row == null이면 PBOnlineException.create("1001", accountNo)를 던진다.
- src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java: null 검사

\`\`\`java
if (row == null) { throw PBOnlineException.create("1001", param.getInner().getAccountNo()); }
\`\`\`

## 실행 정보
- 적용 룰: npe, fico_exception_flow
`;

const CASE: GoldenCase = {
  id: "case-01-npe",
  log: "logs/f-log-cases/case-01-npe.log",
  exception: "java.lang.NullPointerException",
  cause_files: ["src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java"],
  cause_symbol: "tlabq001",
  fix_keywords_any: ["null", "Optional"],
  rule: "npe",
};

describe("flog-eval", () => {
  test("splitSections keys by '## ' header and keeps body until the next header", () => {
    const s = splitSections(REPORT);
    expect(Object.keys(s)).toEqual(["요약", "스택 원문", "진입점 → 원인 경로", "원인 상세와 근거", "해결 방안", "실행 정보"]);
    expect(s["해결 방안"]).toContain("PBOnlineException");
    expect(s["해결 방안"]).not.toContain("적용 룰");
  });

  test("score passes every check on a matching report", () => {
    expect(score(CASE, REPORT)).toEqual({ exception: true, cause_file: true, cause_symbol: true, fix: true, fix_code: true, rule: true });
  });

  test("cause_file accepts a basename-only mention, case-insensitively", () => {
    const md = REPORT.replace("src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java", "tlabq001service.java");
    expect(score(CASE, md).cause_file).toBe(true);
  });

  test("fix fails when no keyword appears in the resolution section only", () => {
    const md = REPORT.replace(
      "row == null이면 PBOnlineException.create(\"1001\", accountNo)를 던진다.\n- src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java: null 검사\n\n```java\nif (row == null) { throw PBOnlineException.create(\"1001\", param.getInner().getAccountNo()); }\n```\n",
      "매퍼 결과를 검사한다.\n- src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java: 결과 검사\n\n```java\nif (row == undefined) { return out; }\n```\n",
    );
    const r = score(CASE, md);
    expect(r.fix).toBe(false);
    expect(r.exception).toBe(true);
  });

  test("rule check passes when the case declares no rule; english headers are recognised", () => {
    const en = `## Summary\nNPE\n## Entry point → cause path\nTLABQ001Service.java tlabq001\n## Cause and evidence\nnull\n## Resolution\nadd a null check\n## Run info\n- rules: none\n`;
    const { rule, ...rest } = CASE;
    expect(score(rest, en)).toEqual({ exception: false, cause_file: true, cause_symbol: true, fix: true, fix_code: false, rule: true });
  });

  test("matchesCaseSelector: comma-separated exact ids", () => {
    expect(matchesCaseSelector("case-05-fixed-list-size-exceeded", "case-04-fixed-string-length-overflow,case-05-fixed-list-size-exceeded")).toBe(true);
    expect(matchesCaseSelector("case-06-fixed-list-missing-size-not-last", "case-04-fixed-string-length-overflow,case-05-fixed-list-size-exceeded")).toBe(false);
  });

  test("matchesCaseSelector: '*' glob pattern for a prefix range", () => {
    expect(matchesCaseSelector("case-04-fixed-string-length-overflow", "case-0*")).toBe(true);
    expect(matchesCaseSelector("case-15-ext-transactional-missing-manager", "case-0*")).toBe(false);
  });

  test("matchesCaseSelector: mixed exact ids and glob patterns, whitespace tolerant", () => {
    const selector = " case-01-npe , case-3*, case-10-fixed-nested-vo-block-count";
    expect(matchesCaseSelector("case-01-npe", selector)).toBe(true);
    expect(matchesCaseSelector("case-10-fixed-nested-vo-block-count", selector)).toBe(true);
    expect(matchesCaseSelector("case-30-encrypt-blake2b-digest-range", selector)).toBe(true);
    expect(matchesCaseSelector("case-02-mybatis-binding", selector)).toBe(false);
  });

  test("matchesCaseSelector: no selector (undefined) matches everything", () => {
    expect(matchesCaseSelector("case-99-anything", undefined)).toBe(true);
  });
});
