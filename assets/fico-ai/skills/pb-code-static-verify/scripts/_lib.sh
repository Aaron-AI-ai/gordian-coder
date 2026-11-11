#!/usr/bin/env bash
# Shared helpers for pb-code-static-verify scripts.
# Sourced by run-checkstyle.sh, run-archunit.sh, run-verify.sh.
#
# Design note: this skill is project-agnostic. It does NOT hard-code any
# subproject names. Instead, it discovers them from settings.gradle at runtime
# so the same scripts work in any Gradle multi-project build that follows the
# standard `include 'foo'` / `include ':foo:bar'` convention.

# Locate project root by walking up from the sourcing script until gradlew is found.
# Sets the global PROJECT_ROOT.
locate_project_root() {
  local dir="${1:?caller must pass a starting directory}"
  while [ "$dir" != "/" ] && [ ! -f "$dir/gradlew" ]; do
    dir="$(dirname "$dir")"
  done
  if [ ! -f "$dir/gradlew" ]; then
    echo "ERROR: could not locate project root (gradlew not found above $1)" >&2
    return 2
  fi
  PROJECT_ROOT="$dir"
}

# Discover all Gradle subprojects declared in settings.gradle.
# Prints unique subproject paths, one per line. Nested modules (`:foo:bar`) are
# converted to filesystem paths (`foo/bar`).
#
# Handles common Groovy DSL forms:
#   include 'foo'
#   include ':foo:bar', ':baz'
discover_subprojects() {
  local root="${1:?root required}"
  local file="$root/settings.gradle"
  [ -f "$file" ] || return 0

  # Strip line comments before parsing so a commented-out `// include ':foo'`
  # does not pollute the candidate list.
  sed 's|//.*$||' "$file" \
    | grep -E '^[[:space:]]*include\b' \
    | grep -oE "['\"][^'\"]+['\"]" \
    | tr -d "'\"" \
    | sed 's|^:||; s|:|/|g' \
    | sort -u
}

# Detect which discovered subprojects have changes in `git status -s`.
# Prints unique subproject names, one per line. Empty output means none changed.
detect_changed_subprojects() {
  local root="${1:?root required}"

  local candidates
  candidates="$(discover_subprojects "$root")"
  [ -z "$candidates" ] && return 0

  local changed_paths
  changed_paths="$(cd "$root" && git status -s 2>/dev/null | awk '{print $NF}')"
  [ -z "$changed_paths" ] && return 0

  # For each candidate, see if any changed path equals it or lives beneath it.
  # Done via shell case (not regex) to sidestep escaping of dots, dashes, etc.
  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    while IFS= read -r path; do
      case "$path" in
        "$candidate"|"$candidate"/*)
          echo "$candidate"
          break
          ;;
      esac
    done <<<"$changed_paths"
  done <<<"$candidates" | sort -u
}

# Validate that a name resolves to a real Gradle subproject directory.
# Nested paths (`foo/bar`) work too.
validate_subproject() {
  local root="$1"
  local name="$2"
  if [ ! -d "$root/$name" ]; then
    echo "ERROR: '$name' is not a subdirectory of project root ($root)" >&2
    return 2
  fi
  if [ ! -f "$root/$name/build.gradle" ]; then
    echo "ERROR: '$name' has no build.gradle — not a Gradle subproject?" >&2
    return 2
  fi
}

# Convert a filesystem path (`foo/bar`) into a Gradle task path prefix (`:foo:bar`).
# Used when invoking gradle: `./gradlew $(gradle_path foo/bar):checkstyleMain`.
gradle_path() {
  local name="${1:?name required}"
  echo ":${name//\//:}"
}
