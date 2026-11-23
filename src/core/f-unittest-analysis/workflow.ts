/**
 * /f-unittest-analysis harness: run the existing unit tests and report. Never writes code.
 *
 *   plan → execute (the plugin runs Gradle itself) → report
 *
 * plan fixes what runs (module, the selected tests or all) and needs no approval: nothing is changed.
 * execute: the plugin runs Gradle itself (runner.ts); the model only calls the stage tool and waits. report: green → the plugin writes report.md/.html itself; red (failing
 * test, no build, nothing ran) → no file, the model explains cause and fix on the console. Every file write
 * and every other bash command is refused in all stages.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { UNIT_TEST_ANALYSIS_SKILL_NAME } from "../pb-online/names";
import { foreignScriptProblem, reportScriptWarning } from "../report-language";
import { readFailedDetails, readTargetCoverage, readTestRun, type FailedTest, type TestRun } from "../f-unit-test/coverage";
import { environmentFailureLine } from "../f-unit-test/env-failure";
import { testMethodNames } from "../f-unit-test/test-check";
import { MTIME_SLACK_MS, WRITES, escapes, fqcn, isDir, isFile, paths, toRelative } from "../f-unit-test/workflow";
import { ANALYSIS_BASH_RULE, analysisBashAllowed } from "./bash-gate";
import { gradleCommandText, readCoverageXmlText, runTests } from "./runner";
import { writeReport } from "./report";

export { UNIT_TEST_ANALYSIS_SKILL_NAME };

export const COMMAND_NAME = "f-unittest-analysis";
export const STAGE_TOOL = "f_unittest_analysis_stage";
/** Scratch directory of the run script (status.json, gradle.log, test-results); not a report. */
export const WORK_DIR = ".fico/work/f-unittest-analysis";
export const MAX_ENV_RETRIES = 3;
const MAX_SESSIONS = 50;
const REPLY_LANGUAGE = "ko";

export type StageId = "plan" | "execute" | "report";

export interface TestSelection {
  /** Project-relative test file under src/test/java. */
  file: string;
  /** Test methods of that file; empty = the whole class. */
  methods?: string[];
}

export interface PlanInputs {
  module: string;
  /** Empty or missing: run every test of the module. */
  tests: TestSelection[];
}

export interface StageInput {
  stage: StageId;
  note?: string;
  inputs?: Partial<PlanInputs>;
}

export type Outcome =
  | { kind: "pass"; reportFile: string; run: TestRun; scriptWarn?: string }
  | { kind: "failed"; reportFile: string; run: TestRun; failures: FailedTest[]; scriptWarn?: string }
  | { kind: "build"; log: string }
  | { kind: "none"; log: string };

export interface AnalysisSession {
  stage: StageId;
  request: string;
  cwd: string;
  startedAt: number;
  inputs?: PlanInputs;
  runDir?: string;
  executeStartedAt?: number;
  baselineMtime?: number;
  envRetries: number;
  running?: boolean;
  outcome?: Outcome;
}

interface Stage {
  goal: string;
  steps: string[];
  tools: string[];
  blocked: string[];
  finish: string;
}

export const STAGES: Record<StageId, Stage> = {
  plan: {
    goal: "Fix what runs: the Gradle module and the selected tests, or all tests. Nothing is written or changed, no approval is needed.",
    steps: [
      `Load the \`${UNIT_TEST_ANALYSIS_SKILL_NAME}\` skill with the skill tool. If the skill is missing, STOP and tell the user to run \`gdc fico-check\`.`,
      "Read the user's input. `--test <spec>` (repeatable or comma separated; bare names count too) selects tests: a class name, a test file path, or `Class#method`. NO input means every test of the module runs: send `tests` as an empty list.",
      "Find the Gradle module (settings.gradle, where the tests live). Turn every spec into the test file under src/test/java (glob) and, for `Class#method`, the method; the method must exist in the file.",
      "If the module is unclear, or a spec matches no test file or several, ASK THE USER and END YOUR TURN; never guess.",
      `Write a short plan for the user in Korean (or the language the user wrote in): the module, and the tests that will run or "전체". Then call ${STAGE_TOOL} with stage "plan", the plan as \`note\` and \`inputs\` = { module, tests: [{ file, methods? }] } with project-relative paths (tests: [] for all). The plan is accepted without waiting; continue straight to execute.`,
    ],
    tools: ["skill", "read", "glob", "grep", "bash (read-only git only)"],
    blocked: [...WRITES, "task", "bash (except read-only git)"],
    finish: "`note` = the plan, `inputs` = { module, tests }",
  },
  execute: {
    goal: "Run the tests. The plugin does it itself (build, then test); you run nothing.",
    steps: [
      `Call ${STAGE_TOOL} with stage "execute" and wait: it builds the module and runs the selected tests, which may take minutes. Do not use bash and do not call it twice.`,
    ],
    tools: [STAGE_TOOL],
    blocked: [...WRITES, "task", "bash"],
    finish: "no arguments; the plugin runs the tests and judges from the results",
  },
  report: {
    goal: "Tell the user the result.",
    steps: [],
    tools: ["read", "grep", "glob"],
    blocked: [...WRITES, "task", "bash"],
    finish: "nothing; the workflow is closed",
  },
};

