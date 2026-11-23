/**
 * Which bash commands each /f-unit-test-code stage may run.
 *
 * Strict allowlists over whitespace tokens. Shell metacharacters, quotes and backslashes are
 * refused outright: none of the allowed commands needs them, and they are how a token hides a
 * flag. Allowed tokens also carry no glob, brace, history or comment characters and no leading
 * `~`/`=`, so the shell cannot expand them into something else.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNIT_TEST_SKILL_NAME } from "../pb-online/names";

export type BashStage = "plan" | "execute" | "verify" | "report";

/** The coverage script arguments of one session (run-coverage.sh and run-coverage.ps1 take the same three). */
export interface CoverageArgs {
  module: string;
  tests: string[];
  out: string;
}

export interface BashContext {
  /** Project root, where `.opencode/skills` lives for a project install. */
  cwd: string;
  coverage: CoverageArgs;
  /** Defaults to os.homedir(); the global install is under `<home>/.config/opencode/skills`. */
  home?: string;
}

export const SHELL_META = /[;&|<>`$\n\r'"\\]/;
// No * ? [ ] { } ! # ( ) anywhere; a leading ~ (home) or = (zsh command path) is refused separately.
const PLAIN_TOKEN = /^[\w./:@^~=,-]+$/;
const plain = (t: string): boolean => PLAIN_TOKEN.test(t) && !/^[~=]/.test(t);

const GIT_SUBCOMMANDS = new Set(["diff", "status", "log", "show", "rev-parse"]);
const GIT_FORBIDDEN = ["--output", "--ext-diff", "--textconv", "-c", "--exec-path", "--git-dir", "--work-tree", "-C"];
const GRADLE_EXE = new Set(["./gradlew", "gradlew", "gradlew.bat", "./gradlew.bat", "gradle"]);
const GRADLE_TASK = /^(:[\w-]+)*:?(classes|testClasses|compileJava|compileTestJava|test|cleanTest)$/;
const GRADLE_FLAGS = new Set(["--offline", "--console=plain", "-q", "--quiet", "--no-daemon", "--parallel", "--continue", "--stacktrace"]);
/** Full class names only: a wildcard would be a shell glob. */
const TEST_FILTER = /^[\w.]+$/;
const SH_SCRIPT = "run-coverage.sh";
const PS_SCRIPT = "run-coverage.ps1";
type ScriptName = typeof SH_SCRIPT | typeof PS_SCRIPT;
export const BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes and without ; & | < > ` $ * ? [ ] { } ! # ( ) or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute: that, or gradle/./gradlew with only classes, testClasses, compileJava, compileTestJava, test, cleanTest tasks (optionally :module:-prefixed), --tests <full test class name> and --offline, --console=plain, -q, --quiet, --no-daemon, --parallel, --continue, --stacktrace. " +
  "verify: only the run-coverage.sh (sh/bash) or run-coverage.ps1 (powershell/pwsh -File) command shown in the guide, exactly.";

/** git accepts any unambiguous prefix of a long option (`--outp` is `--output`), so a prefix is refused too. */
function forbiddenGitArg(a: string): boolean {
  const name = a.split("=")[0]!;
  return GIT_FORBIDDEN.some((f) => a.startsWith(f) || (name.startsWith("--") && name.length > 2 && f.startsWith(name)));
}

export function gitRead([exe, sub, ...rest]: string[]): boolean {
  return exe === "git" && GIT_SUBCOMMANDS.has(sub ?? "") && rest.every((a) => plain(a) && !forbiddenGitArg(a));
}

export function gradle([exe, ...rest]: string[]): boolean {
  if (!GRADLE_EXE.has(exe ?? "")) return false;
  let tasks = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (GRADLE_TASK.test(a)) tasks += 1;
    else if (a === "--tests" && TEST_FILTER.test(rest[i + 1] ?? "")) i += 1;
    else if (!GRADLE_FLAGS.has(a)) return false;
  }
  return tasks > 0;
}

export const slashes = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** `C:/x` also as `c:/x`, `C:/x` and the MSYS/Git Bash form `/c/x`. */
export function driveForms(p: string): string[] {
  const m = /^([A-Za-z]):(\/.*)$/.exec(p);
  if (!m) return [p];
  return [`${m[1]!.toUpperCase()}:${m[2]}`, `${m[1]!.toLowerCase()}:${m[2]}`, `/${m[1]!.toLowerCase()}${m[2]}`];
}

/** Every spelling of the installed script the verify gate accepts: project install first, then global. */
export function skillScriptPaths(cwd: string, home: string, skill: string, name: string): string[] {
  const script = `skills/${skill}/scripts/${name}`;
  return [
    `.opencode/${script}`,
    `./.opencode/${script}`,
    ...driveForms(`${slashes(cwd)}/.opencode/${script}`),
    ...driveForms(`${slashes(home)}/.config/opencode/${script}`),
  ];
}

