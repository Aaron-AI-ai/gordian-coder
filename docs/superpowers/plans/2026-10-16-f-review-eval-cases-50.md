# f-review 평가 케이스 50개 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** f-review 평가 테스트베드를 버그 케이스 10개에서 50개(case-11~50 신규 40개)로, 대조군을 2개에서 6개(control-03~06 신규 4개)로 늘리고, 첫 배치에서 드러난 채점기의 약점 3건(줄 번호 수작업·카테고리 단일값·리포트 폴더 충돌)과 대조군 오탐 노이즈 1건을 먼저 고친다.

**Architecture:** (1) gordian-coder `scripts/freview-eval.ts`를 TDD로 개선한다(`anchor`로 줄 번호 자동 산출, `category` 허용 목록, 출력 폴더 분리, 대조군에서 `tests` 카테고리 무시). (2) `test-projects`의 `on-test-lab-online/review-samples/` 아래에 버그 샘플을 추가하고 케이스마다 커밋+태그를 쌓는다. (3) 마지막에 컨트롤러가 whole 모드로 전체를 한 번 돌려 카테고리를 보정한다.

**Tech Stack:** Bun(채점기), 순수 Java 21 문법(컴파일되지 않는 정적 샘플)과 MyBatis XML, YAML, Git.

**Spec:** `docs/superpowers/specs/2026-10-13-f-review-eval-testbed-design.md`(원 설계) + 2026-10-16 채팅에서 승인된 확장안(축별 케이스 구성, 채점기 개선 3건). 이 계획서의 "케이스 사양" 표가 그 확장안의 확정본이다.

## Global Constraints

- 대상 저장소: `/Users/koscom/workspace/fico/test-projects`(브랜치 `main`, 현재 HEAD `c1f947f`). 작업 디렉터리 `on-test-lab/on-test-lab-online`. 채점기 저장소: `/Users/koscom/workspace/gordian-coder`(브랜치 `develop`, 직접 작업, 워크트리 없음).
- **커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다**(사용자 메모리 규칙: `feedback_no_coauthor.md`).
- **`git push` 금지.** `origin`은 403(`hyosung` 계정에 업로드 권한 없음)이라 사용자 결정 대기 중이다. 커밋과 태그는 로컬에만 쌓는다.
- 버그 샘플은 `review-samples/` 아래에만 둔다(어느 Gradle sourceSet에도 속하지 않음 — 컴파일되지 않으므로 import가 실제로 resolve되지 않아도 무방하나, 실존하는 fico 클래스는 정확한 FQCN을 쓴다).
  - Java: `review-samples/kr/co/koscom/pb/on/test/lab/online/review/<Class>.java`, 패키지 `kr.co.koscom.pb.on.test.lab.online.review`
  - MyBatis XML: `review-samples/mapper/<Name>Mapper.xml`
- **샘플 코드는 버그를 암시하면 안 된다**: 클래스명·메서드명·변수명·주석·Javadoc 어디에도 `bug`, `wrong`, `leak`, `unsafe`, `injection`, `TODO`, `FIXME`, "고의", "버그" 같은 단서를 쓰지 않는다. Javadoc은 클래스의 정상적인 용도만 한 줄로 적는다. 20~40줄의 현실적인 서비스/VO/매퍼 형태로 쓴다. 기존 샘플(`AcntBalanceQueryService.java` 등)의 문체를 따른다.
- **정답 YAML 스키마**(버그 케이스): `file`, `category`(문자열 또는 목록 — f-review의 6종 `correctness/security/performance/maintainability/tests/framework` 중), `min_severity`(`blocker/major/minor/nit`), `anchor`(버그 줄에 **정확히 한 번만** 나오는 문자열), `keywords_any`, `kb_ref`(KB 축만), `commit`(케이스 ID와 같은 git 태그 이름). 대조군: `file`, `expect_clean: true`, `commit`(자기 자신의 태그). **`line_range`는 쓰지 않는다**(채점기가 `anchor`로 산출).
- 앵커 검증: 파일을 쓴 뒤 `grep -c -F -- '<anchor>' <file>`이 정확히 `1`이어야 한다. 아니면 앵커를 더 구체적으로 바꾼다. 앵커를 바꿨으면 YAML과 일치시킨다.
- 케이스 하나 = 파일 1개(샘플) + 정답 YAML 1개 = **커밋 1개** + 태그 1개(`git tag case-NN`). 대조군도 같다(`git tag control-NN`).
- **KB 근거 확인 의무(KB 축 케이스 33~50)**: 사양 표의 `kb_ref` 문서를 직접 읽고(`/Users/koscom/workspace/fico/test-projects/.fico/kb/fico_framework/<kb_ref>`), 그 문서가 규정한 사용법과 **어긋나게** 샘플을 쓴다. 문서 내용이 사양의 "위반 내용"과 모순되면(그런 위반이 문서상 성립하지 않으면) **임의로 바꾸지 말고 BLOCKED로 보고**한다 — 사양 보정은 컨트롤러가 한다.
- 이미 커밋된 케이스(case-01~10, control-01~02)와 그 파일은 건드리지 않는다.
- `kb_ref`는 KB 루트 `test-projects/.fico/kb/fico_framework/` 기준 상대 경로.
- 대상 저장소에서 `git add`는 **명시한 경로만** 쓴다(`-A`/`.` 금지). 새 파일이 `.gitignore`에 걸리지 않는지 `git status --porcelain`으로 확인한다(`review-samples/`·`f-review-cases/`는 걸리지 않는다).

