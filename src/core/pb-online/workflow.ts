/**
 * /pb-online-code harness: the stage graph and its per-session state.
 *
 * The domain knowledge stays in the standard `pb-fixed-online-code` skill and
 * the fico-mcp server (installed by `gdc fico-init`). This file only owns the
 * flow: which stage a session is in, what each stage may touch, and what has to
 * be true to leave it.
 *
 *   plan → execute → verify ─pass→ report → cleanup
 *             ↑_______fail___|
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp } from "../time";
import { checkSkeleton } from "./skeleton-check";
import { MCP_SERVER, SKILL_NAME } from "./names";

export { MCP_SERVER, SKILL_NAME };

export const COMMAND_NAME = "pb-online-code";
export const STAGE_TOOL = "pb_online_stage";
// Separate from f-review's kb_search, which only answers while a review is active.
export const KB_TOOL = "pb_online_kb_search";
export const REPORT_DIR = ".fico/report/pb-online";

/** Verify→execute round trips before the run is reported as incomplete. */
export const MAX_REWORK = 3;
/** Refused calls while the plan waits for the user before the turn is aborted. */
export const MAX_WAIT_CALLS = 3;
// ponytail: in-memory like f-review/f-log, so a server restart drops the gate.
const MAX_SESSIONS = 50;

export type StageId = "plan" | "execute" | "verify" | "report" | "cleanup";

export interface Stage {
  goal: string;
  steps: string[];
  tools: string[];
  mcp: string[];
  blocked: string[];
  /** What the stage tool call has to carry. */
  finish: string;
}

// `task` is blocked everywhere: a subagent's writes would escape this session's gate.
const WRITES = ["edit", "write", "apply_patch", "multiedit", "patch", "task"];

export const STAGES: Record<StageId, Stage> = {
  plan: {
    goal: "Understand the request and the project, then get the user's approval. Nothing is written here.",
    steps: [
      "If the request does not contain a Program ID (Service ID), ask the user for it and END YOUR TURN before doing anything else. Never guess it.",
      `Load the \`${SKILL_NAME}\` skill with the skill tool. If the skill or the ${MCP_SERVER} server is missing, STOP and tell the user to run \`gdc fico-check\`; never invent the API spec.`,
      "Read the skill's `docs/` rules and its `rules/` directory. `rules/online-project-context.md` is an EXAMPLE project: take the real package, URL prefix and paths from this project.",
      "Extract the Program ID, target Controller and comment description from the request.",
      "Fetch the API spec as the skill describes, replacing every placeholder in the URI with a real value. If the program or its group cannot be found, ask the user and END YOUR TURN.",
      "Find the module ending in `-online`, derive `{online_base_path}`, and list the `{qry|upd}/controller`, `service` and `model/vo` directories. Decide per file whether to add to an existing file or create a new one.",
      `Call ${STAGE_TOOL} with stage "plan", the plan as \`note\` (each target file, new or modified), and \`inputs\` with every required field (program_id, group_name, target_controller, method_name, package_path, and files: the list of every file to create or modify). If the plugin rejects it for a missing field you cannot determine, ask the user and END YOUR TURN. Write the plan for the user in your reply before this call; once it is accepted, END YOUR TURN. Any further tool call while the plan waits is refused, and repeated calls stop the turn.`,
      `After the user approves, call ${STAGE_TOOL} with stage "plan" and user_approved=true. If they ask for changes, submit a new \`note\` and ask again.`,
    ],
    tools: ["skill", "read", "glob", "grep", "list_mcp_resources", "read_mcp_resource"],
    mcp: [
      `${MCP_SERVER}: fico://program-detail/{group_name}/{program_id}`,
      `${MCP_SERVER}: fico://all-programs (find the group when it is not given)`,
    ],
    blocked: [...WRITES, "bash"],
    finish: "`note` = the plan with `inputs` = all required fields, then `user_approved` = true after the user's reply",
  },
  execute: {
    goal: "Generate the approved files from the skill's templates and rules.",
    steps: [
      `Before writing, call ${KB_TOOL} once for each framework class, annotation or utility the code will use (e.g. PBRequest, FixedData, PBOnlineException), and follow the md pages it returns. Open other listed pages with read when they apply. Do not retry a query that found nothing. If the project has no KB, continue with the skill's rules.`,
      "Follow the skill's code generation step for the approved files only. Writing any path that is not in the plan's `files` is refused; if another file is really needed, say so in the report instead.",
      "NEVER delete existing code: keep every method, import, annotation and field of a file you modify.",
      "Replace every template placeholder with a real value.",
      "After writing, compile with bash when the project allows it (for example `./gradlew :<module>-online:compileJava`) and fix any error before finishing execute. Do not create, delete or move files with bash: the plugin compares the project before and after every bash call and lists any change outside the plan in the report.",
    ],
    tools: [KB_TOOL, "read", "edit", "write", "grep", "bash"],
    mcp: [],
    blocked: ["task"],
    finish: "no arguments; at least one file must have been written",
  },
  verify: {
    goal: "Check every generated file. This stage is read-only, bash included: a fix goes back through execute.",
    steps: [
      "Apply `docs/pb-code-verification-rule.md` to every file you created or modified.",
      `Call ${KB_TOOL} for the framework APIs the generated code uses and compare its usage with the md pages. Name the pages you checked in \`note\`; a usage that contradicts a page is a "fail". If a page conflicts with the skill's rules, keep the skill's rule and record the conflict in \`note\`. If the project has no KB, say so in \`note\`.`,
      'Report honestly: `result` "fail" sends you back to execute to fix the listed problems.',
      'On "pass" the plugin also checks required annotations, parameters, call order and imports with a Java parser, and sends you back to execute if any are wrong. Review what it cannot judge: Javadoc wording and whether the code matches the API spec.',
    ],
    tools: [KB_TOOL, "read", "grep"],
    mcp: [],
    blocked: [...WRITES, "bash"],
    finish: '`result` = "pass" or "fail", `note` = findings per rule',
  },
  report: {
    goal: "Record what was done.",
    steps: ["Summarise the outcome, including anything left for the developer such as business logic TODOs."],
    tools: [STAGE_TOOL],
    mcp: [],
    blocked: [...WRITES, "bash"],
    finish: "`note` = the summary; the plugin writes the report file",
  },
  cleanup: {
    goal: "Leave the project tidy and close the workflow.",
    steps: [
      "Remove any scratch files you created that are not part of the deliverable.",
      "Close the workflow, then tell the user the generated files, the verification result and the report path.",
    ],
    tools: ["bash", STAGE_TOOL],
    mcp: [],
    blocked: WRITES,
    finish: "no arguments",
  },
};

