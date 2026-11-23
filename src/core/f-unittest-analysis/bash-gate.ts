/**
 * Which bash commands each /f-unittest-analysis stage may run. The plugin runs Gradle itself, so the model gets
 * read-only git while it plans and no bash at all afterwards. Same strict allowlist as the other unit test
 * commands (plain tokens, no shell metacharacters).
 */

import { SHELL_META, gitRead } from "../f-unit-test/bash-gate";

export type AnalysisBashStage = "plan" | "execute" | "report";

export const ANALYSIS_BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes and without ; & | < > ` $ * ? [ ] { } ! # ( ) or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute and report: no bash (the plugin runs the tests itself).";

export function analysisBashAllowed(stage: AnalysisBashStage, command: string): boolean {
  if (SHELL_META.test(command)) return false;
  return stage === "plan" && gitRead(command.trim().split(/\s+/));
}
