/**
 * /f-unit-test-code harness: the stage graph and its per-session state.
 *
 * The rules and templates live in the `f-unit-test-code` skill; the skill's
 * run-coverage.sh leaves the build and coverage facts in files. This module owns
 * the flow and judges verify from those files, never from the model's claim.
 *
 *   plan → execute → verify ─covered/gaps/incomplete→ report
 *             ↑__compile, defects, gaps__|
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { UNIT_TEST_SKILL_NAME } from "../pb-online/names";
import { MAX_WAIT_CALLS, awaitingReply, noteReply, takeAbort, type PlanGateState } from "../plan-gate";
import { isFullyCovered, readCoverage, readFailedTests, type FileCoverage } from "./coverage";
import { checkTestSource, testMethodNames } from "./test-check";

export { MAX_WAIT_CALLS, UNIT_TEST_SKILL_NAME };

export const COMMAND_NAME = "f-unit-test-code";
export const STAGE_TOOL = "f_unit_test_stage";
export const REPORT_DIR = ".fico/report/f-unit-test";
/** Verify→execute rounds for coverage gaps before the run is reported with the gaps left. */
export const MAX_COVERAGE_ROUNDS = 3;
/** Verify→execute rounds for compile failures and static-check defects, shared. */
export const MAX_FIX_RETRIES = 5;
// ponytail: in-memory like pb-online, so a server restart drops the gate.
const MAX_SESSIONS = 50;
// ponytail: file mtimes can trail Date.now() by a clock tick; a stale file from an earlier round is seconds older.
const MTIME_SLACK_MS = 1000;

export type StageId = "plan" | "execute" | "verify" | "report";

export interface CaseDef {
  target: string;
  method: string;
  normal: string[];
  boundary: string[];
  exception: string[];
  mocks: string[];
  skip_reason?: string;
}

export interface PlanInputs {
  mode: "files" | "program" | "git";
  module: string;
  targets: string[];
  files: string[];
  cases: CaseDef[];
}

export interface StageInput {
  stage: StageId;
  note?: string;
  inputs?: Partial<PlanInputs>;
  user_approved?: boolean;
}

export type Verification = "pending" | "covered" | "gaps" | "incomplete";

/** One target's result: the coverage read from jacoco.xml, or null when the file was not in it. */
export interface TargetCoverage {
  target: string;
  coverage: FileCoverage | null;
}

export interface FutSession extends PlanGateState {
  stage: StageId;
  request: string;
  cwd: string;
  inputs?: PlanInputs;
  plan?: string;
  /** @Test method names of planned test files that already existed at plan time. */
  previousMethods: Record<string, string[]>;
  /** Project-relative files written through the gate. */
  touched: Set<string>;
  /** Files written since the run last entered execute; leaving execute needs one. */
  roundWrites: Set<string>;
  /** Project-relative directory passed to run-coverage.sh as --out; holds report.md too. */
  runDir?: string;
  verifyStartedAt?: number;
  /** mtimes of status.json/jacoco.xml at verify entry; only strictly newer files count. */
  verifyBaseline: Record<string, number>;
  fixRetries: number;
  gapRounds: number;
  verification: Verification;
  coverage: TargetCoverage[];
  failedTests: string[];
  /** The last defects or compile log that sent the run back, kept for an incomplete report. */
  lastProblems: string[];
  verifyNote?: string;
}

interface Stage {
  goal: string;
  steps: string[];
  tools: string[];
  blocked: string[];
  finish: string;
}