## 케이스 사양

### A. Java/웹 빈출 (case-11~24) — 클래스명은 `Acnt*`/`Tx*`류 평범한 이름 유지

| ID | 파일(클래스) | 위반 내용 | 앵커 힌트(버그 줄) | category | min_sev | keywords_any |
|---|---|---|---|---|---|---|
| 11 | `SessionDateFormatter` | 싱글톤 서비스가 `static final SimpleDateFormat`을 여러 스레드가 공유 | `private static final SimpleDateFormat` | correctness | major | SimpleDateFormat, thread, 스레드, 동시 |
| 12 | `CustomerGradeService` | 문자열을 `==`로 비교 | `grade == "VIP"` | correctness | major | equals, ==, 문자열 |
| 13 | `FeeCalcService` | 금액 계산에 `double` 사용 | `double fee =` | correctness | major | double, BigDecimal, 정밀, 오차 |
| 14 | `NoticeSendService` | 예외를 빈 catch로 삼킴 | `} catch (Exception e) { }` | correctness, maintainability | major | catch, 예외, 삼키, 빈 |
| 15 | `MemberAuthService` | 로그에 비밀번호를 그대로 출력 | `log.info("login request: id={}, password={}"` | security | blocker | password, 비밀번호, 로그, 민감 |
| 16 | `PasswordStoreService` | 비밀번호를 MD5로 해시 | `MessageDigest.getInstance("MD5")` | security | major | MD5, 해시, bcrypt, 취약 |
| 17 | `OrderDetailService` | 주문 목록 루프 안에서 건별 매퍼 조회(N+1) | `orderMapper.selectItems(orderId)` | performance | major | N+1, 루프, 반복, 쿼리 |
| 18 | `TxnCleanupService` | for-each 순회 중 리스트에서 `remove` | `list.remove(` | correctness | major | ConcurrentModification, 순회, remove, Iterator |
| 19 | `AcntLookupService` | `Optional.get()`을 `isPresent` 확인 없이 호출 | `.get().getAcntNm()` | correctness | major | Optional, get, isPresent, NoSuchElement |
| 20 | `RequestCounterService` | 싱글톤 서비스의 `static int` 카운터를 동기화 없이 증가 | `private static int requestCount` | correctness | major | static, 스레드, 동시, AtomicInteger |
| 21 | `TokenIssueService` | 인증 토큰 생성에 `java.util.Random` 사용 | `new Random()` | security | major | Random, SecureRandom, 예측 |
| 22 | `InputPatternService` | 사용자 입력에 재앙적 백트래킹 정규식 적용 | `Pattern.compile("(\\w+\\s?)+$")` | security, performance | major | 정규식, ReDoS, backtracking, regex |
| 23 | `ConfigHolderService` | double-checked locking에 `volatile` 누락 | `if (instance == null)` | correctness | major | volatile, double-checked, 싱글톤, 동시 |
| 24 | `LoginRedirectController` | 요청 파라미터를 검증 없이 `sendRedirect` | `sendRedirect(returnUrl)` | security | major | redirect, 리다이렉트, 검증, open |

### C. 롬복·코딩 규약 (case-25~28)

| ID | 파일(클래스) | 위반 내용 | 앵커 힌트 | category | min_sev | keywords_any |
|---|---|---|---|---|---|---|
| 25 | `AcntInfoVo` | `@Data @Builder`만 있고 `@NoArgsConstructor`/`@AllArgsConstructor` 없음(MyBatis·Jackson 매핑용 기본 생성자 부재) | `@Builder` | correctness, maintainability | major | @Builder, NoArgsConstructor, 기본 생성자 |
| 26 | `SettleLogService` | 롬복을 쓰는 클래스에서 `Logger`를 수동 생성 | `LoggerFactory.getLogger(` | maintainability | minor | @Slf4j, Logger, 롬복 |
| 27 | `SavingsAcntVo` | `@Data`가 붙은 하위 클래스가 상위 VO의 필드를 equals/hashCode에서 빼먹음(`callSuper` 누락) | `public class SavingsAcntVo extends AcntBaseVo` | correctness | minor | callSuper, EqualsAndHashCode, 상속 |
| 28 | `AcntStatusService` | `@RequiredArgsConstructor`를 쓰는데 주입받을 필드에 `final`이 없음 | `private TestLabMapper testLabMapper;` | correctness | major | final, RequiredArgsConstructor, 주입, null |

