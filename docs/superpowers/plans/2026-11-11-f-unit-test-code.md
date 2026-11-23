# /f-unit-test-code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/f-unit-test-code`로 완성된 Java 코드의 단위 테스트를 만들고, 플러그인이 계획 → 실행 → 검증 단계를 강제하며 JaCoCo 커버리지와 테스트 빌드를 직접 확인한다.

**Architecture:** 도메인 지식(규칙, 템플릿, JaCoCo 번들, 커버리지 스크립트)은 표준 SKILL.md 폴더 `f-unit-test-code`에 두고 `gdc fico-init/fico-check`가 설치·점검한다. OpenCode 플러그인 모듈은 `pb-online`처럼 단계 게이트만 맡고, 검증 단계에서는 모델의 주장 대신 스크립트가 남긴 `status.json`, `jacoco.xml`, 테스트 결과 XML을 직접 읽어 판정한다.

**Tech Stack:** Bun + TypeScript(strict), `bun:test`, Gradle(init 스크립트), JaCoCo 0.8.12 (agent `-runtime`, cli `-nodeps`), POSIX sh.

**Spec:** `docs/superpowers/specs/2026-11-11-f-unit-test-code-design.md`

## Global Constraints

- 슬래시 `/f-unit-test-code`, 스킬 폴더 `assets/fico-ai/skills/f-unit-test-code/`, 워크플로우 코드 `src/core/f-unit-test/`, 리포트 `.fico/report/f-unit-test/report-*/` (스펙 그대로).
- OpenCode 전용. 사용자 프로젝트의 `build.gradle` 등 빌드 파일을 수정하지 않는다(Gradle init 스크립트 `-I`만 사용).
- 폐쇄망: 런타임에 외부 다운로드 없음. JaCoCo 0.8.12 이상, Java 21, EPL-2.0 고지 포함.
- 테스트 형식: `@SpringBootTest` + `@Transactional` + `@BeforeEach` + `@AfterEach`; 메서드마다 정상 2건, 경계값, 예외. 외부 모듈·외부 자원 호출은 전부 mock(`@MockitoBean`, Spring Boot 3.4 미만이면 `@MockBean`), 같은 모듈의 순수 협력 클래스는 실제 객체.
- 테스트 위치/이름: 소스와 같은 패키지 구조의 `src/test/java/.../<클래스명>Test.java`.
- 검증 게이트: 컴파일 실패(와 정적 점검 결함)는 차단, 커버리지 미달은 차단하지 않음. 커버리지 보강 최대 3회(`MAX_COVERAGE_ROUNDS`), 컴파일·결함 재시도는 별도 상한(`MAX_FIX_RETRIES = 5`, 내 판단). 테스트 실패는 검증 항목이 아니며 리포트에만 적는다.
- 기존 테스트 파일은 덮어쓰지 않고 케이스만 추가한다.
- 모든 TS는 strict, 공개 API는 명시적 타입. 문자열 경로는 `/`로 정규화(Windows 백슬래시 대응).

## Review Focus

스펙이 암시하지만 어떤 태스크의 테스트도 직접 다루지 않을 수 있는, 사용자에게 가장 먼저 문제가 될 입력/조건. 각 항목은 해당 태스크에 테스트로 고정한다.

1. **이전 실행의 오래된 `status.json`/`jacoco.xml`**: 검증 단계 진입 이후에 만들어진 파일이 아니면 거부한다 (Task 7).
2. **분기가 없는 클래스, 또는 JaCoCo XML에 아예 없는 소스 파일**: `BRANCH` 카운터 부재와 sourcefile 부재는 크래시가 아니라 "공백"으로 처리한다 (Task 5, 7).
3. **Windows 백슬래시 경로**로 들어온 target/files: 정규화해서 매칭한다 (Task 7).
4. **git 변경분 모드에서 기존 테스트 메서드가 사라지는 편집**: 계획 시점에 기존 `@Test` 메서드 이름을 저장해 두고 검증에서 줄어들면 결함으로 돌려보낸다 (Task 6, 7).
5. **존재하지 않는 모듈/대상 파일, 비-테스트 경로를 files로 제출**: 계획 단계에서 거부한다 (Task 7).

---

## Milestone 1: 스킬

### Task 1: 설치/점검을 스킬 목록으로 일반화

**Files:**
- Modify: `src/core/pb-online/names.ts`
- Modify: `src/adapters/opencode/fico-setup.ts` (`expectedSkillFiles`, `skillDrift`, `installSkill`, `checkFico`)
- Test: `src/adapters/opencode/__tests__/fico-setup.test.ts`

