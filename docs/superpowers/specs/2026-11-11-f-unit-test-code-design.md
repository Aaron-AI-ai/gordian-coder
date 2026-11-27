# /f-unit-test-code: 완성된 Java 코드의 단위 테스트 생성 스킬

2026-11-11

## 의도

`/pb-online-code`가 만든(또는 사람이 짠) Java 코드를 **읽고** 단위 테스트를 만든다. 요구사항에서
테스트를 뽑는 기능은 별도로 만들 예정이며 이 문서의 범위가 아니다. 이 기능은 "이미 있는 코드 →
테스트" 방향만 다룬다.

목표는 대상 클래스의 라인·분기 커버리지를 최대한 100%에 가깝게 채우고, 생성한 테스트 코드 자체에
버그(컴파일 오류, 단언 없는 테스트, 안 맞는 mock 등)가 없게 하는 것이다.

**이름:** 코드 기반은 `/f-unit-test-code`. (요구사항 기반 `/f-unit-test-req`는 2026-11-27에 제거했다.)
테스트 형식 규칙(`@SpringBootTest`, `@Transactional`, `@BeforeEach`/`@AfterEach`, 케이스 구성)과 템플릿은 두 명령이
공유하도록 코드 기반 전용 내용과 분리해서 둔다. 리포트 경로와 워크플로우 코드(`src/core/f-unit-test/`)도 공용이다.

## 목표 / 비목표 / 반(反)목표

**목표**
- 대상 Java 클래스마다 테스트 클래스를 만든다(기존 테스트가 있으면 변경분만 보완한다).
- 생성된 테스트가 컴파일되고, JaCoCo로 대상 클래스의 라인·분기 커버리지를 측정해 보고한다.
- 빈 곳이 있으면 테스트를 보강해 다시 측정한다(상한 있는 반복).

**비목표**
- 요구사항 기반 테스트 생성.
- 실제 DB·Redis·외부 서비스에 붙는 통합 테스트. 접속은 전부 mock이고 `--mock` 옵션은 없다.
- 테스트의 **통과 여부**. 실패하는 테스트는 보고만 하고 고치려 들지 않는다.
- bsm 같은 다른 모듈의 클래스 테스트(Service가 호출하는 BSM은 mock 대상일 뿐이다).

**반목표(기술적으로 동작해도 실패)**
- 단언이 없거나 `assertNotNull`만 있는 테스트로 커버리지 숫자만 채우는 것.
- 사용자 프로젝트의 `build.gradle` 등 빌드 파일을 수정하는 것.
- 실제 DB/Redis를 건드리는 테스트.

## 사용자가 정한 것

### 입력

| 인자 | 동작 |
|---|---|
| `--files <경로...>` | 지정한 Java 클래스의 테스트를 생성한다. |
| (git 변경분) | 최근 수정된 영역에 대해 기존 테스트를 보완한다. |
| `--program <ID>` | 프로그램 ID(예: `SONAQ001`)로 시작하는 Controller, Service(필요 시 In/Out VO)를 찾아 테스트를 생성한다. |

- 프로그램 ID는 `on-stk-ord-online`에서 `SONAQ001Controller`, `SONAQ001Service`,
  `SONAQ001In/Out`처럼 클래스 이름 접두어로 나타난다.
- Service가 쓰는 BSM(예: `AccountBSM`)과 Mapper는 테스트 대상이 아니라 mock 대상이다.

### 테스트 형식

- `@SpringBootTest` 기반, `@Transactional` 필수.
- 각 테스트 클래스에 `@BeforeEach`와 `@AfterEach` 필수(테스트마다 독립 실행).
- 메서드마다 케이스는 **정상 2건, 경계값(boundary), 예외**를 기본으로 한다.
- **외부 모듈이나 외부 자원을 호출하는 것은 전부 mock이다**(사용자 확정). 나머지는 mock하지 않는다.
  - 다른 모듈의 클래스: BSM(`AccountBSM` 등), common-*, 프레임워크 jar의 서비스·유틸 중 외부 자원에 닿는 것
  - MyBatis Mapper(DB)
  - Redis → fico 프레임워크의 Redis 모듈 클래스
  - 외부 API·외부 서비스 클라이언트
  - 같은 모듈 안에서 위 외부 자원에 닿지 않는 협력 클래스(예: Controller가 부르는 같은 모듈 Service,
    순수 변환·검증 유틸)는 **실제 객체**를 쓴다. 즉 Controller 테스트에서는 Service가 실제로 돌고 그 아래
    BSM·Mapper가 mock이다(내 해석, 확인 필요).
  - mock 어노테이션은 `@MockitoBean`(Spring Boot 3.4 미만이면 `@MockBean`).
