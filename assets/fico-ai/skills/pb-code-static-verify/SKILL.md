---
name: pb-code-static-verify
description: "Runs Checkstyle (`checkstyleMain`) and ArchUnit (`verifyArch`) static verification on a target Gradle subproject via bundled scripts, then reports pass/fail with violation details so the AI can fix issues before finishing. Project-agnostic — discovers subprojects from `settings.gradle` at runtime, so the same skill works on any Gradle multi-project build that exposes these tasks. TRIGGER automatically right after generating or modifying Java code (Controller, Service, VO, Mapper, repository, etc.) in a Gradle project, and TRIGGER on explicit user requests like '코드 검증해줘', 'checkstyle 돌려줘', 'archunit 검증해줘', 'verify the changes', 'static analysis 실행', 'lint the module'. DO NOT TRIGGER for documentation-only edits, gradle config tweaks, running unit tests, or commands that already include the gradlew invocation themselves."
---

# pb-code-static-verify

Runs **Checkstyle** and **ArchUnit** verification on a Gradle subproject and surfaces violations in a form the agent can act on.

The two checks complement each other:
- **Checkstyle** (`checkstyleMain`) — style/format/convention rules from the project's configured Checkstyle ruleset.
- **ArchUnit** (`verifyArch`) — architecture rules executed via JUnit (layer dependencies, package conventions, framework invariants, etc.).

This skill is **project-agnostic**. It does not assume any specific module names — the bundled scripts read `settings.gradle` at runtime to discover the available subprojects.

## When to use

- **After code generation/modification.** Once new Java code has been written or edited, run this skill before reporting completion. Catching style and architecture violations here is cheaper than catching them in CI.
- **On explicit user request.** Any phrasing that mentions checkstyle, archunit, lint, static analysis, or "검증" should land here.

## Prerequisites

The target Gradle build must:
- Expose a `gradlew` wrapper at the project root.
- Have its subprojects declared via standard `include` lines in `settings.gradle`.
- Configure `checkstyleMain` (the standard Checkstyle plugin task) and a `verifyArch` task (typical convention: a `Test` task wired to a JUnit engine that runs ArchUnit rules).

If a subproject is missing one of those tasks, that step will fail with Gradle's "Task not found" message — leave the other check running and report what was actually executed.

## How to run

The skill ships three scripts under `scripts/`. **Always invoke them via the bundled script** rather than calling `./gradlew` directly — the scripts handle subproject discovery and apply the right flags (`--rerun-tasks --console=plain` for ArchUnit, etc.) consistently.

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/run-checkstyle.sh` | Runs `./gradlew :<subproject>:checkstyleMain` | `run-checkstyle.sh [subproject]` |
| `scripts/run-archunit.sh`   | Runs `./gradlew :<subproject>:verifyArch --rerun-tasks --console=plain` | `run-archunit.sh [subproject]` |
| `scripts/run-verify.sh`     | Runs **both** for one or more subprojects with a combined summary. **Use this by default.** | `run-verify.sh [subproject ...]` |

## Discovering the target subproject

The agent should pick the subproject before invoking the scripts. There are three layers, in order of preference:

1. **Explicit knowledge.** When you (the agent) just generated or edited code, you know the file path. Derive the subproject from the path's first segment (e.g. an edit to `module-a/src/main/java/...` → subproject `module-a`). Pass it explicitly:
   ```bash
   .agents/skills/pb-code-static-verify/scripts/run-verify.sh module-a
   ```

2. **Auto-detection.** If you don't know (e.g. the user asked "verify my changes" without context), invoke the script with no argument. It reads `settings.gradle`, intersects the declared subprojects with paths from `git status -s`, and runs on each match. `run-verify.sh` accepts multiple matches; the single-task scripts require exactly one.

3. **Disambiguation.** If auto-detection finds multiple candidates and you want to verify only one (e.g. you only edited one of them and the others are unrelated changes), pass the right module explicitly. The script's error output lists all discovered subprojects to help.

For nested Gradle modules (`include ':foo:bar'`), use the filesystem path form: `foo/bar`. The script translates that back to `:foo:bar` when calling Gradle.

### Default workflow for the agent

1. From the project root, run the combined script. Use the explicit form when you know which module was changed:
   ```bash
   .agents/skills/pb-code-static-verify/scripts/run-verify.sh <subproject>
   ```
   Or, if you want it to figure out the targets from your edits:
   ```bash
   .agents/skills/pb-code-static-verify/scripts/run-verify.sh
   ```

2. Inspect the script's output and exit code:
   - **Exit 0** — both checks passed for every target. Report a one-line summary (`Checkstyle ✓ / ArchUnit ✓ on <subproject>`) and continue with the original task.
   - **Non-zero** — at least one check failed. The script prints the failing task name and the full violation excerpt:
     - Checkstyle prints `[ant:checkstyle] [ERROR] <file>:<line>: <rule>` lines and a path to the HTML report under `<subproject>/build/reports/checkstyle/`.
     - ArchUnit prints `Architecture Violation` blocks with rule descriptions and the offending classes.
   - For each violation: locate the file/line, propose a fix, apply it, then re-run the same script to confirm the issue is resolved. Repeat until clean.

3. Final report to the user: which subproject(s) ran, what passed, what was fixed, with the violation messages quoted when relevant.

## Why these flags

- **`--rerun-tasks` for ArchUnit** — Gradle's incremental cache will skip the verification when test classes are unchanged from the previous run. We want the rules to execute against the freshly compiled code on every invocation, otherwise a clean cache may mask new violations introduced by the latest edit.
- **`--console=plain`** — ArchUnit failure messages can be long and multi-line. The plain console keeps output linear and grep-friendly instead of overwriting lines with progress bars, which makes parsing and quoting much easier.

## Performance notes

- **First run cost:** Gradle daemon warm-up plus dependency resolution can make the first invocation slow (often 30–90s). Subsequent runs are typically under 10s.
- **No `--no-daemon`** is set, so the daemon stays warm across runs in the same shell session — leave it alone.
- **Reports** land under `<subproject>/build/reports/checkstyle/` and `<subproject>/build/test-results/`. Refer to those if the script's terminal output is truncated.

## What this skill does NOT do

- Does not modify code automatically. It runs the checks and reports; fixing is the agent's job.
- Does not run unit tests (`test` task). If the user asks for tests, do not use this skill.
- Does not run on the root project; tasks are per-subproject.
- Does not invent subproject names — if a project doesn't declare its modules with standard `include` lines, you'll need to pass the subproject path explicitly.