/** What the skill needs before generating. Only program_id has no other source than the user. */
export const REQUIRED_INPUTS = {
  program_id: "Program ID (Service ID); only the user can give this",
  group_name: "FICO group holding the program; look it up in fico://all-programs, ask the user if it is not found",
  target_controller: "Controller file to create or modify; from the user or project analysis",
  method_name: "Controller method name; from the user or derived from the Program ID",
  package_path: "Package path including the qry/upd segment; from project analysis",
  files: "Every file you will create or modify, as a project-relative path; execute may write nothing else",
} as const;

type TextField = Exclude<keyof typeof REQUIRED_INPUTS, "files">;
export type PlanInputs = Record<TextField, string> & { files: string[] };
type InputField = keyof typeof REQUIRED_INPUTS;

const TEXT_FIELDS = (Object.keys(REQUIRED_INPUTS) as InputField[]).filter((k): k is TextField => k !== "files");
const cleanFiles = (files: unknown): string[] =>
  Array.isArray(files) ? files.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter(Boolean) : [];

export interface PbSession {
  stage: StageId;
  request: string;
  cwd: string;
  touched: Set<string>;
  /** Touched files that did not exist before this run. */
  created: Set<string>;
  /** Paths that did not exist when a write to them was allowed; created once the write succeeds. */
  absentBeforeWrite: Set<string>;
  /** Project files before the running bash call, to see what it changed. */
  bashBefore?: Map<string, string>;
  /** Changes bash made outside the approved plan's files. */
  outOfPlan: Set<string>;
  /** Existing files the structural check could not parse. */
  unchecked: string[];
  /** fico-mcp resources this session really requested. */
  fetched: Set<string>;
  inputs?: PlanInputs;
  plan?: string;
  planAt?: number;
  userRepliedAt?: number;
  rework: number;
  /** Tool calls refused while the plan waits for the user. */
  awaitingCalls: number;
  verification: "pending" | "passed" | "incomplete";
  verifyNote?: string;
}