- 테스트 프로필: 프로젝트에 이미 있는 테스트 프로필이 있으면 그걸 쓴다. 없으면 DataSource를
  H2 인메모리로 둔 최소 프로필을 만든다(`@SpringBootTest` 컨텍스트와 `@Transactional`에 트랜잭션
  매니저가 필요하기 때문).
- 위치와 이름: 소스와 같은 패키지 구조로 `src/test/java`에 `<클래스명>Test`(예: `SONAQ001ServiceTest`).

### 워크플로우 (플러그인이 단계를 관리한다)

`/pb-online-code`처럼 OpenCode 플러그인이 세 단계를 순서대로 강제한다. 앞 단계가 끝나기 전에는
다음 단계의 도구(파일 쓰기 등)를 막는다.

1. **계획(plan):** 어떤 대상 파일(클래스)에 단위 테스트를 만들지 확정하고, 대상별 **테스트 케이스를
   정의**한다(메서드별 정상 2건, 경계값, 예외와 mock 대상). 이 계획이 제출되기 전에는 테스트 코드를
   쓸 수 없다.
2. **실행(execute):** 계획에 따라 스킬의 규칙과 템플릿으로 테스트 코드를 구현한다.
3. **검증(verify):** 두 항목을 확인한다. ① 테스트 코드 빌드(컴파일) 성공 여부, ② 대상 클래스의
   JaCoCo 커버리지. 테스트 통과 여부는 검증 항목이 아니다. 커버리지가 모자라면 실행 단계로 돌아가
   보강한다.

세부(단계 게이트의 구체 규칙, 계획 제출 형식)는 `pb-online`의 `workflow.ts`·`pb-online.ts`를 따른다.

### 구현 방식

- **스킬 + 플러그인 워크플로우.** `/pb-online-code`처럼 규칙, 템플릿(예제 코드), 스크립트를 스킬 폴더에
  담고, OpenCode 프로젝트 환경에 함께 설치되도록 `gdc fico-init`/`fico-check`를 확장한다.
  스킬을 먼저 구현하고, 그 위에 플러그인 워크플로우(위 세 단계)를 얹는다.
- 슬래시 명령(`/f-unit-test-code`)은 플러그인이 등록하고, 호출하면 세션을 시작해 계획 단계로 들어간다.

## 내가 정한 것 (확인 필요)

- 슬래시 이름 `/f-unit-test-code`, 스킬 폴더 `assets/fico-ai/skills/f-unit-test-code/`.
  구조는 `pb-fixed-online-code`(SKILL.md + docs + templates)를 따른다.
- 인자 없이 호출하면 git 변경분(작업트리 + 스테이징을 HEAD와 비교, 변경이 없으면 마지막 커밋)을
  대상으로 한다. 변경된 메서드만 기존 테스트에 보완한다.
- "모든 커버리지"는 라인과 분기 100% 지향으로 해석한다. 도달 불가능한 분기(방어 코드 등)는 억지로
  채우지 않고 사유와 함께 보고한다.
- **JaCoCo는 번들한다.** Nexus에 없으므로 `jacocoagent.jar`(약 0.3MB)와 `jacococli.jar`(nodeps, 약 1MB)
  0.8.12 이상(Java 21)을 스킬 폴더 `tools/`에 넣는다(EPL-2.0, 재배포 가능, 라이선스 고지 포함).
  `build.gradle`은 건드리지 않고 Gradle init 스크립트(`-I`)로 테스트 JVM에 `-javaagent`를 붙인다.
- 커버리지 리포트는 기존 관례대로 `.fico/report/f-unit-test/report-*/`에 쓴다.
- 보강 반복은 최대 3회로 제한한다.

## 검토 후 추가로 정한 것 (내 판단, 확인 필요)

- **H2:** `on-stk-ord`는 online, bsm(testRuntimeOnly), daemon, batch 모듈에 H2가 이미 있다. 따라서 H2가 클래스패스에
  있으면 H2 프로필을 쓰고, 없으면 DataSource 자동 설정을 제외한 최소 프로필로 대체한다(H2 jar는 번들하지 않는다).
- **Spring Boot 3.4.12 기준:** `@MockBean`은 3.4에서 deprecated이므로 `@MockitoBean`을 쓴다. 대상 프로젝트의
  Spring Boot 버전은 계획 단계에서 `build.gradle`로 확인한다. 3.4 미만이면 `@MockBean`.
