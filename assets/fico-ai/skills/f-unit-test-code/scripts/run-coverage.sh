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

# Patterns shared with the plugin's env-failure.ts (a test checks they are identical; keep them in sync).
# Dependency/network failures:
RESOLUTION='No cached version|offline mode|Could not resolve|Could not GET|Could not HEAD|Could not download|Could not find [A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+:|Unable to load Maven meta-data|status code (401|403|407|429|5[0-9][0-9])|Server returned HTTP response code: (401|403|407|429|5[0-9][0-9])|Connection (refused|reset|timed out)|UnknownHost|Read timed out'
# javac errors or summary lines, English or Korean locale (case-sensitive, per line): javac echoes source lines,
# so a log with one is never a resolution failure.
JAVAC='\.java:[0-9]+: (error|오류):|^[0-9]+ errors?$|^오류 [0-9]+개$'
# javac errors in production sources: offline, a stale cached SNAPSHOT looks like this.
MAIN_JAVAC='src[/\\]main[/\\]java[/\\].*\.java:[0-9]+: (error|오류):'
# English diagnostics. A different JAVA_TOOL_OPTIONS value makes Gradle start a separate daemon (seen on Gradle 8.10.2),
# so this takes effect even when a ko/ja daemon is already running; the cost is one extra cold daemon start.
# Exported for this script's process only.
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Duser.language=en -Duser.country=US"

write_status() { # compile coverage logfile
  # The first environment line leads the tail: the plugin judges from status.json, which keeps only 40 lines.
  ENVLINE=
  LC_ALL=C grep -qE "$JAVAC" "$3" 2>/dev/null || ENVLINE=$(LC_ALL=C grep -iE -m 1 "$RESOLUTION" "$3" 2>/dev/null)
  # LC_ALL=C: byte-safe for non-UTF-8 output (e.g. CP949); tr/sed would otherwise abort and truncate
  { [ -n "$ENVLINE" ] && printf '[run-coverage] first environment line: %s\n' "$ENVLINE"; tail -n 40 "$3" 2>/dev/null; } \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037' \
    | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g" \
    | LC_ALL=C awk 'BEGIN{printf "{\"compile\":\"%s\",\"log\":\"", "'"$1"'"} NR>1{printf "\\n"} {printf "%s",$0} END{printf "\",\"coverage\":\"%s\"}\n", "'"$2"'"}' > "$OUT/status.json"
}

# run_gradle <args>: offline first (no repository round-trip for cached SNAPSHOTs); once online only when the
# offline run failed on dependency resolution or on main-source javac errors. Test-source javac errors never
# go online. Output to $LOG, closed by a line naming the mode used.
run_gradle() {
  MODE=offline
  $GR "$@" --offline > "$LOG" 2>&1; RC=$?
  if [ $RC -ne 0 ]; then
    if LC_ALL=C grep -qE "$MAIN_JAVAC" "$LOG"; then MODE='offline failed with main-source errors -> retried online'
    elif ! LC_ALL=C grep -qE "$JAVAC" "$LOG" && LC_ALL=C grep -qiE "$RESOLUTION" "$LOG"; then
      MODE='offline failed on dependency resolution -> retried online'
    fi
    [ "$MODE" = offline ] || { $GR "$@" > "$LOG" 2>&1; RC=$?; }
  fi
  echo "[run-coverage] gradle mode: $MODE" >> "$LOG"
  return $RC
}

rm -rf "$OUT/jacoco.exec" "$OUT/jacoco.xml" "$OUT/jacoco-html" "$OUT/test-results" "$OUT/status.json"
LOG=$OUT/gradle.log
if [ -f ./gradlew ]; then GR="sh ./gradlew"
elif command -v gradle >/dev/null 2>&1; then GR=gradle
else echo "neither ./gradlew nor gradle found" > "$LOG"; write_status fail missing "$LOG"; exit 0; fi

run_gradle ":$GMOD:testClasses" -I "$HERE/init.gradle" || { write_status fail missing "$LOG"; exit 0; }

rm -rf "$MDIR/build/test-results/test"
# cleanTest forces a real run; a cached/UP-TO-DATE test task would write no jacoco.exec
run_gradle ":$GMOD:cleanTest" ":$GMOD:test" --continue -I "$HERE/init.gradle" \
  "-Pfut.agent=$TOOLS/jacocoagent.jar" "-Pfut.exec=$OUT/jacoco.exec" "-Pfut.tests=$TESTS"

[ -d "$MDIR/build/test-results/test" ] && cp -R "$MDIR/build/test-results/test" "$OUT/test-results"

COV=missing
JAVA=java; [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/java" ] && JAVA=$JAVA_HOME/bin/java
if [ -f "$OUT/jacoco.exec" ] && [ -d "$MDIR/build/classes/java/main" ]; then
  "$JAVA" -jar "$TOOLS/jacococli.jar" report "$OUT/jacoco.exec" \
    --classfiles "$MDIR/build/classes/java/main" --sourcefiles "$MDIR/src/main/java" \
    --xml "$OUT/jacoco.xml" --html "$OUT/jacoco-html" >> "$LOG" 2>&1 && [ -f "$OUT/jacoco.xml" ] && COV=ok
fi
write_status ok "$COV" "$LOG"
exit 0
