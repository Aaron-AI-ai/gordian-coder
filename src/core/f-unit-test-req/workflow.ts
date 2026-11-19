/**
 * /f-unit-test-req harness: test-first (TDD) unit tests from requirements.
 *
 *   plan (user approves) → execute → verify (build only) → done
 *                ↑___________ compile errors, defects ______|
 *
 * The rules and templates live in the `f-unit-test-req` skill. The plugin owns the flow: the plan needs
 * the skeleton classes and the requirement source, execute writes only the planned test files, verify
 * judges the build from the compile script's files. Tests are never run, nothing is measured, no report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { MCP_SERVER, UNIT_TEST_REQ_SKILL_NAME } from "../pb-online/names";
import { isFailedResource, normalizeUri } from "../pb-online/workflow";
import { MAX_WAIT_CALLS, awaitingReply, noteReply, takeAbort, type PlanGateState } from "../plan-gate";
import { foreignScriptProblem } from "../report-language";
import { checkTestSource, testMethodBodies, testMethodNames } from "../f-unit-test/test-check";
import { environmentFailureLine } from "../f-unit-test/env-failure";
import {
  MTIME_SLACK_MS, WRITES, escapes, filled, fqcn, isDir, isFile, matchesPath, paths, slash, strings, targetsOf, toRelative,
} from "../f-unit-test/workflow";
import { REQ_BASH_RULE, compileCommandLine, compileScriptName, reqBashAllowed, type ReqBashContext } from "./bash-gate";

export { MAX_WAIT_CALLS, UNIT_TEST_REQ_SKILL_NAME };

export const COMMAND_NAME = "f-unit-test-req";
export const STAGE_TOOL = "f_unit_test_req_stage";
/** Scratch directory of the compile script (status.json, gradle.log); not a report. */
export const WORK_DIR = ".fico/work/f-unit-test-req";
export const MAX_FIX_RETRIES = 5;
const MAX_SESSIONS = 50;
const REPLY_LANGUAGE = "ko";

export type StageId = "plan" | "execute" | "verify" | "done";

export interface ReqCaseDef {
  target: string;
  method: string;
  /** The requirement item (ID or one line of its text) these cases verify. */
  requirement: string;
  normal: string[];
  boundary: string[];
  exception: string[];
  mocks: string[];
  skip_reason?: string;
}

export interface PlanInputs {
  source: "file" | "text" | "program";
  module: string;
  requirement_file?: string;
  program_id?: string;
  group_name?: string;
  /** Skeleton classes under src/main/java that the tests target. */
  targets: string[];
  /** Every test file to create or extend (project-relative). */
  files: string[];
  cases: ReqCaseDef[];
}

export interface StageInput {
  stage: StageId;
  note?: string;
  inputs?: Partial<PlanInputs>;
  user_approved?: boolean;
}

export interface ReqSession extends PlanGateState {
  stage: StageId;
  request: string;
  cwd: string;
  inputs?: PlanInputs;
  plan?: string;
  previousMethods: Record<string, string[]>;
  previousBodies: Record<string, Record<string, string>>;
  baselineLocked: boolean;
  touched: Set<string>;
  roundWrites: Set<string>;
  runDir?: string;
  verifyStartedAt?: number;
  verifyBaseline: Record<string, number>;
  fixRetries: number;
  /** fico-mcp resource URIs this session really fetched. */
  fetched: Set<string>;
  /** Set when the run ended without a clean build. */
  incomplete?: string;
}

interface Stage {
  goal: string;
  steps: string[];
  tools: string[];
  blocked: string[];
  finish: string;
}

const ASK_USER_WHEN =
  "(1) the requirement: none given (no --req-file, --req text or --program), a --req-file that does not exist, or a --program the MCP cannot find; (2) a target skeleton class that does not exist yet; (3) the Gradle module, when the targets sit in none or in several modules; (4) values the requirement does not give (an error code, a limit); (5) for a Mapper target, the test profile and, for a non-primary datasource, the transaction manager bean";
const ASK_USER_NOTE = "If a value cannot be determined from the requirements or the project, ask the user for it and END YOUR TURN; do not guess or leave placeholders. Then submit the plan again.";
const SKELETON_NOTE =
  "The target class does not exist yet. Tests are written before the implementation, but they need a skeleton to compile: tell the user to create the skeleton code first (the class, its method signatures, VOs; empty or UnsupportedOperationException bodies) and END YOUR TURN. Never create production code yourself.";