**Interfaces:**
- Produces: `names.ts`에 `UNIT_TEST_SKILL_NAME = "f-unit-test-code"`, `SKILL_NAMES: readonly string[] = [SKILL_NAME, UNIT_TEST_SKILL_NAME]`. `skillDrift(assets, skillsDir): string[]`는 항목을 `"<skill>/<상대경로>"`로 반환(전 스킬 대상). `installSkill(assets, skillsDir): string`은 모든 스킬을 설치하고 `skillsDir`을 반환. `checkFico`의 `skill`/`skill-loaded` 결과 이름은 유지하되 모든 스킬을 본다.
- Consumes: 기존 시그니처(`cline/cli.ts`가 `skillDrift`, `installSkill`, `installedSkillsDir`를 호출하므로 반환 타입 `string[]`/`string` 유지).

- [ ] **Step 1: 실패하는 테스트.** 테스트 `beforeEach`의 assets에 `f-unit-test-code/SKILL.md`를 추가하고 다음을 쓴다.
  - `skillDrift lists every skill's missing files`: 아무것도 설치 안 한 상태에서 결과가 `"pb-fixed-online-code/SKILL.md"`와 `"f-unit-test-code/SKILL.md"`를 포함.
  - `installSkill installs every listed skill and not the other vendored ones`: 설치 후 두 스킬의 `SKILL.md` 존재, `sql-query-gen`은 없음, `skillDrift`가 `[]`.
  - `checkFico reports skill-loaded false naming the skill OpenCode did not list`: `debug skill` 출력에 pb 스킬만 있으면 `skill-loaded.ok === false`이고 detail에 `f-unit-test-code`가 있음.
  - 기존 테스트 중 drift 문자열이나 설치 경로를 가정한 것은 새 형식(`<skill>/`)으로 고친다.
- [ ] **Step 2: 실행해 실패 확인.** Run: `bun test src/adapters/opencode/__tests__/fico-setup.test.ts` / Expected: 새 테스트 FAIL.
- [ ] **Step 3: 구현.** `expectedSkillFiles(assets, skill: string)`로 스킬 인자를 받게 하고(`rules/`는 스킬마다 `rules/<f>`로 복사하는 기존 동작 유지), 나머지 함수는 `SKILL_NAMES`를 순회한다. 스킬 폴더가 assets에 없으면 `skillDrift`가 그 스킬의 파일 없음이 아니라 `"<skill>/(shipped skill missing)"` 한 항목을 돌려준다.
- [ ] **Step 4: 통과 확인.** Run: `bun test src/adapters/opencode && bun run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Install and check every shipped FICO skill, not just the pb-online one"`

### Task 2: 스킬 본문 (SKILL.md, 규칙, 템플릿)

**Files:**
- Create: `assets/fico-ai/skills/f-unit-test-code/SKILL.md`
- Create: `assets/fico-ai/skills/f-unit-test-code/docs/f-unit-test-format-rule.md`
- Create: `assets/fico-ai/skills/f-unit-test-code/docs/f-unit-test-case-rule.md`
- Create: `assets/fico-ai/skills/f-unit-test-code/docs/f-unit-test-verification-rule.md`
- Create: `assets/fico-ai/skills/f-unit-test-code/templates/ServiceTestTemplate.java`
- Create: `assets/fico-ai/skills/f-unit-test-code/templates/ControllerTestTemplate.java`
- Test: `src/adapters/opencode/__tests__/f-unit-test-assets.test.ts`

**Interfaces:**
- Produces: 스킬 이름 `f-unit-test-code`(프런트매터 `name`과 폴더명 일치), 문서 3개와 템플릿 2개의 위치(위 경로). 템플릿 플레이스홀더는 `{PackagePath}`, `{ClassName}`, `{TargetClass}` 형식(workflow의 미치환 검사가 이 형식을 본다).

- [ ] **Step 1: 실패하는 테스트.** `f-unit-test-assets.test.ts`에서 `resolveAssetsDir()` 기준으로 다음을 확인한다.
  - `SKILL.md` 프런트매터 `name`이 `f-unit-test-code`이고 `description`이 비어 있지 않다.
  - 두 템플릿 모두 `@SpringBootTest`, `@Transactional`, `@BeforeEach`, `@AfterEach`, `@MockitoBean`을 포함하고, 정상 2건·경계값·예외에 해당하는 `@Test` 메서드 이름 접미사(`_normal1`, `_normal2`, `_boundary`, `_exception`)가 있다.
  - 세 문서가 존재하고 `format-rule`은 "외부 모듈", "프로필", "@MockBean"을 언급한다.