/** The spelling the guide prints: project-relative when the project has the skill, else the global path. */
export function guideSkillScriptPath(cwd: string, home: string, skill: string, name: string): string {
  const script = `skills/${skill}/scripts/${name}`;
  return fs.existsSync(path.join(cwd, ".opencode", script)) ? `.opencode/${script}` : `${slashes(home)}/.config/opencode/${script}`;
}

/** The arguments after the script when `t` is `(sh|bash) <one of paths> ...`, else null. */
export function shScriptArgs([shell, script, ...rest]: string[], paths: string[]): string[] | null {
  return (shell === "sh" || shell === "bash") && script !== undefined && paths.includes(script) ? rest : null;
}

/** The arguments after the script when `t` is `(powershell|pwsh) [-NoProfile] [-ExecutionPolicy Bypass] -File <one of paths> ...`, in that order, else null. */
export function psScriptArgs([shell, ...rest]: string[], paths: string[]): string[] | null {
  if (shell !== "powershell" && shell !== "pwsh") return null;
  let i = 0;
  if (rest[i] === "-NoProfile") i += 1;
  if (rest[i] === "-ExecutionPolicy" && rest[i + 1] === "Bypass") i += 2;
  return rest[i] === "-File" && paths.includes(rest[i + 1] ?? "") ? rest.slice(i + 2) : null;
}

export const scriptPaths = (cwd: string, home: string = os.homedir(), name: ScriptName = SH_SCRIPT): string[] => skillScriptPaths(cwd, home, UNIT_TEST_SKILL_NAME, name);
export const guideScriptPath = (cwd: string, home: string = os.homedir(), name: ScriptName = SH_SCRIPT): string => guideSkillScriptPath(cwd, home, UNIT_TEST_SKILL_NAME, name);

/** The coverage script the guide names on this platform: PowerShell on win32, sh elsewhere. */
export function coverageScriptName(platform: NodeJS.Platform = process.platform): ScriptName {
  return platform === "win32" ? PS_SCRIPT : SH_SCRIPT;
}

/**
 * The exact verify command; the guide prints it and `bashAllowed` accepts it (tests in any order).
 * win32 gets the PowerShell script, every other platform the sh one; the gate accepts both everywhere.
 * Null when the script path has whitespace: such a path can never be one plain token.
 */
export function coverageCommandLine(ctx: BashContext, platform: NodeJS.Platform = process.platform): string | null {
  const { module, tests, out } = ctx.coverage;
  const name = coverageScriptName(platform);
  const win = name === PS_SCRIPT;
  const script = guideScriptPath(ctx.cwd, ctx.home, name);
  if (/\s/.test(script)) return null;
  const list = tests.join(",") || "<FQCN,...>";
  return win
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Module ${module} -Tests ${list} -Out ${out}`
    : `sh ${script} --module ${module} --tests ${list} --out ${out}`;
}

/** `<flag> M <flag> T <flag> R`, exactly, with T compared to the session's tests as a set. */
function sameArgs(rest: string[], [m, t, o]: [string, string, string], want: CoverageArgs): boolean {
  if (rest.length !== 6 || rest[0] !== m || rest[2] !== t || rest[4] !== o) return false;
  const tests = rest[3]!.split(",");
  const sameTests = tests.length === want.tests.length && new Set(tests).size === tests.length && tests.every((x) => want.tests.includes(x));
  return rest[1] === want.module && sameTests && rest[5] === want.out;
}

/** `(sh|bash) run-coverage.sh --module M --tests T --out R`. */
function shCoverage(t: string[], ctx: BashContext): boolean {
  const rest = shScriptArgs(t, scriptPaths(ctx.cwd, ctx.home, SH_SCRIPT));
  return rest !== null && sameArgs(rest, ["--module", "--tests", "--out"], ctx.coverage);
}

/** `(powershell|pwsh) [-NoProfile] [-ExecutionPolicy Bypass] -File run-coverage.ps1 -Module M -Tests T -Out R`. */
function psCoverage(t: string[], ctx: BashContext): boolean {
  const rest = psScriptArgs(t, scriptPaths(ctx.cwd, ctx.home, PS_SCRIPT));
  return rest !== null && sameArgs(rest, ["-Module", "-Tests", "-Out"], ctx.coverage);
}

export function bashAllowed(stage: BashStage, command: string, ctx: BashContext): boolean {
  if (SHELL_META.test(command)) return false;
  const t = command.trim().split(/\s+/);
  switch (stage) {
    case "plan":
      return gitRead(t);
    case "execute":
      return gitRead(t) || gradle(t);
    case "verify":
      return shCoverage(t, ctx) || psCoverage(t, ctx);
    case "report":
      return false;
  }
}
