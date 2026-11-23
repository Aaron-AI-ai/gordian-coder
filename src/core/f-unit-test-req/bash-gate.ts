/**
 * Which bash commands each /f-unit-test-req stage may run. Same strict allowlist as /f-unit-test-code
 * (plain tokens, no shell metacharacters); verify allows only the skill's compile-tests script, exactly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SHELL_META, driveForms, gitRead, gradle, slashes } from "../f-unit-test/bash-gate";
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
const skillScript = (name: ScriptName): string => `skills/${UNIT_TEST_REQ_SKILL_NAME}/scripts/${name}`;

export const REQ_BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes and without ; & | < > ` $ * ? [ ] { } ! # ( ) or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute: that, or gradle/./gradlew with only classes, testClasses, compileJava, compileTestJava tasks (optionally :module:-prefixed) and plain flags; tests are never run. " +
  "verify: only the compile-tests.sh (sh/bash) or compile-tests.ps1 (powershell/pwsh -File) command shown in the guide, exactly.";

export function scriptPaths(cwd: string, home: string = os.homedir(), name: ScriptName = SH_SCRIPT): string[] {
  const script = skillScript(name);
  return [
    `.opencode/${script}`,
    `./.opencode/${script}`,
    ...driveForms(`${slashes(cwd)}/.opencode/${script}`),
    ...driveForms(`${slashes(home)}/.config/opencode/${script}`),
  ];
}

export function guideScriptPath(cwd: string, home: string = os.homedir(), name: ScriptName = SH_SCRIPT): string {
  const script = skillScript(name);
  return fs.existsSync(path.join(cwd, ".opencode", script)) ? `.opencode/${script}` : `${slashes(home)}/.config/opencode/${script}`;
}

export const compileScriptName = (platform: NodeJS.Platform = process.platform): ScriptName => (platform === "win32" ? PS_SCRIPT : SH_SCRIPT);

/** The exact verify command; null when the script path has whitespace (it could never be one plain token). */
export function compileCommandLine(ctx: ReqBashContext, platform: NodeJS.Platform = process.platform): string | null {
  const name = compileScriptName(platform);
  const script = guideScriptPath(ctx.cwd, ctx.home, name);
  if (/\s/.test(script)) return null;
  const { module, out } = ctx.compile;
  return name === PS_SCRIPT
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Module ${module} -Out ${out}`
    : `sh ${script} --module ${module} --out ${out}`;
}

function sameArgs(rest: string[], [m, o]: [string, string], want: CompileArgs): boolean {
  return rest.length === 4 && rest[0] === m && rest[1] === want.module && rest[2] === o && rest[3] === want.out;
}

function shCompile([shell, script, ...rest]: string[], ctx: ReqBashContext): boolean {
  if ((shell !== "sh" && shell !== "bash") || !script || !scriptPaths(ctx.cwd, ctx.home, SH_SCRIPT).includes(script)) return false;
  return sameArgs(rest, ["--module", "--out"], ctx.compile);
}

function psCompile([shell, ...rest]: string[], ctx: ReqBashContext): boolean {
  if (shell !== "powershell" && shell !== "pwsh") return false;
  let i = 0;
  if (rest[i] === "-NoProfile") i += 1;
  if (rest[i] === "-ExecutionPolicy" && rest[i + 1] === "Bypass") i += 2;
  if (rest[i] !== "-File" || !scriptPaths(ctx.cwd, ctx.home, PS_SCRIPT).includes(rest[i + 1] ?? "")) return false;
  return sameArgs(rest.slice(i + 2), ["-Module", "-Out"], ctx.compile);
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
      return shCompile(t, ctx) || psCompile(t, ctx);
    case "done":
      return false;
  }
}
