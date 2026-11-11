#!/usr/bin/env bash
# Run ArchUnit verification (`./gradlew :<subproject>:verifyArch --rerun-tasks --console=plain`)
# on a single subproject.
#
# Usage:
#   run-archunit.sh                 # auto-detect from `git status` (must be exactly one)
#   run-archunit.sh on-stk-ord-online
#
# Exit codes:
#   0  — all ArchUnit rules passed
#   1  — at least one rule failed (gradle exit propagated)
#   2  — Misuse: subproject missing/ambiguous, project root not found, etc.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$SCRIPT_DIR/_lib.sh"

locate_project_root "$SCRIPT_DIR" || exit 2

SUBPROJECT="${1:-}"
if [ -z "$SUBPROJECT" ]; then
  detected="$(detect_changed_subprojects "$PROJECT_ROOT")"
  count=$(printf '%s\n' "$detected" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    echo "[archunit] ERROR: no subproject given and no Gradle subprojects with pending changes were found via git status." >&2
    echo "Usage: $0 <subproject>" >&2
    echo "(Discovered subprojects: $(discover_subprojects "$PROJECT_ROOT" | paste -sd, -))" >&2
    exit 2
  elif [ "$count" -gt 1 ]; then
    echo "[archunit] ERROR: multiple changed subprojects detected — pass one explicitly:" >&2
    printf '  - %s\n' $detected >&2
    exit 2
  fi
  SUBPROJECT="$detected"
fi

validate_subproject "$PROJECT_ROOT" "$SUBPROJECT" || exit 2

echo "[archunit] target: $SUBPROJECT"
cd "$PROJECT_ROOT"

# --rerun-tasks: bypass Gradle's incremental cache so the rules execute against
#                the freshly compiled code on every invocation.
# --console=plain: keep multi-line ArchUnit failure messages linear and grep-friendly.
status=0
./gradlew "$(gradle_path "$SUBPROJECT"):verifyArch" --rerun-tasks --console=plain || status=$?

if [ "$status" -eq 0 ]; then
  echo "[archunit] PASS  (subproject=$SUBPROJECT)"
else
  echo "[archunit] FAIL  (subproject=$SUBPROJECT, gradle exit=$status)"
  echo "[archunit] Test results: $SUBPROJECT/build/test-results/verifyArch/"
fi
exit "$status"
