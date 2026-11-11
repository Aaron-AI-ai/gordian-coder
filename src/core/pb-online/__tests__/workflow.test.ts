import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_REWORK,
  MAX_WAIT_CALLS,
  STAGES,
  completeStage,
  endSession,
  gateTool,
  getSession,
  noteToolResult,
  noteUserMessage,
  renderStageGuide,
  startSession,
  takeAbortRequest,
} from "../workflow";

const SID = "ses-1";
const INPUTS = {
  program_id: "AIAC0007",
  group_name: "Account",
  target_controller: "a-online/src/main/java/x/online/qry/controller/AcController.java",
  method_name: "aiac0007",
  package_path: "x.online.qry",
  files: [
    "A.java",
    "b/B.java",
    "a-online/src/main/java/x/online/qry/controller/AcController.java",
    "a-online/src/main/java/x/online/qry/model/vo/AIAC0007In.java",
  ],
};
const SPEC_URI = "fico://program-detail/Account/AIAC0007";
const SPEC_OK = "Resource: x\nMIME: application/json\n{\"programId\": \"AIAC0007\"}";
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pb-online-"));
  startSession(SID, "AIAC0007", cwd);
  noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: SPEC_URI }, SPEC_OK);
});

afterEach(() => {
  endSession(SID);
  fs.rmSync(cwd, { recursive: true, force: true });
});

const done = (input: Parameters<typeof completeStage>[1]) => completeStage(SID, input);
/** A write that the gate allowed and that then succeeded, as OpenCode reports it. */
function writeOk(tool: string, args: Record<string, unknown>): string | null {
  const rejection = gateTool(SID, tool, args);
  if (!rejection) noteToolResult(SID, tool, {}, "ok", args);
  return rejection;
}

function approvePlan(): void {
  done({ stage: "plan", note: "the plan", inputs: INPUTS });
  noteUserMessage(SID, Date.now() + 1);
  done({ stage: "plan", user_approved: true });
}

/** Reach `verify` with one real, clean file written through the gate. */
function reachVerify(content = "class A {}\n"): void {
  approvePlan();
  fs.writeFileSync(path.join(cwd, "A.java"), content);
  writeOk("write", { filePath: path.join(cwd, "A.java") });
  done({ stage: "execute" });
}

describe("stage graph", () => {
  test("every stage names its recommended tools, and plan names the MCP server", () => {
    for (const stage of Object.values(STAGES)) expect(stage.tools.length).toBeGreaterThan(0);
    expect(STAGES.plan.mcp.join(" ")).toContain("fico-mcp");
    expect(STAGES.plan.tools).toContain("read_mcp_resource");
    // OpenCode has no `list` tool; recommending it made the model call a missing tool.
    for (const stage of Object.values(STAGES)) expect(stage.tools).not.toContain("list");
  });

  test("guide shows the stage, tools and what is blocked", () => {
    const guide = renderStageGuide(getSession(SID)!.stage);
    expect(guide).toContain("plan");
    expect(guide).toContain("read_mcp_resource");
    expect(guide).toContain("write");
    expect(guide).toContain("pb-fixed-online-code");
  });

  test("a stale stage is rejected and the session does not move", () => {
    const out = done({ stage: "verify", result: "pass", note: "x" });
    expect(out).toContain("plan");
    expect(getSession(SID)!.stage).toBe("plan");
  });
});

describe("tool gate", () => {
  test("sessions without the workflow are never gated", () => {
    expect(gateTool("other-session", "write", { filePath: "x" })).toBeNull();
    expect(gateTool("other-session", "bash", {})).toBeNull();
  });

  test("plan blocks writes and shell but allows reading", () => {
    expect(gateTool(SID, "write", { filePath: "x" })).toContain("plan");
    expect(gateTool(SID, "edit", { filePath: "x" })).toContain("plan");
    expect(gateTool(SID, "apply_patch", {})).toContain("plan");
    expect(gateTool(SID, "bash", {})).toContain("plan");
    expect(gateTool(SID, "read", { filePath: "x" })).toBeNull();
    expect(gateTool(SID, "read_mcp_resource", {})).toBeNull();
  });

  test("execute allows writes and records the files actually touched", () => {
    approvePlan();
    expect(writeOk("write", { filePath: path.join(cwd, "A.java") })).toBeNull();
    expect(writeOk("apply_patch", { patchText: "*** Begin Patch\n*** Add File: b/B.java\n+x\n*** End Patch" })).toBeNull();
    expect([...getSession(SID)!.touched].sort()).toEqual(["A.java", "b/B.java"]);
  });

  test("verify is read-only so a fix has to go back through execute", () => {
    reachVerify();
    expect(gateTool(SID, "edit", { filePath: "A.java" })).toContain("verify");
    expect(gateTool(SID, "bash", {})).toContain("verify");
  });
});