export const STAGES: Record<StageId, Stage> = {
  plan: {
    goal: "Turn the requirements into test cases per target method and get the user's approval. Nothing is written here.",
    steps: [
      `Load the \`${UNIT_TEST_REQ_SKILL_NAME}\` skill with the skill tool and read its docs/ rules and templates/. If the skill is missing, STOP and tell the user to run \`gdc fico-check\`.`,
      `Read the requirements: \`--req-file <path>\` → read that file ("file"); \`--req "<text>"\` → the typed text is the requirement ("text"); \`--program <ID>\` → read \`fico://program-detail/{group_name}/{program_id}\` from ${MCP_SERVER} with read_mcp_resource (find the group in \`fico://all-programs\` when it is not given) and use its description and input/output fields ("program"). They may be combined; then pick the main source.`,
      "Find the skeleton classes the tests target (under src/main/java), their Gradle module and the Spring Boot version (root build.gradle; below 3.4: @MockBean instead of @MockitoBean). Read only their signatures and VO fields, never to take expected values from their bodies.",
      `If a required input is missing or cannot be settled from the requirements and the project, ASK THE USER and END YOUR TURN before doing anything else; never guess and never put a placeholder in \`inputs\`. Required inputs: ${ASK_USER_WHEN}.`,
      "Split the requirements into items. For every target method define cases per the skill's case rule: at least two normal, one boundary, one exception, each tied to the requirement item it verifies (`requirement`), plus the external classes to mock. A method with no requirement gets `skip_reason`. Requirement items that contradict each other are shown to the user, who decides.",
      "Test files go under the module's src/test/java in the target's package as `<ClassName>Test.java`. An existing test file is extended, never replaced.",
      `Write the plan for the user in your reply, in Korean (or the language the user wrote to you in); never switch to another language. Then call ${STAGE_TOOL} with stage "plan", the plan as \`note\` and \`inputs\` = { source, module, requirement_file?, program_id?, group_name?, targets, files, cases: [{ target, method, requirement, normal, boundary, exception, mocks, skip_reason? }] } with project-relative paths. Once it is accepted, END YOUR TURN. Any further tool call while the plan waits is refused.`,
      `After the user approves, call ${STAGE_TOOL} with ONLY stage "plan" and user_approved=true (no note, no inputs). If they ask for changes, submit a new \`note\` and \`inputs\` and ask again.`,
    ],
    tools: ["skill", "read", "glob", "grep", "list_mcp_resources", "read_mcp_resource", "bash (read-only git only)"],
    blocked: [...WRITES, "task", "bash (except read-only git)"],
    finish: "`note` = the plan with `inputs`, then `user_approved` = true after the user's reply",
  },
  execute: {
    goal: "Write the planned tests from the skill's rules and templates, with the explanation in comments.",
    steps: [
      "Write only the planned `files`; any other path is refused.",
      "Follow the format rule: @SpringBootTest, @Transactional, @BeforeEach, @AfterEach; mock every external module or resource. Expected values come from the requirements, never from the skeleton's body.",
      "Explain in comments: a class Javadoc with the requirement source, and the three lines `// [요구사항] ...`, `// [시나리오] ...`, `// [기대] ...` directly above EVERY @Test. A test without that comment is a defect.",
      "Keep every existing @Test of a file you extend byte-for-byte; add cases only. Replace every template placeholder.",
      "You may compile with gradle in bash (`./gradlew :<module>:compileTestJava`). Never run the tests; the test tasks are refused.",
    ],
    tools: ["read", "edit", "write", "grep", "bash (gradle compile only)"],
    blocked: ["task", "bash (except gradle compile and read-only git)", "gradle test"],
    finish: "no arguments; at least one planned file must have been written",
  },
  verify: {
    goal: "Check that the tests compile. The plugin reads the build facts itself; the tests are not run.",
    steps: [
      `Run the skill's compile script (\`scripts/compile-tests.sh\` with sh, or \`scripts/compile-tests.ps1\` with PowerShell on Windows; the PowerShell run is not verified in the development environment) with bash using exactly the command below. It leaves status.json in the output directory.`,
      `Then call ${STAGE_TOOL} with stage "verify" and a \`note\` ("none" is fine). Compile errors and static-check defects send you back to execute with the details.`,
    ],
    tools: ["bash (compile-tests.sh/.ps1 only)", "read", "grep"],
    blocked: [...WRITES, "task", "bash (except compile-tests.sh/.ps1)"],
    finish: "`note` = anything the user should know; the plugin judges from the files",
  },
  done: {
    goal: "Explain what was created on the console. No report file.",
    steps: ["List per test class which test cases were created and which requirement items they cover, briefly, in Korean. The details are in the code comments."],
    tools: [],
    blocked: [...WRITES, "task", "bash"],
    finish: "nothing; the workflow is closed",
  },
};

