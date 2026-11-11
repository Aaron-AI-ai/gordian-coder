---
name: git-workflow
description: "Use when establishing branching strategies, implementing Conventional Commits, handling merge conflicts git worktrees."
---

# Git Workflow Skill

Provides guidance for git workflows: branching strategies, commit message conventions, staging changes (add → commit → push), syncing with the latest code (pull/fetch), resolving merge conflicts, and merge operations.

## Critical Rules

1. **No direct push to main**\
2. **No squash unless user asked** — atomic commits preserved; keeps GPG signatures and bisection.
3. **Force-push only with `--force-with-lease`** — never plain `--force`.

## Reference Files

Load references on demand based on the task at hand:

| Reference | Content Triggers |
|-----------|-----------------|
| `references/branching-strategies.md` | Branching model, Git Flow, GitHub Flow, trunk-based, protected branches |
| `references/commit-conventions.md` | Commit messages, conventional commits, semantic versioning, commitlint |
| `references/advanced-git.md` | Rebase, cherry-pick, bisect, stash, worktrees, reflog, submodules, recovery |

## Conventional Commits

### 1. Commit Message Structure

A standard commit message has three parts — **subject**, **body**, and **footer** — separated by blank lines:

```
type(scope): subject   <-- subject

body                   <-- body

footer                 <-- footer
```

### 2. Types

The type tells reviewers the nature of the change at a glance.

| Type | Meaning |
|------|---------|
| `feat` | Add a new feature |
| `fix` | Fix a bug |
| `docs` | Documentation changes (README, wiki, etc.) |
| `style` | Formatting-only changes (whitespace, semicolons) with no semantic impact |
| `refactor` | Code restructuring or refactoring without feature change |
| `perf` | Performance-related code changes |
| `test` | Add or update tests |
| `chore` | Build tooling, package manager config, miscellaneous tasks |
| `ci` | CI configuration files and scripts |

**Breaking change**: add `!` after the type (e.g. `feat!:`) or include `BREAKING CHANGE:` in the footer.

### 3. Seven Rules for a Good Subject (Chris Beams)

The de-facto standard in the git community.

1. Separate subject from body with a blank line.
2. Limit the subject to 50 characters (72 max).
3. Capitalize the first letter of the subject.
4. Do not end the subject with a period.
5. Use the imperative mood (e.g. `Fix`, not `Fixed`; `Add`, not `Added`).
6. Wrap the body at 72 characters.
7. Use the body to explain **what** and **why** — the code itself shows **how**.

### 4. Body and Footer

**Body** — optional. Use it when the change is complex or needs a rationale. State the motivation and contrast with the previous behavior.

**Footer** — optional. Use it for:
- **Issue tracker IDs** to link the commit to an issue (e.g. `Closes #123`).
- **Breaking changes**: `BREAKING CHANGE: <description>` for significant API changes.

## Branch Naming

### 1. Structure and Rules

The widely-adopted standard format:

```
prefix/issue-number_short-description
```

Example: `feature/123-add-login-api`

**Key rules**
- **Lowercase only**: write everything in lowercase to avoid case-sensitivity errors.
- **Separators**: use a hyphen (`-`) or underscore (`_`) between words. Hyphens are generally preferred.
- **Prefix**: use a prefix to indicate the branch's purpose and keep names hierarchical.
- **Include the issue number**: referencing the issue number ties the branch to the tracker (GitLab, Jira, etc.).

### 2. Branch Prefixes

| Prefix | Purpose | Description |
|--------|---------|-------------|
| `feature/` | New feature | Developing a new feature |
| `bugfix/` | Bug fix | Fixing a general bug |
| `hotfix/` | Emergency fix | Immediate fix needed in a deployed production environment |
| `refactor/` | Refactoring | Improving code structure without changing behavior |
| `docs/` | Documentation | README, wiki, and other documentation work |
| `test/` | Test code | Adding or updating test cases |
| `chore/` | Miscellaneous | Build config, package manager config, and other incidental tasks |