- [ ] **Step 2: 실행해 실패 확인.** Run: `bun test src/adapters/opencode/__tests__/f-unit-test-assets.test.ts` / Expected: FAIL (파일 없음).
- [ ] **Step 3: 작성.** 내용 결정 사항만 적는다(문장은 작성자가 쓴다).
  - `SKILL.md`: 트리거(한국어 "단위 테스트 만들어줘" 등), 입력 3종(`--files`, `--program`, git 변경분), 단계(계획 → 구현 → 검증), 세 문서와 두 템플릿을 언제 읽는지, `scripts/run-coverage.sh` 호출법, pb-fixed-online-code와 같은 구성.
  - `format-rule`: 스펙의 "테스트 형식" 절 전부 — 어노테이션 4종, mock 대상 목록(외부 모듈 클래스, Mapper, fico Redis 모듈, 외부 API 클라이언트)과 실제 객체로 두는 것, 테스트 프로필 규칙(기존 `application-test.*`나 `@ActiveProfiles` 사용 테스트가 있으면 그것을 쓴다 → 없으면 H2가 클래스패스에 있을 때 H2 인메모리 `application-test.yml`을 만든다 → H2도 없으면 DataSource 자동 설정을 제외하고 `PlatformTransactionManager`를 `@MockitoBean`으로 둔다), Spring Boot 버전 확인 방법(루트 `build.gradle`의 `spring-boot-gradle-plugin` 버전 → 3.4 미만이면 `@MockBean`), 위치와 이름.
  - `case-rule`: 메서드별 정상 2건(서로 다른 입력/경로), 경계값(코드의 `<`,`<=`,`==`, 길이/크기 제한, null/빈 값에서 도출), 예외(코드의 `throw`/`PBOnlineException` 경로와 mock이 던지는 예외). Controller는 Service 실제 객체로 요청 → 응답 검증. 건너뛸 수 있는 경우와 `skip_reason` 작성법(getter, 분기 없는 위임).
  - `verification-rule`: 스펙의 "자기 점검" 7항목, 커버리지 공백이 났을 때 라인/분기별 보강 방법, 도달 불가능한 분기를 `note`에 사유와 함께 적는 법, 테스트 실패는 고치지 않는다는 것.
  - 템플릿 2개: 위 테스트가 요구하는 요소를 모두 갖춘 완결된 예제 파일(주석에 각 요소의 의미).
- [ ] **Step 4: 통과 확인.** Run: `bun test src/adapters/opencode/__tests__/f-unit-test-assets.test.ts` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Add the f-unit-test-code skill: rules and example test templates"`

### Task 3: JaCoCo 번들과 커버리지 스크립트

**Files:**
- Create: `assets/fico-ai/skills/f-unit-test-code/tools/jacocoagent.jar`, `tools/jacococli.jar`, `tools/NOTICE.md`
- Create: `assets/fico-ai/skills/f-unit-test-code/scripts/init.gradle`
- Create: `assets/fico-ai/skills/f-unit-test-code/scripts/run-coverage.sh`
- Test: `src/adapters/opencode/__tests__/f-unit-test-assets.test.ts`에 추가, `src/core/f-unit-test/__tests__/run-coverage.test.ts`

**Interfaces:**
- Produces(스크립트 계약, Task 5·7이 읽는다): `run-coverage.sh --module <gradle모듈명> --tests <테스트클래스FQCN,...> --out <디렉터리> [--project <루트>]`.
  `--out` 아래에 다음을 남긴다.
  - `status.json`: `{"compile":"ok"|"fail","log":"<마지막 40줄>","coverage":"ok"|"missing"}`
  - `jacoco.exec`, `jacoco.xml` (JaCoCo cli 리포트, classfiles는 `<module>/build/classes/java/main`, sourcefiles는 `<module>/src/main/java`)
  - `test-results/*.xml` (`<module>/build/test-results/test/`의 복사본)
  스크립트는 컴파일 실패여도 종료 코드 0으로 끝내고 `status.json`에 사실을 남긴다.
- Produces: `init.gradle`은 `-Pfut.agent=<jar> -Pfut.exec=<file> -Pfut.tests=<콤마목록>`을 받아 모든 `Test` 태스크에 `-javaagent:<jar>=destfile=<exec>,append=false`, `ignoreFailures = true`, 지정 테스트만 실행(`failOnNoMatchingTests = false`)을 건다.