const sessions = new Map<string, ReqSession>();

export function startSession(sessionId: string, request: string, cwd: string): ReqSession {
  sessions.delete(sessionId);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const session: ReqSession = {
    stage: "plan",
    request,
    cwd,
    previousMethods: {},
    previousBodies: {},
    baselineLocked: false,
    touched: new Set(),
    roundWrites: new Set(),
    verifyBaseline: {},
    awaitingCalls: 0,
    fixRetries: 0,
    fetched: new Set(),
  };
  sessions.set(sessionId, session);
  return session;
}

export const getSession = (sessionId: string): ReqSession | undefined => sessions.get(sessionId);
export const endSession = (sessionId: string): void => void sessions.delete(sessionId);

export function noteUserMessage(sessionId: string, createdAt: number): void {
  const session = sessions.get(sessionId);
  if (session) noteReply(session, createdAt);
}

export function takeAbortRequest(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session ? takeAbort(session) : false;
}

const bashContext = (session: ReqSession): ReqBashContext => ({
  cwd: session.cwd,
  compile: { module: session.inputs?.module ?? "<module>", out: session.runDir ?? "<runDir>" },
});

export function renderStageGuide(stageId: StageId, session?: ReqSession, platform: NodeJS.Platform = process.platform): string {
  const stage = STAGES[stageId];
  const lines = [
    `[${COMMAND_NAME}] Current stage: ${stageId} (plan → execute → verify → done)`,
    `Goal: ${stage.goal}`,
    `Skill: ${UNIT_TEST_REQ_SKILL_NAME}`,
    "Steps:",
    ...stage.steps.map((step, i) => `${i + 1}. ${step}`),
  ];
  if (stageId === "verify" && session) {
    const command = compileCommandLine(bashContext(session), platform);
    lines.push(
      command
        ? `Run exactly (no quotes, no extra arguments): ${command}`
        : "The global skill path contains whitespace, so no command can pass the bash gate. Tell the user to run `gdc fico-init` in this project (it installs the skill under .opencode/skills) and END YOUR TURN.",
    );
  }
  if (stageId === "execute" && session?.inputs) lines.push(`Planned files: ${session.inputs.files.join(", ")}`);
  lines.push(`Recommended tools: ${stage.tools.join(", ") || "none"}`);
  lines.push(`Blocked at this stage: ${stage.blocked.join(", ")}`);
  if (stageId !== "done") lines.push(`To finish this stage call ${STAGE_TOOL} with stage "${stageId}": ${stage.finish}.`);
  return lines.join("\n");
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
  if (tool === "task") return refuse();
  if (tool === "bash") {
    if (reqBashAllowed(session.stage, typeof args.command === "string" ? args.command : "", bashContext(session))) return null;
    return `${refuse()}\n${REQ_BASH_RULE}`;
  }
  if (!WRITES.includes(tool)) return null;
  if (session.stage !== "execute") return refuse();
  if (tool === "apply_patch" && typeof args.patchText === "string" && /^\*\*\* (?:Delete File|Move to):/m.test(args.patchText)) {
    return `${COMMAND_NAME}: apply_patch may not delete or move files; existing tests must be kept.`;
  }
  const planned = session.inputs?.files ?? [];
  if (targetsOf(args).length === 0) return `${COMMAND_NAME}: ${tool} was refused because its target file could not be determined. Use write or edit with filePath for a planned file.`;
  const unplanned = targetsOf(args).map((f) => toRelative(session.cwd, f)).filter((f) => !planned.some((p) => matchesPath(p, f)));
  if (unplanned.length > 0) return `${COMMAND_NAME}: ${unplanned.join(", ")} is not in the approved plan. Write only the planned files: ${planned.join(", ")}.`;
  return null;
}