export interface StageInput {
  stage: StageId;
  note?: string;
  inputs?: Partial<PlanInputs>;
  user_approved?: boolean;
  result?: "pass" | "fail";
}

const sessions = new Map<string, PbSession>();

export function startSession(sessionId: string, request: string, cwd: string): PbSession {
  sessions.delete(sessionId);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const session: PbSession = {
    stage: "plan",
    request,
    cwd,
    touched: new Set(),
    created: new Set(),
    absentBeforeWrite: new Set(),
    outOfPlan: new Set(),
    unchecked: [],
    fetched: new Set(),
    rework: 0,
    awaitingCalls: 0,
    verification: "pending",
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): PbSession | undefined {
  return sessions.get(sessionId);
}

export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** A real user turn: the only thing that can unlock plan approval. */
export function noteUserMessage(sessionId: string, createdAt: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  // A late update to an older message must not move the reply back before the plan.
  session.userRepliedAt = Math.max(session.userRepliedAt ?? 0, createdAt);
  session.awaitingCalls = 0;
}

/** A recorded plan the user has not answered yet. */
function awaitingReply(session: PbSession): boolean {
  if (session.stage !== "plan" || session.planAt === undefined) return false;
  return session.userRepliedAt === undefined || session.userRepliedAt <= session.planAt;
}

/**
 * True once when the model keeps calling tools while the plan waits. A model
 * that ignores "END YOUR TURN" otherwise loops until its step limit, so the
 * adapter aborts the turn instead.
 */
export function takeAbortRequest(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.awaitingCalls < MAX_WAIT_CALLS) return false;
  session.awaitingCalls = 0;
  return true;
}

export function renderStageGuide(stageId: StageId): string {
  const stage = STAGES[stageId];
  const lines = [
    `[pb-online-code] Current stage: ${stageId} (plan → execute → verify → report → cleanup)`,
    `Goal: ${stage.goal}`,
    `Skill: ${SKILL_NAME}`,
    "Steps:",
    ...stage.steps.map((step, i) => `${i + 1}. ${step}`),
    `Recommended tools: ${stage.tools.join(", ")}`,
  ];
  if (stage.mcp.length > 0) lines.push(`MCP: ${stage.mcp.join("; ")}`);
  lines.push(`Blocked at this stage: ${stage.blocked.join(", ")}`);
  lines.push(`To finish this stage call ${STAGE_TOOL} with stage "${stageId}": ${stage.finish}.`);
  return lines.join("\n");
}

function toRelative(cwd: string, file: string): string {
  return path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
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
    return `pb-online-code: the plan is waiting for the user's reply. Do not call ${tool} or any other tool. END YOUR TURN now.`;
  }
  if (STAGES[session.stage].blocked.includes(tool)) {
    return `pb-online-code: ${tool} is not allowed in the ${session.stage} stage.\n\n${renderStageGuide(session.stage)}`;
  }
  if (tool === "apply_patch" && typeof args.patchText === "string" && /^\*\*\* (?:Delete File|Move to):/m.test(args.patchText)) {
    return "pb-online-code: apply_patch may not delete or move files; existing code must be preserved.";
  }
  if (session.stage === "execute" && WRITES.includes(tool)) {
    const unplanned = targetsOf(tool, args).map((f) => toRelative(session.cwd, f)).filter((f) => !inPlan(session, f));
    if (unplanned.length > 0) {
      return `pb-online-code: ${unplanned.join(", ")} is not in the approved plan. Write only the planned files: ${(session.inputs?.files ?? []).join(", ")}. If another file is really needed, say so in the report.`;
    }
  }
  if (tool === "bash" && session.stage === "execute") session.bashBefore = snapshotFiles(session.cwd);
  // Recorded as generated only after the tool succeeds (noteToolResult): a denied or failed write is not ours.
  if (WRITES.includes(tool)) {
    for (const file of targetsOf(tool, args)) {
      const relative = toRelative(session.cwd, file);
      if (!session.touched.has(relative) && !fs.existsSync(path.resolve(session.cwd, file))) session.absentBeforeWrite.add(relative);
    }
  }
  return null;
}