- [ ] **Step 1: JaCoCo 받기.** 이 개발 머신(인터넷 가능)에서 한 번만 받아 커밋한다. Run:
  ```bash
  cd assets/fico-ai/skills/f-unit-test-code && mkdir -p tools scripts
  V=0.8.12; B=https://repo1.maven.org/maven2/org/jacoco
  curl -fLo tools/jacocoagent.jar $B/org.jacoco.agent/$V/org.jacoco.agent-$V-runtime.jar
  curl -fLo tools/jacococli.jar  $B/org.jacoco.cli/$V/org.jacoco.cli-$V-nodeps.jar
  for p in "org.jacoco.agent/$V/org.jacoco.agent-$V-runtime" "org.jacoco.cli/$V/org.jacoco.cli-$V-nodeps"; do curl -fL $B/$p.jar.sha1; echo; done
  shasum tools/*.jar
  ```
  Expected: 두 SHA-1이 Maven Central 값과 일치. `unzip -p tools/jacocoagent.jar META-INF/MANIFEST.MF | grep Premain-Class`가 `org.jacoco.agent.rt.internal_*.PreMain`을 출력. `NOTICE.md`에 JaCoCo 0.8.12, EPL-2.0, 출처 URL, SHA-1을 적는다.
- [ ] **Step 2: 실패하는 테스트.**
  - `f-unit-test-assets.test.ts`: 두 jar가 `PK` 매직으로 시작하고 각각 100KB 이상, `NOTICE.md`에 `EPL-2.0` 포함.
  - `run-coverage.test.ts`(임시 프로젝트 디렉터리에 가짜 `gradlew` 셸 스크립트를 만들어 사용): ① `gradlew`가 `testClasses`에서 종료 코드 1이면 `status.json.compile === "fail"`이고 `log`에 가짜 출력이 있으며 스크립트 종료 코드는 0, ② `testClasses`가 성공하고 `test`도 성공하지만 `jacoco.exec`가 생기지 않으면 `compile === "ok"`, `coverage === "missing"`, ③ `sh -n run-coverage.sh` 문법 검사 통과, ④ `--module` 누락 시 종료 코드 2와 사용법 출력.
- [ ] **Step 3: 구현.** `run-coverage.sh`: 인자 파싱 → `./gradlew :<module>:testClasses -I init.gradle` → 실패 시 `status.json` 기록 후 종료 → `./gradlew :<module>:test --continue -I init.gradle -Pfut.*` → `jacoco.exec` 있으면 `java -jar jacococli.jar report ... --xml` → 테스트 결과 복사 → `status.json`. `gradlew`가 없으면 `gradle`, 둘 다 없으면 `compile:"fail"`과 사유를 기록. 스크립트 위치 기준으로 `tools/`를 찾는다(설치 위치에 의존하지 않음).
- [ ] **Step 4: 통과 확인.** Run: `bun test src/core/f-unit-test/__tests__/run-coverage.test.ts src/adapters/opencode/__tests__/f-unit-test-assets.test.ts` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Bundle JaCoCo 0.8.12 and add the coverage script that leaves its facts in status.json and jacoco.xml"`

---

## Milestone 2: 플러그인 워크플로우

### Task 4: 계획 대기 게이트를 공용으로 분리

**Files:**
- Create: `src/core/plan-gate.ts`
- Modify: `src/core/pb-online/workflow.ts` (`awaitingReply`, `noteUserMessage`, `takeAbortRequest`, `MAX_WAIT_CALLS`)
- Test: `src/core/__tests__/plan-gate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_WAIT_CALLS = 3;
  export interface PlanGateState { stage: string; planAt?: number; userRepliedAt?: number; awaitingCalls: number }
  export function awaitingReply(s: PlanGateState): boolean;        // stage==="plan" && planAt set && no newer user reply
  export function noteReply(s: PlanGateState, createdAt: number): void; // userRepliedAt = max(...), awaitingCalls = 0
  export function takeAbort(s: PlanGateState): boolean;            // true once when awaitingCalls >= MAX_WAIT_CALLS, then resets to 0
  ```
- Consumes: `PbSession`이 `PlanGateState`를 만족한다(필드명 동일). `workflow.ts`의 기존 export(`MAX_WAIT_CALLS` 포함)와 동작은 그대로.

