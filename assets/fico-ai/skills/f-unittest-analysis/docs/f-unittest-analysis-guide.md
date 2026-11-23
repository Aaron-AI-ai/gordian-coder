# Failure guidance rule

Used when a run has a test failure. The plugin already wrote the report with every result, failing tests included — this console explanation is in addition to that, not instead of it. Korean, no code edits, no report of your own.

Per failed test, in this order:
1. **테스트**: `Class.method` and the failing line (`File.java:NN`).
2. **원인**: one sentence from the assertion message or exception, checked against the test code and the code it calls. Say what was expected and what happened.
3. **판단**: which side is wrong: the test (stale expectation, bad setup, missing mock) or the production code (a regression, a bug), or the environment (DB, config). Give the reason; do not guess when the code does not show it.
4. **수정 방법**: concrete: what to change, in which file and method, as text. Do not write the patch into a file.

Rules:
- Several failures with one root cause (for example the Spring context does not start) are explained once, listing the affected tests.
- A compile failure: quote the first error line, name the file, say how to fix it.
- Nothing ran: say why (no tests matched the selection, or the module has none) and how to select correctly.
- Never edit, create or delete a file, never rerun tests to "check a fix".