/** After a tool succeeded: counts written files and the fico-mcp resources that really came back. */
export function noteToolResult(
  sessionId: string,
  tool: string,
  metadata: Record<string, unknown> = {},
  output = "",
  args: Record<string, unknown> = {},
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (WRITES.includes(tool)) {
    for (const file of targetsOf(args)) {
      const rel = toRelative(session.cwd, file);
      session.touched.add(rel);
      session.roundWrites.add(rel);
    }
    return;
  }
  if (tool !== "read_mcp_resource") return;
  if (metadata.server !== MCP_SERVER || typeof metadata.uri !== "string" || isFailedResource(output)) return;
  session.fetched.add(normalizeUri(metadata.uri));
}

function normalizeInputs(raw: Partial<PlanInputs>, cwd: string): PlanInputs {
  const rel = (p: string): string => toRelative(cwd, p);
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return {
    source: raw.source as PlanInputs["source"],
    module: typeof raw.module === "string" ? rel(raw.module).replace(/\/$/, "") : "",
    requirement_file: raw.requirement_file ? slash(String(raw.requirement_file)) : undefined,
    program_id: text(raw.program_id) || undefined,
    group_name: text(raw.group_name) || undefined,
    targets: paths(raw.targets).map(rel),
    files: paths(raw.files).map(rel),
    cases: (Array.isArray(raw.cases) ? raw.cases : []).map((c: Partial<ReqCaseDef>) => ({
      ...c,
      target: typeof c?.target === "string" ? rel(c.target) : "",
      method: typeof c?.method === "string" ? c.method : "",
      requirement: text(c?.requirement),
      normal: strings(c?.normal),
      boundary: strings(c?.boundary),
      exception: strings(c?.exception),
      mocks: strings(c?.mocks),
    })),
  };
}

/** Problems per field, empty when the plan can be recorded. A missing target is reported separately (skeleton). */
function planProblems(p: PlanInputs, cwd: string): { problems: string[]; missingTargets: string[] } {
  const problems: string[] = [];
  const missingTargets: string[] = [];
  const abs = (f: string): string => path.resolve(cwd, f);
  if (!["file", "text", "program"].includes(p.source)) problems.push('source: must be "file", "text" or "program"');
  if (p.source === "file" && (!p.requirement_file || !isFile(abs(p.requirement_file)))) problems.push("requirement_file: must be an existing requirement file when source is \"file\"");
  if (p.source === "program" && (!p.program_id || !p.group_name)) problems.push("program_id and group_name: both are required when source is \"program\"");
  const moduleDir = p.module.replace(/^:/, "").replace(/:/g, "/");
  if (!/^[\w.\/:-]+$/.test(p.module)) problems.push(`module: "${p.module}" may contain only letters, digits, _ . / : -`);
  else if (!moduleDir || moduleDir === "." || escapes(moduleDir) || !isDir(abs(moduleDir))) problems.push(`module: "${p.module}" must be an existing module directory inside the project`);
  if (p.targets.length === 0) problems.push("targets: list the skeleton classes to test");
  for (const t of p.targets) {
    if (escapes(t) || !t.endsWith(".java") || !`/${t}`.includes("/src/main/java/")) problems.push(`targets: ${t} must be a .java file under src/main/java`);
    else if (!isFile(abs(t))) missingTargets.push(t);
  }
  if (!p.files.some((f) => f.endsWith(".java"))) problems.push("files: list at least one .java test file you will write");
  for (const f of p.files) {
    const ok = !escapes(f) && `/${f}`.includes("/src/test/") && (f.endsWith(".java") || `/${f}`.includes("/src/test/resources/"));
    if (!ok) problems.push(`files: ${f} must be a .java file under src/test or a file under src/test/resources, inside the project`);
    else if (/compile-tests\.(sh|ps1)$/.test(path.posix.basename(f).toLowerCase())) problems.push(`files: ${f} may not be named like compile-tests.sh or compile-tests.ps1`);
    else if (f.endsWith(".java") && !/^[\w.]+$/.test(fqcn(f) ?? "")) problems.push(`files: ${f} must be under src/test/java with a plain package path`);
  }
  for (const c of p.cases) {
    const where = `cases: ${c.target || "(no target)"}#${c.method || "(no method)"}`;
    if (!p.targets.includes(c.target)) problems.push(`${where}: target is not in targets`);
    for (const m of c.mocks) if (!/^[\w.$]+$/.test(m)) problems.push(`${where}: mock "${m}" must be a class name only`);
    if (c.skip_reason?.trim()) continue;
    if (!c.requirement) problems.push(`${where}: needs \`requirement\` (the requirement item these cases verify)`);
    if (filled(c.normal) < 2) problems.push(`${where}: needs at least 2 normal cases`);
    if (filled(c.boundary) < 1) problems.push(`${where}: needs at least 1 boundary case`);
    if (filled(c.exception) < 1) problems.push(`${where}: needs at least 1 exception case`);
  }
  for (const t of p.targets) if (!p.cases.some((c) => c.target === t)) problems.push(`cases: ${t} has no case (or skip_reason)`);
  return { problems, missingTargets };
}