- [ ] **Step 1: 실패하는 테스트.** `plan-gate.test.ts`: ① 계획 전에는 `awaitingReply === false`, ② `planAt=10`, `userRepliedAt` 없음 → true, ③ `noteReply(s, 11)` 후 false, ④ 더 오래된 `createdAt`(5)로 `noteReply`해도 `userRepliedAt`이 줄지 않음, ⑤ `awaitingCalls = 3`이면 `takeAbort`가 true 한 번, 다음 호출은 false.
- [ ] **Step 2: 실패 확인.** Run: `bun test src/core/__tests__/plan-gate.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현.** 위 세 함수를 `plan-gate.ts`로 옮기고 `workflow.ts`는 이를 import해 기존 `noteUserMessage`/`takeAbortRequest`/`awaitingReply` 본문을 위임 호출로 바꾼다. `MAX_WAIT_CALLS`는 `workflow.ts`에서 re-export.
- [ ] **Step 4: 회귀 확인.** Run: `bun test src/core src/adapters/opencode && bun run typecheck` / Expected: 기존 pb-online 테스트 포함 전부 PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Share the plan wait gate between workflows"`

### Task 5: JaCoCo XML과 테스트 결과 읽기

**Files:**
- Create: `src/core/f-unit-test/coverage.ts`
- Test: `src/core/f-unit-test/__tests__/coverage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Counter { missed: number; covered: number }
  export interface FileCoverage { target: string; line: Counter; branch: Counter; uncoveredLines: number[]; partialLines: number[] }
  /** target = 프로젝트 상대 경로 (…/src/main/java/a/b/C.java). 소스 파일이 XML에 없으면 null. */
  export function readCoverage(xml: string, target: string): FileCoverage | null;
  /** `<failure`/`<error`가 있는 testcase를 "Class.method"로. */
  export function readFailedTests(resultsDir: string): string[];
  export function isFullyCovered(c: FileCoverage | null): boolean; // null이면 false
  ```
- 규칙: 패키지는 `src/main/java/` 뒤 경로의 디렉터리 부분(`a/b`), 소스 파일명은 `C.java`. `uncoveredLines`는 `ci==0 && mi>0`인 줄 번호, `partialLines`는 `mb>0`인 줄 번호. `BRANCH` 카운터가 없으면 `{missed:0, covered:0}`.

- [ ] **Step 1: 실패하는 테스트.** 작은 JaCoCo XML 문자열(패키지 `kr/co/x/service`, sourcefile `SvcA.java`에 줄 10(mi=0,ci=3), 줄 11(mi=2,ci=0), 줄 12(mi=1,ci=2,mb=1,cb=1), 카운터 `LINE missed=1 covered=2`, `BRANCH missed=1 covered=1`)로:
  - `readCoverage(xml, "mod/src/main/java/kr/co/x/service/SvcA.java")` → `line {1,2}`, `branch {1,1}`, `uncoveredLines [11]`, `partialLines [12]`.
  - 분기 카운터가 없는 sourcefile → `branch {0,0}`.
  - 같은 패키지의 다른 sourcefile만 있으면 `null`, `isFullyCovered(null) === false`.
  - 경로가 백슬래시(`mod\\src\\main\\java\\kr\\co\\x\\service\\SvcA.java`)여도 같은 결과.
  - `readFailedTests`: 임시 디렉터리에 한 개는 `<failure>`, 한 개는 `<error>`, 한 개는 통과인 `TEST-*.xml` → 앞의 둘만 `Class.method`로 반환. 디렉터리가 없으면 `[]`.
- [ ] **Step 2: 실패 확인.** Run: `bun test src/core/f-unit-test/__tests__/coverage.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현.** 정규식으로 `<package name=...>` → `<sourcefile name=...>` 블록을 자른다 // ponytail: XML 파서 의존성 없이 JaCoCo의 고정된 출력 형식만 읽는다.
- [ ] **Step 4: 통과 확인.** Run: `bun test src/core/f-unit-test/__tests__/coverage.test.ts && bun run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Read JaCoCo XML coverage and failed tests for the unit-test workflow"`

### Task 6: 생성된 테스트 소스의 정적 점검

**Files:**
- Create: `src/core/f-unit-test/test-check.ts`
- Test: `src/core/f-unit-test/__tests__/test-check.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function testMethodNames(source: string): string[];            // @Test/@ParameterizedTest/@RepeatedTest 다음 메서드 이름
  export function checkTestSource(source: string, opts: { mocks: string[]; previousMethods?: string[] }): string[]; // 결함 메시지 목록
  ```
