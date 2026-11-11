#!/usr/bin/env bash
# Run BOTH Checkstyle and ArchUnit on one or more subprojects, with a combined
# pass/fail summary at the end. This is the default entry point for the skill.
#
# Usage:
#   run-verify.sh                                # auto-detect all changed subprojects
#   run-verify.sh on-stk-ord-online              # explicit single subproject
#   run-verify.sh on-stk-ord-online on-stk-ord-batch   # explicit multiple
#
# Exit codes:
#   0  — every check on every subproject passed
#   1  — at least one check failed
#   2  — misuse: nothing to verify, project root not found, etc.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$SCRIPT_DIR/_lib.sh"

locate_project_root "$SCRIPT_DIR" || exit 2

SUBPROJECTS=()
if [ "$#" -gt 0 ]; then
  SUBPROJECTS=("$@")
else
  while IFS= read -r line; do
    [ -n "$line" ] && SUBPROJECTS+=("$line")
  done < <(detect_changed_subprojects "$PROJECT_ROOT")
fi

if [ "${#SUBPROJECTS[@]}" -eq 0 ]; then
  echo "[verify] ERROR: no subproject given and no Gradle subprojects with pending changes were found via git status." >&2
  echo "Usage: $0 [subproject ...]" >&2
  echo "(Discovered subprojects: $(discover_subprojects "$PROJECT_ROOT" | paste -sd, -))" >&2
  exit 2
fi

# Validate everything up front so we fail fast on typos.
for sp in "${SUBPROJECTS[@]}"; do
  validate_subproject "$PROJECT_ROOT" "$sp" || exit 2
done

echo "[verify] targets: ${SUBPROJECTS[*]}"
echo ""

# Track results: parallel arrays of "name|cs_status|au_status".
RESULTS=()
overall=0

for sp in "${SUBPROJECTS[@]}"; do
  echo "================================================================"
  echo "[verify] running on $sp"
  echo "================================================================"

  cs_status=0
  "$SCRIPT_DIR/run-checkstyle.sh" "$sp" || cs_status=$?

  echo ""
  au_status=0
  "$SCRIPT_DIR/run-archunit.sh" "$sp" || au_status=$?

  RESULTS+=("$sp|$cs_status|$au_status")
  if [ "$cs_status" -ne 0 ] || [ "$au_status" -ne 0 ]; then
    overall=1
  fi
  echo ""
done

echo "================================================================"
echo "[verify] summary"
echo "================================================================"
printf '%-22s  %-12s  %-12s\n' "subproject" "checkstyle" "archunit"
printf '%-22s  %-12s  %-12s\n' "----------" "----------" "--------"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r name cs au <<<"$row"
  cs_label=$([ "$cs" = "0" ] && echo "PASS" || echo "FAIL($cs)")
  au_label=$([ "$au" = "0" ] && echo "PASS" || echo "FAIL($au)")
  printf '%-22s  %-12s  %-12s\n' "$name" "$cs_label" "$au_label"
done
echo "================================================================"

exit "$overall"