function submitPlan(session: ReqSession, input: StageInput): string {
  if (!input.note?.trim()) return `Rejected: the plan needs a \`note\` describing it for the user.\n${ASK_USER_NOTE}`;
  const lang = foreignScriptProblem(input.note, REPLY_LANGUAGE, "the plan note");
  if (lang) return `Rejected: ${lang}`;
  const inputs = normalizeInputs(input.inputs ?? {}, session.cwd);
  const { problems, missingTargets } = planProblems(inputs, session.cwd);
  if (problems.length > 0) return `Rejected: the plan is not valid. Fix these fields and submit again:\n${problems.map((p) => `- ${p}`).join("\n")}\n${ASK_USER_NOTE}`;
  if (missingTargets.length > 0) return `Rejected: ${missingTargets.join(", ")} does not exist.\n${SKELETON_NOTE}`;
  if (inputs.source === "program") {
    const uri = `fico://program-detail/${inputs.group_name}/${inputs.program_id}`;
    if (![...session.fetched].includes(uri)) {
      return `Rejected: the program specification was not fetched successfully. Read ${uri} from ${MCP_SERVER} with read_mcp_resource first. If it returns an error or cannot be found, tell the user, ask them to confirm the Program ID and group or run \`gdc fico-check\`, and END YOUR TURN. Never plan without the specification.`;
    }
  }
  if (!session.baselineLocked) {
    session.previousMethods = {};
    session.previousBodies = {};
    for (const f of inputs.files) {
      const abs = path.resolve(session.cwd, f);
      if (!f.endsWith(".java") || !isFile(abs)) continue;
      const src = fs.readFileSync(abs, "utf-8");
      session.previousMethods[f] = testMethodNames(src);
      session.previousBodies[f] = testMethodBodies(src);
    }
  }
  session.inputs = inputs;
  session.plan = input.note;
  session.planAt = Date.now();
  session.userRepliedAt = undefined;
  session.awaitingCalls = 0;
  return "Plan recorded. Show it to the user and END YOUR TURN; do not continue until they reply.";
}

function advance(session: ReqSession, to: StageId, lead: string): string {
  session.stage = to;
  if (to === "execute") {
    session.baselineLocked = true;
    session.runDir ??= `${WORK_DIR}/run-${localFileStamp()}`;
    session.roundWrites.clear();
  }
  if (to === "verify") {
    session.verifyStartedAt = Date.now();
    session.verifyBaseline = {};
    const file = path.join(session.cwd, session.runDir!, "status.json");
    if (isFile(file)) session.verifyBaseline["status.json"] = fs.statSync(file).mtimeMs;
  }
  return `${lead}\n\n${renderStageGuide(to, session)}`;
}

/** Every new @Test needs a comment right above it (annotations such as @DisplayName in between are skipped). */
export function uncommentedTests(source: string, previousMethods: string[] = []): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/@(?:Test|ParameterizedTest)\b/g)) {
    const name = /\bvoid\s+(\w+)\s*\(/.exec(source.slice(m.index!))?.[1];
    if (!name || previousMethods.includes(name)) continue;
    const lines = source.slice(0, m.index!).split("\n");
    lines.pop(); // the text before the annotation on its own line
    let i = lines.length - 1;
    while (i >= 0 && (lines[i]!.trim() === "" || /^\s*@(?!Test\b)\w+/.test(lines[i]!))) i -= 1;
    const above = (lines[i] ?? "").trim();
    if (!(above.startsWith("//") || above.endsWith("*/"))) found.push(name);
  }
  return found;
}