- 결함 규칙(메시지는 한국어): ① `@SpringBootTest`, `@Transactional`, `@BeforeEach`, `@AfterEach` 중 빠진 것 ② `@Test` 메서드 중 단언이 없는 것(`assert*`, `verify(`, `assertThrows`, `fail(` 어느 것도 없음)이나 `assertNotNull`/`assertTrue(true)`만 있는 것 ③ `@Disabled` 존재 ④ `opts.mocks`의 클래스 단순명이 소스에 없거나 `@MockitoBean`/`@MockBean`이 하나도 없음 ⑤ `previousMethods`에 있던 메서드 이름이 사라짐 ⑥ 템플릿 플레이스홀더 `\{[A-Z][A-Za-z]+\}` 잔존.

- [ ] **Step 1: 실패하는 테스트.** 정상 템플릿형 소스 한 개를 만들어 `[]`을 확인하고, 각 규칙마다 한 군데만 깨뜨린 소스로 해당 메시지가 정확히 하나 나오는지 확인한다(예: `@AfterEach` 제거 → 메시지에 `@AfterEach` 포함, 단언 없는 `@Test` 추가 → 그 메서드 이름 포함, `previousMethods: ["old_case"]`인데 소스에 없음 → `old_case` 포함, `{ClassName}` 잔존). `testMethodNames`는 `@Test void a()`, `@Test\n public void b()` 둘 다 잡는다.
- [ ] **Step 2: 실패 확인.** Run: `bun test src/core/f-unit-test/__tests__/test-check.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현.** `@Test` 위치부터 다음 `@Test`/`@BeforeEach`/`@AfterEach`/파일 끝까지를 그 메서드 본문으로 본다 // ponytail: 정규식 기반이라 중첩 클래스의 드문 형태는 놓칠 수 있다. 오탐보다 미탐을 택한다.
- [ ] **Step 4: 통과 확인.** Run: `bun test src/core/f-unit-test/__tests__/test-check.test.ts && bun run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Add the static check that catches empty, disabled and missing-annotation tests"`

### Task 7: 워크플로우 (단계, 게이트, 판정)

**Files:**
- Create: `src/core/f-unit-test/workflow.ts`
- Test: `src/core/f-unit-test/__tests__/workflow.test.ts`

**Interfaces:**
- Consumes: Task 4 `PlanGateState` 함수들, Task 5 `readCoverage`/`readFailedTests`/`isFullyCovered`/`FileCoverage`, Task 6 `testMethodNames`/`checkTestSource`, `../time`의 `localFileStamp`, `../pb-online/names`의 `UNIT_TEST_SKILL_NAME`.
- Produces(어댑터가 쓴다):
  ```ts
  export const COMMAND_NAME = "f-unit-test-code"; STAGE_TOOL = "f_unit_test_stage";
  export const REPORT_DIR = ".fico/report/f-unit-test"; MAX_COVERAGE_ROUNDS = 3; MAX_FIX_RETRIES = 5;
  export type StageId = "plan" | "execute" | "verify" | "report";
  export interface CaseDef { target: string; method: string; normal: string[]; boundary: string[]; exception: string[]; mocks: string[]; skip_reason?: string }
  export interface PlanInputs { mode: "files" | "program" | "git"; module: string; targets: string[]; files: string[]; cases: CaseDef[] }
  export interface StageInput { stage: StageId; note?: string; inputs?: Partial<PlanInputs>; user_approved?: boolean }
  export function startSession(sessionId: string, request: string, cwd: string): FutSession;
  export function getSession(id: string): FutSession | undefined;   export function endSession(id: string): void;
  export function noteUserMessage(id: string, createdAt: number): void;
  export function takeAbortRequest(id: string): boolean;
  export function renderStageGuide(stage: StageId, session?: FutSession): string;
  export function gateTool(id: string, tool: string, args: Record<string, unknown>): string | null;
  export function noteToolResult(id: string, tool: string, args?: Record<string, unknown>): void;
  export function completeStage(id: string, input: StageInput): string;
  export const COMMAND_DESCRIPTION: string; STAGE_TOOL_DESCRIPTION: string; COMMAND_TEMPLATE: string;
  ```
