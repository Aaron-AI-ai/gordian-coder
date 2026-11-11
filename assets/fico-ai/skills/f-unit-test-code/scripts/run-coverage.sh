#!/bin/sh
# Usage: run-coverage.sh --module <gradle module> --tests <FQCN,...> --out <dir> [--project <root>]
# Always exits 0 after arguments are valid; facts go to <out>/status.json.
usage() { echo "usage: run-coverage.sh --module <gradle module> --tests <FQCN,...> --out <dir> [--project <root>]" >&2; exit 2; }

MODULE= TESTS= OUT= PROJECT=.
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --module) MODULE=$2 ;; --tests) TESTS=$2 ;; --out) OUT=$2 ;; --project) PROJECT=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$MODULE" ] && [ -n "$OUT" ] || usage

HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=$HERE/../tools
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd) || exit 2
cd "$PROJECT" || { echo "no such project dir: $PROJECT" >&2; exit 2; }
MDIR=$(printf '%s' "$MODULE" | sed 's/^://; s/:/\//g')

write_status() { # compile coverage logfile
  tail -n 40 "$3" 2>/dev/null | tr -d '\000-\010\013\014\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g" \
    | awk 'BEGIN{printf "{\"compile\":\"%s\",\"log\":\"", "'"$1"'"} NR>1{printf "\\n"} {printf "%s",$0} END{printf "\",\"coverage\":\"%s\"}\n", "'"$2"'"}' > "$OUT/status.json"
}

LOG=$OUT/gradle.log
if [ -f ./gradlew ]; then GR="sh ./gradlew"
elif command -v gradle >/dev/null 2>&1; then GR=gradle
else echo "neither ./gradlew nor gradle found" > "$LOG"; write_status fail missing "$LOG"; exit 0; fi

$GR ":$MODULE:testClasses" -I "$HERE/init.gradle" > "$LOG" 2>&1 \
  || { write_status fail missing "$LOG"; exit 0; }

rm -f "$OUT/jacoco.exec" "$OUT/jacoco.xml"
$GR ":$MODULE:test" --continue -I "$HERE/init.gradle" \
  "-Pfut.agent=$TOOLS/jacocoagent.jar" "-Pfut.exec=$OUT/jacoco.exec" "-Pfut.tests=$TESTS" > "$LOG" 2>&1

rm -rf "$OUT/test-results"
[ -d "$MDIR/build/test-results/test" ] && cp -R "$MDIR/build/test-results/test" "$OUT/test-results"

COV=missing
if [ -f "$OUT/jacoco.exec" ] && [ -d "$MDIR/build/classes/java/main" ]; then
  java -jar "$TOOLS/jacococli.jar" report "$OUT/jacoco.exec" \
    --classfiles "$MDIR/build/classes/java/main" --sourcefiles "$MDIR/src/main/java" \
    --xml "$OUT/jacoco.xml" >> "$LOG" 2>&1 && [ -f "$OUT/jacoco.xml" ] && COV=ok
fi
write_status ok "$COV" "$LOG"
exit 0
