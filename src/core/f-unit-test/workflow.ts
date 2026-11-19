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
import { isFullyCovered, readCoverage, readFailedDetails, type FailedTest, type FileCoverage } from "./coverage";
import { checkTestSource, testMethodBodies, testMethodNames } from "./test-check";
import { writeReport } from "./report";
import { checkMapperTargets, isPlainInterface, mapperDefects, type MapperCheck } from "./mapper";
import { BASH_RULE, bashAllowed, coverageCommandLine, coverageScriptName, type BashContext } from "./bash-gate";
import { environmentFailureLine } from "./env-failure";

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

/** An existing @Test method the user approved to change because this code change breaks it. */
export interface ExistingUpdate {
  file: string;
  test: string;
  /** Why it breaks and the new expectation, e.g. "age 45: 12000 → 11000 (band 40 → 50)". */
  reason: string;
}

export interface PlanInputs {
  mode: "files" | "program" | "git";
  module: string;
  targets: string[];
  files: string[];
  cases: CaseDef[];
  update_existing?: ExistingUpdate[];
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
  /** Normalized bodies of those methods (file → name → body), to find edits the plan did not approve. */
  previousBodies: Record<string, Record<string, string>>;
  /** Test files named by the first plan: an amended plan may not add others (they would have no trustworthy baseline). */
  baselineFiles: string[];
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
  /** The same failures with message, exception type and stack frame, for the report. */
  failedDetails: FailedTest[];
  /** Mapper targets (judged by the static call check, not JaCoCo) with which methods the planned test calls. */
  mapperChecks: MapperCheck[];
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
/** What the plan cannot do without; shared by the plan guide and the plan rejection text. */
const ASK_USER_WHEN =
  "(1) the target: no --files and no --program was given and git shows no changed Java file, or the --program ID matches no Controller/Service class, or a --files path does not exist; (2) the Gradle module, when the targets sit in none or in several modules; (3) the case details you cannot derive from the code, such as which exception a branch is meant to raise; (4) for a Mapper target, the test profile: the project has several (e.g. test, test-oracle, test-postgres) and the request does not say which, or has none (never invent an H2 profile); (5) for a Mapper on a non-primary datasource (e.g. secondary, ext), the transaction manager bean name, when the project's datasource config classes do not show it";
const ASK_USER_NOTE = `If a value cannot be determined from the request or the project, ask the user for it and END YOUR TURN; do not guess or leave placeholders. Then submit the plan again.`;
const WINDOWS_NOTE = "Windows uses the PowerShell script `scripts/run-coverage.ps1`; its execution is not verified in the development environment.";

export const STAGES: Record<StageId, Stage> = {
  plan: {
    goal: "Decide which classes get unit tests and define every test case, then get the user's approval. Nothing is written here.",
    steps: [
      `Load the \`${UNIT_TEST_SKILL_NAME}\` skill with the skill tool and read its docs/ rules and templates/. If the skill is missing, STOP and tell the user to run \`gdc fico-check\`.`,
      'Pick the mode from the request: `--files <paths>` → "files"; `--program <ID>` → "program" (the Controller, Service and, if needed, In/Out VO whose class names start with the ID); no argument → "git" (working tree and staged changes against HEAD, or the last commit when there are none; read-only git commands are allowed in bash).',
      "Find the Gradle module of the targets (e.g. `on-stk-ord-online`) and check the Spring Boot version in the root build.gradle (below 3.4: @MockBean instead of @MockitoBean).",
      `If a required input is missing or cannot be settled from the request and the project, ASK THE USER and END YOUR TURN before doing anything else; never guess and never put a placeholder in \`inputs\`. Required inputs: ${ASK_USER_WHEN}.`,
      "For every public method of each target define cases: at least two normal, one boundary and one exception, plus the external classes to mock (other modules, Mappers, Redis, external API clients). A method that really needs no test gets `skip_reason` instead.",
      "A MyBatis Mapper interface (`@Mapper` from org.apache.ibatis, or a `*Mapper.java` interface in a mapper/mappers/repo/repository/dao/persistence package that does not use MapStruct) is tested against the real DB of the test profile, not mocked: give it its own case(s) covering every method, put the chosen test profile in the plan `note`, and list no mocks for it. If the project has several test profiles or none, ask the user which to use and END YOUR TURN. In --program mode include the Mappers the target Service uses in the same Gradle module; a Mapper of another module must be named with --files and its test goes in that module. Controller and Service tests still mock their Mappers. A class-level @Transactional rolls back only the default transaction manager: for a Mapper on a non-primary datasource the test must use `@Transactional(\"<transactionManager bean>\")`; read the bean name from the datasource config classes, put it in the plan `note`, and ask the user when it cannot be read. A bulk-delete method (`deleteAll`, `truncate*`) may get `skip_reason`.",
      "Test files go under the module's src/test/java in the target's package as `<ClassName>Test.java`; a test profile may go under src/test/resources. An existing test file is extended, never replaced: keep every existing @Test method.",
      "When the change under test alters behavior that an existing @Test asserts (typical in git mode: a threshold, a fee, an error code changed), that test will fail. Read the existing tests of each planned file against the new code, list every one this change breaks in `update_existing` = [{ file, test, reason }] (reason = what changed and the new expected value, e.g. \"age 45: 12000 → 11000, band 40 → 50\") and show the same list in the plan `note`. Only tests broken by this change go there; leave passing tests and old-format tests as they are. If you are not sure the change is intended (it could be a regression), say so in the note and let the user decide.",
      `Write the plan for the user in your reply, in Korean (or the language the user wrote to you in); never switch to another language such as Chinese or Russian. Then call ${STAGE_TOOL} with stage "plan", the plan as \`note\` and \`inputs\` = { mode, module, targets, files, cases: [{ target, method, normal, boundary, exception, mocks, skip_reason? }], update_existing?: [{ file, test, reason }] } with project-relative paths. Once it is accepted, END YOUR TURN. Any further tool call while the plan waits is refused, and repeated calls stop the turn.`,
      `After the user approves, call ${STAGE_TOOL} with ONLY stage "plan" and user_approved=true (no note, no inputs: any change to them is a new plan that needs a new approval). If they ask for changes, submit a new \`note\` and \`inputs\` and ask again.`,
    ],
    tools: ["skill", "read", "glob", "grep", "bash (read-only git only)"],
    blocked: [...WRITES, "task", "bash (except read-only git)"],
    finish: "`note` = the plan with `inputs`, then `user_approved` = true after the user's reply",
  },
  execute: {
    goal: "Write the planned tests from the skill's rules and templates.",
    steps: [
      "Write only the planned `files`; any other path is refused. If another file is really needed, say so in the report.",
      "Follow the skill's format rule: @SpringBootTest, @Transactional, @BeforeEach, @AfterEach; mock every external module or resource (a Mapper test is the exception: the Mapper under test is real and runs on the planned profile), keep same-module pure collaborators real.",
      "Keep every existing @Test method of a file you extend. Change an existing @Test only when the approved plan lists it in `update_existing`, and then only its expected values (and the input, if the change requires it) so it matches the new behavior; never delete it, rename it or add @Disabled. Any other existing @Test must stay byte-for-byte as it was. If you find that another existing @Test must change, do not work around it (adapters, wrappers): call ${STAGE_TOOL} with stage \"plan\", a new `note` and `inputs` that add it to `update_existing`, and wait for the user's approval. Replace every template placeholder.",
      "You may compile with gradle in bash, without quotes (e.g. `./gradlew :<module>:compileTestJava`; `--tests` takes a full test class name, no wildcards). Failing tests are not your job to fix here; they are reported.",
    ],
    tools: ["read", "edit", "write", "grep", "bash (gradle only)"],
    blocked: ["task", "bash (except gradle and read-only git)"],
    finish: "no arguments; at least one planned file must have been written",
  },
  verify: {
    goal: "Measure. The plugin reads the build and coverage facts itself; you do not report pass or fail.",
    steps: [
      `Run the skill's coverage script (\`scripts/run-coverage.sh\` with sh, or \`scripts/run-coverage.ps1\` with PowerShell on Windows) with bash using exactly the command below. It leaves status.json, jacoco.xml and test-results/ in the output directory. ${WINDOWS_NOTE}`,
      `Then call ${STAGE_TOOL} with stage "verify" and a \`note\`: for any line or branch you consider unreachable, the reason. Compile errors, static-check defects and coverage gaps send you back to execute with the details.`,
    ],
    tools: ["bash (run-coverage.sh/.ps1 only)", "read", "grep"],
    blocked: [...WRITES, "task", "bash (except run-coverage.sh/.ps1)"],
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
    previousBodies: {},
    baselineFiles: [],
    touched: new Set(),
    roundWrites: new Set(),
    verifyBaseline: {},
    awaitingCalls: 0,
    fixRetries: 0,
    gapRounds: 0,
    verification: "pending",
    coverage: [],
    failedTests: [],
    failedDetails: [],
    mapperChecks: [],
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

const bashContext = (session: FutSession): BashContext => ({ cwd: session.cwd, coverage: coverageParts(session) });

/** `platform` picks the verify command (PowerShell on win32); tests pass it instead of mocking process.platform. */
export function renderStageGuide(stageId: StageId, session?: FutSession, platform: NodeJS.Platform = process.platform): string {
  const stage = STAGES[stageId];
  const lines = [
    `[${COMMAND_NAME}] Current stage: ${stageId} (plan → execute → verify → report)`,
    `Goal: ${stage.goal}`,
    `Skill: ${UNIT_TEST_SKILL_NAME}`,
    "Steps:",
    ...stage.steps.map((step, i) => `${i + 1}. ${step}`),
  ];
  if (stageId === "verify" && session) {
    const command = coverageCommandLine(bashContext(session), platform);
    lines.push(
      command
        ? `Run exactly (no quotes, no extra arguments): ${command}`
        : "The global skill path contains whitespace, so no command can pass the bash gate. Tell the user to run `gdc fico-init` in this project (it installs the skill under .opencode/skills) and END YOUR TURN.",
    );
  }
  if (stageId === "execute" && session?.inputs) lines.push(`Planned files: ${session.inputs.files.join(", ")}`);
  lines.push(`Recommended tools: ${stage.tools.join(", ")}`);
  lines.push(`Blocked at this stage: ${stage.blocked.join(", ")}`);
  lines.push(`To finish this stage call ${STAGE_TOOL} with stage "${stageId}": ${stage.finish}.`);
  return lines.join("\n");
}

/** The files a write-capable call is about to touch. */
function targetsOf(args: Record<string, unknown>): string[] {
  if (typeof args.filePath === "string") return [args.filePath];
  if (typeof args.patchText === "string") {
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
    if (bashAllowed(session.stage, typeof args.command === "string" ? args.command : "", bashContext(session))) return null;
    return `${refuse()}\n${BASH_RULE}`;
  }
  if (!WRITES.includes(tool)) return null;
  if (session.stage !== "execute") return refuse();
  if (tool === "apply_patch" && typeof args.patchText === "string" && /^\*\*\* (?:Delete File|Move to):/m.test(args.patchText)) {
    return `${COMMAND_NAME}: apply_patch may not delete or move files; existing tests must be kept.`;
  }
  const planned = session.inputs?.files ?? [];
  // Fail closed: a write whose target cannot be read from its arguments cannot be checked against the plan.
  if (targetsOf(args).length === 0) return `${COMMAND_NAME}: ${tool} was refused because its target file could not be determined. Use write or edit with filePath for a planned file.`;
  const unplanned = targetsOf(args).map((f) => toRelative(session.cwd, f)).filter((f) => !planned.some((p) => matchesPath(p, f)));
  if (unplanned.length > 0) {
    return `${COMMAND_NAME}: ${unplanned.join(", ")} is not in the approved plan. Write only the planned files: ${planned.join(", ")}. If another file is really needed, say so in the report.`;
  }
  return null;
}

/** Called after a tool succeeded: a denied or failed write is not counted. */
export function noteToolResult(sessionId: string, tool: string, args: Record<string, unknown> = {}): void {
  const session = sessions.get(sessionId);
  if (!session || !WRITES.includes(tool)) return;
  for (const file of targetsOf(args)) {
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
    update_existing: (Array.isArray(raw.update_existing) ? raw.update_existing : []).map((u: Partial<ExistingUpdate>) => ({
      file: typeof u?.file === "string" ? rel(slash(u.file)) : "",
      test: typeof u?.test === "string" ? u.test.trim() : "",
      reason: typeof u?.reason === "string" ? u.reason.trim() : "",
    })),
  };
}

const isFile = (abs: string): boolean => fs.existsSync(abs) && fs.statSync(abs).isFile();
const isDir = (abs: string): boolean => fs.existsSync(abs) && fs.statSync(abs).isDirectory();

/** Problems per field, empty when the plan can be recorded. */
function planProblems(p: PlanInputs, cwd: string, raw: Partial<PlanInputs> = {}): string[] {
  const problems: string[] = [];
  if (raw.update_existing !== undefined && !Array.isArray(raw.update_existing)) problems.push("update_existing: must be an array of {file, test, reason}");
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
    // verify allows bash only for run-coverage.sh/.ps1; a planned file of that name could forge its facts.
    else if (/run-coverage\.(sh|ps1)$/.test(path.posix.basename(f).toLowerCase())) problems.push(`files: ${f} may not be named like run-coverage.sh or run-coverage.ps1`);
    else if (f.endsWith(".java") && !/^[\w.]+$/.test(fqcn(f) ?? "")) problems.push(`files: ${f} must be under src/test/java with a plain package path (it becomes a --tests class name)`);
  }
  for (const c of p.cases) {
    const where = `cases: ${c.target || "(no target)"}#${c.method || "(no method)"}`;
    if (!p.targets.includes(c.target)) problems.push(`${where}: target is not in targets`);
    if ("update_existing" in c) problems.push(`${where}: \`update_existing\` belongs at the top level of \`inputs\` (a sibling of \`cases\`), not inside a case`);
    for (const m of c.mocks) {
      if (!/^[\w.$]+$/.test(m)) problems.push(`${where}: mock "${m}" must be a class name only (simple or fully qualified, e.g. AccountBSM), without module names, methods or spaces`);
    }
    if (c.skip_reason?.trim()) continue;
    if (filled(c.normal) < 2) problems.push(`${where}: needs at least 2 normal cases`);
    if (filled(c.boundary) < 1) problems.push(`${where}: needs at least 1 boundary case`);
    if (filled(c.exception) < 1) problems.push(`${where}: needs at least 1 exception case`);
  }
  for (const t of p.targets) if (!p.cases.some((c) => c.target === t)) problems.push(`cases: ${t} has no case (or skip_reason)`);
  for (const u of p.update_existing ?? []) {
    const where = `update_existing: ${u.file || "(no file)"}#${u.test || "(no test)"}`;
    if (!p.files.includes(u.file)) problems.push(`${where}: file must be one of files`);
    else if (!isFile(abs(u.file)) || !testMethodNames(fs.readFileSync(abs(u.file), "utf-8")).includes(u.test)) {
      problems.push(`${where}: must be an existing @Test method of that file`);
    }
    if (!u.reason) problems.push(`${where}: needs a reason (why this change breaks it and the new expectation)`);
  }
  return problems;
}

function submitPlan(session: FutSession, input: StageInput, keepBaseline = false): string {
  if (!input.note?.trim()) return `Rejected: the plan needs a \`note\` describing it for the user.\n${ASK_USER_NOTE}`;
  const inputs = normalizeInputs(input.inputs ?? {}, session.cwd);
  const problems = planProblems(inputs, session.cwd, input.inputs ?? {});
  if (problems.length > 0) {
    return `Rejected: the plan is not valid. Fix these fields and submit again:\n${problems.map((p) => `- ${p}`).join("\n")}\n${ASK_USER_NOTE}`;
  }
  // An amended plan keeps the bodies recorded at the first plan: files written since then must not become the baseline.
  if (keepBaseline) {
    const added = inputs.files.filter((f) => !session.baselineFiles.includes(f));
    if (added.length > 0) return `Rejected: an amended plan cannot add test files (${added.join(", ")}); they have no baseline from the first plan. Keep the first plan's files.\n${ASK_USER_NOTE}`;
  } else {
    session.previousMethods = {};
    session.previousBodies = {};
    session.baselineFiles = [...inputs.files];
  }
  for (const f of keepBaseline ? [] : inputs.files) {
    const abs = path.resolve(session.cwd, f);
    if (!f.endsWith(".java") || !isFile(abs)) continue;
    const src = fs.readFileSync(abs, "utf-8");
    session.previousMethods[f] = testMethodNames(src);
    session.previousBodies[f] = testMethodBodies(src);
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

/**
 * The Mapper a test file tests, by simple name: the planned test of a MyBatis Mapper target, or by file name
 * `<X>MapperTest.java` / `<X>RepoTest.java`. Undefined for any other test.
 */
function mapperUnderTest(file: string, checks: MapperCheck[]): string | undefined {
  const planned = checks.find((c) => c.testFile === file);
  if (planned) return path.posix.basename(planned.target, ".java");
  return /^(\w+(?:Mapper|Repo))Test\.java$/.exec(path.posix.basename(file))?.[1];
}

/** Static-check defects of the written test classes, as `file: defect`. */
function testDefects(session: FutSession, checks: MapperCheck[]): string[] {
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
    const mapper = mapperUnderTest(file, checks);
    const found = checkTestSource(fs.readFileSync(abs, "utf-8"), {
      mocks,
      previousMethods: session.previousMethods[file],
      previousBodies: session.previousBodies[file],
      allowedUpdates: (session.inputs?.update_existing ?? []).filter((u) => u.file === file).map((u) => u.test),
      requireTransactional: mapper !== undefined,
      mapperUnderTest: mapper,
    });
    defects.push(...found.map((d) => `${file}: ${d}`));
  }
  return defects;
}

/** Mapper targets with a case to test, each with the methods the planned test calls. */
function mapperChecksOf(session: FutSession): MapperCheck[] {
  const cases = session.inputs?.cases ?? [];
  const tested = (session.inputs?.targets ?? []).filter((t) => cases.some((c) => c.target === t && !c.skip_reason?.trim()));
  const skipped = (t: string): string[] => cases.filter((c) => c.target === t && c.skip_reason?.trim()).map((c) => c.method);
  return checkMapperTargets(session.cwd, tested, (session.inputs?.files ?? []).filter((f) => f.endsWith(".java")), skipped);
}

/** Targets with at least one case to test (not every case has skip_reason). */
function testedTargets(session: FutSession): string[] {
  const cases = session.inputs?.cases ?? [];
  return (session.inputs?.targets ?? []).filter((t) => cases.some((c) => c.target === t && !c.skip_reason?.trim()));
}

/**
 * Tested targets that are plain interfaces but not MyBatis Mappers (e.g. a Service interface): an interface has no
 * executable lines, so JaCoCo can never measure it. Reported as unmeasured; no call check either.
 */
export function interfaceTargets(session: FutSession): string[] {
  const mappers = new Set(mapperChecksOf(session).map((m) => m.target));
  return testedTargets(session).filter((t) => {
    const abs = path.resolve(session.cwd, t);
    return !mappers.has(t) && isFile(abs) && isPlainInterface(fs.readFileSync(abs, "utf-8"));
  });
}

/** Targets JaCoCo judges: tested, not a Mapper (its SQL is in XML) and not an interface. A target whose every case has skip_reason is only reported as skipped. */
export function measuredTargets(session: FutSession): string[] {
  const unmeasured = new Set([...mapperChecksOf(session).map((m) => m.target), ...interfaceTargets(session)]);
  return testedTargets(session).filter((t) => !unmeasured.has(t));
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

/**
 * A build that failed on dependency resolution or the network: not a test-code defect, so it stays in verify
 * (no new write needed) and the model must hand it to the user. Still a fix retry, so the loop ends.
 */
function environmentFailure(session: FutSession, line: string): string {
  const reason = `The build failed on a dependency/network problem in the environment, not in the tests: ${line}`;
  session.lastProblems = [reason];
  session.fixRetries += 1;
  if (session.fixRetries > MAX_FIX_RETRIES) {
    session.verification = "incomplete";
    return advance(session, "report", `Fix limit (${MAX_FIX_RETRIES}) reached. Report this run as INCOMPLETE.\n${reason}`);
  }
  // The same status.json must not be judged again: the next verify needs a fresh run of the script.
  session.verifyBaseline["status.json"] = fs.statSync(path.join(session.cwd, session.runDir!, "status.json")).mtimeMs;
  return [
    `Rejected (fix retry ${session.fixRetries}/${MAX_FIX_RETRIES}): this is a dependency/network problem in the environment, not in the test code.`,
    `First matching line: ${line}`,
    "So do NOT edit the tests. Tell the user what failed (for example a Nexus/repository rate limit, authentication or network failure) and END YOUR TURN.",
    `After the user has fixed it, run the coverage script again and call ${STAGE_TOOL} with stage "verify" again.`,
  ].join("\n");
}

/** The script name the verify guide prints on this machine, for rejection texts. */
const SCRIPT_NAME = coverageScriptName();
const RERUN = `Rejected: run ${SCRIPT_NAME} first in this verify stage (its status.json and jacoco.xml must be newer than the stage entry).`;

/** A verify call without fresh facts. It burns a fix retry so a run that never measures still ends. */
function rerun(session: FutSession): string {
  session.fixRetries += 1;
  if (session.fixRetries > MAX_FIX_RETRIES) {
    session.verification = "incomplete";
    session.lastProblems = [`verify was called without fresh ${SCRIPT_NAME} results (status.json/jacoco.xml) too many times`];
    return advance(session, "report", `Fix limit (${MAX_FIX_RETRIES}) reached without coverage results. Report this run as INCOMPLETE.`);
  }
  return `${RERUN} This counts as a fix retry (${session.fixRetries}/${MAX_FIX_RETRIES}).\n\n${renderStageGuide("verify", session)}`;
}

function completeVerify(session: FutSession, input: StageInput): string {
  if (!input.note?.trim()) return "Rejected: verify needs a `note` (the reason for any line or branch you leave uncovered, or \"none\").";
  const statusFile = freshFile(session, "status.json");
  if (!statusFile) return rerun(session);
  let status: { compile?: string; log?: string; coverage?: string };
  try {
    status = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as typeof status;
  } catch {
    return `Rejected: ${session.runDir}/status.json is not valid JSON. Run ${SCRIPT_NAME} again.`;
  }
  session.verifyNote = input.note;
  session.failedDetails = readFailedDetails(path.join(session.cwd, session.runDir!, "test-results"));
  session.failedTests = session.failedDetails.map((d) => d.id);

  // Compile failure, or a test step that left no coverage: either can be the environment's (resolution, network).
  const envLine = status.compile === "fail" || status.coverage === "missing" ? environmentFailureLine(status.log ?? "") : null;
  if (envLine) return environmentFailure(session, envLine);
  if (status.compile !== "ok") return sendBackToFix(session, [`Test compilation failed:\n${status.log ?? "(no log)"}`]);
  session.mapperChecks = mapperChecksOf(session);
  const defects = [...testDefects(session, session.mapperChecks), ...mapperDefects(session.mapperChecks)];
  if (defects.length > 0) return sendBackToFix(session, [`The plugin found defects in the tests:\n${defects.join("\n")}`]);
  // Compiled but no coverage: the test run itself broke. Bounded by the fix retries, not an endless rerun.
  if (status.coverage === "missing") return sendBackToFix(session, [`Tests compiled but produced no coverage:\n${status.log ?? "(no log)"}`]);
  const xmlFile = freshFile(session, "jacoco.xml");
  if (!xmlFile) return rerun(session);

  const xml = fs.readFileSync(xmlFile, "utf-8");
  session.coverage = measuredTargets(session).map((target) => ({ target, coverage: readCoverage(xml, target) }));
  const gaps = session.coverage.filter((c) => !isFullyCovered(c.coverage));
  const failed =
    session.failedDetails.length > 0
      ? `\nFailing tests (reported with their cause, not blocking, never edited or disabled):\n${session.failedDetails.map((d) => `- ${d.id}: ${d.message || d.type || "(no message)"}`).join("\n")}`
      : "";
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

/** Compared after normalization; a reordered list counts as a revision (harmless: the plan is recorded again). */
function sameInputs(a: Partial<PlanInputs>, session: FutSession): boolean {
  return session.inputs !== undefined && JSON.stringify(normalizeInputs(a, session.cwd)) === JSON.stringify(session.inputs);
}

export function completeStage(sessionId: string, input: StageInput): string {
  const session = sessions.get(sessionId);
  if (!session) return `No /${COMMAND_NAME} workflow is active in this session.`;
  // Amend: execute/verify found another existing test that must change. Back to plan for a new approval; the baseline stays.
  if (input.stage === "plan" && input.note !== undefined && (session.stage === "execute" || session.stage === "verify")) {
    const out = submitPlan(session, input, true);
    if (!out.startsWith("Plan recorded")) return out;
    session.stage = "plan";
    return `${out}\nThis amends the approved plan (the files already written stay). When the user approves, call ${STAGE_TOOL} with ONLY stage "plan" and user_approved=true to continue to execute.`;
  }
  if (input.stage !== session.stage) {
    return `Rejected: the current stage is ${session.stage}, not ${input.stage}.\n\n${renderStageGuide(session.stage, session)}`;
  }

  switch (session.stage) {
    case "plan": {
      // Same rule as pb-online: changed inputs always re-plan; a reworded note only when it is not an approval.
      const inputsChanged = input.inputs !== undefined && !sameInputs(input.inputs, session);
      const reworded = input.note !== session.plan && !input.user_approved;
      if (input.note !== undefined && (!session.plan || inputsChanged || reworded)) {
        const out = submitPlan(session, input);
        // An approval call that also carried a changed plan re-records it; say so, or the model repeats the same call.
        return input.user_approved && out.startsWith("Plan recorded")
          ? `${out}\nYou sent user_approved=true together with a ${inputsChanged ? "changed `inputs`" : "changed `note`"}, so this is a NEW plan and the user has to approve it again. When the user approves, call ${STAGE_TOOL} with ONLY stage "plan" and user_approved=true: no note, no inputs.`
          : out;
      }
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