const MAPPER_TEST = /^(\w+(?:Mapper|Repo))Test\.java$/;

/** Static-check defects of the written test classes, as `file: defect`. */
function testDefects(session: ReqSession): string[] {
  const defects: string[] = [];
  for (const file of session.touched) {
    if (!file.endsWith(".java")) continue;
    const abs = path.resolve(session.cwd, file);
    if (!isFile(abs)) {
      defects.push(`${file}: file does not exist`);
      continue;
    }
    const src = fs.readFileSync(abs, "utf-8");
    const cls = path.posix.basename(file, ".java").replace(/Test$/, "");
    const mocks = [...new Set((session.inputs?.cases ?? []).filter((c) => path.posix.basename(c.target, ".java") === cls).flatMap((c) => c.mocks))];
    const mapper = MAPPER_TEST.exec(path.posix.basename(file))?.[1];
    const found = checkTestSource(src, {
      mocks,
      previousMethods: session.previousMethods[file],
      previousBodies: session.previousBodies[file],
      requireTransactional: mapper !== undefined,
      mapperUnderTest: mapper,
    });
    defects.push(...found.map((d) => `${file}: ${d}`));
    for (const name of uncommentedTests(src, session.previousMethods[file])) {
      defects.push(`${file}: ${name} has no comment above it (add the three lines // [요구사항], // [시나리오], // [기대])`);
    }
  }
  return defects;
}

function sendBackToFix(session: ReqSession, problems: string[]): string {
  session.fixRetries += 1;
  const detail = problems.join("\n");
  if (session.fixRetries > MAX_FIX_RETRIES) {
    session.incomplete = detail;
    return finish(session, `Fix limit (${MAX_FIX_RETRIES}) reached. The tests do NOT build cleanly yet. Tell the user exactly this:\n${detail}`);
  }
  return advance(session, "execute", `Back to execute (fix ${session.fixRetries}/${MAX_FIX_RETRIES}). Fix:\n${detail}`);
}

function environmentFailure(session: ReqSession, line: string): string {
  session.fixRetries += 1;
  const reason = `The build failed on a dependency/network problem in the environment, not in the tests: ${line}`;
  if (session.fixRetries > MAX_FIX_RETRIES) {
    session.incomplete = reason;
    return finish(session, `Fix limit (${MAX_FIX_RETRIES}) reached. ${reason}`);
  }
  session.verifyBaseline["status.json"] = fs.statSync(path.join(session.cwd, session.runDir!, "status.json")).mtimeMs;
  return [
    `Rejected (fix retry ${session.fixRetries}/${MAX_FIX_RETRIES}): this is a dependency/network problem in the environment, not in the test code.`,
    `First matching line: ${line}`,
    "So do NOT edit the tests. Tell the user what failed and END YOUR TURN.",
    `After the user has fixed it, run the compile script again and call ${STAGE_TOOL} with stage "verify" again.`,
  ].join("\n");
}

/** Closes the workflow: the plugin's own list of the tests that exist, for the console explanation. */
function finish(session: ReqSession, lead: string): string {
  session.stage = "done";
  const lines: string[] = [];
  for (const file of [...session.touched].filter((f) => f.endsWith(".java"))) {
    const abs = path.resolve(session.cwd, file);
    if (!isFile(abs)) continue;
    const before = new Set(session.previousMethods[file] ?? []);
    const added = testMethodNames(fs.readFileSync(abs, "utf-8")).filter((n) => !before.has(n));
    lines.push(`- ${file}: ${added.length > 0 ? added.join(", ") : "(no new test)"}`);
  }
  return [
    lead,
    "",
    "Test methods created:",
    ...lines,
    "",
    "Workflow closed. Now tell the user in Korean, on the console and briefly: per test class which test cases were created (what each verifies) and which requirement items they cover. The details are in the code comments. The tests were only compiled, not run, and a failing test against the skeleton is expected. Write no report file.",
  ].join("\n");
}

