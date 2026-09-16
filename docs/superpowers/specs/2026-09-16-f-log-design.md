# f-log — 에러 로그 분석 설계 스펙

상위 그림은 `docs/design/error-log-analysis-design.md`(4단계 파이프라인, 추후 항목)를 따른다.
이 문서는 그 그림을 구현 가능한 수준으로 확정한 것이다. 상위 문서와 다른 결정은 §16에 모았다.

## 1. 범위

**한다**
- Spring Boot(fico 프레임워크) 서비스의 Java 스택트레이스 한 건을 받아 **원인 코드 위치 · 원인 · 해결 방안**을 리포트로 낸다.
- 입력: `/f-log`에 붙여넣은 로그 원문, 또는 `--file=path`.
- 근거: 저장소 코드 + 사내 프레임워크 KB + 번들/프로젝트 룰. 웹 검색 없음(오프라인).
- 대상: Java / Spring / fico 프레임워크(`fico-fwk-core`, `fico-fwk-extension`, `framework-site-ext`). 스택 없는 로그(핸들러 warn 줄, 저널 ERROR)도 정상 입력.

**안 한다** (상위 문서 점선 + 이번 결정)
- 코드 수정(fixer), 재현 검증(1.3), OpenSearch 연동, 사례 KB(Jira), 로그 집계·빈도 순위(IBF/FF), 동적 분석, tree-sitter/LSP 콜그래프.

## 2. 확정된 결정

| 결정 | 선택 | 이유 |
|---|---|---|
| 산출물 | 원인 진단 리포트. 수정은 사람 | 범위 질문 답변 |
| 입력 크기 | 스택트레이스 한 덩어리 | 〃 |
| 분석 루프 구조 | **단일 analyst 순차** + 독립 judge 서브에이전트 | 가설 탐색은 rework 라운드가 커버. 심사 독립성은 상위 문서 3단계 |
| 코드 재사용 경계 | **얇은 독립 코어**(`src/core/log/`) + review의 무상태 계층만 import. `pipeline/*`, `report/output.ts` 미사용 | `judge.ts`는 `(runId,file,part)`와 review findings에 결합. 빌릴 알맹이는 70줄 |
| 예외: 가드 계층 | **공용화** — `guardExploration` + `repeat-guard`를 모듈 등록제로 | "소형 모델 무한 루프 방어를 동일하게" — 복사는 시간이 지나면 갈라짐 |
| 산출물 위치 | `.fico/` 아래, `fico_ai.json` `log` 섹션 | 사용자 요청 |
| 룰 | f-review와 같은 md 구조, 게이트만 예외 타입 | 사용자 요청 |
| 컨텍스트 | **총량 예산 40,000자** + 우선순위 절단 | "상한 안에 든다"는 잘못된 기준. 소형 모델은 총량에 무너짐 |

## 3. 구조

```
src/core/guard.ts                  ← 신규. review/pipeline/loop.ts에서 이동
  GuardState, guardExploration, MAX_DUP_CALLS, MAX_MISS_STREAK, MISS_PREFIXES

src/core/log/                      ← 신규 코어 (플랫폼 독립)
  parse.ts        Java/fico 스택트레이스 → ParsedLog          순수 함수
  plan.ts         프레임 분류 → 용의 파일 → observations → run 생성
  rules.ts        룰 md 로더/게이트/렌더러 (frontmatter: exceptions·globs·mode)
  rules/*.md      번들 룰 (§7)
  context.ts      f_log_context 조립 — 예산·우선순위 절단 (§8)
  tools.ts        탐색 툴 스펙 7개 → read.ts/related.ts 함수 직접 호출
  submit.ts       f_log_submit 스키마 + 거부/강제 수락
  judge.ts        f_log_judge_context / f_log_judge, verdict, rework 누적
  finalize.ts     누락 검증 → 리포트 md/html
  state.ts        sessionID → LogSession (GuardState + runId + round). 가드용 메모리
  run-store.ts    runId → .fico/f-log/runs/<id>/ 디스크. 서브에이전트 간 공유
  config.ts       loadLogConfig(cwd) = loadConfig() 위에 raw.log 덮어쓰기
  prompt.ts       analyst / judge 프롬프트 템플릿
  index.ts

src/adapters/opencode/log/
  index.ts        createLogModule(input) → tools + agents + command + event + registerGuardModule
  prompts.ts      f-log-analyst, f-log-judge 정의, /f-log 커맨드 템플릿

src/adapters/opencode/modules.ts   factories에 createLogModule 추가 (1줄)
src/adapters/opencode/repeat-guard.ts   등록제로 변경 (§13)
src/core/review/evidence/rubric.ts      frameworkKbRule, BUNDLED_RULES의 mapper 룰에 export (동작 변화 없음)
```

