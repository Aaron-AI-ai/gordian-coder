# Git Branching Strategies

## Trunk-Based Development

### Overview

All developers work on a single branch with short-lived feature branches.

```
main ───●───●───●───●───●───●───●───●───●───●─── (trunk)
        │   │       │       │   │       │
        └─┬─┘       └───┬───┘   └───┬───┘
          │             │           │
        small         small       small
        feature       feature     feature
        (< 1 day)     (< 1 day)   (< 1 day)
```

### Principles

1. **Single branch**: All code goes to `main`/`trunk`
2. **Short-lived branches**: Max 1-2 days
3. **Feature flags**: Hide incomplete features
4. **Continuous integration**: Merge multiple times per day
5. **No long-running branches**: Avoid merge conflicts

### Workflow

```bash
# Start small feature (should complete today)
git checkout main
git pull
git checkout -b small-feature

# Work in small increments
git add .
git commit -m "feat: add basic structure"
git push

# Merge quickly (within hours/day) via the platform's UI or CLI,
# using rebase-merge to preserve linear history
```

### Release Strategies

```bash
# Release from trunk
git tag v1.2.0
git push origin v1.2.0
```