/** fico-mcp reports API failures as a JSON body with an `error` key, not as a tool error. */
function isFailedResource(output: string): boolean {
  if (output.startsWith("Failed to read MCP resource")) return true;
  const start = output.indexOf("{");
  if (start < 0) return false;
  try {
    const parsed = JSON.parse(output.slice(start)) as Record<string, unknown> | null;
    return parsed !== null && typeof parsed === "object" && parsed.error != null && parsed.error !== false;
  } catch {
    // Not one JSON body (several contents, or trailing text): any non-null error key fails it.
    return /"error"\s*:\s*(?!null\b|false\b)/.test(output);
  }
}

/** Only a spec that really came back counts as fetched; a 401 or 404 must not unlock the plan. */
export function noteToolResult(
  sessionId: string,
  tool: string,
  metadata: Record<string, unknown>,
  output: string,
  args: Record<string, unknown> = {},
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (tool === "bash") {
    noteBashChanges(session);
    return;
  }
  if (WRITES.includes(tool)) {
    for (const file of targetsOf(tool, args)) {
      const relative = toRelative(session.cwd, file);
      if (session.absentBeforeWrite.delete(relative)) session.created.add(relative);
      session.touched.add(relative);
    }
    return;
  }
  if (tool !== "read_mcp_resource") return;
  if (metadata.server !== MCP_SERVER || typeof metadata.uri !== "string" || isFailedResource(output)) return;
  session.fetched.add(normalizeUri(metadata.uri));
}

function normalizeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** Blank values and unfilled `{placeholders}` both count as missing. */
function missingInputs(inputs: Partial<PlanInputs> | undefined): InputField[] {
  const missing: InputField[] = TEXT_FIELDS.filter((field) => {
    const value = typeof inputs?.[field] === "string" ? inputs[field].trim() : "";
    return !value || /[{}]/.test(value);
  });
  const files = cleanFiles(inputs?.files);
  if (files.length === 0 || files.some((f) => /[{}]/.test(f))) missing.push("files");
  return missing;
}

/** Field by field, so a resubmission with the keys in another order is not a revision. */
function sameInputs(a: Partial<PlanInputs>, b: Partial<PlanInputs> | undefined): boolean {
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const files = (v: unknown): string => cleanFiles(v).sort().join("\n");
  return TEXT_FIELDS.every((k) => text(a[k]) === text(b?.[k])) && files(a.files) === files(b?.files);
}

/** Records a complete plan, or says what is still needed. */
function submitPlan(session: PbSession, input: StageInput): string {
  const missing = missingInputs(input.inputs);
  if (missing.length > 0) {
    const fields = missing.map((field) => `- ${field}: ${REQUIRED_INPUTS[field]}`).join("\n");
    return `Rejected: required input is missing.\n${fields}\nFind what the project or ${MCP_SERVER} can tell you. Ask the user for the rest and END YOUR TURN; do not guess or leave placeholders. Then submit the plan again.`;
  }
  const inputs = input.inputs as PlanInputs;
  const specUri = `fico://program-detail/${inputs.group_name.trim()}/${inputs.program_id.trim()}`;
  if (!session.fetched.has(specUri)) {
    return `Rejected: the spec was not fetched successfully. Read ${specUri} from ${MCP_SERVER} with read_mcp_resource first. If it returns an error or cannot be found, tell the user the error, ask them to confirm the Program ID and group or run \`gdc fico-check\`, and END YOUR TURN. Never plan without the spec.`;
  }
  session.inputs = { ...inputs, files: cleanFiles(inputs.files) };
  session.plan = input.note;
  session.planAt = Date.now();
  session.userRepliedAt = undefined;
  session.awaitingCalls = 0;
  return "Plan recorded. Show it to the user and END YOUR TURN; do not continue until they reply.";
}

const PLACEHOLDER =
  /\{(?:PackagePath|CurrentDate|AuthorName|ServiceId|serviceId|ServiceKoreanName|ServiceDescription|ChangeDescription|Collection|DependencyType|dependencyName|ResponseMessageCode|FieldName|Description|Length|PadType|PadChar|Size)\}/g;