review에서 import하는 것: `imports.ts`(`resolveImport`, `isExternalImport`, `normalizeRepoPath`), `evidence/framework-kb.ts`(`frameworkKbDocs`), `tools/read.ts`(`fileRead`, `fileFind`, `codeSearch`, `readFileAt`, `listFilesAt`, 상한 상수), `tools/related.ts`(`renderRelatedCode`, `gitHistory`), `config.ts`(`loadConfig`, `resolveMaxToolCalls`), `pipeline/judge-store.ts`의 상수(`DEFAULT_JUDGE_THRESHOLD`, `MAX_JUDGE_ROUNDS`, `MAX_INVALID_JUDGE_SUBMISSIONS`), `pipeline/loop.ts`의 `MAX_FAILED_SUBMITS`, `MAX_RESUMES`.

## 4. 데이터 흐름

```
/f-log <로그 원문 | --file=path> [--output=] [--judge]
  │  메인 세션 = 오케스트레이터 (커맨드 템플릿)
  ▼
f_log_plan(log)                                   코드
  parse → 분류 → suspects(≤8) → observations → KB → 룰 매칭
  스택 없으면: svcId/URI → Controller/Service, errorCode → throw 지점을 code_search로 선탐색
  run 생성 → runId + "f-log-analyst를 스폰하라"
  ▼
[f-log-analyst]  ──────────────────────────────┐
  f_log_context(runId)   예산 절단된 컨텍스트     │ rework: 기각 가설 누적, 룰·KB 생략
  탐색 툴 (예산·가드 §13)                         │
  f_log_submit(runId, …)                          │
  ▼                                               │
[f-log-judge]                                     │
  f_log_judge_context(runId) → f_log_judge(runId, scores…)
  코드 판정: 합 ≥ judgeThreshold → pass / rework ─┘  (rework > judgeRounds → terminal)
  ▼
f_log_finalize(runId)   누락 검증 → .fico/report/f-log/log-<stamp>.md + .html
```

상태: 가드 카운터는 `state.ts`(세션 메모리), 라운드 산출물·심사는 `run-store.ts`(디스크). 서브에이전트는 세션이 다르므로 runId로 디스크를 본다.

## 5. 파서 (`parse.ts`)

```ts
interface StackFrame    { cls: string; method: string; file: string|null; line: number|null; raw: string }
interface ExceptionBlock{ type: string; message: string; frames: StackFrame[]; omitted: number }
interface ParsedLog {
  chain: ExceptionBlock[];        // [0]=바깥 … at(-1)=마지막 Caused by = root cause
  suppressed: ExceptionBlock[];
  handler: { errorCode?: string; svcId?: string; uri?: string; even?: string; logger?: string } // 직전 핸들러 줄에서
  raw: string;
}
```

처리 규칙 (전부 픽스처로 고정):
1. **줄머리 제거** — fico log4j2 `[LEVEL:trace:user][host:ts][thread][logger{5}:method:L] ` 및 일반 logback 프리픽스. 로거는 축약(`%logger{5}`)이므로 프레임 FQCN과 대조하지 않는다.
2. **프레임** `at (java.base/)?FQCN.method(File.java:N | Unknown Source | Native Method)` + 접미 `~[jar:ver]`, ` [jar:ver]`, `~[?:?]`, `[main/:?]` 제거.
3. **체인** `Caused by:` 블록 분리, `... N more` → `omitted` 기록 + 바깥 블록 프레임으로 복원, `Suppressed:`.
4. **정규화** `Foo$$EnhancerBySpringCGLIB$$a1b2` / `$$FastClassBySpringCGLIB$$` / `$Proxy42` / `$$Lambda$` → 원 클래스, `lambda$save$0` → `save`, `<init>`/`<clinit>` 유지.
5. **구식 Spring** `; nested exception is X: msg` → 체인 블록으로 분리.
6. **메시지 없는 헤더** — `CommonException.create(code)`는 message null → 헤더에 타입만. `: null`도 빈 메시지로.
7. **여러 줄 메시지** — `at`/`Caused by`/`...`/줄머리 어느 것도 아닌 연속 줄은 직전 메시지에 이어붙임.
8. **핸들러 줄 추출** — 스택 직전 로그 줄에서 `errorCode=(\S+)`, `code=(\S+)`, `URI=(\S+)`, `CommonException:\[(.*)\]`, `Exception:\[(FQCN): (msg)\]`, `PB (404|405|415|9604)`. `PB 9604`는 errorCode `9604`로.

픽스처(`__tests__/fixtures/`): fico-app-example 실 로그 2건(기동 실패 BeanCreation→JMX InstanceAlreadyExists 체인, NoResourceFound via CommonControllerAdvice) + 핸들러 소스 문자열로 합성한 PBOnlineException(`고정길이 전문 CommonException: errorCode=1001`), PBGlobalExceptionAdvice warn(스택 없음), Kafka `Consumer.listen() consumerRecord=`, CGLIB/lambda, `nested exception is`, 줄머리 없는 순수 스택.

## 6. plan (`plan.ts`)

```ts
interface LogPlan {
  runId: string;
  suspects: Array<{ path: string; frame: StackFrame|null; block: number; rank: number; source: "frame"|"svcId"|"errorCode" }>;
  entry: StackFrame|null;      // 가장 바깥 in-app 프레임 (Controller/Job/Consumer)
  observations: string[];      // 심사·누락검증 기준. 코드가 생성
  kbDocs: KbDoc[];
  rules: LogRule[];            // 매칭된 룰 (렌더는 context.ts)
}
```

