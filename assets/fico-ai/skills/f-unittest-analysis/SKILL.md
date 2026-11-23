---
name: f-unittest-analysis
description: 'Runs the existing JUnit unit tests of a FICO Java module (all of them, or only the ones named) and publishes a report of the results, pass or fail. It never creates or edits test code or production code: on a fail it also explains the cause and the fix on the console. TRIGGER when user asks to run the unit tests and report the result in Korean or English (e.g. 단위 테스트 돌려서 결과 리포트 만들어줘, 이 테스트만 실행해줘, 단위 테스트 분석, run the unit tests and report). DO NOT TRIGGER for writing tests (use f-unit-test-code or f-unit-test-req) or non-Java code.'
---

# f-unittest-analysis

Runs the tests that already exist and reports. It does **not** write or change any test or production code. The report also shows overall line/branch coverage for the run (informational only — a low number never blocks the report or the pass verdict).

### Input
- `--test <spec>` (repeatable, or comma separated): run only these tests. A spec is a test class name (`PayServiceTest`), a test file path, or `Class#method` for one test method. **No input: every test of the module runs.**
- The module is found from the project (settings.gradle, where the tests are). Ask the user when it is unclear.

## Steps

### 1. Plan
1. Decide the Gradle module. Turn every `--test` spec into the test file under `src/test/java` (find it with glob) and, for `Class#method`, the method name; check the method exists in the file. If a spec matches no file or several, ask the user and stop.
2. Nothing is asked for approval: the plan only fixes what will run (module, selected tests or "all").

### 2. Execute
Call the stage tool with stage `execute` and wait; it can take a few minutes. The plugin itself builds the module and runs the selected tests with Gradle (offline first), the same on Windows and Linux/macOS. You run nothing in bash. A dependency/network failure is an environment problem: report it and stop.

### 3. Report
- **Tests ran** (whether all passed or some failed): the plugin writes the report (`.fico/report/f-unittest-analysis/report-<time>/report.md` and `report.html`) with the run input, overall coverage, the list of files run, and per-file/per-test results, every failing test marked and listed with its cause — the HTML lets you expand the file list and search the detail section by file name. Tell the user the report path and the pass/fail totals either way; on a fail, also read the failing test and the code it calls (read-only) and explain on the console, per failure: the cause, whether the test or the production code is wrong, and how to fix it (see `docs/f-unittest-analysis-guide.md`). Never fix it yourself. If every test was skipped, the verdict is SKIP, not a pass: say that nothing ran.
- **The tests do not compile, or nothing ran:** there is no test result to report, so write **no report and no file**. Explain the cause on the console the same way.
