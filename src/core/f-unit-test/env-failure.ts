/**
 * Gradle failures caused by the environment (dependency resolution, repository or network), not by test code.
 *
 * run-coverage.sh and run-coverage.ps1 carry this exact pattern string to decide on their online retry
 * (a test checks it), so it must stay valid as POSIX ERE (`grep -iE`), .NET and JavaScript regex alike.
 */
export const ENV_FAILURE_PATTERN =
  "No cached version|offline mode|Could not resolve|Could not GET|Could not HEAD|Unable to load Maven meta-data|status code (401|403|407|429|5[0-9][0-9])|Connection (refused|reset|timed out)|UnknownHost|Read timed out";

const ENV_FAILURE = new RegExp(ENV_FAILURE_PATTERN, "i");

/** The first log line naming an environment failure, trimmed; null when there is none. */
export function environmentFailureLine(log: string): string | null {
  return log.split(/\r?\n/).find((l) => ENV_FAILURE.test(l))?.trim() ?? null;
}

export function isEnvironmentFailure(log: string): boolean {
  return environmentFailureLine(log) !== null;
}