- **분류** — 각 프레임 FQCN을 `resolveImport(cwd, null, fqcn, "x.java", all)`로 해석(네 번째 인자는 언어 선택용 확장자만 보므로 가짜 경로로 Java 분기를 태운다): 해석되면 **in-app**; 아니면 `frameworkKb` 프리픽스 매칭 시 **framework**(KB 주입); 아니면 external. 순서가 중요: 앱 `kr.co.koscom.pb.on…`과 프레임워크 `kr.co.koscom.pb.framework…`가 접두를 공유한다. `isExternalImport`로 `java.*`/`javax.*`/`jakarta.*` 선제외.
- **순위** — root-cause 블록(`chain.at(-1)`)의 in-app 프레임 먼저, 블록 내 1/k; 다음 바깥 블록. 경로 중복 제거, 최대 8.
- **스택 없는 입력** — `handler.svcId`/`uri`가 있으면 `codeSearch(cwd, null, '@PostMapping(value = "/…"' )`와 `"{svcId}Controller"`/`"{svcId}Service"`로 파일을 찾아 `source:"svcId"`로 추가. `handler.errorCode`가 있으면 `codeSearch('create("<code>"')`(및 `withExceptionCode("<code>"`)로 throw 지점을 `source:"errorCode"`로 추가.
- **entry** — in-app 프레임 중 가장 바깥(배열 끝쪽) 것. 이름이 `*Controller`/`*Job`/`*Tasklet`/`*Consumer*`/`*Listener`면 우선.
- **observations** — 체인의 각 `type: message`(메시지 값 포함), `omitted` 있으면 "N프레임 생략", 반복 프레임(재귀), `handler`의 errorCode/svcId/uri/even 각각 한 줄. 이 목록이 제출의 `observations[]`와 1:1로 대응한다.
- **KB** — root-cause 블록에 나온 framework 프레임의 FQCN만 `frameworkKbDocs`에 넣고 상위 3개, 각 3,000자로 자른다(§8).

## 7. 룰 (`rules.ts`, `rules/*.md`)

frontmatter — f-review 문법에 키 하나 추가:
```markdown
---
exceptions: "org.springframework.dao.*", "*SQLException"   # 체인의 어느 예외 FQCN이라도 glob 매칭
globs: "**/mapper/**/*.xml"                                   # 선택: 용의 파일 중 하나라도 매칭
mode: reference                                               # 선택: 본문 대신 목록, file_read로 읽게
---
```
- 두 키 다 있으면 AND. 둘 다 없으면 항상.
- 게이트 특이도 = 매칭된 glob 문자열 길이. 특이도 순으로 예산에 넣고 넘치면 reference 모드로 강등.
- 프로젝트 룰: `log.rulesDir`(기본 `log/rules`) 아래 `.md` 재귀. 번들 뒤에 붙는다.
- 파서는 f-log 자체 구현(~25줄, `ponytail:` 주석). rubric의 `parseRule`은 미export이고 `exceptions`를 모른다. 세 번째 소비자가 생기면 합친다.
- 룰 본문 길이 **15–25줄**: "무엇을 의심하라 3–5줄 + 어느 툴로 확인하라 2–3줄". 프레임워크 설명은 KB가 하므로 클래스명만 짚는다.
- judge에는 v1 미적용.

번들 룰 (fico 프레임워크 소스·위키·on-stk-ord에서 확인한 사실 기준):

