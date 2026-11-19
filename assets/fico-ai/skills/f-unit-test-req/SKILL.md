---
name: f-unit-test-req
description: 'Writes JUnit 5 + Mockito unit tests (@SpringBootTest, @Transactional) FIRST from requirements (TDD) for FICO Java classes whose production code is only a skeleton, then checks that the tests compile. TRIGGER when user asks to create tests from requirements before implementation in Korean or English (e.g. 요구사항으로 단위 테스트 먼저 만들어줘, TDD로 테스트부터, XXXX 프로그램 요구사항 기반 테스트 생성, write tests from this requirement first). DO NOT TRIGGER for tests of finished code (use f-unit-test-code), coverage measurement, or non-Java code.'
---

# f-unit-test-req

Test-first (TDD): reads the requirements and writes the unit tests before the production code exists. Format, mock and template rules are the same as `f-unit-test-code`; the cases come from the requirements, not from code. It only checks that the tests **compile**: it does not run them, does not measure coverage, and writes no report. A failing test against the skeleton is expected.
This skill does NOT modify production code or the project's build files, and does not look for conflicts with existing code.

### Input (one of, or combined)
- `--req-file <path>`: a file with the requirements (md/txt). Read it with the read tool.
- `--req "<text>"`: the requirements typed after the command.
- `--program <ID>`: a program ID. Read the program's I/O specification from the FICO MCP server (`fico://program-detail/{group_name}/{program_id}`; find the group in `fico://all-programs` when it is not given) and derive the cases from its input/output fields and description.
- The target classes must already exist as a **skeleton** (class and method signatures, empty or `UnsupportedOperationException` bodies, VOs) so the tests can compile. If a target does not exist, ask the user to create the skeleton first and stop; never create production code yourself.

## Steps

### 1. Plan the cases
1. Read the rules: `docs/f-unit-test-req-case-rule.md` and `docs/f-unit-test-format-rule.md`.
2. Read the requirements (per Input) and the skeleton classes. Split the requirements into items; list the classes, methods and external collaborators to mock, the Spring Boot version (root `build.gradle`) and the test profile situation.
3. For every target method decide the cases per requirement item (normal 2, boundary, exception). Methods you skip need a `skip_reason`.
4. If a required input is missing, ask the user and stop; never guess: no requirement given, a `--req-file` that does not exist, a `--program` the MCP cannot find, a missing skeleton class, an unclear Gradle module, a value the requirements do not give (error code, limit).

### 2. Implement with the templates
1. Pick the template (`templates/ServiceTestTemplate.java`, `ControllerTestTemplate.java`, `MapperTestTemplate.java`), replace the placeholders and example code with the target's own. No placeholder may remain.
2. Put the explanation in comments: class Javadoc with the requirement source, and the three-line `[요구사항] / [시나리오] / [기대]` comment above every `@Test` (see the case rule).
3. If a test file already exists, add cases only; never delete, rename, `@Disabled` or edit an existing test.
4. Do not touch production code or `build.gradle`. Read only inside the project.

### 3. Verify (build only)
1. Run the compile script; it writes `status.json` and `gradle.log` into the output directory.
   - macOS/Linux: `sh scripts/compile-tests.sh --module <gradle module> --out <dir>`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compile-tests.ps1 -Module <gradle module> -Out <dir>` (forward slashes in paths). Its execution is not verified in the development environment.
2. Fix compile errors in the tests. A dependency/network failure is an environment problem: report it and stop; never "fix" it in test code. Tests are never run and their results are not checked.

### 4. Tell the user
On the console, briefly list per test class which test cases were created (method names and what each verifies) and the requirement items they cover. The details are in the code comments. Do not write a report file.