/** `target` may be a path, a file name or a bare class name. */
function matchesPath(cwd: string, wanted: string, file: string): boolean {
  let want = wanted.trim().replace(/\\/g, "/");
  if (path.isAbsolute(want)) want = toRelative(cwd, want);
  want = want.replace(/^\.\//, "");
  return file === want || file.endsWith(`/${want}`);
}

function isTarget(cwd: string, target: string, file: string): boolean {
  const wanted = target.trim();
  return matchesPath(cwd, wanted.endsWith(".java") ? wanted : `${wanted}.java`, file);
}

/** Whether a project-relative path is one of the approved plan's files. */
function inPlan(session: PbSession, file: string): boolean {
  return (session.inputs?.files ?? []).some((planned) => matchesPath(session.cwd, planned, file));
}

// ponytail: an mtime+size scan of the project around each bash call; fine for a few thousand files.
const SNAPSHOT_SKIP = new Set([".git", ".gradle", ".idea", ".fico", ".opencode", "build", "out", "bin", "target", "node_modules", "logs"]);

function snapshotFiles(cwd: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(e.name)) walk(path.join(dir, e.name), rel);
      } else if (e.isFile()) {
        const st = fs.statSync(path.join(dir, e.name));
        files.set(rel, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(cwd, "");
  return files;
}

/** bash cannot be gated by path, so compare the project before and after it ran. */
function noteBashChanges(session: PbSession): void {
  const before = session.bashBefore;
  session.bashBefore = undefined;
  if (!before) return;
  const after = snapshotFiles(session.cwd);
  for (const [file, stamp] of after) {
    if (before.get(file) === stamp) continue;
    if (inPlan(session, file)) {
      if (!before.has(file)) session.created.add(file);
      session.touched.add(file);
    } else {
      session.outOfPlan.add(`${file} (bash로 ${before.has(file) ? "수정" : "생성"})`);
    }
  }
  for (const file of before.keys()) if (!after.has(file)) session.outOfPlan.add(`${file} (bash로 삭제)`);
}

/** What the plugin can check itself, whatever the model claimed. */
function findFileProblems(session: PbSession): string[] {
  const problems: string[] = [];
  for (const file of session.touched) {
    const abs = path.resolve(session.cwd, file);
    if (!fs.existsSync(abs)) {
      problems.push(`${file}: file does not exist`);
      continue;
    }
    const source = fs.readFileSync(abs, "utf-8");
    const left = [...new Set(source.match(PLACEHOLDER) ?? [])];
    if (left.length > 0) {
      problems.push(`${file}: unreplaced placeholders ${left.join(" ")}`);
      continue;
    }
    const target = session.inputs?.target_controller;
    const result = checkSkeleton(file, source, {
      isNew: session.created.has(file),
      methodName: session.inputs?.method_name,
      isTargetController: target !== undefined && isTarget(session.cwd, target, file),
    });
    problems.push(...result.problems);
    if (result.unparsable) session.unchecked.push(`${file}: ${result.unparsable}`);
  }
  return problems;
}

function advance(session: PbSession, to: StageId, lead: string): string {
  session.stage = to;
  return `${lead}\n\n${renderStageGuide(session.stage)}`;
}

function writeReport(session: PbSession, summary: string): string {
  const dir = path.join(session.cwd, REPORT_DIR, `report-${localFileStamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.md");
  const body = [
    "# pb-online-code 리포트",
    "",
    `- 요청: ${session.request}`,
    `- 프로그램: ${session.inputs?.group_name}/${session.inputs?.program_id}`,
    `- 검증 결과: ${session.verification === "passed" ? "통과" : "미완료 (재작업 한도 초과)"}`,
    `- 재작업 횟수: ${session.rework}`,
    "",
    "## 생성/수정 파일",
    ...[...session.touched].sort().map((f) => `- ${f}`),
    "",
    "## 계획",
    session.plan ?? "",
    "",
    ...(session.outOfPlan.size > 0
      ? ["## 계획 외 변경 (확인 필요)", ...[...session.outOfPlan].sort().map((f) => `- ${f}`), ""]
      : []),
    "## 검증",
    session.verifyNote ?? "",
    "",
    ...(session.unchecked.length > 0
      ? ["## 구조 검사 불가 (파싱 실패, LLM 검증만 수행됨)", ...session.unchecked.map((u) => `- ${u}`), ""]
      : []),
    "## 요약",
    summary,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

function completeVerify(session: PbSession, input: StageInput): string {
  if (!input.result) return `Rejected: verify needs \`result\` ("pass" or "fail").`;
  if (!input.note) return "Rejected: verify needs a `note` with the findings per rule.";
  session.verifyNote = input.note;
  session.unchecked = [];

  const problems = input.result === "pass" ? findFileProblems(session) : [];
  if (input.result === "pass" && problems.length === 0) {
    session.verification = "passed";
    const skipped = session.unchecked.length > 0 ? ` Structural check skipped (could not parse): ${session.unchecked.join("; ")}` : "";
    const stray = session.outOfPlan.size > 0 ? ` Changed outside the plan, listed in the report: ${[...session.outOfPlan].join("; ")}` : "";
    return advance(session, "report", `Verification passed.${skipped}${stray}`);
  }

  const detail = problems.length > 0 ? `The plugin found problems:\n${problems.join("\n")}` : input.note;
  session.verifyNote = problems.length > 0 ? `${input.note}\n\n${detail}` : input.note;
  session.rework += 1;
  if (session.rework > MAX_REWORK) {
    session.verification = "incomplete";
    return advance(session, "report", `Rework limit (${MAX_REWORK}) reached. Report this run as INCOMPLETE.\n${detail}`);
  }
  return advance(session, "execute", `Back to execute (rework ${session.rework}/${MAX_REWORK}). Fix:\n${detail}`);
}

export function completeStage(sessionId: string, input: StageInput): string {
  const session = sessions.get(sessionId);
  if (!session) return `No /${COMMAND_NAME} workflow is active in this session.`;
  if (input.stage !== session.stage) {
    return `Rejected: the current stage is ${session.stage}, not ${input.stage}.\n\n${renderStageGuide(session.stage)}`;
  }

  switch (session.stage) {
    case "plan": {
      // Changed inputs always make a new plan. A reworded note only does when it is not an approval:
      // models restate the plan when approving, and that must not send the user back to approve again.
      const inputsChanged = input.inputs !== undefined && !sameInputs(input.inputs, session.inputs);
      const reworded = input.note !== session.plan && !input.user_approved;
      if (input.note !== undefined && (!session.plan || inputsChanged || reworded)) return submitPlan(session, input);
      if (!session.plan || session.planAt === undefined) return "Rejected: submit the plan as `note` first.";
      if (awaitingReply(session)) {
        session.awaitingCalls += 1;
        return "Rejected: the plan is recorded and the user has not replied yet. Do not call any tool. END YOUR TURN now.";
      }
      if (!input.user_approved) return "Rejected: pass user_approved=true once the user approved, or a revised `note`.";
      return advance(session, "execute", "Plan approved.");
    }
    case "execute":
      if (session.touched.size === 0) return "Rejected: no file has been written yet.";
      return advance(session, "verify", `Generated: ${[...session.touched].join(", ")}`);
    case "verify":
      return completeVerify(session, input);
    case "report": {
      if (!input.note) return "Rejected: report needs a `note` with the summary.";
      const file = writeReport(session, input.note);
      return advance(session, "cleanup", `Report written: ${file}`);
    }
    case "cleanup":
      sessions.delete(sessionId);
      return "Workflow closed. Tell the user the generated files, the verification result and the report path.";
  }
}

export const COMMAND_DESCRIPTION = "FICO PB 고정길이 온라인 코드(Controller/Service/In·Out VO) 스켈레톤 생성";

export const STAGE_TOOL_DESCRIPTION =
  "Finish the current stage of the /pb-online-code workflow (plan, execute, verify, report, cleanup) and get the next stage's guide. Only callable meaningfully while that workflow is active.";

export const KB_TOOL_DESCRIPTION =
  "Search the in-house framework knowledge base (md pages outside git) for a class, annotation or utility during the /pb-online-code execute and verify stages. Returns the best pages in full and lists the rest by path.";

export const COMMAND_TEMPLATE =`Generate FICO PB fixed-text online code (Controller, Service, Input/Output VO) by following the stages below. The plugin enforces them: tools outside the current stage are rejected, and every ${STAGE_TOOL} result tells you the next stage.

${renderStageGuide("plan")}

User request: $ARGUMENTS`;