| 파일 | exceptions 게이트 | 본문 핵심 |
|---|---|---|
| `fico_error_code.md` | 항상 (observations에 errorCode 있을 때 의미) | `CommonException`→`PBBaseException`→`PBOnline/Batch/Daemon/Module`; `create(code)`는 message null; 4자리 숫자만 고정헤더 msgCode, 아니면 `9000`; `9604` 전문 포맷; `FWKE0001/0002/0003`; 메시지 텍스트는 DB `COM_MSG`(`DBMessageSource`) — 저장소에 없으니 찾지 말 것; 확인: `code_search 'create("<code>"'` |
| `fico_exception_flow.md` | `*CommonException`, `*PB*Exception`, 또는 handler.uri | 핸들러 로그 줄 → 발생 층: `고정길이 전문 CommonException: errorCode=` = `PBExceptionHandlerAspect`(컨트롤러 메서드 안, `PBRequest` 첫 인자); `PB CommonException: URI=, code=`(warn, 스택 없음) = `PBGlobalExceptionAdvice`(디스패처 레벨); `CommonException:[…]`/`Exception:[…]` = `CommonControllerAdvice`(JSON); `PB 404/405/415/9604` = 매핑/전문 파싱. 컨트롤러 try-catch 금지(AOP) → catch가 있으면 후보 |
| `fico_transaction.md` | `*TransactionException`, `*UnexpectedRollbackException`, `*CannotCreateTransactionException`, `*TransactionSystemException`, 프레임 `PBTransactionAspect` | `@Around("bean(*Service)")`: svcId 5번째 글자 `Q`/`R`이면 **정상 종료도 rollback**; 중첩 Service 호출 스킵(`TX_ACTIVE`); svcId null(비-PB)이면 미적용; `mapper/ext`는 auto-commit; `qry/service @Transactional(readOnly=true)` vs `upd/service @Transactional` 충돌 |
| `fico_datasource.md` | `*BadSqlGrammarException`, `*CannotGetJdbcConnectionException`, 메시지 `table or view does not exist` / `relation .* does not exist`, 프레임 `DynamicDataSource*` | `DynamicDataSourceAspect @Before Controller/Module args(commonRequest,..)`: `commonHeader.even` `'1'`→PRIMARY `'2'`→SECONDARY 그 외 PRIMARY; **첫 인자가 `CommonRequest`가 아니면 미스위칭**; ThreadLocal이라 비동기·배치 스레드엔 키 없음; 벤더별 `mybatis.mapper-locations`(`mapper/postgres/**` vs `mapper/oracle/**`) — 활성 프로파일 yml 먼저; `RefreshableSqlSessionFactoryBean` 5초 리로드 |
| `fico_mybatis.md` | `org.apache.ibatis.*`, `*MyBatisSystemException`, `*PersistenceException`, `*SQLException`, `*DataAccessException` + globs `**/mapper/**/*.xml` | `MyBatisPagingInterceptor`가 `StatementHandler.prepare`에서 ROWNUM/OFFSET-LIMIT로 SQL을 감쌈 → 페이징 조회 오류는 래핑 결과; `#{}`↔DTO 필드, XML id↔Mapper 메서드; 상세는 `mapper_dao_xml.md` |
| `fico_fixed_message.md` | `*HttpMessageNotReadableException`, errorCode `9604`, 프레임 `PBFixedDataConverter` | Content-Type charset 우선 → formatter 폴백; `PBFixedHeader.HEADER_LENGTH`; `@FixedData/@FixedString/@FixedList` 길이 불일치; 헤더 `cmprTp`/`encrpTp` → `PayloadCompressionHandler`/CubeOne crypto; 저널 `PHASE_ERROR`엔 errorType/errorMessage만 |
| `fico_request_scope.md` | `java.lang.IllegalStateException`(`No thread-bound request`), NPE with 프레임 `RequestScopeUtils|PBHeaderUtils|ControllerAspect`, errorCode `FWKE0002` | 요청 상태 4종이 ThreadLocal/RequestContextHolder: `CommonRequest`, svcId, DS key, `TX_ACTIVE`; `@Async`/스케줄러/배치/Kafka 스레드에서 null; `ControllerAspect`가 commonHeader null이면 FWKE0002; `commonHeader.timeout` |
| `fico_outbound.md` | `*RestClientException`, `*ResourceAccessException`, `*HttpClientErrorException`, `*HttpServerErrorException`, `*CallNotPermittedException`, `*SocketTimeoutException`, `*ConnectException` | `RestCallModule` = resilience4j 서킷 + `RetryableRestTemplate`(spring-retry); `CallNotPermitted`는 서킷 열림 — 원인은 이전 실패; `WebClientProperties` 타임아웃; `TrControlModule` 거래통제 → FWKE0001; **`envCause` 표시 지시** |
| `fico_redis.md` | `org.springframework.data.redis.*`, `io.lettuce.*`, `*RedisConnectionFailureException`, `*QueryTimeoutException` | `RedisConfig` standalone/cluster/sentinel, pool, `command-timeout-sec`, eager warmup; `ContKeyService`(Redis/InMemory, `CONT_KEY:`) 연속조회 `contYn`; `RedisLogLevelStore`; envCause 지시 |
| `fico_batch.md` | `org.springframework.batch.*`, `*PBBatchException`, `*JobExecutionException`, `*SkipLimitExceededException`, `*RetryException` | `BaseJob`/`BaseTasklet`/`DefaultStepListener`/`DefaultCenterCutJob`; `PBBatchException.skipable/retryable`→SkipPolicy/RetryPolicy; ExitStatus; 배치 스레드엔 request scope 없음 |
| `fico_daemon.md` | `org.apache.kafka.*`, `*PBDaemonException`, `*KafkaException`, `*SerializationException`, Solace/OracleAQ 타입 | `DefaultKafkaConsumerRunnable`: 레코드별 catch → `Consumer.listen() consumerRecord=` 로그 후 **commitSync 계속(유실)**; `PBDaemonException.ackMode(ACK/NACK/DEAD_LETTER)/requeue`; `PBDaemonService`; ext `solace`/`oracleaq` |
| `fico_wiring.md` | `org.springframework.beans.factory.*`, `*BeanCreationException`, `*UnsatisfiedDependencyException`, `*NoSuchBeanDefinitionException`, `*ApplicationContextException` | `PBDaemonAutoConfiguration`/`PBWarmupAutoConfiguration`/`LogLevelStoreAutoConfiguration`; `redis.enabled`; optional ext mapper(앱의 `extLogMapper != null`); MBean 이름 중복(`InstanceAlreadyExistsException … GenericObjectPool,name=pool` — 실 로그) |
| `npe.md` | `java.lang.NullPointerException` | 역참조 대상 → 생산자 추적(`find_callers`); fico: `create(code)` null 메시지, optional 빈, commonHeader, request scope |
| `framework_kb.md` | 항상 | review의 `frameworkKbRule(cwd)` export 재사용 — 설정 표 치환 + "KB는 주입됐으니 읽지 말라" 문구 |
| `mapper_dao_xml.md` | globs `**/mapper/**/*.xml` | review 번들 export 재사용 |

