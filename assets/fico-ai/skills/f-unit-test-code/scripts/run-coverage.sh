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
[ -n "$MODULE" ] && [ -n "$TESTS" ] && [ -n "$OUT" ] || usage

HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=$HERE/../tools
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd) || exit 2
cd "$PROJECT" || { echo "no such project dir: $PROJECT" >&2; exit 2; }
# Accept :a:b, a:b and a/b alike: GMOD is the Gradle path without the leading colon, MDIR its directory.
GMOD=$(printf '%s' "$MODULE" | sed 's#/#:#g; s/^://')
MDIR=$(printf '%s' "$GMOD" | sed 's#:#/#g')

write_status() { # compile coverage logfile
  # LC_ALL=C: byte-safe for non-UTF-8 output (e.g. CP949); tr/sed would otherwise abort and truncate
  tail -n 40 "$3" 2>/dev/null | LC_ALL=C tr -d '\000-\010\013\014\016-\037' \
    | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g" \
    | LC_ALL=C awk 'BEGIN{printf "{\"compile\":\"%s\",\"log\":\"", "'"$1"'"} NR>1{printf "\\n"} {printf "%s",$0} END{printf "\",\"coverage\":\"%s\"}\n", "'"$2"'"}' > "$OUT/status.json"
}

rm -rf "$OUT/jacoco.exec" "$OUT/jacoco.xml" "$OUT/test-results" "$OUT/status.json"
LOG=$OUT/gradle.log
if [ -f ./gradlew ]; then GR="sh ./gradlew"
elif command -v gradle >/dev/null 2>&1; then GR=gradle
else echo "neither ./gradlew nor gradle found" > "$LOG"; write_status fail missing "$LOG"; exit 0; fi

$GR ":$GMOD:testClasses" -I "$HERE/init.gradle" > "$LOG" 2>&1 \
  || { write_status fail missing "$LOG"; exit 0; }

rm -rf "$MDIR/build/test-results/test"
# cleanTest forces a real run; a cached/UP-TO-DATE test task would write no jacoco.exec
$GR ":$GMOD:cleanTest" ":$GMOD:test" --continue -I "$HERE/init.gradle" \
  "-Pfut.agent=$TOOLS/jacocoagent.jar" "-Pfut.exec=$OUT/jacoco.exec" "-Pfut.tests=$TESTS" > "$LOG" 2>&1

[ -d "$MDIR/build/test-results/test" ] && cp -R "$MDIR/build/test-results/test" "$OUT/test-results"

COV=missing
JAVA=java; [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/java" ] && JAVA=$JAVA_HOME/bin/java
if [ -f "$OUT/jacoco.exec" ] && [ -d "$MDIR/build/classes/java/main" ]; then
  "$JAVA" -jar "$TOOLS/jacococli.jar" report "$OUT/jacoco.exec" \
    --classfiles "$MDIR/build/classes/java/main" --sourcefiles "$MDIR/src/main/java" \
    --xml "$OUT/jacoco.xml" >> "$LOG" 2>&1 && [ -f "$OUT/jacoco.xml" ] && COV=ok
fi
write_status ok "$COV" "$LOG"
exit 0
