import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hideCases, matchesCaseSelector, score, splitSections, type GoldenCase } from "../flog-eval";

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

const tmps: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

describe("flog-eval", () => {
  test("splitSections keys by '## ' header and keeps body until the next header", () => {
    const s = splitSections(REPORT);
    expect(Object.keys(s)).toEqual(["요약", "스택 원문", "진입점 → 원인 경로", "원인 상세와 근거", "해결 방안", "실행 정보"]);
    expect(s["해결 방안"]).toContain("PBOnlineException");
    expect(s["해결 방안"]).not.toContain("적용 룰");
  });

  test("score passes every check on a matching report", () => {
    expect(score(CASE, REPORT)).toEqual({ exception: true, cause_file: true, cause_symbol: true, fix: true, fix_code: true, fix_forbid: true, rule: true });
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

  // case-02: the report names the root cause (ReflectionException) and leaves the
  // wrapping PersistenceException to the quoted stack — both are a correct answer.
  test("exception may list several acceptable exceptions; any one in the scored sections passes", () => {
    const md = REPORT.replaceAll("NullPointerException", "ReflectionException");
    const wrapperOnly = { ...CASE, exception: "org.apache.ibatis.exceptions.PersistenceException" };
    expect(score(wrapperOnly, md).exception).toBe(false);
    const either = { ...CASE, exception: ["org.apache.ibatis.exceptions.PersistenceException", "org.apache.ibatis.reflection.ReflectionException"] };
    expect(score(either, md).exception).toBe(true);
  });

  // fix_code alone only proves a code block exists; fix_code_any pins what the fix must say.
  test("fix_code_any requires one expected fragment inside a fix-section code block, spacing and case ignored", () => {
    expect(score({ ...CASE, fix_code_any: ["if(row==NULL)"] }, REPORT).fix_code).toBe(true);
    expect(score({ ...CASE, fix_code_any: ["Optional.ofNullable"] }, REPORT).fix_code).toBe(false);
    // prose outside the code block does not count
    expect(score({ ...CASE, fix_code_any: ["PBOnlineException.create(\"1001\", accountNo)"] }, REPORT).fix_code).toBe(false);
    // without fix_code_any the old rule (any code block) holds
    expect(score(CASE, REPORT).fix_code).toBe(true);
  });

  test("a fix_code_any entry starting with re: is a regex over the whitespace-free, lowercased code", () => {
    expect(score({ ...CASE, fix_code_any: ['re:create\\("\\d{4}"'] }, REPORT).fix_code).toBe(true);
    expect(score({ ...CASE, fix_code_any: ['re:create\\("\\d{5}"'] }, REPORT).fix_code).toBe(false);
  });

  // Framework style: the fix must not fall back to the plain-Java way the framework replaces.
  test("fix_forbid_any fails when a forbidden fragment appears in fix code, prose and @-prefixed lookalikes aside", () => {
    expect(score({ ...CASE, fix_forbid_any: ["new RuntimeException"] }, REPORT).fix_forbid).toBe(true);
    expect(score({ ...CASE, fix_forbid_any: ["throw PBOnlineException .create("] }, REPORT).fix_forbid).toBe(false);
    // prose outside the code block does not count
    expect(score({ ...CASE, fix_forbid_any: ["null 검사"] }, REPORT).fix_forbid).toBe(true);
    const ext = REPORT.replace("if (row == null)", "@ExtTransactional\nif (row == null)");
    expect(score({ ...CASE, fix_forbid_any: ["@Transactional"] }, ext).fix_forbid).toBe(true);
    expect(score({ ...CASE, fix_forbid_any: ['re:row==null\\)\\{throw'] }, REPORT).fix_forbid).toBe(false);
  });

  // Squashing drops indentation, so a top-level yml key and a nested one look the same; raw: sees lines.
  test("a raw: entry is a multiline regex over the code as written", () => {
    const yml = (body: string) => REPORT.replace(/```java[\s\S]*?```/, "```yml\n" + body + "```");
    const top = yml("fico:\n  crypto:\n    enabled: true\ncubeone:\n  default-crypto-id: ACNT\n");
    const nested = yml("fico:\n  crypto:\n    enabled: true\n    cubeone:\n      default-crypto-id: ACNT\n");
    expect(score({ ...CASE, fix_forbid_any: ["raw:^cubeone:"] }, top).fix_forbid).toBe(false);
    expect(score({ ...CASE, fix_forbid_any: ["raw:^cubeone:"] }, nested).fix_forbid).toBe(true);
    expect(score({ ...CASE, fix_code_any: ["raw:^\\s+cubeone:"] }, nested).fix_code).toBe(true);
  });

  test("rule check passes when the case declares no rule; english headers are recognised", () => {
    const en = `## Summary\nNPE\n## Entry point → cause path\nTLABQ001Service.java tlabq001\n## Cause and evidence\nnull\n## Resolution\nadd a null check\n## Run info\n- rules: none\n`;
    const { rule, ...rest } = CASE;
    expect(score(rest, en)).toEqual({ exception: false, cause_file: true, cause_symbol: true, fix: true, fix_code: false, fix_forbid: true, rule: true });
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

  test("hideCases moves f-log-cases/ out of the project and restore puts it back once", () => {
    const target = tmp("flog-hide-");
    const away = tmp("flog-away-");
    mkdirSync(join(target, "f-log-cases"));
    writeFileSync(join(target, "f-log-cases", "case-01.yaml"), "log: x");
    const restore = hideCases(target, join(away, "cases"));
    expect(existsSync(join(target, "f-log-cases"))).toBe(false);
    expect(existsSync(join(away, "cases", "case-01.yaml"))).toBe(true);
    restore();
    restore();
    expect(existsSync(join(target, "f-log-cases", "case-01.yaml"))).toBe(true);
  });

  test("hideCases first recovers a set left hidden by an interrupted run", () => {
    const target = tmp("flog-hide-");
    const away = join(tmp("flog-away-"), "cases");
    mkdirSync(away);
    writeFileSync(join(away, "case-01.yaml"), "log: x");
    const restore = hideCases(target, away);
    expect(existsSync(join(away, "case-01.yaml"))).toBe(true);
    restore();
    expect(existsSync(join(target, "f-log-cases", "case-01.yaml"))).toBe(true);
  });

  test("hideCases is a no-op when there is no golden set anywhere", () => {
    const target = tmp("flog-hide-");
    const away = join(tmp("flog-away-"), "cases");
    hideCases(target, away)();
    expect(existsSync(away) || existsSync(join(target, "f-log-cases"))).toBe(false);
  });
});
