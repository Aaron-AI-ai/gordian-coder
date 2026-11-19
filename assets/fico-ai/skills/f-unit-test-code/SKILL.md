---
name: f-unit-test-code
description: 'Generates JUnit 5 + Mockito unit tests (@SpringBootTest, @Transactional) for existing FICO Java classes (Controller, Service, and Mapper (MyBatis) tests against the test-profile DB) from their code, then verifies the test build and JaCoCo line/branch coverage. TRIGGER when user asks to create unit tests for existing code in Korean or English (e.g. 단위 테스트 만들어줘, XXXX 프로그램 단위 테스트 생성해줘, Mapper 테스트 만들어줘, 변경분 테스트 보완해줘, generate unit tests for this class). Uses the real DB only for MyBatis Mapper tests; everything else is mocked. DO NOT TRIGGER for requirement-based test design, end-to-end tests against real Redis or external services, or non-Java code.'
---

# f-unit-test-code

Reads finished Java code and generates unit tests for it. Controller and Service tests mock every bean dependency on other modules, Mappers, Redis and external APIs. The Mapper test is the one exception: the MyBatis Mapper under test is a real bean that runs against the DB of the chosen test profile inside a rolled-back test transaction (`@Transactional`, or `@Transactional("<transactionManager>")` for a non-primary datasource); everything else is mocked.
This skill does NOT modify production code or the project's build files.

### Input (one of)
- `--files <path...>`: test the given Java classes
- `--program <ID>`: find the Controller/Service (and In/Out VO) whose class name starts with the program ID (e.g. `SONAQ001`) and test them
- no argument: test the git changes (working tree + staged vs HEAD; last commit if clean). When a test already exists, add cases for the changed methods; an existing test that the change breaks is updated only with the user's approval (see rule 4).
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
4. **CRITICAL - Existing tests:** never delete, rename or `@Disabled` an existing test. Add cases and imports. An existing test that this code change breaks (its expected value no longer matches the changed code) may be updated, but only when the plan lists it in `update_existing` with the reason and new expected value and the user approves the plan; change only its expected values (and the input if the change requires it). Leave every other existing test exactly as it was, including old-format ones. If the change might be a regression rather than intended, say so in the plan and let the user decide.
5. Do not touch production code or `build.gradle`.
6. Read only inside the project. Never search or read outside it (for example `~/.gradle/caches`, `~/.m2`, or jar contents): such calls are auto-rejected and stop the run. To find out which logging backend or library a project uses, read `build.gradle` and the project sources (imports, `logback*.xml`, `log4j2*.xml`, `application*.yml`); if that does not settle it, do not assert on log output and test the observable behavior instead (return value, exception, mock interaction), and say so in the plan note.

### 3. Verify
1. Read `docs/f-unit-test-verification-rule.md` and run its self-check list.
2. Run the coverage script; it writes `status.json`, `jacoco.xml`, `test-results/` and `gradle.log` into the output directory. Both scripts take the same arguments and write the same files.
   - macOS/Linux: `sh scripts/run-coverage.sh --module <gradle module> --tests <comma separated FQCNs> --out <dir>`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-coverage.ps1 -Module <gradle module> -Tests <comma separated FQCNs> -Out <dir>` (forward slashes in paths). Its execution is not verified in the development environment.

| `run-coverage.sh` | `run-coverage.ps1` | Meaning |
|---|---|---|
| `--module` | `-Module` | Gradle module (`a`, `a/b`, `:a:b` or `a:b`) |
| `--tests` | `-Tests` | Test class FQCNs, comma separated |
| `--out` | `-Out` | Output directory (stale results are removed first) |
| `--project` (optional) | `-Project` (optional) | Project root, default the current directory |

   - The script runs Gradle offline first (`--offline`, from the Gradle cache) and retries online only when the offline run failed on dependency resolution or on javac errors in `src/main/java`, never for javac errors in `src/test/java`. Gradle trusts a cached changing module (SNAPSHOT) for 24 hours, so the online retry only picks up a newer SNAPSHOT once the cache entry is older than that; never add `--refresh-dependencies` (it re-resolves everything and triggers repository rate limits); the last line of `gradle.log` names the mode used.
   - A dependency/network failure (e.g. `Could not resolve`, `status code 429` from Nexus) is an environment problem: report it to the user and stop. Never "fix" it in test code.

3. Fix compile errors. Fill coverage gaps by adding cases (at most 3 rounds). Mapper targets are not JaCoCo-measured; every method the Mapper declares must be called in its test (`<MapperName>Test.java`). Report unreachable branches with a reason; do not fix failing tests.