- 단계 규칙:
  - **plan** 도구: `skill, read, glob, grep, bash`. `bash`는 명령이 `^\s*git\s+(diff|status|log|show|rev-parse)\b`일 때만. 쓰기 도구(`edit, write, apply_patch, multiedit, patch`)는 plan·verify·report에서 차단하고, `task`는 모든 단계에서 차단한다(서브에이전트의 쓰기가 게이트를 피하지 못하게).
  - **plan 제출 검증**(모두 실패 시 `Rejected: ...`로 이유와 고칠 필드를 반환): `mode`가 셋 중 하나; `module` 디렉터리가 `cwd` 아래에 존재; `targets` 각각 존재하는 `.java` 파일이고 `/src/main/java/`를 포함; `files` 각각 `/src/test/`를 포함하고 `.java` 또는 `src/test/resources/` 아래 파일; `cases` 각 항목의 `target`이 `targets`에 있고, `skip_reason`이 없으면 `normal.length >= 2 && boundary.length >= 1 && exception.length >= 1`(공백 문자열은 제외하고 센다); 모든 target에 케이스가 최소 1개; 경로는 `\`→`/`로 정규화. 통과하면 계획 시점에 이미 존재하는 `files`의 `testMethodNames`를 `session.previousMethods`(파일별)로 저장한다. 이후는 pb-online과 같은 plan-gate(제출 → 사용자 답 대기 → `user_approved`).
  - **execute**: 쓰기는 `inputs.files`에 있는 경로만(`matchesPath` 의미: 정확히 같거나 `/`+경로로 끝남). `bash`는 `\bgradlew(\.bat)?\b|\bgradle\b` 또는 git 읽기 명령만. 진입 시 `session.runDir = REPORT_DIR/report-<localFileStamp()>` 설정(가이드에 `--out <runDir>`로 표시). 완료는 쓰기 성공이 1개 이상일 때.
  - **verify**: 쓰기 차단, `bash`는 명령에 `run-coverage.sh`가 들어 있을 때만. 진입 시각을 `session.verifyStartedAt`에 기록. `completeStage`는 `note` 필수(보강이 끝나도 남은 공백의 사유를 적는다) 후 판정: ① `<runDir>/status.json`이 없거나 mtime < `verifyStartedAt` → "Rejected: run run-coverage.sh first" ② `compile === "fail"` 또는 touched 테스트 파일의 `checkTestSource` 결함 → `fixRetries++`, 상한(`MAX_FIX_RETRIES`) 초과 시 `verification = "incomplete"`로 report, 아니면 결함 목록과 함께 execute ③ `jacoco.xml`이 없거나 mtime이 오래됨 → ①과 같은 거부 ④ 각 target의 `readCoverage`가 `isFullyCovered`가 아니면, `gapRounds < MAX_COVERAGE_ROUNDS`일 때 `gapRounds++` 후 줄/분기 공백 목록과 함께 execute, 아니면 공백을 남긴 채 `verification = "gaps"`로 report ⑤ 전부 채워졌으면 `"covered"`로 report. 테스트 실패는 `readFailedTests(<runDir>/test-results)`로 세션에 저장만 한다.
  - **report**: `note` 필수. `<runDir>/report.md`에 대상, target별 라인/분기 커버리지 표, 남은 공백(줄 번호), 실패한 테스트, 재시도 횟수, 계획, 요약을 쓰고 세션을 종료한다(별도 cleanup 단계 없음).

- [ ] **Step 1: 실패하는 테스트.** 임시 프로젝트 디렉터리(모듈 폴더, 대상 `.java`, 테스트 파일)를 만들어 다음을 검증한다. 테스트 헬퍼 `okPlan()`이 유효한 `PlanInputs`를 돌려준다.
  - plan: `plan rejects a case set without two normal, one boundary and one exception cases`, `plan accepts skip_reason instead of cases`, `plan rejects a module directory that does not exist`, `plan rejects files outside src/test`, `plan rejects a target that is not under src/main/java`, `plan normalizes backslash paths` (`\\` 입력이 `/`로 저장됨), `plan waits for the user: a reply is required before approval`(Task 4와 동일 흐름), `plan allows only read-only git in bash`.
  - execute: `execute refuses to write a file that is not in the plan`, `execute allows bash for gradle only`, `execute needs at least one written file to finish`.
  - verify: `verify refuses a status.json older than the stage entry`(파일 mtime을 과거로), `compile failure returns to execute and does not use a coverage round`, `fix retries over the cap end the run as incomplete`, `a lost existing test method is returned as a defect`(previousMethods에 있던 메서드를 지운 파일), `coverage gap returns to execute with uncovered lines up to three rounds then reports with gaps`, `a target missing from the jacoco xml counts as a gap, not a crash`, `full coverage reports as covered`, `failed tests are listed in the report but do not block`.
  - report: `report writes report.md with the coverage table and ends the session`.
- [ ] **Step 2: 실패 확인.** Run: `bun test src/core/f-unit-test/__tests__/workflow.test.ts` / Expected: FAIL (모듈 없음).
- [ ] **Step 3: 구현.** `pb-online/workflow.ts`의 세션 맵(최대 50), `gateTool`의 대기 게이트 분기, `advance`/`renderStageGuide` 구조를 따른다. 경로 비교와 `toRelative`는 새 파일에 필요한 만큼만 둔다(`pb-online`과 코드를 맞추려고 그쪽을 건드리지 않는다). 가이드에는 스킬 이름, 단계별 목표, `--out <runDir>`, 호출할 스크립트 인자(`--module`, `--tests` = `files` 중 `.java` 테스트 클래스의 FQCN)를 넣는다.
- [ ] **Step 4: 통과 확인.** Run: `bun test src/core/f-unit-test && bun run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Add the f-unit-test workflow: plan, execute and verify judged from JaCoCo and build facts"`