- **검증 게이트:** 빌드(컴파일) 실패는 **차단**한다(컴파일이 되어야 다음으로 간다). 커버리지 미달은 **차단하지 않는다**.
  보강 3회 뒤에도 빈 곳이 있으면 남은 라인·분기와 사유를 리포트에 적고 완료 처리한다. 컴파일 오류 재시도는
  보강 3회에 포함하지 않는다.
- **테스트 실패와 커버리지:** init 스크립트가 테스트 태스크에 `ignoreFailures = true`를 걸어 JaCoCo `.exec`가
  항상 생기게 한다. 실패한 테스트는 리포트에 별도 목록으로 적되 커버리지 계산에서 빼지 않는다.
- **범위:** OpenCode 전용(Claude Code, Cline 제외). 계획은 두 마일스톤: ① 스킬(규칙, 템플릿, JaCoCo 번들,
  `fico-init`/`fico-check` 확장) ② 플러그인 워크플로우.
- **git 변경분 모드:** 기존 테스트가 있으면 **덮어쓰지 않고 변경 메서드의 케이스만 추가**한다. 형식 규칙(@BeforeEach 등)이
  빠져 있으면 계획 단계에서 보고만 하고 고치지 않는다. 변경 메서드는 `git diff` 헝크의 줄 범위를 메서드 범위에
  대응시킨다(모델이 수행, 스크립트 불필요).

## 빌더에게 맡기는 것

- 스킬의 규칙 문서 분할, 템플릿 종류(Controller, Service, 기타 클래스), 스크립트 언어(sh 또는 Bun).
- Controller 테스트 방식(`MockMvc` 등)과 fico `CommonRequest<T>` 처리: 실제 프로젝트 코드를 보고 정한다.
- fico Redis 모듈의 실제 클래스·메서드 이름과 외부 API 클라이언트 유형 식별 방법.
- 생성 테스트의 자기 점검 목록 구체화(아래 "자기 점검" 참고).
- `SKILL_NAME` 단일 상수를 스킬 목록으로 일반화하는 방식(`fico-setup.ts`).
- 워크플로우 코드 구조(`src/core/f-unit-test/`와 어댑터 배선)와 계획 제출 형식, 단계별 게이트 규칙.
  `pb-online`을 재사용할 수 있는 부분(세션 상태, 게이트)은 복사하지 말고 공유한다.
- Gradle 멀티모듈에서 대상 모듈과 테스트 태스크를 찾는 방법.

## 자기 점검 (생성 후 모델이 스스로 확인할 항목)

반드시 포함할 것(구체 문구는 빌더가 정한다).
- 모든 테스트 메서드에 의미 있는 단언이 있는가(상태 또는 반환값 + `verify`).
- 정상 2건이 서로 다른 입력/경로를 타는가.
- 경계값이 실제 코드의 비교 연산자(`<`, `<=`, 길이·크기 제한)에서 도출되었는가.
- 예외 테스트가 코드에 실제로 있는 예외 타입을 기대하는가.
- mock 스텁이 호출 인자와 맞는가(사용되지 않는 스텁, 널 반환으로 인한 NPE).
- `@BeforeEach`/`@AfterEach`/`@Transactional`이 모두 있는가, 테스트 간 상태 공유가 없는가.
- 컴파일에 필요한 import와 VO 필수 필드를 놓치지 않았는가.

## 제약

- Java 21, Gradle 멀티모듈, Spring Boot, MyBatis, Oracle/PostgreSQL/H2, fico 프레임워크.
- 폐쇄망: 외부 다운로드 없이 동작해야 한다(JaCoCo 번들의 이유).
- 사용자 프로젝트의 빌드 파일을 수정하지 않는다.

## 참고 (확인한 코드)

- 대상 프로젝트: `~/workspace/fico/on-stk-ord`. 루트 `build.gradle`에 `spring-boot-starter-test`,
  JUnit Platform, Checkstyle, `ver-test-engine`(ArchUnit)이 있고 JaCoCo는 없다.
- `on-stk-ord-online/src/test/resources`에는 `ver-rules.yml`만 있고 테스트 프로필은 없다.
- 이 저장소의 설치 경로: `src/adapters/opencode/fico-setup.ts`가 `assets/fico-ai/skills/<SKILL_NAME>`을
  `.opencode/skills/`에 복사하고 `fico-check`가 누락·변경을 점검한다. `SKILL_NAME`은
  `src/core/pb-online/names.ts`의 단일 상수다.