describe("review fixes", () => {
  test("a write that was denied or failed is not counted as generated", () => {
    approvePlan();
    expect(gateTool(SID, "write", { filePath: path.join(cwd, "A.java") })).toBeNull();
    expect(getSession(SID)!.touched.size).toBe(0);
    expect(done({ stage: "execute" })).toContain("no file");
  });

  test("apply_patch may not delete or move files", () => {
    approvePlan();
    expect(gateTool(SID, "apply_patch", { patchText: "*** Begin Patch\n*** Delete File: A.java\n*** End Patch" })).toContain("delete");
    expect(gateTool(SID, "apply_patch", { patchText: "*** Begin Patch\n*** Update File: A.java\n*** Move to: B.java\n*** End Patch" })).toContain("delete");
  });

  test("a late update to an older user message does not take the approval back", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    noteUserMessage(SID, Date.now() + 1000);
    noteUserMessage(SID, Date.now() - 60_000);
    done({ stage: "plan", user_approved: true });
    expect(getSession(SID)!.stage).toBe("execute");
  });

  test("the same note with corrected inputs is recorded again and needs a new reply", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    noteUserMessage(SID, Date.now() + 1);
    noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/G2/AIAC0007" }, SPEC_OK);
    const fixed = { ...INPUTS, group_name: "G2" };
    expect(done({ stage: "plan", note: "the plan", inputs: fixed, user_approved: true })).toContain("Plan recorded");
    expect(getSession(SID)!.inputs).toEqual(fixed);
    expect(getSession(SID)!.stage).toBe("plan");
  });

  test("approving with a reworded note approves the recorded plan instead of revising it", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    noteUserMessage(SID, Date.now() + 1);
    done({ stage: "plan", note: "the plan, summarised again", inputs: INPUTS, user_approved: true });
    expect(getSession(SID)!.stage).toBe("execute");
    expect(getSession(SID)!.plan).toBe("the plan");
  });

  test("the same inputs in a different key order are not a revision", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    const planAt = getSession(SID)!.planAt;
    const reordered = Object.fromEntries(Object.entries(INPUTS).reverse()) as typeof INPUTS;
    expect(done({ stage: "plan", note: "the plan", inputs: reordered })).toContain("has not replied yet");
    expect(getSession(SID)!.planAt).toBe(planAt);
  });

  test.each([
    ['{"success": true, "error": null, "data": {}}', true],
    ['{"error": "[401] Unauthorized"}\nsee the logs', false],
  ])("resource output %s counts as fetched: %s", (body, fetched) => {
    noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/Account/AIAC4444" }, `Resource: x\nMIME: application/json\n${body}`);
    done({ stage: "plan", note: "p", inputs: { ...INPUTS, program_id: "AIAC4444" } });
    expect(getSession(SID)!.plan !== undefined).toBe(fetched);
  });
});

describe("approved files only", () => {
  test("the plan must list the files it will write", () => {
    expect(done({ stage: "plan", note: "p", inputs: { ...INPUTS, files: [] } })).toContain("files");
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("execute refuses a file that is not in the approved plan", () => {
    approvePlan();
    const out = gateTool(SID, "edit", { filePath: path.join(cwd, "a-online/src/main/java/x/online/mapper/TestLabMapper.java") });
    expect(out).toContain("not in the approved plan");
    expect(gateTool(SID, "write", { filePath: path.join(cwd, "A.java") })).toBeNull();
  });

  test("a patch that adds an unplanned file is refused", () => {
    approvePlan();
    const patch = "*** Begin Patch\n*** Add File: A.java\n+x\n*** Add File: Extra.java\n+y\n*** End Patch";
    expect(gateTool(SID, "apply_patch", { patchText: patch })).toContain("Extra.java");
  });
});

describe("bash changes in execute", () => {
  function bash(change: () => void): void {
    expect(gateTool(SID, "bash", { command: "x" })).toBeNull();
    change();
    noteToolResult(SID, "bash", {}, "done", { command: "x" });
  }

  test("a planned file written by bash counts as generated", () => {
    approvePlan();
    bash(() => fs.writeFileSync(path.join(cwd, "A.java"), "class A {}\n"));
    expect(getSession(SID)!.touched.has("A.java")).toBe(true);
    expect(getSession(SID)!.created.has("A.java")).toBe(true);
  });

  test("files bash changes outside the plan, or deletes, are reported", () => {
    fs.writeFileSync(path.join(cwd, "Existing.java"), "class E {}\n");
    approvePlan();
    bash(() => {
      fs.writeFileSync(path.join(cwd, "Stray.java"), "x");
      fs.rmSync(path.join(cwd, "Existing.java"));
      fs.writeFileSync(path.join(cwd, "A.java"), "class A {}\n");
    });
    done({ stage: "execute" });
    const out = done({ stage: "verify", result: "pass", note: "ok" });
    expect(out).toContain("Stray.java");
    done({ stage: "report", note: "s" });
    const root = path.join(cwd, ".fico", "report", "pb-online");
    const report = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]!, "report.md"), "utf-8");
    expect(report).toContain("계획 외 변경");
    expect(report).toContain("Stray.java");
    expect(report).toContain("Existing.java");
  });

  test("build output directories are not reported", () => {
    approvePlan();
    bash(() => {
      fs.mkdirSync(path.join(cwd, "build/classes"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "build/classes/A.class"), "x");
      fs.writeFileSync(path.join(cwd, "A.java"), "class A {}\n");
    });
    expect(getSession(SID)!.outOfPlan.size).toBe(0);
  });
});

