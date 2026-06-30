---
description: Rule-based code review over a git commit, files, or package
agent: k-reviewer
---
Start a code review using the k-codereview tools.

Free-form arguments: $ARGUMENTS

Parse the arguments into `k_review_context` parameters (all optional):
- a bare ref (`HEAD`, `<sha>`) or range (`A..B`) → `commit`
- `--from=<ref>` / `--to=<ref>` → `from` / `to`
- `--files=a.ts,b.ts` → `files`
- `--package=src/foo` → `package`
- `--exclude=glob,glob` → `exclude`
- `--output=path` → `output`
- `--background=...` → `requirementBackground`
- `--plan=...` → `planGuidance`

If no arguments are given, call `k_review_context` with no commit/files/package — it reviews the latest commit.

After seeding, follow the injected review checklist. For EACH file:
1. Read the diff; pull missing context with `file_read` (wider lines), `code_search`
   (symbols/usages), `file_find` (locate files), `file_read_diff` (other changed files) — do not guess.
2. Assess every rubric category (security, nfr, correctness, tests).
3. Call `k_review_submit` with `assessed` (all categories you evaluated) and `findings` (issues, may be empty).

Keep going until `k_review_submit` reports the review is complete and gives the report path.