const sessions = new Map<string, AnalysisSession>();

export function startSession(sessionId: string, request: string, cwd: string): AnalysisSession {
  sessions.delete(sessionId);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const session: AnalysisSession = { stage: "plan", request, cwd, startedAt: Date.now(), envRetries: 0 };
  sessions.set(sessionId, session);
  return session;
}

export const getSession = (sessionId: string): AnalysisSession | undefined => sessions.get(sessionId);
export const endSession = (sessionId: string): void => void sessions.delete(sessionId);

/** Full test class names, with `.method` for a selected method. */
export function selectionNames(inputs: PlanInputs | undefined): string[] {
  return (inputs?.tests ?? []).flatMap((t) => {
    const cls = fqcn(t.file);
    if (!cls) return [];
    return t.methods && t.methods.length > 0 ? t.methods.map((m) => `${cls}.${m}`) : [cls];
  });
}

const failureLine = (d: FailedTest): string =>
  `- ${d.cls.split(".").pop()}.${d.method} (${d.kind === "error" ? "예외" : "단언 실패"})${d.frame ? ` [${d.frame}]` : ""}: ${d.type ? `${d.type.split(".").pop()}: ` : ""}${d.message || "(메시지 없음)"}`;

/** What the model must do in the report stage, per outcome. */
function reportSteps(o: Outcome): string[] {
  const guideCore = `Read at most the failing tests and the code they call (read-only, a few reads), then your reply MUST be a Korean text message following the skill's docs/f-unittest-analysis-guide.md (per failure: 테스트, 원인, 판단, 수정 방법). Ending the turn after only tool calls, with no text, is a failure. Edit no code, and run nothing.`;
  switch (o.kind) {
    case "pass":
      return [`All ${o.run.total} tests passed (skipped ${o.run.skipped}). The plugin wrote the report: ${o.reportFile} (and report.html next to it).${o.scriptWarn ? `\n${o.scriptWarn}` : ""}`, `Now reply to the user, and only this, in Korean: "리포트: ${o.reportFile} (같은 폴더에 report.html) — 전체 ${o.run.total}개 통과". Do not call any tool.`];
    case "failed":
      return [
        `${o.run.failed + o.run.errored} of ${o.run.total} tests failed (passed ${o.run.passed}, skipped ${o.run.skipped}). The plugin wrote the report anyway: ${o.reportFile} (and report.html next to it), with every test's result including the failing ones marked.${o.scriptWarn ? `\n${o.scriptWarn}` : ""}`,
        "Failures:",
        ...o.failures.map(failureLine),
        `Tell the user the report path and the pass/fail totals, then per failure give the cause, which side is wrong and how to fix it. ${guideCore} The plugin already wrote the report; do not write another yourself.`,
      ];
    case "build":
      return ["The module did not compile, so no test ran. No report is written: there is no test result to put in one.", `Build log (tail):\n${o.log}`, `Give the cause and how to fix the first error. ${guideCore} Write NO report and NO file yourself.`];
    case "none":
      return ["No test ran: the selection matched no test, or the module has none. No report is written: there is no test result to put in one.", `Log (tail):\n${o.log}`, `Say why nothing ran and how to select correctly. ${guideCore} Write NO report and NO file yourself.`];
  }
}

export function renderStageGuide(stageId: StageId, session?: AnalysisSession): string {
  const stage = STAGES[stageId];
  const steps = stageId === "report" && session?.outcome ? reportSteps(session.outcome) : stage.steps;
  const lines = [
    `[${COMMAND_NAME}] Current stage: ${stageId} (plan → execute → report)`,
    `Goal: ${stage.goal}`,
    `Skill: ${UNIT_TEST_ANALYSIS_SKILL_NAME}`,
    "Steps:",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
  ];
  lines.push(`Recommended tools: ${stage.tools.join(", ") || "none"}`);
  lines.push(`Blocked at this stage: ${stage.blocked.join(", ")}`);
  if (stageId !== "report") lines.push(`To finish this stage call ${STAGE_TOOL} with stage "${stageId}": ${stage.finish}.`);
  return lines.join("\n");
}

