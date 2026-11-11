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

/** The run-coverage.sh arguments of one session. */
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

const SHELL_META = /[;&|<>`$\n\r'"\\]/;
// No * ? [ ] { } ! # ( ) anywhere; a leading ~ (home) or = (zsh command path) is refused separately.
const PLAIN_TOKEN = /^[\w./:@^~=,-]+$/;
const plain = (t: string): boolean => PLAIN_TOKEN.test(t) && !/^[~=]/.test(t);

const GIT_SUBCOMMANDS = new Set(["diff", "status", "log", "show", "rev-parse"]);
const GIT_FORBIDDEN = ["--output", "--ext-diff", "--textconv", "-c", "--exec-path", "--git-dir", "--work-tree", "-C"];
const GRADLE_EXE = new Set(["./gradlew", "gradlew", "gradlew.bat", "gradle"]);
const GRADLE_TASK = /^(:[\w-]+)*:?(classes|testClasses|compileJava|compileTestJava|test|cleanTest)$/;
const GRADLE_FLAGS = new Set(["--offline", "--console=plain", "-q", "--quiet", "--no-daemon", "--parallel", "--continue", "--stacktrace"]);
/** Full class names only: a wildcard would be a shell glob. */
const TEST_FILTER = /^[\w.]+$/;
const SKILL_SCRIPT = `skills/${UNIT_TEST_SKILL_NAME}/scripts/run-coverage.sh`;

export const BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes and without ; & | < > ` $ * ? [ ] { } ! # ( ) or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute: that, or gradle/./gradlew with only classes, testClasses, compileJava, compileTestJava, test, cleanTest tasks (optionally :module:-prefixed), --tests <full test class name> and --offline, --console=plain, -q, --quiet, --no-daemon, --parallel, --continue, --stacktrace. " +
  "verify: only the run-coverage.sh command shown in the guide, exactly.";

/** git accepts any unambiguous prefix of a long option (`--outp` is `--output`), so a prefix is refused too. */
function forbiddenGitArg(a: string): boolean {
  const name = a.split("=")[0]!;
  return GIT_FORBIDDEN.some((f) => a.startsWith(f) || (name.startsWith("--") && name.length > 2 && f.startsWith(name)));
}

function gitRead([exe, sub, ...rest]: string[]): boolean {
  return exe === "git" && GIT_SUBCOMMANDS.has(sub ?? "") && rest.every((a) => plain(a) && !forbiddenGitArg(a));
}

function gradle([exe, ...rest]: string[]): boolean {
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

const slashes = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** `C:/x` also as `c:/x`, `C:/x` and the MSYS/Git Bash form `/c/x`. */
function driveForms(p: string): string[] {
  const m = /^([A-Za-z]):(\/.*)$/.exec(p);
  if (!m) return [p];
  return [`${m[1]!.toUpperCase()}:${m[2]}`, `${m[1]!.toLowerCase()}:${m[2]}`, `/${m[1]!.toLowerCase()}${m[2]}`];
}

/** Every spelling of the installed script the verify gate accepts: project install first, then global. */
export function scriptPaths(cwd: string, home: string = os.homedir()): string[] {
  return [
    `.opencode/${SKILL_SCRIPT}`,
    `./.opencode/${SKILL_SCRIPT}`,
    ...driveForms(`${slashes(cwd)}/.opencode/${SKILL_SCRIPT}`),
    ...driveForms(`${slashes(home)}/.config/opencode/${SKILL_SCRIPT}`),
  ];
}

/** The spelling the guide prints: project-relative when the project has the skill, else the global path. */
export function guideScriptPath(cwd: string, home: string = os.homedir()): string {
  return fs.existsSync(path.join(cwd, ".opencode", SKILL_SCRIPT)) ? `.opencode/${SKILL_SCRIPT}` : `${slashes(home)}/.config/opencode/${SKILL_SCRIPT}`;
}

/** The exact verify command; the guide prints it and `bashAllowed` accepts it (tests in any order). */
export function coverageCommandLine(ctx: BashContext): string {
  const { module, tests, out } = ctx.coverage;
  return `sh ${guideScriptPath(ctx.cwd, ctx.home)} --module ${module} --tests ${tests.join(",") || "<FQCN,...>"} --out ${out}`;
}

function coverageCommand([shell, script, ...rest]: string[], ctx: BashContext): boolean {
  if ((shell !== "sh" && shell !== "bash") || !script || !scriptPaths(ctx.cwd, ctx.home).includes(script)) return false;
  const want = ctx.coverage;
  if (rest.length !== 6 || rest[0] !== "--module" || rest[2] !== "--tests" || rest[4] !== "--out") return false;
  const tests = rest[3]!.split(",");
  const sameTests = tests.length === want.tests.length && new Set(tests).size === tests.length && tests.every((t) => want.tests.includes(t));
  return rest[1] === want.module && sameTests && rest[5] === want.out;
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
      return coverageCommand(t, ctx);
    case "report":
      return false;
  }
}