## 8. 컨텍스트 예산 (`context.ts`)

`f_log_context` 응답 전체 상한 `log.contextMaxChars`(기본 **40,000**). 아래 순서로 채우고, 넘치면 **뒤에서부터** 자른다. 2번은 절대 잘리지 않는다.

| 순위 | 항목 | 개별 상한 |
|---|---|---|
| 1 | 로그 원문 (root-cause 블록 우선, 바깥 블록은 in-app 프레임만) | 6,000 |
| 2 | observations + 기각 가설 목록 | 3,000 |
| 3 | 1순위 용의 프레임 ±40줄 (`renderFileContent`) | 4,000 |
| 4 | 적용 룰 (특이도 순, 넘치면 reference 강등) | 6,000 |
| 5 | KB 문서 (root-cause 블록의 framework 클래스만) | 3 × 3,000 |
| 6 | 2–8순위 용의 파일 ±10줄 | 8,000 |
| 7 | 툴 안내 · 제출 형식 | ~2,000 고정 |

rework 라운드: 1·2·3만 다시 주고, 룰·KB는 "이전 라운드와 동일 — 필요하면 `file_read`" 한 줄. 실환경에서 한 번 돌려 `contextMaxChars`를 맞춘다.

## 9. 탐색 툴 (`tools.ts`)

| 툴 | 구현 | 비고 |
|---|---|---|
| `file_read` | `fileRead(cwd, null, path, start, end)` | ref = null (워킹트리) |
| `file_find` | `fileFind` | |
| `code_search` | `codeSearch` | |
| `related_code` | `renderRelatedCode` | |
| `git_history` | `gitHistory` | 파일 단위 |
| `find_callers` (신규) | `codeSearch(cwd, null, "\\.<method>\\(", ["*.java"])` 결과를 파일:줄 목록으로, 상한 50 | 콜그래프 grep 근사 (PRAXIS/SWE-agent 근거) |
| `git_blame` (신규) | `git blame -L n,n --porcelain` + `git log -L n,n:file -n 3 --format=…` | 줄 단위 원인 커밋 (Sentry/Datadog 방식) |

출력 상한은 `read.ts` 상수 그대로. 모든 툴 호출은 §13 가드를 통과한다.

## 10. 제출 · 심사

**`f_log_submit`** (zod)
```ts
{ runId, submitToken,
  cause:        { file, line?, summary, mechanism },
  evidence:     [{ file, lines: [s, e], why }],          // ≥1, callLog에 file_read/git_blame된 파일만
  observations: [{ observation, explained: boolean, how? }],  // plan.observations 각각과 대응, 누락 시 거부
  alternatives: [{ hypothesis, rejectedBecause }],        // ≥1; rework면 이전 기각 가설 포함
  resolution:   { summary, changes: [{ file, description }], kind: "root-cause"|"mitigation" },
  confidence:   0..100,
  envCause?:    boolean }
```
거부 사유별 카운트 → `MAX_FAILED_SUBMITS`(5) 초과 시 **강제 수락**(리포트에 표시). `submitToken`은 라운드마다 회전, 불일치 시 거부(같은 상한).

**`f_log_judge`** (zod)
```ts
{ runId, judgeToken,
  scores: { observation: 0..40, alternatives: 0..30, rootCause: 0..30 },   // 상위 문서 1.1 세 축
  unexplained: string[],
  feedback: string }
```
- verdict는 **코드가**: `합 ≥ judgeThreshold`(기본 70) → `pass`, 아니면 `rework`.
- rework → `{ cause.summary, feedback }`를 `judgments.json`의 `rejected[]`에 적재. 다음 `f_log_context`가 전부 주입(상위 문서 1.2).
- rework 횟수 > `judgeRounds`(기본 2) → `terminal`, 최고 점수 제출물로 finalize.
- malformed 심사 제출 `MAX_INVALID_JUDGE_SUBMISSIONS`(3) 초과 → 심사 생략하고 현재 제출물로 진행(리포트 표시).

## 11. 종료 · 리포트 (`finalize.ts`)

누락 검증 — 전부 집합 연산:

| 항목 | 계산 |
|---|---|
| 설명 안 된 예외 | `chain.types − observations[explained=true]가 가리키는 예외` |
| 안 읽은 용의 파일 | `suspects.path − callLog[file_read ∪ git_blame].path` |
| 미해결 관측 | 최종 judge attempt의 `unexplained` |

### 11.1 입력과 함수