/** Returns a rejection message, or null to allow. Sessions outside the workflow always pass. */
export function gateTool(sessionId: string, tool: string, args: Record<string, unknown>): string | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const refuse = (): string => `${COMMAND_NAME}: ${tool} is not allowed in the ${session.stage} stage.\n\n${renderStageGuide(session.stage, session)}`;
  if (tool === "task" || WRITES.includes(tool)) {
    return `${COMMAND_NAME}: ${tool} is refused: this command never creates or changes files.\n\n${renderStageGuide(session.stage, session)}`;
  }
  if (tool === "bash") {
    if (analysisBashAllowed(session.stage, typeof args.command === "string" ? args.command : "")) return null;
    return `${refuse()}\n${ANALYSIS_BASH_RULE}`;
  }
  return null;
}

function normalizeInputs(raw: Partial<PlanInputs>, cwd: string): PlanInputs {
  const tests = (Array.isArray(raw.tests) ? raw.tests : []).map((t: Partial<TestSelection>) => ({
    file: typeof t?.file === "string" ? toRelative(cwd, t.file) : "",
    methods: paths(t?.methods).map((m) => m.replace(/^.*#/, "")),
  }));
  return { module: typeof raw.module === "string" ? toRelative(cwd, raw.module).replace(/\/$/, "") : "", tests };
}

function planProblems(p: PlanInputs, cwd: string): string[] {
  const problems: string[] = [];
  const abs = (f: string): string => path.resolve(cwd, f);
  const moduleDir = p.module.replace(/^:/, "").replace(/:/g, "/");
  if (!/^[\w.\/:-]+$/.test(p.module)) problems.push(`module: "${p.module}" may contain only letters, digits, _ . / : -`);
  else if (!moduleDir || moduleDir === "." || escapes(moduleDir) || !isDir(abs(moduleDir))) problems.push(`module: "${p.module}" must be an existing module directory inside the project`);
  for (const t of p.tests) {
    if (escapes(t.file) || !t.file.endsWith(".java") || !/^[\w.]+$/.test(fqcn(t.file) ?? "")) {
      problems.push(`tests: ${t.file || "(empty)"} must be a .java file under src/test/java with a plain package path`);
    } else if (!isFile(abs(t.file))) {
      problems.push(`tests: ${t.file} does not exist`);
    } else {
      const known = testMethodNames(fs.readFileSync(abs(t.file), "utf-8"));
      for (const m of t.methods ?? []) if (!known.includes(m)) problems.push(`tests: ${t.file} has no @Test method ${m}`);
    }
  }
  return problems;
}

function advance(session: AnalysisSession, to: StageId, lead: string): string {
  session.stage = to;
  if (to === "execute") {
    session.runDir ??= `${WORK_DIR}/run-${localFileStamp()}`;
    session.executeStartedAt = Date.now();
    const file = path.join(session.cwd, session.runDir, "status.json");
    session.baselineMtime = isFile(file) ? fs.statSync(file).mtimeMs : undefined;
  }
  return `${lead}\n\n${renderStageGuide(to, session)}`;
}

function submitPlan(session: AnalysisSession, input: StageInput): string {
  if (!input.note?.trim()) return "Rejected: the plan needs a `note` describing it for the user. If a value cannot be determined, ask the user and END YOUR TURN.";
  const lang = foreignScriptProblem(input.note, REPLY_LANGUAGE, "the plan note");
  if (lang) return `Rejected: ${lang}`;
  const inputs = normalizeInputs(input.inputs ?? {}, session.cwd);
  const problems = planProblems(inputs, session.cwd);
  if (problems.length > 0) return `Rejected: the plan is not valid. Fix these fields and submit again (ask the user when a value is unclear):\n${problems.map((p) => `- ${p}`).join("\n")}`;
  session.inputs = inputs;
  return advance(session, "execute", `Plan recorded: module ${inputs.module}, ${inputs.tests.length > 0 ? `tests ${selectionNames(inputs).join(", ")}` : "all tests"}. Continue with execute now.`);
}

function close(session: AnalysisSession, outcome: Outcome): string {
  session.outcome = outcome;
  session.stage = "report";
  return `Run finished.\n\n${renderStageGuide("report", session)}`;
}

function completeExecute(session: AnalysisSession): string {
  const dir = path.join(session.cwd, session.runDir!);
  const file = path.join(dir, "status.json");
  const fresh = isFile(file) && fs.statSync(file).mtimeMs > (session.baselineMtime ?? 0) && fs.statSync(file).mtimeMs >= (session.executeStartedAt ?? 0) - MTIME_SLACK_MS;
  if (!fresh) return `Rejected: the run left no fresh result (status.json). Call ${STAGE_TOOL} with stage "execute" to run the tests.\n\n${renderStageGuide("execute", session)}`;
  let status: { compile?: string; log?: string; tests?: string };
  try {
    status = JSON.parse(fs.readFileSync(file, "utf-8")) as typeof status;
  } catch {
    return `Rejected: ${session.runDir}/status.json is not valid JSON. Call ${STAGE_TOOL} with stage "execute" again.`;
  }
  const log = status.log ?? "(no log)";
  if (status.compile !== "ok") {
    const env = environmentFailureLine(log);
    if (env) {
      session.envRetries += 1;
      if (session.envRetries > MAX_ENV_RETRIES) return close(session, { kind: "build", log });
      session.baselineMtime = fs.statSync(file).mtimeMs;
      return `The build failed on a dependency/network problem in the environment: ${env}\nTell the user what failed and END YOUR TURN. After they have fixed it, call ${STAGE_TOOL} with stage "execute" again.`;
    }
    return close(session, { kind: "build", log });
  }
  const run = readTestRun(path.join(dir, "test-results"));
  if (status.tests !== "run" || run.total === 0) return close(session, { kind: "none", log });
  const inputs = session.inputs!;
  const xml = readCoverageXmlText(dir);
  const failures = run.failed + run.errored > 0 ? readFailedDetails(path.join(dir, "test-results")) : [];
  const reportFile = writeReport({
    cwd: session.cwd,
    request: session.request,
    module: inputs.module,
    selection: selectionNames(inputs),
    command: gradleCommandText(inputs.module, selectionNames(inputs)),
    run,
    failures,
    coverage: xml ? readTargetCoverage(xml, run.tests.map((t) => t.cls)) : null,
    startedAt: session.startedAt,
  });
  const scriptWarn = reportScriptWarning(fs.readFileSync(path.join(session.cwd, reportFile), "utf-8"), REPLY_LANGUAGE) || undefined;
  if (failures.length > 0) return close(session, { kind: "failed", reportFile, run, failures, scriptWarn });
  return close(session, { kind: "pass", reportFile, run, scriptWarn });
}

/** execute: the plugin runs the tests itself, then judges. `onProgress` feeds the tool's title while it runs. */
export async function runExecute(sessionId: string, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session || session.stage !== "execute" || !session.inputs || !session.runDir) return completeStage(sessionId, { stage: "execute" });
  if (session.running) return "Rejected: the tests are already running. Wait for that call; do not call this twice.";
  session.running = true;
  try {
    await runTests({ cwd: session.cwd, module: session.inputs.module, tests: selectionNames(session.inputs), outDir: path.join(session.cwd, session.runDir), signal, onProgress });
  } catch (e) {
    return `The run could not be completed: ${e instanceof Error ? e.message : String(e)}. Tell the user and END YOUR TURN.`;
  } finally {
    session.running = false;
  }
  if (signal?.aborted) return "The run was cancelled by the user. Tell the user and END YOUR TURN.";
  return completeStage(sessionId, { stage: "execute" });
}

export function completeStage(sessionId: string, input: StageInput): string {
  const session = sessions.get(sessionId);
  if (!session) return `No /${COMMAND_NAME} workflow is active in this session.`;
  if (input.stage !== session.stage) return `Rejected: the current stage is ${session.stage}, not ${input.stage}.\n\n${renderStageGuide(session.stage, session)}`;
  switch (session.stage) {
    case "plan":
      return submitPlan(session, input);
    case "execute":
      return completeExecute(session);
    case "report":
      return "The workflow is closed. Tell the user the result on the console; write nothing.";
  }
}

export const COMMAND_DESCRIPTION = "단위 테스트 실행 후 결과 리포트 (--test 로 일부만, 코드는 수정하지 않음)";

export const STAGE_TOOL_DESCRIPTION =
  "Finish the current stage of the /f-unittest-analysis workflow (plan, execute) and get the next stage's guide. Only callable meaningfully while that workflow is active.";

export const COMMAND_TEMPLATE = `Run the existing unit tests and report by following the stages below. Input: optional \`--test <class | file | Class#method>\` (repeatable); no input runs every test of the module. The plugin enforces the stages: tools outside the current stage are rejected, the result is judged from the run script's files, and every ${STAGE_TOOL} result tells you the next stage. You never create or change any file: a green run gets a report written by the plugin, a red run gets cause and fix guidance on the console only.

${renderStageGuide("plan")}

User request: $ARGUMENTS`;