### D. MyBatis XML (case-29~32) — 파일 `review-samples/mapper/<Name>Mapper.xml`

| ID | 파일 | 위반 내용 | 앵커 힌트 | category | min_sev | keywords_any |
|---|---|---|---|---|---|---|
| 29 | `AcntSearchMapper.xml` | `LIKE`에 `${keyword}` 문자열 치환 | `LIKE '%${keyword}%'` | security | blocker | ${, SQL, 인젝션, #{ |
| 30 | `TxHistoryMapper.xml` | 페이징 대상 조회에 `ORDER BY` 없음 | `FROM TB_TX_HISTORY` | correctness, performance | major | ORDER BY, 페이징, 정렬 |
| 31 | `BalanceResetMapper.xml` | `WHERE` 없는 전체 `UPDATE` | `UPDATE TB_BALANCE SET AMT = 0` | correctness | blocker | WHERE, 전체, UPDATE |
| 32 | `CodeListMapper.xml` | 빈 컬렉션이 올 수 있는 `foreach IN`에 가드 없음 | `<foreach collection="codeList"` | correctness | major | foreach, 빈, empty, IN |

### B. fico KB 위배 (case-33~50) — 전부 `kb_ref` 문서를 읽고 작성, 기본 category는 `framework`(분류가 갈릴 수 있는 것은 목록으로)

| ID | 파일(클래스) | 위반 내용 | `kb_ref` | category | min_sev | keywords_any |
|---|---|---|---|---|---|---|
| 33 | `AcntFixedVo` | `@FixedVo` 클래스에 `@FixedData` 없는 필드 선언 | `fico-fwk-core/internal/annotations/FixedVo.md` | framework, correctness | major | FixedData, FixedVo, 고정길이 |
| 34 | `AcntListFixedVo` | `@FixedList` 건수 필드를 리스트보다 뒤에 선언 | `fico-fwk-core/internal/annotations/FixedList.md` | framework, correctness | major | FixedList, 건수, size, 순서 |
| 35 | `AcntResponseVo` | 주민번호/비밀번호 성격 필드를 `@EncryptData` 없이 응답 VO에 노출 | `fico-fwk-extension/annotation/EncryptData.md` | framework, security | major | EncryptData, 암호화, 민감 |
| 36 | `PartnerCallService` | 외부 호출을 `new RestTemplate()`로 직접 수행(Retryable/서킷 우회) | `fico-fwk-core/internal/RetryableRestTemplate.md` | framework | major | RestTemplate, Retryable, RestCallModule, 서킷 |
| 37 | `ScheduledSyncService` | `@Scheduled` 메서드에서 `RequestScopeUtils.getAttribute` 호출 | `fico-fwk-core/utils/RequestScopeUtils.md` | framework, correctness | major | RequestScopeUtils, 스레드, 요청 스코프, Scheduled |
| 38 | `AsyncBalanceService` | `@Async` 메서드가 `DynamicDataSourceContextHolder` 키가 있다고 가정 | `fico-fwk-core/internal/database/dynamic/DynamicDataSourceContextHolder.md` | framework, correctness | major | DynamicDataSource, ThreadLocal, Async, 데이터소스 |
| 39 | `AcntQueryController` | 컨트롤러 첫 파라미터가 `CommonRequest`가 아님(`DynamicDataSourceAspect` 미적용) | `fico-fwk-extension/aspect/DynamicDataSourceAspect.md` | framework | major | CommonRequest, DynamicDataSourceAspect, 첫 번째 |
| 40 | `AcntValidateService` | 오류 코드를 `MessageCode` 상수 대신 리터럴 문자열로 사용 | `fico-fwk-extension/constant/MessageCode.md` | framework, maintainability | minor | MessageCode, 상수, FWKE |
| 41 | `AuthTokenService` | `JwtUtils` 시크릿 키를 소스에 하드코딩 | `fico-fwk-core/jwt/JwtUtils.md` | security, framework | blocker | JwtUtils, 시크릿, 하드코딩, 키 |
| 42 | `MaskKeyService` | `EncryptUtils.encryptNumberByBlake2b` digestSize를 허용 범위(10~16) 밖(예: 20)으로 호출 | `fico-fwk-core/utils/EncryptUtils.md` | framework, correctness | major | Blake2b, digestSize, 범위 |
| 43 | `InterestCalcService` | `NumberUtils.setScalePrc`의 반올림 모드 값을 유효 범위(0~7) 밖(예: 99)으로 호출 | `fico-fwk-core/utils/NumberUtils.md` | framework, correctness | major | setScalePrc, 반올림, RoundingMode, 범위 |
| 44 | `ContractTermService` | `DateUtils.compareDate`에 8자리 `yyyyMMdd`가 아닌 형식(예: `"2026-10-16"`) 전달 | `fico-fwk-core/utils/DateUtils.md` | framework, correctness | major | compareDate, yyyyMMdd, 8자리, DateUtils |
| 45 | `NameMaskService` | `StringUtils` 마스킹에 문서에 없는 유형 값 전달 | `fico-fwk-core/utils/StringUtils.md` | framework, correctness | minor | masking, 유형, StringUtils |
| 46 | `StaticLookupHolder` | 컨텍스트 준비 전(static 초기화)에 `BeanUtils.getBean` 호출 | `fico-fwk-core/utils/BeanUtils.md` | framework, correctness | major | BeanUtils, getBean, static, 컨텍스트 |
| 47 | `EventPollingService` | Kafka 컨슈머를 직접 `poll` 루프로 구현하고 리밸런스 리스너·fico 컨슈머 서비스 미사용 | `fico-fwk-core/kafka/KafkaConsumerService.md` | framework | major | KafkaConsumer, RebalanceListener, 컨슈머, poll |
| 48 | `EventPublishService` | `KafkaProducerService` 전송 결과를 확인/처리하지 않고 fire-and-forget | `fico-fwk-core/kafka/KafkaProducerService.md` | framework, correctness | minor | Kafka, 전송, 결과, 콜백 |
| 49 | `StatementUploadService` | `SftpModule` 세션을 사용 후 닫지 않음 | `fico-fwk-core/module/SftpModule.md` | framework, performance | major | Sftp, 세션, disconnect, 닫 |
| 50 | `PagingKeyService` | `PagingInfo` 연속키 필드명 개수와 값 개수 불일치 | `fico-fwk-core/model/PagingInfo.md` | framework, correctness | major | 연속키, contTrKey, PagingInfo, 개수 |

### 대조군(오탐 측정) — 신규 4개, 각각 자기 태그 사용

| ID | 파일 | 내용 |
|---|---|---|
| control-03 | `SafeFormatService` | A축 모양의 정상 코드: `DateTimeFormatter`(불변) 사용, 문자열은 `equals`, 금액은 `BigDecimal`, 예외는 로깅 후 처리 |
| control-04 | `CleanSettleService` | C축 모양의 정상 코드: `@Slf4j` + `@RequiredArgsConstructor` + `private final` 필드 |
| control-05 | `CleanQueryMapper.xml` | D축 모양의 정상 XML: `#{}` 바인딩, `ORDER BY` 포함, `foreach` 가드 |
| control-06 | `CleanHeaderService` | B축 모양의 정상 코드: `commonHeader` null 체크, `CommonException.create(MessageCode.FWKE0002, "commonHeader를")` 형태 |

---

### Task 1: 채점기 개선 (TDD)

**Files:**
- Modify: `/Users/koscom/workspace/gordian-coder/scripts/freview-eval.ts`
- Modify: `/Users/koscom/workspace/gordian-coder/scripts/__tests__/freview-eval.test.ts`

**Interfaces:**
- Consumes: 기존 `freview-eval.ts` 구조(Task 6 산출물, 커밋 `f5d14db`) — 먼저 파일을 전부 읽어 현재 모양을 확인한다.
- Produces: `resolveLineRange(c: BugCase, source: string): [number, number]`(신규 export), `scoreBugCase(c, rows, range?)`(시그니처 확장), `BugCase.category: string | string[]`, `BugCase.anchor?: string`, `BugCase.line_range?`. Task 2~6의 정답 YAML이 이 스키마를 쓴다.

- [ ] **Step 1: 실패하는 테스트 추가**

`scripts/__tests__/freview-eval.test.ts`의 import 줄에 `resolveLineRange`를 추가하고, 파일 끝에 다음을 덧붙인다.

```typescript
describe("resolveLineRange", () => {
  const base = {
    id: "case-x", kind: "bug" as const, file: "A.java",
    category: "correctness", min_severity: "major", keywords_any: ["x"], commit: "case-x",
  };
  const src = ["package a;", "class A {", "  void f() {", "    row.getName();", "  }", "}"].join("\n");

  test("finds the single line containing the anchor (1-based)", () => {
    expect(resolveLineRange({ ...base, anchor: "row.getName()" }, src)).toEqual([4, 4]);
  });
  test("throws when the anchor matches no line", () => {
    expect(() => resolveLineRange({ ...base, anchor: "nope" }, src)).toThrow(/matched 0 lines/);
  });
  test("throws when the anchor matches more than one line", () => {
    expect(() => resolveLineRange({ ...base, anchor: "a" }, src)).toThrow(/matched \d+ lines/);
  });
  test("falls back to line_range when there is no anchor", () => {
    expect(resolveLineRange({ ...base, line_range: [3, 5] }, src)).toEqual([3, 5]);
  });
  test("throws when neither anchor nor line_range is given", () => {
    expect(() => resolveLineRange(base, src)).toThrow(/needs anchor or line_range/);
  });
});

describe("scoreBugCase with category lists and explicit ranges", () => {
  const c = {
    id: "case-x", kind: "bug" as const, file: "A.java",
    category: ["performance", "maintainability"], min_severity: "minor",
    anchor: "x", keywords_any: ["누수"], commit: "case-x",
  };
  const row = (category: string, line: number) =>
    ({ severity: "major", category, line, rule: "r", message: "리소스 누수", suggestion: "" });

  test("accepts any category from the list", () => {
    expect(scoreBugCase(c, [row("performance", 10)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("maintainability", 10)], [10, 10])).toBe(true);
  });
  test("rejects a category outside the list", () => {
    expect(scoreBugCase(c, [row("security", 10)], [10, 10])).toBe(false);
  });
  test("honors the explicit range with the +-3 tolerance (boundary pass at +3, fail at +4)", () => {
    expect(scoreBugCase(c, [row("performance", 13)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("performance", 14)], [10, 10])).toBe(false);
    expect(scoreBugCase(c, [row("performance", 7)], [10, 10])).toBe(true);
    expect(scoreBugCase(c, [row("performance", 6)], [10, 10])).toBe(false);
  });
});

describe("scoreControlCase ignores the tests category", () => {
  test("a minor 'tests' finding alone does not count as a false positive", () => {
    expect(scoreControlCase([{ severity: "minor", category: "tests", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("a major 'tests' finding is also ignored", () => {
    expect(scoreControlCase([{ severity: "major", category: "tests", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("a minor finding in any other category still fails", () => {
    expect(scoreControlCase([{ severity: "minor", category: "maintainability", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/koscom/workspace/gordian-coder && bun test scripts/__tests__/freview-eval.test.ts`
Expected: FAIL — `resolveLineRange`가 export되지 않아 import 에러.

- [ ] **Step 3: 구현**

`scripts/freview-eval.ts`를 다음과 같이 고친다(현재 파일을 읽고 해당 위치를 정확히 찾아 바꾼다).

(a) `BugCase` 인터페이스의 세 필드를 교체:
```typescript
  category: string | string[];
  min_severity: string;
  line_range?: [number, number];
  anchor?: string;
```
(기존 `category: string;`, `line_range: [number, number];` 줄을 위 내용으로 대체. `min_severity`는 그대로.)

(b) `loadCases`의 버그 케이스 push 안에서:
```typescript
        category: y.category as string | string[],
        min_severity: y.min_severity as string,
        line_range: y.line_range as [number, number] | undefined,
        anchor: y.anchor as string | undefined,
```

(c) `scoreBugCase`와 `scoreControlCase`를 다음으로 교체하고, 그 위에 `resolveLineRange`를 추가:
```typescript
/** 정답의 줄 범위를 구한다. anchor가 있으면 소스에서 그 문자열이 든 줄을 찾는다(정확히 1줄이어야 함). */
export function resolveLineRange(c: BugCase, source: string): [number, number] {
  if (!c.anchor) {
    if (!c.line_range) throw new Error(`${c.id}: needs anchor or line_range`);
    return c.line_range;
  }
  const hits = source.split("\n").flatMap((l, i) => (l.includes(c.anchor!) ? [i + 1] : []));
  if (hits.length !== 1) throw new Error(`${c.id}: anchor "${c.anchor}" matched ${hits.length} lines (need exactly 1)`);
  return [hits[0], hits[0]];
}

export function scoreBugCase(c: BugCase, rows: FindingRow[], range?: [number, number]): boolean {
  const [lo, hi] = range ?? resolveLineRange(c, "");
  const cats = Array.isArray(c.category) ? c.category : [c.category];
  return rows.some((r) =>
    cats.includes(r.category) &&
    SEVERITY_RANK[r.severity] <= SEVERITY_RANK[c.min_severity] &&
    r.line !== null &&
    r.line >= lo - LINE_TOLERANCE && r.line <= hi + LINE_TOLERANCE &&
    c.keywords_any.some((k) => (r.message + " " + r.suggestion).toLowerCase().includes(k.toLowerCase()))
  );
}

/** 대조군은 minor 이상 finding이 없어야 통과. `tests` 카테고리는 샘플 코드에 테스트가 없어서 항상 뜨는 노이즈라 제외한다. */
export function scoreControlCase(rows: FindingRow[]): boolean {
  return !rows.some((r) => r.category !== "tests" && SEVERITY_RANK[r.severity] <= SEVERITY_RANK.minor);
}
```

(d) 리포트 출력 폴더를 f-review의 자동 백업 규칙(폴더명이 정확히 `f-review`일 때 이전 리포트를 통째로 이동)에 걸리지 않게 바꾼다. `freview-eval.ts` 안의 `.fico/report/f-review`(두 곳: `runFReview`의 `mkdirSync`와 `main`의 `const report =`)를 `.fico/report/freview-eval`로 바꾼다.

(e) `main`의 채점 줄을 교체. 기존:
```typescript
    const findings = parseFileFindings(md, c.file);
    const pass = c.kind === "bug" ? scoreBugCase(c, findings) : scoreControlCase(findings);
```
교체 후:
```typescript
    const findings = parseFileFindings(md, c.file);
    let pass: boolean;
    if (c.kind === "bug") {
      try {
        const src = await Bun.file(join(target, c.file)).text();
        pass = scoreBugCase(c, findings, resolveLineRange(c, src));
      } catch (e) {
        console.error((e as Error).message);
        pass = false;
      }
    } else {
      pass = scoreControlCase(findings);
    }
```

- [ ] **Step 4: 통과 확인**

Run: `bun test scripts/__tests__/freview-eval.test.ts`
Expected: 전부 PASS(기존 12개 + 신규). 기존 `scoreBugCase(c, rows)` 호출 테스트는 `c.line_range`가 있으므로 그대로 통과해야 한다 — 통과하지 않으면 구현을 고친다(테스트를 고치지 않는다).

- [ ] **Step 5: 전체 검증과 커밋**

Run: `bun test && bun run typecheck && bun run build`
Expected: 전부 통과.

```bash
cd /Users/koscom/workspace/gordian-coder
git add scripts/freview-eval.ts scripts/__tests__/freview-eval.test.ts
git commit -m "Let f-review eval cases locate their bug line by anchor and accept several categories

Hand-counted line ranges drifted by one line in 4 of the first 10 cases, and
two guessed categories disagreed with what f-review actually reports. Cases
may now give a unique anchor string (resolved to a line at scoring time) and a
list of acceptable categories. Control cases ignore the always-present 'tests'
finding, and reports go to .fico/report/freview-eval/ because f-review moves a
folder literally named f-review aside on every write."
```

---

### Task 2: A축 전반부 case-11~18 + control-03

**Files (모두 test-projects):**
- Create: `on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/` 아래 사양 표 case-11~18의 Java 8개 + `SafeFormatService.java`
- Create: `on-test-lab/on-test-lab-online/f-review-cases/case-11.yaml` ~ `case-18.yaml`, `control-03.yaml`

**Interfaces:**
- Consumes: Task 1의 YAML 스키마(`anchor`, `category` 목록). 직전 태그 `case-10` 위에 `4b327ba`·`c1f947f` 정정 커밋이 있으므로 현재 HEAD(`c1f947f`)에서 시작한다.
- Produces: 태그 `case-11`~`case-18`, `control-03`.

- [ ] **Step 1~9: 케이스마다 반복(case-11부터 18까지 순서대로)**

각 케이스에 대해:
1. 사양 표의 행을 읽고 `<Class>.java`를 쓴다. 버그 줄 한 곳에만 위반이 있고, 나머지는 정상 코드여야 한다. 앵커 힌트의 문자열이 정확히 한 줄에 한 번만 나오게 쓴다.
2. 앵커 검증: `grep -c -F -- '<앵커>' <파일>` → `1`.
3. 정답 YAML을 쓴다. 예(case-12):
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/CustomerGradeService.java
category: correctness
min_severity: major
anchor: 'grade == "VIP"'
keywords_any: ["equals", "==", "문자열"]
commit: case-12
```
`category`가 둘 이상이면 `category: [correctness, maintainability]` 형식으로 쓴다.
4. 커밋과 태그(경로는 명시):
```bash
cd /Users/koscom/workspace/fico/test-projects
git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/<Class>.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-NN.yaml
git commit -m "Add f-review case-NN: <한 줄 요약>"
git tag case-NN
```
5. 대조군 `control-03`은 case-18 다음에 같은 방식으로 추가한다: `SafeFormatService.java`(사양 표의 "정상 코드"), `control-03.yaml`(`expect_clean: true`, `commit: control-03`), 커밋, `git tag control-03`.

- [ ] **Step 10: 마무리 검증**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects
git log --oneline -10
git tag -l | sort -V | tr '\n' ' '
git status --porcelain -- on-test-lab/on-test-lab-online/review-samples on-test-lab/on-test-lab-online/f-review-cases
```
Expected: 새 커밋 9개가 `c1f947f` 위에 일직선, 태그에 `case-11`~`case-18`, `control-03`이 추가, 마지막 `git status`는 출력 없음. 각 커밋은 정확히 파일 2개를 추가한다(`git show --stat <sha>`).

---

### Task 3: A축 후반부 + C축 case-19~28 + control-04

**Files:** Task 2와 같은 위치. Java: 사양 표 case-19~28(10개) + `CleanSettleService.java`. YAML: `case-19.yaml`~`case-28.yaml`, `control-04.yaml`.

**Interfaces:**
- Consumes: Task 2가 만든 `case-18`/`control-03` 태그와 그 위의 HEAD.
- Produces: 태그 `case-19`~`case-28`, `control-04`.

- [ ] **Step 1~11: Task 2의 "케이스마다 반복" 절차와 동일하게 case-19부터 28까지 진행**

(A축 19~24, C축 25~28. C축 case-25는 롬복 어노테이션 배치가 핵심이므로 클래스 선언 위쪽에 `@Data`와 `@Builder`만 두고 `@NoArgsConstructor`/`@AllArgsConstructor`는 쓰지 않는다. case-27은 상위 VO `AcntBaseVo`를 같은 파일 안에 package-private 클래스로 함께 정의하거나, import만 하고 정의는 생략한다 — 컴파일되지 않으므로 둘 다 허용.) 마지막에 `control-04`(`CleanSettleService`: `@Slf4j`, `@RequiredArgsConstructor`, `private final` 필드)를 추가한다.

- [ ] **Step 12: 마무리 검증** — Task 2 Step 10과 같은 명령. Expected: 새 커밋 11개(케이스 10 + 대조군 1), 태그 `case-19`~`case-28`, `control-04`.

---

### Task 4: D축 case-29~32 + B축 case-33~36 + control-05

**Files:** Java 4개(case-33~36), XML 4개(`review-samples/mapper/*.xml`), 대조군 XML `review-samples/mapper/CleanQueryMapper.xml`, YAML 9개.

**Interfaces:**
- Consumes: Task 3의 HEAD(`control-04` 태그).
- Produces: 태그 `case-29`~`case-36`, `control-05`.

- [ ] **Step 1~10: 케이스마다 반복**

D축(29~32)은 MyBatis XML이다. 형식 예(case-29):
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.mapper.AcntSearchMapper">
  <select id="searchByName" resultType="map">
    SELECT ACNT_NO, ACNT_NM
      FROM TB_ACNT
     WHERE ACNT_NM LIKE '%${keyword}%'
  </select>
</mapper>
```
정답 YAML의 `file`은 `review-samples/mapper/AcntSearchMapper.xml`. B축 33~36은 사양 표의 `kb_ref` 문서를 먼저 읽는다(Global Constraints의 KB 근거 확인 의무). 마지막에 대조군 `control-05`(`CleanQueryMapper.xml`: `#{}` 바인딩, `ORDER BY`, `foreach` 앞 가드)를 추가한다.

- [ ] **Step 11: 마무리 검증** — Task 2 Step 10과 같은 명령(`git status` 경로에 `review-samples/mapper`가 포함되므로 그대로 `review-samples` 전체를 본다). Expected: 새 커밋 9개, 태그 `case-29`~`case-36`, `control-05`.

---

### Task 5: B축 case-37~44 + control-06

**Files:** 사양 표 case-37~44의 Java 8개 + `CleanHeaderService.java`, YAML 9개.

**Interfaces:**
- Consumes: Task 4의 HEAD(`control-05` 태그).
- Produces: 태그 `case-37`~`case-44`, `control-06`.

- [ ] **Step 1~10: Task 2의 "케이스마다 반복" 절차**, 단 B축이므로 모든 케이스에서 `kb_ref` 문서를 먼저 읽고 `kb_ref` 필드를 정답 YAML에 넣는다. `control-06`은 case-44 다음에 추가한다(사양 표의 "정상 코드").

- [ ] **Step 11: 마무리 검증** — Task 2 Step 10과 같은 명령. Expected: 새 커밋 9개, 태그 `case-37`~`case-44`, `control-06`.

---

### Task 6: B축 case-45~50

**Files:** 사양 표 case-45~50의 Java 6개, YAML 6개.

**Interfaces:**
- Consumes: Task 5의 HEAD(`control-06` 태그).
- Produces: 태그 `case-45`~`case-50`. 이로써 `case-01`~`case-50`, `control-01`~`control-06`, `baseline`이 모두 존재한다.

- [ ] **Step 1~7: Task 5와 같은 절차로 case-45부터 50까지.**

- [ ] **Step 8: 전체 사슬 검증**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects
git log --oneline baseline..case-50 | wc -l
git tag -l 'case-*' | wc -l
git tag -l 'control-*' | wc -l
ls on-test-lab/on-test-lab-online/f-review-cases/*.yaml | wc -l
for f in on-test-lab/on-test-lab-online/f-review-cases/case-{11..50}.yaml; do
  a=$(grep -m1 '^anchor:' "$f" | sed -E "s/^anchor: *['\"]?//; s/['\"]? *$//")
  file=$(grep -m1 '^file:' "$f" | sed 's/^file: *//')
  n=$(grep -c -F -- "$a" "on-test-lab/on-test-lab-online/$file")
  [ "$n" = "1" ] || echo "ANCHOR PROBLEM: $f -> $n hits"
done
echo "anchor check done"
```
Expected: 첫 줄은 `case-01`~`case-50` 사이 커밋 수(정정 커밋 2개 포함해 52 이상, 즉 일직선 이력), 태그 `case-*` 50개, `control-*` 6개, YAML 56개, "ANCHOR PROBLEM" 줄 없음.

---

### Task 7: 전체 라이브 평가와 카테고리 보정 (컨트롤러가 직접 수행)

이 태스크는 서브에이전트가 아니라 컨트롤러가 직접 한다 — 라이브 `opencode` 호출이 메모리 부족·네트워크 장애로 자주 끊기는 환경이라, 케이스마다 한 번에 하나씩 순차 실행하고 끊기면 이어서 재개하는 운영 판단이 필요하기 때문이다.

- [ ] **Step 1:** 사용자가 별도 OpenCode 세션으로 같은 디렉터리를 쓰고 있지 않은지 `ps aux | grep opencode`로 확인한다(과거 동시 실행으로 리포트가 섞인 전례).
- [ ] **Step 2:** `./scripts/run-freview-eval.sh --mode whole --case <한 케이스>`를 56개(버그 50 + 대조군 6)에 대해 순차 실행한다. 출력은 `.fico/report/freview-eval/`에 쌓인다(Task 1 이후 이전 리포트가 백업 폴더로 이동하지 않음). 끊긴 케이스는 해당 케이스만 재실행한다.
- [ ] **Step 3:** FAIL 케이스마다 리포트의 finding 표를 읽고 원인을 분류한다: (a) 카테고리 추정 오류 → 정답 YAML의 `category` 목록에 실제 분류 추가, (b) 앵커/키워드 문제 → 정답 보정, (c) f-review가 정말 못 찾음 → **보정하지 않고 그대로 FAIL로 기록**(이것이 측정하려는 약점이다). 보정은 새 커밋으로 하고 `git commit --amend`/태그 이동은 하지 않는다.
- [ ] **Step 4:** diff 모드는 축별 샘플(case-11, case-25, case-29, case-33, case-50)만 실행한다.
- [ ] **Step 5:** 결과 요약(축별 검출률, 대조군 오탐, 보정 내역, 못 찾은 케이스 목록)을 `docs/reports/f-review-eval-50-<날짜>.md`로 gordian-coder에 커밋한다.

---

## Self-review

- 사용자 요청(50개까지, 다양하게)과 승인된 설계: 버그 50(기존 10 + 신규 40: A 14·C 4·D 4·B 18), 대조군 6(기존 2 + 신규 4) — Task 2~6이 사양 표 전부를 덮는다(11~24 Task 2·3, 25~28 Task 3, 29~32 Task 4, 33~36 Task 4, 37~44 Task 5, 45~50 Task 6).
- 채점기 개선 4건(anchor, category 목록, 출력 폴더, 대조군 `tests` 무시) 전부 Task 1에 코드와 테스트가 있다.
- 줄 번호 수작업을 없애는 것이 이 계획의 핵심이므로, 정답 YAML에는 `line_range`를 쓰지 않고 앵커 유일성 검증(Task 2 Step 2, Task 6 Step 8)을 둔다.
- KB 축은 문서 근거 확인 의무와 모순 시 BLOCKED 보고 규칙을 Global Constraints에 두어, 문서에 없는 규약을 지어내지 못하게 했다.
- 알려진 위험: (1) case-40(MessageCode 문자열 리터럴)처럼 f-review가 실제로 못 짚을 수 있는 케이스가 있다 — Task 7 Step 3(c)가 "못 찾음은 못 찾음으로 기록"하도록 규정. (2) push는 403으로 막혀 있어 이번 계획에서 하지 않는다.
