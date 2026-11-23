/**
 * Which bash commands each /f-unit-test-req stage may run. Same strict allowlist as /f-unit-test-code
 * (plain tokens, no shell metacharacters); verify allows only the skill's compile-tests script, exactly.
 */

import * as os from "node:os";
import { SHELL_META, gitRead, gradle, guideSkillScriptPath, psScriptArgs, shScriptArgs, skillScriptPaths } from "../f-unit-test/bash-gate";
import { UNIT_TEST_REQ_SKILL_NAME } from "../pb-online/names";

export type ReqBashStage = "plan" | "execute" | "verify" | "done";

export interface CompileArgs {
  module: string;
  out: string;
}

export interface ReqBashContext {
  cwd: string;
  compile: CompileArgs;
  home?: string;
}

const SH_SCRIPT = "compile-tests.sh";
const PS_SCRIPT = "compile-tests.ps1";
type ScriptName = typeof SH_SCRIPT | typeof PS_SCRIPT;
const paths = (ctx: ReqBashContext, name: ScriptName): string[] => skillScriptPaths(ctx.cwd, ctx.home ?? os.homedir(), UNIT_TEST_REQ_SKILL_NAME, name);

export const REQ_BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes and without ; & | < > ` $ * ? [ ] { } ! # ( ) or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute: that, or gradle/./gradlew with only classes, testClasses, compileJava, compileTestJava tasks (optionally :module:-prefixed) and plain flags; tests are never run. " +
  "verify: only the compile-tests.sh (sh/bash) or compile-tests.ps1 (powershell/pwsh -File) command shown in the guide, exactly.";

export const compileScriptName = (platform: NodeJS.Platform = process.platform): ScriptName => (platform === "win32" ? PS_SCRIPT : SH_SCRIPT);

/** The exact verify command; null when the script path has whitespace (it could never be one plain token). */
export function compileCommandLine(ctx: ReqBashContext, platform: NodeJS.Platform = process.platform): string | null {
  const name = compileScriptName(platform);
  const script = guideSkillScriptPath(ctx.cwd, ctx.home ?? os.homedir(), UNIT_TEST_REQ_SKILL_NAME, name);
  if (/\s/.test(script)) return null;
  const { module, out } = ctx.compile;
  return name === PS_SCRIPT
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Module ${module} -Out ${out}`
    : `sh ${script} --module ${module} --out ${out}`;
}

/** `<flag> M <flag> R`, exactly. */
function sameArgs(rest: string[] | null, [m, o]: [string, string], want: CompileArgs): boolean {
  return rest !== null && rest.length === 4 && rest[0] === m && rest[1] === want.module && rest[2] === o && rest[3] === want.out;
}

export function reqBashAllowed(stage: ReqBashStage, command: string, ctx: ReqBashContext): boolean {
  if (SHELL_META.test(command)) return false;
  const t = command.trim().split(/\s+/);
  switch (stage) {
    case "plan":
      return gitRead(t);
    case "execute":
      // Tests are never run here: the test tasks and --tests are refused.
      return gitRead(t) || (gradle(t) && !t.some((a) => a === "--tests" || /(^|:)(test|cleanTest)$/.test(a)));
    case "verify":
      return sameArgs(shScriptArgs(t, paths(ctx, SH_SCRIPT)), ["--module", "--out"], ctx.compile) || sameArgs(psScriptArgs(t, paths(ctx, PS_SCRIPT)), ["-Module", "-Out"], ctx.compile);
    case "done":
      return false;
  }
}
