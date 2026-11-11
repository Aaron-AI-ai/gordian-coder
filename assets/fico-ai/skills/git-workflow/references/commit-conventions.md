# Commit Conventions

## Conventional Commits

### Specification

A standard commit message has three parts — **subject**, **body**, and **footer** — separated by blank lines:

```
type(scope): subject   <-- subject

body                   <-- body

footer                 <-- footer
```

### Commit Types

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

### Examples

```bash
# Simple feature
feat: Add user authentication

# Feature with scope
feat(auth): Add OAuth2 login support

# Bug fix
fix: Resolve null pointer in user service

# Bug fix with issue reference
fix(api): Handle empty response from external service

Closes #123

# Breaking change
feat!: Remove deprecated v1 API endpoints

BREAKING CHANGE: The /api/v1/* endpoints have been removed.
Migrate to /api/v2/* before upgrading.
```

### Scope Guidelines

Scopes should be consistent across the project:

```bash
# By feature area
feat(auth): ...
feat(payment): ...
feat(notification): ...

# By layer
fix(api): ...
fix(db): ...
fix(ui): ...

# By component
style(button): ...
refactor(modal): ...
```

## Commit Message Best Practices

### Seven Rules for a Good Subject (Chris Beams)

The de-facto standard in the git community.

1. Separate subject from body with a blank line.
2. Limit the subject to 50 characters (72 max).
3. Capitalize the first letter of the subject.
4. Do not end the subject with a period.
5. Use the imperative mood (e.g. `Fix`, not `Fixed`; `Add`, not `Added`).
6. Wrap the body at 72 characters.
7. Use the body to explain **what** and **why** — the code itself shows **how**.

### Subject Line Examples

```bash
# ✅ Good: Imperative mood, capitalized, concise
feat: Add password reset functionality
fix: Prevent duplicate form submissions

# ✅ Good: Specific
feat: Implement rate limiting for API endpoints
```

### Body

Optional. Use it when the change is complex or needs a rationale. State the motivation and contrast with the previous behavior. Wrap lines at 72 characters.

```bash
fix: Prevent race condition in order processing

The previous implementation allowed concurrent modifications to the
same order, leading to inconsistent state.

This change introduces optimistic locking using version numbers.
When a conflict is detected, the operation is retried with fresh data.
```

### Footer

Optional. Use it for:

- **Issue tracker IDs** to link the commit to an issue (e.g. `Closes #123`).
- **Breaking changes**: `BREAKING CHANGE: <description>` for significant API changes.

```bash
# Issue references
fix: Resolve login timeout

Closes #123

# Breaking changes
feat!: Update authentication API

BREAKING CHANGE: The `authenticate()` method now returns a Promise
instead of using callbacks. Update all call sites to use async/await.
```

## Commit Templates

### Setup

```bash
# Create template file
cat > ~/.gitmessage << 'EOF'
# <type>(<scope>): <subject>
# |<----  Using a Maximum Of 50 Characters  ---->|

# Explain why this change is being made
# |<----   Try To Limit Each Line to a Maximum Of 72 Characters   ---->|

# Provide links or keys to any relevant tickets, articles or other resources
# Example: Fixes #23

# --- COMMIT END ---
# Type can be:
#   feat     (new feature)
#   fix      (bug fix)
#   docs     (changes to documentation)
#   style    (formatting, missing semi colons, etc; no code change)
#   refactor (refactoring production code)
#   perf     (performance improvements)
#   test     (adding missing tests, refactoring tests; no production code change)
#   chore    (build tooling, package manager config, miscellaneous tasks)
#   ci       (CI configuration)
# --------------------
EOF

# Configure git to use template
git config --global commit.template ~/.gitmessage
```

### Project-Specific Template

```bash
# .gitmessage in project root
# <type>(<scope>): <subject>

# Body: Explain the motivation for the change

# Footer:
# Fixes #issue
# BREAKING CHANGE: description

# ---
# Remember:
# - Use imperative mood ("Add" not "Added", "Move" not "Moves")
# - Capitalize the first letter of the subject
# - Do not end the subject with a period
# - First line max 50 chars (72 max), body wrap at 72
# - Reference issues and PRs at the bottom
```

## Rewriting History

### Amending Commits

```bash
# Fix last commit message
git commit --amend -m "feat: Correct commit message"

# Add files to last commit
git add forgotten-file.js
git commit --amend --no-edit

# Change author
git commit --amend --author="Name <email@example.com>"
```

### Interactive Rebase

```bash
# Rewrite last 5 commits
git rebase -i HEAD~5

# Commands in editor:
# pick   - use commit
# reword - edit message
# edit   - stop and amend
# squash - combine with previous
# fixup  - combine, discard message
# drop   - remove commit

# Example: Squash fixup commits
pick abc1234 feat: Add user API
fixup def5678 fixup! feat: Add user API
pick ghi9012 feat: Add admin API
```

### Fixup Commits

```bash
# Create fixup commit
git add .
git commit --fixup=abc1234

# Auto-squash during rebase
git rebase -i --autosquash main
```

## Best Practices Summary

1. **Write meaningful messages**: Future you will thank present you
2. **Use conventional commits**: Enable automated versioning
3. **Keep commits atomic**: One logical change per commit
4. **Reference issues**: Link commits to project management
5. **Use scopes consistently**: Help with changelog generation
6. **Don't include generated files**: Keep commits focused on source changes

## Atomic Commits

Each commit should be a **single, self-contained logical change** that builds and passes tests independently.

**Good:**

- `feat: Add user authentication endpoint` (one feature, complete)
- `fix: Correct SAML attribute name mapping` (one bug, fixed)
- `chore(deps): Bump go-ldap/ldap/v3 from 3.4.8 to 3.4.11` (one bump)

**Bad:**

- `feat: Add auth + fix typo + update deps` (three unrelated concerns)
- `wip` / `fixup` (leftover scratch commits)


## Push Upstream on First Push

When pushing a new branch for the first time, set upstream tracking with `-u`:

```bash
git push -u origin feature-branch
```

This makes subsequent `git pull` / `git push` work without specifying remote+branch. Without `-u`, everyone who clones the branch later has to set it up themselves.