### Task 8: OpenCode 어댑터와 등록

**Files:**
- Create: `src/adapters/opencode/f-unit-test.ts`
- Modify: `src/adapters/opencode/modules.ts` (factories에 추가)
- Test: `src/adapters/opencode/__tests__/f-unit-test.test.ts`

**Interfaces:**
- Consumes: Task 7의 모든 export, `pb-online.ts`의 모듈 구조(`createPbOnlineModule`을 그대로 따른다).
- Produces: `export function createFUnitTestModule(input: PluginInput): OpenCodeModule` — 슬래시 `f-unit-test-code` 등록(`??=`로 사용자 정의 우선), `commandBefore`가 세션 시작, `toolBefore`가 `gateTool` 거부 시 throw, `toolAfter`가 `noteToolResult(sessionID, tool, args)`, 시스템 프롬프트에 가이드 추가, `message.updated`(user)로 `noteUserMessage`, 루프 방지 `session.abort`. 도구 `f_unit_test_stage`의 zod 인자는 `StageInput`과 같은 모양(`inputs.cases[]`는 `CaseDef`).

- [ ] **Step 1: 실패하는 테스트.** `pb-online.test.ts`의 구조를 따른다: ① 명령이 등록되고 사용자 정의 명령은 유지, ② 다른 명령(`f-review`, `f-log`, `pb-online-code`)은 세션을 시작하지 않음, ③ 슬래시가 해당 세션만 시작, ④ 게이트는 워크플로우 안에서만 throw, ⑤ 시스템 변환은 워크플로우 세션에만 가이드 추가, ⑥ 사용자 메시지 이벤트 후 `approved` 단계 진행, ⑦ 계획 대기 중 도구 호출을 반복하면 `abort`가 정확히 한 번 호출됨.
- [ ] **Step 2: 실패 확인.** Run: `bun test src/adapters/opencode/__tests__/f-unit-test.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현과 등록.** 위 인터페이스대로 작성하고 `modules.ts`의 `factories` 배열 끝에 추가한다. `toolAfter` 인자 `args`가 쓰기 대상 추적에 필요하다.
- [ ] **Step 4: 전체 확인.** Run: `bun test && bun run typecheck && bun run build` / Expected: 전부 PASS, 빌드 성공.
- [ ] **Step 5: 커밋.** `git add -A && git commit -m "Wire /f-unit-test-code into the OpenCode plugin"`

### Task 9: 실제 프로젝트 검증 (수동, Nexus 접근 필요)

**Files:** 없음 (확인 작업). 결과는 `docs/reports/f-unit-test-live-test-20261111.md`에 정리.

- [ ] **Step 1: 설치.** `~/workspace/fico/on-stk-ord`에서 `gdc fico-init` 후 `gdc fico-check` / Expected: `skill`, `skill-loaded`에 `f-unit-test-code` 포함, 모두 OK.
- [ ] **Step 2: JaCoCo 단독 확인.** 임시 JUnit 테스트 하나로 `run-coverage.sh --module on-stk-ord-online --tests <FQCN> --out /tmp/x`를 직접 실행 / Expected: `status.json`의 `compile:"ok"`, `jacoco.xml` 생성, 프로젝트의 `build.gradle`·`git status`는 변하지 않음(`build/`와 `.fico/`는 제외).
- [ ] **Step 3: 전체 흐름.** OpenCode에서 `/f-unit-test-code --program SONAQ001` 실행 / Expected: 계획에서 대상 3종(Controller, Service, VO)과 케이스 정의를 제출하고 승인 대기 → 구현 → 검증에서 커버리지 표가 `report.md`에 생김. 기존 테스트가 있는 파일의 메서드는 유지됨.
- [ ] **Step 4: 기록.** 발견한 문제(Checkstyle/ArchUnit 규칙과의 충돌, `@MockitoBean` 대상 오인, Redis 모듈 클래스 이름 등)를 리포트에 적고, 규칙 문서 수정이 필요하면 Task 2 문서에 반영해 커밋한다.