```ts
// finalize.ts
interface FinalizeInput {
  plan: LogPlan;                    // runs/<id>/plan.json
  input: string;                    // runs/<id>/input.log
  submission: LogSubmission;        // 채택된 제출물 (pass / terminal 최고점 / 강제 수락 / 부분)
  judgments: LogJudgments;          // attempts[], rejected[], skipped?: string
  session: { toolCalls: number; maxToolCalls: number; rounds: number; forcedNote?: string; partial?: boolean };
}
interface FinalizeResult { gaps: Gaps; reportPath: string }
interface Gaps { unexplainedExceptions: string[]; unreadSuspects: string[]; unresolvedObservations: string[] }

export function computeGaps(plan, submission, judgments, callLog): Gaps          // 순수, §11 표
export function renderLogReport(i: FinalizeInput, gaps: Gaps, lang: "ko"|"en", now: Date): string   // 순수 → md 문자열
export function reportPath(cwd: string, cfg: LogConfig, runId: string): string   // <output>/log-<runId>.md
export async function finalizeRun(runId: string, cwd: string): Promise<string>   // 위 셋 조합 + 디스크 쓰기 + finalize.json → 오케스트레이터 응답
```

- 파일명은 `log-<runId>.md`. runId(`<stamp>-<rand>`)가 이미 유일하므로 f-review의 같은 초 충돌 처리(`backupReportDir`)가 필요 없다. 기존 파일은 절대 덮어쓰지 않는다.
- `output`이 `/`로 끝나거나 디렉터리면 그 안에, 아니면 그 경로 그대로(f-review `resolveOutputPath`와 같은 규칙, 이름만 다름).
- 언어: `lang`은 `log.language ?? review.language ?? "ko"`. 섹션 제목·고정 문구는 `LABELS[lang]` 표 하나로 두고, 모델이 쓴 본문(원인·해결안)은 그대로 싣는다. analyst 프롬프트가 `languageInstructionFor(lang)`(review 재사용)으로 같은 언어를 요구한다.
- `renderLogReport`는 **순수 함수**라 테스트는 문자열 스냅샷 + 섹션 존재 검사로 한다.

### 11.2 리포트 섹션 → 데이터

| # | 섹션 | 데이터 | 비고 |
|---|---|---|---|
| 0 | 헤더 | runId, 생성 시각, 대상 저장소(`cwd` basename), 상태 배지 | 배지: `PASS` / `REWORK n/m` / `TERMINAL` / `FORCED` / `PARTIAL` / `JUDGE SKIPPED` |
| 1 | 요약 | `submission.cause.summary`, `confidence`, `envCause`, `resolution.kind` | `envCause`면 "환경 원인 가능 — 코드 수정 전 설정·인프라 확인" 한 줄 |
| 2 | 스택 원문 | `input` | 코드 블록. 6,000자 넘으면 root-cause 블록 + 첫 40줄 + "… (N줄 생략, runs/<id>/input.log)" |
| 3 | 진입점 → 원인 경로 | `plan.entry`, root-cause 블록의 in-app 프레임 순서, `submission.cause.file/line` | `Controller.method(File:L)` → … → **원인 프레임** 굵게. 스택 없으면 `svcId`/`uri`에서 찾은 파일 목록 |
| 4 | 원인 상세와 근거 | `cause.mechanism`, `evidence[]` | 근거마다 `path:s-e` 링크 + `fileRead(cwd, null, path, s, e)`로 실제 코드 인용(각 ≤ 30줄) — 모델이 적은 줄 번호가 실제 코드와 대조되도록 |
| 5 | 해결 방안 | `resolution.summary`, `resolution.changes[]` | `kind: mitigation`이면 "원인 제거가 아닌 증상 완화" 경고 |
| 6 | 검토한 대안 | `submission.alternatives[]` + `judgments.rejected[]` | 기각 가설은 라운드·심사 feedback과 함께 |
| 7 | 못 본 것 | `gaps` 세 목록 | 비어 있으면 "누락 없음". 있으면 "다시 돌릴지는 읽는 사람이 정한다"(상위 문서 1.4) |
| 8 | 심사 이력 | `judgments.attempts[]` | 라운드별 3축 점수·합·verdict·unexplained. `skipped`면 사유 |
| 9 | 실행 정보 | `session` | 툴 호출 `n/max`, 라운드 수, `forcedNote`, `partial`, 적용된 룰 파일명, 주입된 KB 경로, runs 디렉터리 경로 |

### 11.3 상태 처리

| 상황 | `submission` 선택 | 배지 | 표시 |
|---|---|---|---|
| 심사 pass | 그 제출물 | PASS | — |
| rework 상한 초과 | `attempts` 중 최고 합 점수의 제출물 | TERMINAL | 8절에 "임계값 미달, 최고점 채택" |
| `MAX_FAILED_SUBMITS` 초과 강제 수락 | 마지막 유효 파싱 제출물(없으면 빈 제출물) | FORCED | `forcedNote` 사유. 빈 제출물이면 1·4·5절은 "제출 없음" |
| idle 감시 초과(부분) | 저장된 부분 제출물 또는 없음 | PARTIAL | 9절에 "분석 미완 — 모델이 중단" |
| 심사 malformed 상한 초과 | 현재 제출물 | JUDGE SKIPPED | 8절에 사유 |
| `--judge` 꺼짐 | 첫 제출물 | (배지 없음) | 8절 "심사 안 함" |