const WRITES = ["edit", "write", "apply_patch", "multiedit", "patch"];
// Strict allowlists over whitespace tokens. Shell metacharacters, quotes and backslashes are refused
// outright: none of the allowed commands needs them, and they are how a token hides a flag.
const SHELL_META = /[;&|<>`$\n\r'"\\]/;
const GIT_SUBCOMMANDS = new Set(["diff", "status", "log", "show", "rev-parse"]);
const GIT_TOKEN = /^[\w./:@^~=,*-]+$/;
const GIT_FORBIDDEN = ["--output", "--ext-diff", "--textconv", "-c", "--exec-path", "--git-dir", "--work-tree", "-C"];
const GRADLE_EXE = new Set(["./gradlew", "gradlew", "gradlew.bat", "gradle"]);
const GRADLE_TASK = /^(:[\w-]+)*:?(classes|testClasses|compileJava|compileTestJava|test|cleanTest)$/;
const GRADLE_FLAGS = new Set(["--offline", "--console=plain", "-q", "--quiet", "--no-daemon", "--parallel", "--continue", "--stacktrace"]);
const TEST_FILTER = /^[\w.*]+$/;
const SKILL_SCRIPT = `${UNIT_TEST_SKILL_NAME}/scripts/run-coverage.sh`;

/** git accepts any unambiguous prefix of a long option (`--outp` is `--output`), so a prefix is refused too. */
function forbiddenGitArg(a: string): boolean {
  const name = a.split("=")[0]!;
  return GIT_FORBIDDEN.some((f) => a.startsWith(f) || (name.startsWith("--") && name.length > 2 && f.startsWith(name)));
}

function gitRead([exe, sub, ...rest]: string[]): boolean {
  return exe === "git" && GIT_SUBCOMMANDS.has(sub ?? "") && rest.every((a) => GIT_TOKEN.test(a) && !forbiddenGitArg(a));
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

/** Exactly the command the verify guide shows: the skill's script with this session's arguments. */
function coverageCommand([shell, script, ...rest]: string[], session: FutSession): boolean {
  if ((shell !== "sh" && shell !== "bash") || !script) return false;
  if (script.split("/").includes("..") || !`/${script}`.endsWith(`/${SKILL_SCRIPT}`)) return false;
  const want = coverageParts(session);
  if (rest.length !== 6 || rest[0] !== "--module" || rest[2] !== "--tests" || rest[4] !== "--out") return false;
  const tests = rest[3]!.split(",");
  const sameTests = tests.length === want.tests.length && new Set(tests).size === tests.length && tests.every((t) => want.tests.includes(t));
  return rest[1] === want.module && sameTests && rest[5] === want.out;
}

function bashAllowed(session: FutSession, command: string): boolean {
  if (SHELL_META.test(command)) return false;
  const t = command.trim().split(/\s+/);
  switch (session.stage) {
    case "plan":
      return gitRead(t);
    case "execute":
      return gitRead(t) || gradle(t);
    case "verify":
      return coverageCommand(t, session);
    case "report":
      return false;
  }
}

const SCRIPT = "scripts/run-coverage.sh";
const BASH_RULE =
  "bash runs one plain command, written without quotes or backslashes (e.g. `--tests com.x.FooTest`) and without ; & | < > ` $ or newlines. " +
  "plan: git diff|status|log|show|rev-parse with plain arguments. execute: that, or gradle/./gradlew with only classes, testClasses, compileJava, compileTestJava, test, cleanTest tasks (optionally :module:-prefixed), --tests <pattern> and --offline, --console=plain, -q, --quiet, --no-daemon, --parallel, --continue, --stacktrace. " +
  "verify: only the run-coverage.sh command shown in the guide, exactly.";

export const STAGES: Record<StageId, Stage> = {
  plan: {
    goal: "Decide which classes get unit tests and define every test case, then get the user's approval. Nothing is written here.",
    steps: [
      `Load the \`${UNIT_TEST_SKILL_NAME}\` skill with the skill tool and read its docs/ rules and templates/. If the skill is missing, STOP and tell the user to run \`gdc fico-check\`.`,
      'Pick the mode from the request: `--files <paths>` → "files"; `--program <ID>` → "program" (the Controller, Service and, if needed, In/Out VO whose class names start with the ID); no argument → "git" (working tree and staged changes against HEAD, or the last commit when there are none; read-only git commands are allowed in bash).',
      "Find the Gradle module of the targets (e.g. `on-stk-ord-online`) and check the Spring Boot version in the root build.gradle (below 3.4: @MockBean instead of @MockitoBean).",
      "For every public method of each target define cases: at least two normal, one boundary and one exception, plus the external classes to mock (other modules, Mappers, Redis, external API clients). A method that really needs no test gets `skip_reason` instead.",
      "Test files go under the module's src/test/java in the target's package as `<ClassName>Test.java`; a test profile may go under src/test/resources. An existing test file is extended, never replaced: keep every existing @Test method.",
      `Write the plan for the user in your reply, then call ${STAGE_TOOL} with stage "plan", the plan as \`note\` and \`inputs\` = { mode, module, targets, files, cases: [{ target, method, normal, boundary, exception, mocks, skip_reason? }] } with project-relative paths. Once it is accepted, END YOUR TURN. Any further tool call while the plan waits is refused, and repeated calls stop the turn.`,
      `After the user approves, call ${STAGE_TOOL} with stage "plan" and user_approved=true. If they ask for changes, submit a new \`note\` and \`inputs\` and ask again.`,
    ],
    tools: ["skill", "read", "glob", "grep", "bash (read-only git only)"],
    blocked: [...WRITES, "task", "bash (except read-only git)"],
    finish: "`note` = the plan with `inputs`, then `user_approved` = true after the user's reply",
  },
  execute: {
    goal: "Write the planned tests from the skill's rules and templates.",
    steps: [
      "Write only the planned `files`; any other path is refused. If another file is really needed, say so in the report.",
      "Follow the skill's format rule: @SpringBootTest, @Transactional, @BeforeEach, @AfterEach; mock every external module or resource, keep same-module pure collaborators real.",
      "Keep every existing @Test method of a file you extend. Replace every template placeholder.",
      "You may compile with gradle in bash, without quotes (e.g. `./gradlew :<module>:compileTestJava`). Failing tests are not your job to fix here; they are reported.",
    ],
    tools: ["read", "edit", "write", "grep", "bash (gradle only)"],
    blocked: ["task", "bash (except gradle and read-only git)"],
    finish: "no arguments; at least one planned file must have been written",
  },
  verify: {
    goal: "Measure. The plugin reads the build and coverage facts itself; you do not report pass or fail.",
    steps: [
      `Run the skill's \`${SCRIPT}\` with bash (the path is under the skill directory the skill tool showed) with the arguments below. It leaves status.json, jacoco.xml and test-results/ in --out.`,
      `Then call ${STAGE_TOOL} with stage "verify" and a \`note\`: for any line or branch you consider unreachable, the reason. Compile errors, static-check defects and coverage gaps send you back to execute with the details.`,
    ],
    tools: ["bash (run-coverage.sh only)", "read", "grep"],
    blocked: [...WRITES, "task", "bash (except run-coverage.sh)"],
    finish: "`note` = reasons for any gap you leave; the plugin judges from the files",
  },
  report: {
    goal: "Record what was done.",
    steps: ["Summarise the tests written, what is left uncovered and why, and the failing tests for the developer."],
    tools: [STAGE_TOOL],
    blocked: [...WRITES, "task", "bash"],
    finish: "`note` = the summary; the plugin writes report.md and closes the workflow",
  },
};

const sessions = new Map<string, FutSession>();

export function startSession(sessionId: string, request: string, cwd: string): FutSession {
  sessions.delete(sessionId);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const session: FutSession = {
    stage: "plan",
    request,
    cwd,
    previousMethods: {},
    touched: new Set(),
    roundWrites: new Set(),
    verifyBaseline: {},
    awaitingCalls: 0,
    fixRetries: 0,
    gapRounds: 0,
    verification: "pending",
    coverage: [],
    failedTests: [],
    lastProblems: [],
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): FutSession | undefined {
  return sessions.get(sessionId);
}

export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** A real user turn: the only thing that can unlock plan approval. */
export function noteUserMessage(sessionId: string, createdAt: number): void {
  const session = sessions.get(sessionId);
  if (session) noteReply(session, createdAt);
}

/** True once when the model keeps calling tools while the plan waits. */
export function takeAbortRequest(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session ? takeAbort(session) : false;
}

const slash = (p: string): string => p.trim().replace(/\\/g, "/");

/** Project-relative, `/`-separated and normalized (`a/../b` → `b`, `./x` → `x`). */
function toRelative(cwd: string, file: string): string {
  const f = slash(file);
  const rel = path.isAbsolute(f) ? path.relative(cwd, f).split(path.sep).join("/") : f;
  return rel ? path.posix.normalize(rel) : "";
}

/** A normalized path that leaves the project: `..`, `../x`, or still absolute (other drive, `C:/`). */
const escapes = (rel: string): boolean => rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel);

/**
 * Both sides are normalized project-relative paths, so only an exact match counts. A suffix
 * match would let `x/<planned>` through and then be checked as the planned file.
 */
function matchesPath(planned: string, file: string): boolean {
  return !escapes(file) && file === planned;
}

/** `a/src/test/java/x/y/ZTest.java` → `x.y.ZTest`. */
function fqcn(file: string): string | null {
  const m = /(?:^|\/)src\/test\/java\/(.+)\.java$/.exec(file);
  return m ? m[1]!.replace(/\//g, ".") : null;
}

/** The run-coverage.sh arguments for this session; the guide prints them and verify's bash gate requires them. */
function coverageParts(session: FutSession): { module: string; tests: string[]; out: string } {
  const tests = (session.inputs?.files ?? []).map(fqcn).filter((f): f is string => f !== null);
  return { module: session.inputs?.module ?? "<module>", tests, out: session.runDir ?? "<runDir>" };
}

function coverageArgs(session: FutSession): string {
  const { module, tests, out } = coverageParts(session);
  return `--module ${module} --tests ${tests.join(",") || "<FQCN,...>"} --out ${out}`;
}

export function renderStageGuide(stageId: StageId, session?: FutSession): string {
  const stage = STAGES[stageId];
  const lines = [
    `[${COMMAND_NAME}] Current stage: ${stageId} (plan → execute → verify → report)`,
    `Goal: ${stage.goal}`,
    `Skill: ${UNIT_TEST_SKILL_NAME}`,
    "Steps:",
    ...stage.steps.map((step, i) => `${i + 1}. ${step}`),
  ];
  if (stageId === "verify" && session) lines.push(`Run exactly (no quotes, no extra arguments): sh <skill dir>/${SCRIPT} ${coverageArgs(session)}`);
  if (stageId === "execute" && session?.inputs) lines.push(`Planned files: ${session.inputs.files.join(", ")}`);
  lines.push(`Recommended tools: ${stage.tools.join(", ")}`);
  lines.push(`Blocked at this stage: ${stage.blocked.join(", ")}`);
  lines.push(`To finish this stage call ${STAGE_TOOL} with stage "${stageId}": ${stage.finish}.`);
  return lines.join("\n");
}

/** The files a write-capable call is about to touch. */
function targetsOf(tool: string, args: Record<string, unknown>): string[] {
  if (typeof args.filePath === "string") return [args.filePath];
  if (tool === "apply_patch" && typeof args.patchText === "string") {
    return [...args.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1]!.trim());
  }
  return [];
}

/** Returns a rejection message, or null to allow. Sessions outside the workflow always pass. */
export function gateTool(sessionId: string, tool: string, args: Record<string, unknown>): string | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (tool !== STAGE_TOOL && awaitingReply(session)) {
    session.awaitingCalls += 1;
    return `${COMMAND_NAME}: the plan is waiting for the user's reply. Do not call ${tool} or any other tool. END YOUR TURN now.`;
  }
  const refuse = (): string => `${COMMAND_NAME}: ${tool} is not allowed in the ${session.stage} stage.\n\n${renderStageGuide(session.stage, session)}`;
  // A subagent's writes would escape this session's gate.
  if (tool === "task") return refuse();
  if (tool === "bash") {
    if (bashAllowed(session, typeof args.command === "string" ? args.command : "")) return null;
    return `${refuse()}\n${BASH_RULE}`;
  }
  if (!WRITES.includes(tool)) return null;
  if (session.stage !== "execute") return refuse();
  if (tool === "apply_patch" && typeof args.patchText === "string" && /^\*\*\* (?:Delete File|Move to):/m.test(args.patchText)) {
    return `${COMMAND_NAME}: apply_patch may not delete or move files; existing tests must be kept.`;
  }
  const planned = session.inputs?.files ?? [];
  const unplanned = targetsOf(tool, args).map((f) => toRelative(session.cwd, f)).filter((f) => !planned.some((p) => matchesPath(p, f)));
  if (unplanned.length > 0) {
    return `${COMMAND_NAME}: ${unplanned.join(", ")} is not in the approved plan. Write only the planned files: ${planned.join(", ")}. If another file is really needed, say so in the report.`;
  }
  return null;
}

