---
description: Rule-based code review over a git commit or files
agent: f-reviewer
---
Start a code review using the f-review tools.

Free-form arguments: $ARGUMENTS

Parse the arguments into `f_review_context` parameters (all optional):
- a bare ref (`HEAD`, `<sha>`) or range (`A..B`) → `commit`
- `--from=<ref>` / `--to=<ref>` → `from` / `to`
- `--files=a.ts,b.ts` → `files`
- `--whole` → `whole` (review the full file content instead of just the diff)
- `--exclude=glob,glob` → `exclude`
- `--output=path` → `output`
- `--background=...` → `requirementBackground`
- `--plan=...` → `planGuidance`

If no arguments are given, call `f_review_context` with no commit/files — it reviews the latest commit.

After seeding, follow the injected review checklist. For EACH file:
1. Start from the automatically injected related-code and Git-history evidence.
   Inspect high-confidence dependencies, callers, tests, and co-changed files with
   `related_code`, `file_read`, `code_search`, and `file_read_diff` — do not guess.
2. When commit intent or regression risk is unclear, call `git_history` with
   `include_patch=true` and compare the historical behavior with the current diff.
3. Assess every rubric category (security, nfr, correctness, tests, framework).
4. Call `f_review_submit` with `assessed` (all categories you evaluated) and `findings` (issues, may be empty).

Keep going until `f_review_submit` reports the review is complete and gives the report path.