### 11.4 `f_log_finalize` 응답

오케스트레이터가 사용자에게 그대로 보여줄 수 있는 짧은 텍스트:
```
✅ f-log finished — <배지>
Report: .fico/report/f-log/log-<runId>.md
Cause: <cause.summary 한 줄> (confidence <n>)
Gaps: <unexplained k> / <unread k> / <unresolved k>   ← 0/0/0이면 "none"
```
두 번째 호출은 저장된 `finalize.json`을 읽어 같은 응답을 돌려준다(no-op 패턴 → 가드 #8 대상).

**v1은 markdown만** — review `html.ts`는 findings 전용(심각도 탭·필터)이라 재사용 불가하고, f-log 전용 HTML은 요청이 있을 때 만든다.

## 12. 산출물 · 설정

`.fico/config/fico_ai.json`:
```json
{
  "review": { "frameworkKb": { … }, "language": "ko" },
  "log": {
    "output":  ".fico/report/f-log/",
    "runsDir": ".fico/f-log/runs/",
    "rulesDir": "log/rules",
    "judgeThreshold": 70,
    "judgeRounds": 2,
    "contextMaxChars": 40000
  }
}
```
- `loadLogConfig(cwd)` = `loadConfig(cwd)`(review 평탄화) 위에 `raw.log` 덮어쓰기. `frameworkKb`·`language`·`maxToolCalls`·`maxIter`는 review 값을 상속. `log` 섹션이 없으면 위 기본값.
- 디스크 (덮어쓰지 않고 누적, rotation 없음):
```
.fico/report/f-log/log-<stamp>.md
.fico/f-log/runs/<stamp>-<rand>/
  input.log  plan.json  context-<n>.md  submission-<n>.json  judgments.json  finalize.json
```

## 13. 가드 공용화

f-review 방어 14개를 같은 상수·같은 의미로 적용한다.

**추출**
```ts
// src/core/guard.ts
export interface GuardState {
  active: boolean; cwd: string; scope: string;            // scope: review=현재 파일, log=runId
  maxToolCalls: number; toolCalls: number; explorationCalls: number;
  explorationSealed: boolean; toolBudgetExhausted: boolean; graceCalls: number;
  iterations: number; maxIter?: number;
  dupCalls: Record<string, number>; missStreak: number;
  callLog: Record<string, Record<string, number>>;
}
export function guardExploration(st: GuardState, tool: string, out: string, args?: unknown): string
export const MAX_DUP_CALLS = 2, MAX_MISS_STREAK = 4, MISS_PREFIXES = […]
```
`ReviewState`는 이 인터페이스를 구조적으로 만족한다(`scope`는 `currentFile(st)`를 getter로). `loop.ts`는 `guard.ts`를 re-export해 기존 import 경로와 테스트가 그대로 돈다.

**등록제**
```ts
// repeat-guard.ts
export function registerGuardModule(m: {
  lookup: (sessionID: string) => GuardState | undefined;
  submitTool: string;                       // 항상 허용
  explorers: ReadonlySet<string>;           // 예산 합산 대상
  idempotentPatterns: Record<string, RegExp>;
  submitAdvice: string;                     // "call f_log_submit now" 문구
}): void
```
`getState` 직접 호출 → 등록된 모듈 중 `lookup`이 active 상태를 돌려주는 것을 쓴다. review는 `review/index.ts`에서, log는 `log/index.ts`에서 각 1회 등록. `opencode/index.ts`는 무변경. 기존 `repeat-guard` 테스트가 무수정 통과해야 한다(회귀 증명).

**매핑**

| # | 장치 | f-log |
|---|---|---|
| 1 | 세션 총량 `maxToolCalls` + 예약 2슬롯 + 유예 3 → abort | 동일, submitTool = `f_log_submit` |
| 2–4 | `maxIter`, `MAX_DUP_CALLS`, `MAX_MISS_STREAK` | `guardExploration` 공용 |
| 5–6 | 연속 반복·교대 루프 | explorers = 7개 툴 |
| 7 | 네이티브 read/grep/glob 합산 | `guardNativeCall` 공용 |
| 8 | no-op 응답 억제 | `f_log_submit`/`f_log_judge`/`f_log_plan`/`f_log_context` 응답 문구 |
| 9–10 | `MAX_FAILED_SUBMITS`, submitToken | §10 |
| 11 | judge 상한 | §10 |
| 12 | idle 감시 `MAX_RESUMES` | `session.idle` → 재촉, 초과 시 부분 제출물 저장 → finalize가 "분석 미완" 표시 |
| 13 | steps | analyst `2×maxToolCalls`, judge `6` (review 상수 import) |
| 14 | 출력 크기 | `read.ts` 상수 |

## 14. OpenCode 배선

| 항목 | 값 |
|---|---|
| 커맨드 `/f-log` | `$ARGUMENTS` = 로그 원문 또는 `--file=path`; `--output=`; `--judge`(기본은 설정). 템플릿: `f_log_plan` → analyst 스폰 → judge 스폰 → rework면 analyst 재스폰 → `f_log_finalize` |
| `f-log-analyst` | permission: `*: deny` + `f_log_context`, `file_read`, `file_find`, `code_search`, `related_code`, `git_history`, `find_callers`, `git_blame`, `f_log_submit` allow. steps `2×maxToolCalls` |
| `f-log-judge` | `f_log_judge_context`, `f_log_judge`. steps 6 |
| system.transform | 없음 (컨텍스트는 툴 응답으로 전달) |
| event | `session.idle` 감시 |

## 15. 테스트 (bun test, `__tests__/`)

| 파일 | 검증 |
|---|---|
| `parse.test.ts` | §5 픽스처 전부: 체인 순서, omitted 복원, 접미 4종, 프록시/람다 정규화, nested exception, 줄머리, 핸들러 추출, 여러 줄 메시지 |
| `plan.test.ts` | 임시 git 레포에 `.java`·Controller 심어 분류·순위·entry·observations·스택 없는 입력의 svcId/errorCode 선탐색 |
| `rules.test.ts` | frontmatter 3키, AND 게이트, 특이도 정렬, reference 강등, 번들 14개 로드 |
| `context.test.ts` | 예산 절단 순서, 2번 불가침, rework 라운드 축약 |
| `submit.test.ts` / `judge.test.ts` | 스키마 거부, observations 누락 거부, evidence↔callLog, 토큰 회전, 강제 수락, threshold, rework 상한, rejected 누적, invalid 심사 상한 |
| `finalize.test.ts` | `computeGaps` 세 집합 차집합; `renderLogReport` 스냅샷 + 9개 섹션 존재 + ko/en 라벨; §11.3 여섯 상태별 배지·문구; `reportPath` 디렉터리/파일 규칙; `finalizeRun` 두 번 호출 시 같은 응답·파일 미덮어쓰기 |
| `tools.test.ts` | `find_callers` 상한, `git_blame` 출력 |
| `guard` | 기존 `repeat-guard` 테스트 무수정 통과 + f-log 등록 후 동일 시나리오 |
| 어댑터 | 모듈 등록·에이전트/커맨드 주입 스모크 |

## 16. 상위 문서와 다른 점

| 상위 문서 | 이 스펙 | 이유 |
|---|---|---|
| "판정 엔진은 `pipeline/judge.ts` 재사용" | f-log 자체 70줄 | §2 재사용 경계 |
| 산출물 경로 미지정 | `.fico/` + `fico_ai.json log` | 사용자 요청 |
| 룰 언급 없음 | §7 룰 계층 | 사용자 요청 |
| 컨텍스트 예산 언급 없음 | §8 | 소형 모델 |

## 17. 참고

조사 근거: [Rollbar Java stack trace](https://rollbar.com/blog/java-stack-trace/), [Bug localization from crash reports (2024)](https://arxiv.org/html/2403.10753v1), [Fault localization families](https://arxiv.org/pdf/1803.09939), [Sentry in-app frames](https://docs.sentry.io/platforms/java/configuration/options/), [Sentry suspect commits](https://blog.sentry.io/suspect-commits-via-git-blame), [Datadog suspect commits](https://docs.datadoghq.com/error_tracking/suspect_commits/), [SWE-agent (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf), [PRAXIS](https://arxiv.org/pdf/2512.22113), [Spring NestedExceptionUtils](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/core/NestedExceptionUtils.html).

프레임워크 확인 소스 (`/Users/koscom/workspace/fico/`): `fico-fwk-core` `CommonException`, `DynamicDatabaseKey/DynamicDataSource/DynamicDataSourceContextHolder`, `MyBatisPagingInterceptor/PagingSqlHelper`, `RefreshableSqlSessionFactoryBean`, `RequestScopeUtils`, `RetryableRestTemplate`, `kafka/runnable/DefaultKafkaConsumerRunnable`; `fico-fwk-extension` `aspect/CommonControllerAdvice`, `DynamicDataSourceAspect`, `ControllerAspect`, `CommonHeaderAspect`, `message/DBMessageSource`, `MessageMapper.xml`(COM_MSG), `module/RestCallModule`, `TrControlModule`, `config/RedisConfig`; `framework-site-ext` `exception/*`, `aspect/PBGlobalExceptionAdvice`, `PBExceptionHandlerAspect`, `PBTransactionAspect`, `PBJournalLogAspect`, `utils/PBCommonUtils`, `PBHeaderUtils`, `converter/PBFixedDataConverter`, `model/fixed/PBFixedHeader`; `fico-fwk-batch` `BaseJob/BaseTasklet/DefaultStepListener`; 앱 `on-stk-ord`(`log4j2-spring.xml`, `application*.yml`, `SONAQ001Controller`, `.fico/config/fico_ai.json`); 실 로그 `fico-app-example/logs/local_8090.log`; 위키 `fico-wiki/{fico-fwk-core,fico-fwk-extension,framework-site-ext}`; 스킬 `fico-ai/skills/pb-fixed-online-code/docs/*.md`.
