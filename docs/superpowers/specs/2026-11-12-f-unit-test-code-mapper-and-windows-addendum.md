# /f-unit-test-code 추가: Mapper 테스트(실제 DB)와 Windows PowerShell

2026-11-12. `2026-11-11-f-unit-test-code-design.md`에 대한 추가 결정이다. 충돌하는 곳은 이 문서가 우선한다.

## A. MyBatis Mapper 테스트

사용자 결정: Mapper는 mock하지 않고 **실제 DB를 직접 조회**한다. 대신 `@Transactional`을 철저히 건다.

### 범위와 mock 규칙 변경
- 이전 결정("DB는 항상 mock, 실제 접속 없음")은 **Mapper 자체를 테스트할 때만** 예외다. Mapper 테스트는 Spring이 만든 실제 Mapper 빈으로 프로젝트의 테스트 프로필 DB(H2/Oracle/PostgreSQL 중 프로필이 가리키는 것)를 조회한다.
- Controller·Service 테스트에서는 Mapper를 지금처럼 `@MockitoBean`으로 mock한다(그쪽에서는 외부 자원이다). Redis, 외부 API, 다른 모듈 클래스도 변함없이 mock.
- 대상: `@Mapper` 인터페이스(또는 `mapper` 패키지의 `*Mapper.java`). `--files`로 직접 지정할 수 있다. `--program` 모드는 같은 Gradle 모듈 안에서 대상 Service가 쓰는 Mapper를 포함한다. 다른 모듈(예: bsm)의 Mapper는 `--files`로 지정해야 하고 그 모듈의 `src/test`에 만든다.
- 위치/이름: 소스와 같은 패키지의 `<MapperName>Test.java`. 어노테이션: `@SpringBootTest`, `@ActiveProfiles("<프로필>")`, `@Transactional`, `@BeforeEach`, `@AfterEach`.

### 트랜잭션 안전 규칙 (정적 점검 결함으로 강제)
- 테스트 클래스에 `@Transactional`이 있어야 하고, 아래는 **결함**: `@Commit`, `@Rollback(false)`, `@Rollback(value = false)`, `Propagation.NOT_SUPPORTED` / `REQUIRES_NEW` / `NEVER` / `SUPPORTS`. (`@Sql`로 DDL을 실행하는 것은 문서 규칙으로만 금지하고, 정적 점검은 위 어노테이션만 본다.)
- 쓰기 케이스(insert/update/delete)는 같은 테스트 안에서 Mapper로 다시 조회해 결과를 단언한다(롤백되므로 DB에 남지 않음).
- `@BeforeEach`는 테스트 데이터를 Mapper(또는 `@Sql`, 테스트 트랜잭션 안에서 실행)로 넣고, 키는 충돌을 피하도록 `UT_` 접두어 + 유일 값을 쓴다. `@AfterEach`는 트랜잭션 안에서 만든 행을 지우고 사라졌는지 확인한다(어차피 롤백되지만 규칙상 필수).
- 한 테스트에서 여러 DB 쓰기가 필요하면 하나의 `@Transactional` 안에서 처리한다(`REQUIRES_NEW`로 쪼개지 않는다).

### 테스트 프로필
- 프로젝트에 테스트 프로필이 하나면 그것을 쓴다. 여럿이면(예: `test`, `test-oracle`, `test-postgres`) **계획 단계에서 사용자에게 어느 프로필을 쓸지 묻고** 턴을 끝낸다. 하나도 없으면 사용자에게 묻는다(Mapper 테스트용으로 H2 프로필을 임의로 만들지 않는다. 스키마/Oracle SQL 호환성을 알 수 없다).
- 선택한 프로필 이름을 계획의 `note`에 적는다.