describe("plan approval", () => {
  test("requires a plan", () => {
    expect(done({ stage: "plan" })).toContain("note");
    expect(getSession(SID)!.stage).toBe("plan");
  });

  test("the model cannot approve its own plan without a new user message", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    const out = done({ stage: "plan", user_approved: true });
    expect(out).toContain("user");
    expect(getSession(SID)!.stage).toBe("plan");
  });

  test("a user message older than the plan does not count", () => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
    noteUserMessage(SID, Date.now() - 60_000);
    done({ stage: "plan", user_approved: true });
    expect(getSession(SID)!.stage).toBe("plan");
  });

  test("a revised plan needs a fresh reply", () => {
    done({ stage: "plan", note: "v1", inputs: INPUTS });
    noteUserMessage(SID, Date.now() + 1);
    done({ stage: "plan", note: "v2", inputs: INPUTS });
    done({ stage: "plan", user_approved: true });
    expect(getSession(SID)!.stage).toBe("plan");
  });

  test("a user reply after the plan advances to execute", () => {
    approvePlan();
    expect(getSession(SID)!.stage).toBe("execute");
  });
});

describe("plan required inputs", () => {
  const submit = (inputs: Partial<typeof INPUTS> | undefined) =>
    done({ stage: "plan", note: "the plan", inputs: inputs as typeof INPUTS });

  test("guide says to ask for the Program ID before doing anything else", () => {
    const guide = renderStageGuide(getSession(SID)!.stage);
    expect(guide).toContain("Program ID");
    expect(guide).toContain("END YOUR TURN");
  });

  test("no inputs at all names every field and tells the model to ask", () => {
    const out = submit(undefined);
    for (const field of Object.keys(INPUTS)) expect(out).toContain(field);
    expect(out).toContain("Ask the user");
    expect(out.split("\n").length).toBeGreaterThan(Object.keys(INPUTS).length);
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test.each(Object.keys(INPUTS))("%s alone missing is rejected and named", (field) => {
    const out = submit({ ...INPUTS, [field]: "  " });
    expect(out).toContain(field);
    expect(out).toContain("Rejected");
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("an unfilled placeholder is treated as missing", () => {
    const out = submit({ ...INPUTS, group_name: "{group_name}" });
    expect(out).toContain("group_name");
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("the plan is refused until that program's spec was actually fetched", () => {
    const out = submit({ ...INPUTS, program_id: "AIAC9999" });
    expect(out).toContain("fico://program-detail/Account/AIAC9999");
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("a percent-encoded group in the fetched URI still matches", () => {
    noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/%EA%B3%84%EC%A2%8C/AIAC0007" }, SPEC_OK);
    submit({ ...INPUTS, group_name: "계좌" });
    expect(getSession(SID)!.plan).toBe("the plan");
  });

  test("a fetch from another MCP server does not count", () => {
    noteToolResult(SID, "read_mcp_resource", { server: "other", uri: "fico://program-detail/Account/AIAC1111" }, SPEC_OK);
    submit({ ...INPUTS, program_id: "AIAC1111" });
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("a fetch that returned an error does not count", () => {
    const failed = 'Resource: x\nMIME: application/json\n{\n  "error": "[401] Unauthorized",\n  "status": 401\n}';
    noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/Account/AIAC2222" }, failed);
    const out = submit({ ...INPUTS, program_id: "AIAC2222" });
    expect(out).toContain("not fetched");
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("merely calling the read tool does not count", () => {
    gateTool(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/Account/AIAC3333" });
    submit({ ...INPUTS, program_id: "AIAC3333" });
    expect(getSession(SID)!.plan).toBeUndefined();
  });

  test("complete inputs are recorded and reach the report", () => {
    submit(INPUTS);
    expect(getSession(SID)!.inputs).toEqual(INPUTS);
  });
});

describe("waiting for the user's reply", () => {
  beforeEach(() => {
    done({ stage: "plan", note: "the plan", inputs: INPUTS });
  });

  test("every other tool is refused while the plan waits", () => {
    expect(gateTool(SID, "read", { filePath: "x" })).toContain("END YOUR TURN");
    expect(gateTool(SID, "glob", {})).toContain("END YOUR TURN");
  });

  test("resubmitting the same plan is refused, not recorded again", () => {
    const planAt = getSession(SID)!.planAt;
    expect(done({ stage: "plan", note: "the plan", inputs: INPUTS })).toContain("END YOUR TURN");
    expect(getSession(SID)!.planAt).toBe(planAt);
  });

  test(`after ${MAX_WAIT_CALLS} refused calls the plugin asks once to stop the turn`, () => {
    for (let i = 0; i < MAX_WAIT_CALLS - 1; i++) gateTool(SID, "read", {});
    expect(takeAbortRequest(SID)).toBe(false);
    done({ stage: "plan", user_approved: true });
    expect(takeAbortRequest(SID)).toBe(true);
    expect(takeAbortRequest(SID)).toBe(false);
  });

  test("the user's reply lifts the wait and approval works with the same plan resubmitted", () => {
    noteUserMessage(SID, Date.now() + 1);
    expect(gateTool(SID, "read", { filePath: "x" })).toBeNull();
    done({ stage: "plan", note: "the plan", inputs: INPUTS, user_approved: true });
    expect(getSession(SID)!.stage).toBe("execute");
  });
});

describe("execute and verify", () => {
  test("execute cannot finish without writing anything", () => {
    approvePlan();
    expect(done({ stage: "execute" })).toContain("no file");
    expect(getSession(SID)!.stage).toBe("execute");
  });

  test("verify needs a result and findings", () => {
    reachVerify();
    expect(done({ stage: "verify", note: "ok" })).toContain("result");
    expect(done({ stage: "verify", result: "pass" })).toContain("note");
    expect(getSession(SID)!.stage).toBe("verify");
  });

  test("pass on clean files moves to report", () => {
    reachVerify();
    done({ stage: "verify", result: "pass", note: "all rules ok" });
    expect(getSession(SID)!.stage).toBe("report");
  });

  test("a claimed pass with a template placeholder left is overruled", () => {
    reachVerify("package {PackagePath};\n");
    const out = done({ stage: "verify", result: "pass", note: "all good" });
    expect(out).toContain("{PackagePath}");
    expect(getSession(SID)!.stage).toBe("execute");
    expect(getSession(SID)!.rework).toBe(1);
  });

  test("a brace expression that is not a template placeholder passes", () => {
    reachVerify('@Foo(names = {Bar.class}) String s = "{other}";\n');
    done({ stage: "verify", result: "pass", note: "ok" });
    expect(getSession(SID)!.stage).toBe("report");
  });

  test("a claimed pass on a file that no longer exists is overruled", () => {
    reachVerify();
    fs.rmSync(path.join(cwd, "A.java"));
    done({ stage: "verify", result: "pass", note: "ok" });
    expect(getSession(SID)!.stage).toBe("execute");
  });

  test("fail goes back to execute, and past the cap reports incomplete rather than passed", () => {
    reachVerify();
    for (let i = 0; i < MAX_REWORK; i++) {
      done({ stage: "verify", result: "fail", note: `issue ${i}` });
      expect(getSession(SID)!.stage).toBe("execute");
      done({ stage: "execute" });
    }
    done({ stage: "verify", result: "fail", note: "still broken" });
    const s = getSession(SID)!;
    expect(s.stage).toBe("report");
    expect(s.verification).toBe("incomplete");
  });
});

describe("target controller matching", () => {
  const TPL = path.resolve(import.meta.dir, "../../../../assets/fico-ai/skills/pb-fixed-online-code/templates/ControllerTemplate.java");
  const FILE = "a-online/src/main/java/x/online/qry/controller/AcController.java";

  test.each(["AcController", "AcController.java", "qry/controller/AcController.java"])(
    "target given as %s still requires the method",
    (target) => {
      done({ stage: "plan", note: "p", inputs: { ...INPUTS, target_controller: target, method_name: "missingMethod" } });
      noteUserMessage(SID, Date.now() + 1);
      done({ stage: "plan", user_approved: true });
      const source = fs.readFileSync(TPL, "utf-8").replace(/\{(\w+)\}/g, (_m, k: string) => (k === "serviceId" ? "aiac0007" : k === "ServiceId" ? "AIAC0007" : "v"));
      const gate = gateTool(SID, "write", { filePath: path.join(cwd, FILE) });
      fs.mkdirSync(path.dirname(path.join(cwd, FILE)), { recursive: true });
      fs.writeFileSync(path.join(cwd, FILE), source);
      expect(gate).toBeNull();
      noteToolResult(SID, "write", {}, "ok", { filePath: path.join(cwd, FILE) });
      done({ stage: "execute" });
      expect(done({ stage: "verify", result: "pass", note: "ok" })).toContain("missingMethod");
    }
  );
});

describe("structural check at the verify gate", () => {
  const TEMPLATES = path.resolve(import.meta.dir, "../../../../assets/fico-ai/skills/pb-fixed-online-code/templates");
  const VO_FILE = "a-online/src/main/java/x/online/qry/model/vo/AIAC0007In.java";
  const voSource = (): string =>
    fs
      .readFileSync(path.join(TEMPLATES, "VoInTemplate.java"), "utf-8")
      .replace(/\{Length\}/g, "10")
      .replace(/\{PadType\}/g, "RIGHT")
      .replace(/\{PadChar\}/g, "0")
      .replace(/\{FieldName\}/g, "acctNo")
      .replace(/\{ServiceId\}/g, "AIAC0007")
      .replace(/\{(\w+)\}/g, "v");

  /** Write through the gate first, as OpenCode does: the file does not exist yet. */
  function generate(file: string, content: string): void {
    approvePlan();
    const gate = gateTool(SID, "write", { filePath: path.join(cwd, file) });
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
    expect(gate).toBeNull();
    noteToolResult(SID, "write", {}, "Wrote file successfully.", { filePath: path.join(cwd, file) });
    done({ stage: "execute" });
  }

  test("a clean generated VO passes", () => {
    generate(VO_FILE, voSource());
    done({ stage: "verify", result: "pass", note: "ok" });
    expect(getSession(SID)!.stage).toBe("report");
  });

  test("a claimed pass on a VO missing padType is overruled with the reason", () => {
    generate(VO_FILE, voSource().replace(", padType = PAD_TYPE.RIGHT", ""));
    const out = done({ stage: "verify", result: "pass", note: "all good" });
    expect(out).toContain("padType");
    expect(getSession(SID)!.stage).toBe("execute");
    expect(getSession(SID)!.verifyNote).toContain("padType");
  });

  test("an existing controller that cannot be parsed passes but is flagged in the report", () => {
    const file = "a-online/src/main/java/x/online/qry/controller/AcController.java";
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), "public class {{{");
    approvePlan();
    writeOk("edit", { filePath: path.join(cwd, file) });
    done({ stage: "execute" });
    expect(done({ stage: "verify", result: "pass", note: "ok" })).toContain("could not parse");
    done({ stage: "report", note: "summary" });
    const root = path.join(cwd, ".fico", "report", "pb-online");
    const report = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]!, "report.md"), "utf-8");
    expect(report).toContain("구조 검사 불가");
    expect(report).toContain(file);
  });
});

describe("report and cleanup", () => {
  test("report is written under .fico/report/pb-online and cleanup ends the session", () => {
    reachVerify();
    done({ stage: "verify", result: "pass", note: "rule findings" });
    expect(done({ stage: "report" })).toContain("note");

    const out = done({ stage: "report", note: "made one controller" });
    const root = path.join(cwd, ".fico", "report", "pb-online");
    const [dir] = fs.readdirSync(root);
    expect(dir).toStartWith("report-");
    const report = fs.readFileSync(path.join(root, dir!, "report.md"), "utf-8");
    expect(report).toContain("AIAC0007");
    expect(report).toContain("Account");
    expect(report).toContain("A.java");
    expect(report).toContain("the plan");
    expect(report).toContain("rule findings");
    expect(report).toContain("made one controller");
    expect(out).toContain(dir!);
    expect(getSession(SID)!.stage).toBe("cleanup");

    done({ stage: "cleanup" });
    expect(getSession(SID)).toBeUndefined();
    expect(gateTool(SID, "write", { filePath: "x" })).toBeNull();
  });
});
