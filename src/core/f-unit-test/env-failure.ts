/**
 * Gradle failures caused by the environment (dependency resolution, repository or network), not by test code.
 *
 * run-coverage.sh and run-coverage.ps1 carry these exact pattern strings for their online retry and their
 * "first environment line" (a test checks it), so each must stay valid as POSIX ERE (`grep -E`), .NET and
 * JavaScript regex alike: no `\d`/`\w`, only bracket classes.
 */
export const ENV_FAILURE_PATTERN =
  "No cached version|offline mode|Could not resolve|Could not GET|Could not HEAD|Could not download|Could not find [A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+:|Unable to load Maven meta-data|status code (401|403|407|429|5[0-9][0-9])|Server returned HTTP response code: (401|403|407|429|5[0-9][0-9])|Connection (refused|reset|timed out)|UnknownHost|Read timed out";

/** A javac error line. javac echoes source lines, so a log with one is never judged an environment failure. Case-sensitive. */
export const JAVAC_ERROR_PATTERN = "\\.java:[0-9]+: error:";

/** A javac error in production sources (both path separators): offline, a stale SNAPSHOT shows up like this. */
export const MAIN_JAVAC_ERROR_PATTERN = "src[/\\\\]main[/\\\\]java[/\\\\].*\\.java:[0-9]+: error:";

const ENV_FAILURE = new RegExp(ENV_FAILURE_PATTERN, "i");
const JAVAC_ERROR = new RegExp(JAVAC_ERROR_PATTERN);

/** The first log line naming an environment failure, trimmed; null when there is none or the log has a javac error. */
export function environmentFailureLine(log: string): string | null {
  if (JAVAC_ERROR.test(log)) return null;
  return log.split(/\r?\n/).find((l) => ENV_FAILURE.test(l))?.trim() ?? null;
}

export function isEnvironmentFailure(log: string): boolean {
  return environmentFailureLine(log) !== null;
}
