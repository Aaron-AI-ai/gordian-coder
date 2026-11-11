#!/usr/bin/env bash
# Run Checkstyle (`./gradlew :<subproject>:checkstyleMain`) on a single subproject.
#
# Usage:
#   run-checkstyle.sh                 # auto-detect from `git status` (must be exactly one)
#   run-checkstyle.sh on-stk-ord-online
#
# Exit codes:
#   0  — Checkstyle passed
#   1  — Checkstyle reported violations (gradle exit propagated)
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
    echo "[checkstyle] ERROR: no subproject given and no Gradle subprojects with pending changes were found via git status." >&2
    echo "Usage: $0 <subproject>" >&2
    echo "(Discovered subprojects: $(discover_subprojects "$PROJECT_ROOT" | paste -sd, -))" >&2
    exit 2
  elif [ "$count" -gt 1 ]; then
    echo "[checkstyle] ERROR: multiple changed subprojects detected — pass one explicitly:" >&2
    printf '  - %s\n' $detected >&2
    exit 2
  fi
  SUBPROJECT="$detected"
fi

validate_subproject "$PROJECT_ROOT" "$SUBPROJECT" || exit 2

echo "[checkstyle] target: $SUBPROJECT"
cd "$PROJECT_ROOT"

status=0
./gradlew "$(gradle_path "$SUBPROJECT"):checkstyleMain" --console=plain || status=$?

if [ "$status" -eq 0 ]; then
  echo "[checkstyle] PASS  (subproject=$SUBPROJECT)"
else
  echo "[checkstyle] FAIL  (subproject=$SUBPROJECT, gradle exit=$status)"
  echo "[checkstyle] HTML report: $SUBPROJECT/build/reports/checkstyle/main.html (when produced)"
fi
exit "$status"