/** Called after a tool succeeded: a denied or failed write is not counted. */
export function noteToolResult(sessionId: string, tool: string, args: Record<string, unknown> = {}): void {
  const session = sessions.get(sessionId);
  if (!session || !WRITES.includes(tool)) return;
  for (const file of targetsOf(tool, args)) {
    const rel = toRelative(session.cwd, file);
    session.touched.add(rel);
    session.roundWrites.add(rel);
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const paths = (v: unknown): string[] => strings(v).map(slash).filter(Boolean);
const filled = (v: unknown): number => strings(v).filter((s) => s.trim()).length;

function normalizeInputs(raw: Partial<PlanInputs>, cwd: string): PlanInputs {
  const rel = (p: string): string => toRelative(cwd, p);
  return {
    mode: raw.mode as PlanInputs["mode"],
    module: typeof raw.module === "string" ? rel(raw.module).replace(/\/$/, "") : "",
    targets: paths(raw.targets).map(rel),
    files: paths(raw.files).map(rel),
    cases: (Array.isArray(raw.cases) ? raw.cases : []).map((c: Partial<CaseDef>) => ({
      ...c,
      target: typeof c?.target === "string" ? rel(c.target) : "",
      method: typeof c?.method === "string" ? c.method : "",
      normal: strings(c?.normal),
      boundary: strings(c?.boundary),
      exception: strings(c?.exception),
      mocks: strings(c?.mocks),
    })),
  };
}

const isFile = (abs: string): boolean => fs.existsSync(abs) && fs.statSync(abs).isFile();
const isDir = (abs: string): boolean => fs.existsSync(abs) && fs.statSync(abs).isDirectory();

/** Problems per field, empty when the plan can be recorded. */
function planProblems(p: PlanInputs, cwd: string): string[] {
  const problems: string[] = [];
  const abs = (f: string): string => path.resolve(cwd, f);
  if (!["files", "program", "git"].includes(p.mode)) problems.push('mode: must be "files", "program" or "git"');
  // A Gradle path (:a:b) maps to the directory a/b, as run-coverage.sh does.
  const moduleDir = p.module.replace(/^:/, "").replace(/:/g, "/");
  if (!/^[\w.\/:-]+$/.test(p.module)) problems.push(`module: "${p.module}" may contain only letters, digits, _ . / : -`);
  else if (!moduleDir || moduleDir === "." || escapes(moduleDir) || !isDir(abs(moduleDir))) {
    problems.push(`module: "${p.module}" must be an existing module directory inside the project`);
  }
  if (p.targets.length === 0) problems.push("targets: list the classes to test");
  for (const t of p.targets) {
    if (escapes(t) || !t.endsWith(".java") || !`/${t}`.includes("/src/main/java/") || !isFile(abs(t))) {
      problems.push(`targets: ${t} must be an existing .java file under src/main/java`);
    }
  }
  if (!p.files.some((f) => f.endsWith(".java"))) problems.push("files: list at least one .java test file you will write");
  for (const f of p.files) {
    const ok = !escapes(f) && `/${f}`.includes("/src/test/") && (f.endsWith(".java") || `/${f}`.includes("/src/test/resources/"));
    if (!ok) problems.push(`files: ${f} must be a .java file under src/test or a file under src/test/resources, inside the project`);
    // verify allows bash only for run-coverage.sh; a planned file of that name could forge its facts.
    else if (path.posix.basename(f).toLowerCase().endsWith("run-coverage.sh")) problems.push(`files: ${f} may not be named like run-coverage.sh`);
    else if (f.endsWith(".java") && !/^[\w.]+$/.test(fqcn(f) ?? "")) problems.push(`files: ${f} must be under src/test/java with a plain package path (it becomes a --tests class name)`);
  }
  for (const c of p.cases) {
    const where = `cases: ${c.target || "(no target)"}#${c.method || "(no method)"}`;
    if (!p.targets.includes(c.target)) problems.push(`${where}: target is not in targets`);
    if (c.skip_reason?.trim()) continue;
    if (filled(c.normal) < 2) problems.push(`${where}: needs at least 2 normal cases`);
    if (filled(c.boundary) < 1) problems.push(`${where}: needs at least 1 boundary case`);
    if (filled(c.exception) < 1) problems.push(`${where}: needs at least 1 exception case`);
  }
  for (const t of p.targets) if (!p.cases.some((c) => c.target === t)) problems.push(`cases: ${t} has no case (or skip_reason)`);
  return problems;
}

function submitPlan(session: FutSession, input: StageInput): string {
  if (!input.note?.trim()) return "Rejected: the plan needs a `note` describing it for the user.";
  const inputs = normalizeInputs(input.inputs ?? {}, session.cwd);
  const problems = planProblems(inputs, session.cwd);
  if (problems.length > 0) {
    return `Rejected: the plan is not valid. Fix these fields and submit again:\n${problems.map((p) => `- ${p}`).join("\n")}`;
  }
  session.previousMethods = {};
  for (const f of inputs.files) {
    const abs = path.resolve(session.cwd, f);
    if (f.endsWith(".java") && isFile(abs)) session.previousMethods[f] = testMethodNames(fs.readFileSync(abs, "utf-8"));
  }
  session.inputs = inputs;
  session.plan = input.note;
  session.planAt = Date.now();
  session.userRepliedAt = undefined;
  session.awaitingCalls = 0;
  return "Plan recorded. Show it to the user and END YOUR TURN; do not continue until they reply.";
}

function advance(session: FutSession, to: StageId, lead: string): string {
  session.stage = to;
  if (to === "execute") {
    session.runDir ??= `${REPORT_DIR}/report-${localFileStamp()}`;
    session.roundWrites.clear();
  }
  if (to === "verify") {
    session.verifyStartedAt = Date.now();
    session.verifyBaseline = {};
    for (const name of ["status.json", "jacoco.xml"]) {
      const file = path.join(session.cwd, session.runDir!, name);
      if (isFile(file)) session.verifyBaseline[name] = fs.statSync(file).mtimeMs;
    }
  }
  return `${lead}\n\n${renderStageGuide(to, session)}`;
}

/** The file when run-coverage.sh wrote it during this verify stage, else null. */
function freshFile(session: FutSession, name: string): string | null {
  const file = path.join(session.cwd, session.runDir!, name);
  if (!isFile(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const baseline = session.verifyBaseline[name];
  if (baseline !== undefined && mtime <= baseline) return null;
  return mtime >= (session.verifyStartedAt ?? 0) - MTIME_SLACK_MS ? file : null;
}

/** Static-check defects of the written test classes, as `file: defect`. */
function testDefects(session: FutSession): string[] {
  const defects: string[] = [];
  for (const file of session.touched) {
    if (!file.endsWith(".java")) continue;
    const abs = path.resolve(session.cwd, file);
    if (!isFile(abs)) {
      defects.push(`${file}: file does not exist`);
      continue;
    }
    const cls = path.posix.basename(file, ".java").replace(/Test$/, "");
    const mocks = [...new Set((session.inputs?.cases ?? []).filter((c) => path.posix.basename(c.target, ".java") === cls).flatMap((c) => c.mocks))];
    const found = checkTestSource(fs.readFileSync(abs, "utf-8"), { mocks, previousMethods: session.previousMethods[file] });
    defects.push(...found.map((d) => `${file}: ${d}`));
  }
  return defects;
}

function describeGap(c: TargetCoverage): string {
  if (!c.coverage) return `- ${c.target}: not in jacoco.xml (no test executed it)`;
  const { line, branch, uncoveredLines, partialLines } = c.coverage;
  const parts = [`lines ${line.covered}/${line.covered + line.missed}`, `branches ${branch.covered}/${branch.covered + branch.missed}`];
  if (uncoveredLines.length > 0) parts.push(`uncovered lines ${uncoveredLines.join(", ")}`);
  if (partialLines.length > 0) parts.push(`partly covered branches at lines ${partialLines.join(", ")}`);
  return `- ${c.target}: ${parts.join("; ")}`;
}

function sendBackToFix(session: FutSession, problems: string[]): string {
  session.lastProblems = problems;
  session.fixRetries += 1;
  const detail = problems.join("\n");
  if (session.fixRetries > MAX_FIX_RETRIES) {
    session.verification = "incomplete";
    return advance(session, "report", `Fix limit (${MAX_FIX_RETRIES}) reached. Report this run as INCOMPLETE.\n${detail}`);
  }
  return advance(session, "execute", `Back to execute (fix ${session.fixRetries}/${MAX_FIX_RETRIES}). Fix:\n${detail}`);
}

const RERUN = `Rejected: run run-coverage.sh first in this verify stage (its status.json and jacoco.xml must be newer than the stage entry).`;

function completeVerify(session: FutSession, input: StageInput): string {
  if (!input.note?.trim()) return "Rejected: verify needs a `note` (the reason for any line or branch you leave uncovered, or \"none\").";
  const statusFile = freshFile(session, "status.json");
  if (!statusFile) return `${RERUN}\n\n${renderStageGuide("verify", session)}`;
  let status: { compile?: string; log?: string; coverage?: string };
  try {
    status = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as typeof status;
  } catch {
    return `Rejected: ${session.runDir}/status.json is not valid JSON. Run run-coverage.sh again.`;
  }
  session.verifyNote = input.note;
  session.failedTests = readFailedTests(path.join(session.cwd, session.runDir!, "test-results"));

  if (status.compile !== "ok") return sendBackToFix(session, [`Test compilation failed:\n${status.log ?? "(no log)"}`]);
  const defects = testDefects(session);
  if (defects.length > 0) return sendBackToFix(session, [`The plugin found defects in the tests:\n${defects.join("\n")}`]);
  // Compiled but no coverage: the test run itself broke. Bounded by the fix retries, not an endless rerun.
  if (status.coverage === "missing") return sendBackToFix(session, [`Tests compiled but produced no coverage:\n${status.log ?? "(no log)"}`]);
  const xmlFile = freshFile(session, "jacoco.xml");
  if (!xmlFile) return `${RERUN}\n\n${renderStageGuide("verify", session)}`;

  const xml = fs.readFileSync(xmlFile, "utf-8");
  session.coverage = (session.inputs?.targets ?? []).map((target) => ({ target, coverage: readCoverage(xml, target) }));
  const gaps = session.coverage.filter((c) => !isFullyCovered(c.coverage));
  const failed = session.failedTests.length > 0 ? `\nFailing tests (reported, not blocking): ${session.failedTests.join(", ")}` : "";
  if (gaps.length === 0) {
    session.verification = "covered";
    return advance(session, "report", `Every target is fully covered.${failed}`);
  }
  const detail = gaps.map(describeGap).join("\n");
  if (session.gapRounds < MAX_COVERAGE_ROUNDS) {
    session.gapRounds += 1;
    return advance(session, "execute", `Coverage gaps (round ${session.gapRounds}/${MAX_COVERAGE_ROUNDS}). Add cases for:\n${detail}${failed}`);
  }
  session.verification = "gaps";
  return advance(session, "report", `Coverage rounds (${MAX_COVERAGE_ROUNDS}) used up. Report the remaining gaps with their reasons:\n${detail}${failed}`);
}

const pct = (c: { missed: number; covered: number }): string => {
  const total = c.missed + c.covered;
  return total === 0 ? "-" : `${c.covered}/${total} (${Math.round((c.covered / total) * 100)}%)`;
};

const VERDICT: Record<Verification, string> = {
  pending: "측정 안 됨",
  covered: "전부 커버됨",
  gaps: `공백 남음 (보강 ${MAX_COVERAGE_ROUNDS}회 소진)`,
  incomplete: `미완료 (수정 재시도 ${MAX_FIX_RETRIES}회 초과)`,
};

function writeReport(session: FutSession, summary: string): string {
  session.runDir ??= `${REPORT_DIR}/report-${localFileStamp()}`;
  const dir = path.join(session.cwd, session.runDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.md");
  const rows = session.coverage.map((c) =>
    c.coverage ? `| ${c.target} | ${pct(c.coverage.line)} | ${pct(c.coverage.branch)} |` : `| ${c.target} | jacoco.xml에 없음 | - |`,
  );
  const gaps = session.coverage
    .filter((c) => !isFullyCovered(c.coverage))
    .map((c) =>
      c.coverage
        ? `- ${c.target}: 미실행 줄 ${c.coverage.uncoveredLines.join(", ") || "없음"}, 분기 일부 미실행 줄 ${c.coverage.partialLines.join(", ") || "없음"}`
        : `- ${c.target}: 어떤 테스트도 실행하지 않음`,
    );
  const body = [
    "# f-unit-test-code 리포트",
    "",
    `- 요청: ${session.request}`,
    `- 모드: ${session.inputs?.mode ?? "-"}, 모듈: ${session.inputs?.module ?? "-"}`,
    `- 검증 결과: ${VERDICT[session.verification]}`,
    `- 재시도: 수정 ${session.fixRetries}회, 커버리지 보강 ${session.gapRounds}회`,
    "",
    "## 대상",
    ...(session.inputs?.targets ?? []).map((t) => `- ${t}`),
    "",
    "## 테스트 파일",
    ...[...session.touched].sort().map((f) => `- ${f}`),
    "",
    "## 커버리지",
    ...(rows.length > 0 ? ["| 대상 | 라인 | 분기 |", "|---|---|---|", ...rows] : ["측정 결과 없음"]),
    "",
    ...(gaps.length > 0 ? ["## 남은 공백", ...gaps, ""] : []),
    ...(session.verification === "incomplete" ? ["## 마지막 오류", ...session.lastProblems, ""] : []),
    "## 실패한 테스트",
    ...(session.failedTests.length > 0 ? session.failedTests.map((t) => `- ${t}`) : ["없음"]),
    "",
    "## 검증 메모",
    session.verifyNote ?? "",
    "",
    "## 계획",
    session.plan ?? "",
    "",
    "## 요약",
    summary,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

/** Compared after normalization; a reordered list counts as a revision (harmless: the plan is recorded again). */
function sameInputs(a: Partial<PlanInputs>, session: FutSession): boolean {
  return session.inputs !== undefined && JSON.stringify(normalizeInputs(a, session.cwd)) === JSON.stringify(session.inputs);
}

export function completeStage(sessionId: string, input: StageInput): string {
  const session = sessions.get(sessionId);
  if (!session) return `No /${COMMAND_NAME} workflow is active in this session.`;
  if (input.stage !== session.stage) {
    return `Rejected: the current stage is ${session.stage}, not ${input.stage}.\n\n${renderStageGuide(session.stage, session)}`;
  }

  switch (session.stage) {
    case "plan": {
      // Same rule as pb-online: changed inputs always re-plan; a reworded note only when it is not an approval.
      const inputsChanged = input.inputs !== undefined && !sameInputs(input.inputs, session);
      const reworded = input.note !== session.plan && !input.user_approved;
      if (input.note !== undefined && (!session.plan || inputsChanged || reworded)) return submitPlan(session, input);
      if (!session.plan || session.planAt === undefined) return "Rejected: submit the plan as `note` with `inputs` first.";
      if (awaitingReply(session)) {
        session.awaitingCalls += 1;
        return "Rejected: the plan is recorded and the user has not replied yet. Do not call any tool. END YOUR TURN now.";
      }
      if (!input.user_approved) return "Rejected: pass user_approved=true once the user approved, or a revised `note`.";
      return advance(session, "execute", "Plan approved.");
    }
    case "execute":
      if (session.roundWrites.size === 0) {
        return session.touched.size === 0
          ? "Rejected: no planned file has been written yet."
          : "Rejected: nothing was written in this round. Fix the listed problems in the planned files before finishing execute.";
      }
      return advance(session, "verify", `Written: ${[...session.touched].join(", ")}`);
    case "verify":
      return completeVerify(session, input);
    case "report": {
      if (!input.note?.trim()) return "Rejected: report needs a `note` with the summary.";
      const file = writeReport(session, input.note);
      sessions.delete(sessionId);
      return `Report written: ${file}\nWorkflow closed. Tell the user the test files, the coverage result, the failing tests and the report path.`;
    }
  }
}

export const COMMAND_DESCRIPTION = "FICO 완성 Java 코드의 단위 테스트 생성 (JaCoCo 커버리지 확인)";

export const STAGE_TOOL_DESCRIPTION =
  "Finish the current stage of the /f-unit-test-code workflow (plan, execute, verify, report) and get the next stage's guide. Only callable meaningfully while that workflow is active.";

export const COMMAND_TEMPLATE = `Generate unit tests for finished Java code by following the stages below. The plugin enforces them: tools outside the current stage are rejected, verify is judged from the coverage script's files, and every ${STAGE_TOOL} result tells you the next stage.

${renderStageGuide("plan")}

User request: $ARGUMENTS`;