function completeVerify(session: ReqSession, input: StageInput): string {
  if (!input.note?.trim()) return 'Rejected: verify needs a `note` ("none" is fine).';
  const file = path.join(session.cwd, session.runDir!, "status.json");
  const fresh = (): boolean => {
    if (!isFile(file)) return false;
    const mtime = fs.statSync(file).mtimeMs;
    const baseline = session.verifyBaseline["status.json"];
    if (baseline !== undefined && mtime <= baseline) return false;
    return mtime >= (session.verifyStartedAt ?? 0) - MTIME_SLACK_MS;
  };
  if (!fresh()) {
    session.fixRetries += 1;
    if (session.fixRetries > MAX_FIX_RETRIES) {
      session.incomplete = "verify was called without a fresh compile-tests result too many times";
      return finish(session, `Fix limit (${MAX_FIX_RETRIES}) reached without build results.`);
    }
    return `Rejected: run ${compileScriptName()} first in this verify stage (its status.json must be newer than the stage entry). This counts as a fix retry (${session.fixRetries}/${MAX_FIX_RETRIES}).\n\n${renderStageGuide("verify", session)}`;
  }
  let status: { compile?: string; log?: string };
  try {
    status = JSON.parse(fs.readFileSync(file, "utf-8")) as typeof status;
  } catch {
    return `Rejected: ${session.runDir}/status.json is not valid JSON. Run ${compileScriptName()} again.`;
  }
  const envLine = status.compile === "fail" ? environmentFailureLine(status.log ?? "") : null;
  if (envLine) return environmentFailure(session, envLine);
  if (status.compile !== "ok") return sendBackToFix(session, [`Test compilation failed:\n${status.log ?? "(no log)"}`]);
  const defects = testDefects(session);
  if (defects.length > 0) return sendBackToFix(session, [`The plugin found defects in the tests:\n${defects.join("\n")}`]);
  return finish(session, "The test code compiles and passes the static checks.");
}

export function completeStage(sessionId: string, input: StageInput): string {
  const session = sessions.get(sessionId);
  if (!session) return `No /${COMMAND_NAME} workflow is active in this session.`;
  if (input.stage !== session.stage) return `Rejected: the current stage is ${session.stage}, not ${input.stage}.\n\n${renderStageGuide(session.stage, session)}`;
  switch (session.stage) {
    case "plan": {
      const sameAsRecorded = input.inputs !== undefined && session.inputs !== undefined && JSON.stringify(normalizeInputs(input.inputs, session.cwd)) === JSON.stringify(session.inputs);
      const inputsChanged = input.inputs !== undefined && !sameAsRecorded;
      const reworded = input.note !== session.plan && !input.user_approved;
      if (input.note !== undefined && (!session.plan || inputsChanged || reworded)) {
        const out = submitPlan(session, input);
        return input.user_approved && out.startsWith("Plan recorded")
          ? `${out}\nYou sent user_approved=true together with a changed plan, so this is a NEW plan and the user has to approve it again. When the user approves, call ${STAGE_TOOL} with ONLY stage "plan" and user_approved=true.`
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
        return session.touched.size === 0 ? "Rejected: no planned file has been written yet." : "Rejected: nothing was written in this round. Fix the listed problems in the planned files before finishing execute.";
      }
      return advance(session, "verify", `Written: ${[...session.touched].join(", ")}`);
    case "verify":
      return completeVerify(session, input);
    case "done":
      return "The workflow is closed. Explain the created tests to the user on the console; write no report.";
  }
}

export const COMMAND_DESCRIPTION = "요구사항 기반 단위 테스트 먼저 생성 (TDD, 컴파일만 확인)";

export const STAGE_TOOL_DESCRIPTION =
  "Finish the current stage of the /f-unit-test-req workflow (plan, execute, verify) and get the next stage's guide. Only callable meaningfully while that workflow is active.";

export const COMMAND_TEMPLATE = `Write unit tests first (TDD) from requirements by following the stages below. The plugin enforces them: tools outside the current stage are rejected, verify is judged from the compile script's files, and every ${STAGE_TOOL} result tells you the next stage. The tests are only compiled, never run, and no report is written.

${renderStageGuide("plan")}

User request: $ARGUMENTS`;