### 케이스 규칙 (Mapper 메서드마다)
- select: 정상 2건(서로 다른 키로 찾는 경우 / 목록·페이징 결과), 경계(결과 없음, 선택 파라미터 null, 페이징 첫/마지막 페이지), 예외(필수 파라미터 null 등으로 `DataAccessException` 계열).
- insert/update/delete: 정상 2건(영향 행 수 1 + 다시 조회해 값 확인 / 다른 컬럼 조합), 경계(최대 길이 값, 대상 없는 키의 update/delete가 0건), 예외(중복 키·NOT NULL 위반 → `DuplicateKeyException`/`DataIntegrityViolationException`).
- 예외 케이스는 `assertThrows`.

### 커버리지(검증) 처리
- Mapper 인터페이스는 JaCoCo가 잴 코드 줄이 없다(SQL은 XML에 있다). 따라서 Mapper 대상은 JaCoCo 커버리지 판정에서 **제외**하고, 대신 정적 점검: 인터페이스에 선언된 모든 메서드가 계획된 테스트 파일에서 `.<메서드>(`로 호출되어야 한다. 빠진 메서드는 결함(컴파일 결함처럼 execute로 되돌리고 재시도 `fixRetries`를 쓴다. 커버리지 라운드는 쓰지 않는다).
- 리포트에는 Mapper 대상을 "커버리지 측정 안 함(XML SQL 커버리지는 JaCoCo가 보지 않음)"으로 표시하고, 메서드별 호출 여부를 적는다.
- Mapper가 Mapper 인터페이스인지의 판정: 소스에 `interface`가 있고 (`@Mapper` 또는 파일명이 `Mapper.java`로 끝남).

## B. Windows PowerShell 지원

- `scripts/run-coverage.ps1`을 추가한다. 기능/출력은 `run-coverage.sh`와 동일(`status.json`, `jacoco.exec`, `jacoco.xml`, `test-results/`, `gradle.log`, 오래된 산출물 선삭제, `cleanTest` 후 `test`, 컴파일 실패 시에도 종료 코드 0, 인자 누락 시 종료 코드 2 + 사용법). 인자: `-Module`, `-Tests`, `-Out`, 선택 `-Project`.
- 같은 `init.gradle`을 쓴다(경로는 슬래시). Windows에서는 `gradlew.bat`, 그 외 `./gradlew`; `JAVA_HOME`이 있으면 그 `java`를 쓴다. JSON은 `ConvertTo-Json`으로 만들어 이스케이프 문제가 없게 한다. 로그는 UTF-8 안전하게 읽는다(깨진 바이트 허용).
- 플러그인:
  - verify 게이트는 두 형태 중 **정확히 일치**하는 명령만 허용한다. ① `(sh|bash) <경로>/run-coverage.sh --module M --tests T --out R` ② `(powershell|pwsh)` + 선택적 `-NoProfile`, 선택적 `-ExecutionPolicy Bypass`, `-File <경로>/run-coverage.ps1 -Module M -Tests T -Out R`. 경로 고정 규칙(프로젝트 `.opencode/skills/f-unit-test-code/scripts/…` 또는 홈 `~/.config/opencode/skills/…`, 슬래시, 공백 없음)은 두 형태 모두 동일. 백슬래시·따옴표 금지는 그대로(PowerShell도 슬래시 경로를 받는다).
  - execute의 gradle 허용 실행 파일에 `gradlew.bat`, `./gradlew.bat`를 추가한다.
  - 가이드(`renderStageGuide`)는 `process.platform === "win32"`이면 PowerShell 명령 한 줄을, 아니면 sh 명령을 출력한다. 가이드와 게이트는 같은 빌더를 계속 공유한다.
  - "POSIX 셸 필요(Git Bash/WSL)" 문구는 "Windows는 PowerShell 스크립트를 쓴다. 단 이 개발 환경에서는 PowerShell 실행을 검증하지 못했다"로 바꾼다.
- 한계(솔직히 문서화): 이 저장소를 개발한 macOS에는 PowerShell이 없어 `.ps1`은 실제 실행 검증을 못 한다. `pwsh`가 있으면 돌리는 테스트를 두고, 없으면 건너뛴다. Windows 실기 검증은 사용자 몫이다.
