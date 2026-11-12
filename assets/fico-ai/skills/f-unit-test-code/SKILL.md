---
name: f-unit-test-code
description: 'Generates JUnit 5 + Mockito unit tests (@SpringBootTest, @Transactional) for existing FICO Java classes (Controller, Service) from their code, then verifies the test build and JaCoCo line/branch coverage. TRIGGER when user asks to create unit tests for existing code in Korean or English (e.g. 단위 테스트 만들어줘, XXXX 프로그램 단위 테스트 생성해줘, 변경분 테스트 보완해줘, generate unit tests for this class). DO NOT TRIGGER for requirement-based test design, integration tests against a real DB/Redis, or non-Java code.'
---

# f-unit-test-code

Reads finished Java code and generates unit tests for it. Bean dependencies on other modules, Mappers, Redis and external APIs are all mocked; no real resource is touched. The Mapper test is the one exception: the MyBatis Mapper under test is real and runs against the test-profile DB, with every write rolled back by `@Transactional`.
This skill does NOT modify production code or the project's build files.

### Input (one of)
- `--files <path...>`: test the given Java classes
- `--program <ID>`: find the Controller/Service (and In/Out VO) whose class name starts with the program ID (e.g. `SONAQ001`) and test them
- no argument: test the git changes (working tree + staged vs HEAD; last commit if clean). When a test already exists, add cases for the changed methods only, never overwrite.
  - Find the changed methods by mapping the `git diff` hunk line ranges to each method's line range (do this yourself, no script).
  - If an existing test lacks the format rules (`@BeforeEach`, `@AfterEach`, `@Transactional`, ...), report it in the plan; do not fix it.

## Steps

### 1. Plan the cases
1. Read the rules:
   - `docs/f-unit-test-format-rule.md`
   - `docs/f-unit-test-case-rule.md`
2. Read each target class. List its public methods, the external collaborators to mock, and the Spring Boot version (root `build.gradle`) and test profile situation.
3. For every target class decide the cases per method (normal 2, boundary, exception) following the case rule. Methods you skip need a `skip_reason`.
4. If a required input is missing, ask the user and stop; never guess. That means: no target (no `--files`, no `--program`, and git shows no changed Java file), a `--program` ID that matches no Controller/Service class, a `--files` path that does not exist, a Gradle module that is unclear (targets in none or in several modules), case details you cannot derive from the code (for example which exception a branch should raise), or, for a Mapper target, a test profile that is unclear: the project has several (`test`, `test-oracle`, ...) and the request does not say which, or it has none (never invent an H2 profile). Put the chosen profile in the plan `note`.

### 2. Implement with the templates
1. Pick the template:

| Template | When to Use |
|----------|-------------|
| `templates/ServiceTestTemplate.java` | Service classes (BSM/Mapper/Redis mocked) |
| `templates/ControllerTestTemplate.java` | Controller classes (real Service, mocked BSM/Mapper/Redis) |
| `templates/MapperTestTemplate.java` | MyBatis Mapper interfaces (real Mapper bean, real test-profile DB, no mock, `UT_` seed rows) |

2. Replace the placeholders `{PackagePath}`, `{ClassName}`, `{TargetClass}` with real values, and replace the example imports, fields and methods with the target's own. No placeholder may remain.
3. Before creating a test file, check whether one already exists at the target path. If it does, add cases only.
4. **CRITICAL - Preserve existing tests:** never delete or overwrite existing test code; add cases and imports only.
5. Do not touch production code or `build.gradle`.

### 3. Verify
1. Read `docs/f-unit-test-verification-rule.md` and run its self-check list.
2. Run `scripts/run-coverage.sh --module <gradle module> --tests <comma separated FQCNs> --out <dir>`; it writes `status.json`, `jacoco.xml` and `test-results/` into `--out`. The verify step needs a POSIX shell (Git Bash or WSL on Windows); Windows execution of the coverage script is untested.
3. Fix compile errors. Fill coverage gaps by adding cases (at most 3 rounds). Mapper targets are not JaCoCo-measured; every method the Mapper declares must be called in its test (`<MapperName>Test.java`). Report unreachable branches with a reason; do not fix failing tests.
