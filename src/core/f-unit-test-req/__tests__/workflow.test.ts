import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  COMMAND_NAME, STAGE_TOOL, completeStage, endSession, gateTool, getSession, noteToolResult, noteUserMessage, renderStageGuide,
  startSession, uncommentedTests, type PlanInputs,
} from "../workflow";
import { compileCommandLine, reqBashAllowed } from "../bash-gate";

const SID = "s1";
const TARGET = "app/src/main/java/x/Pay.java";
const TEST_FILE = "app/src/test/java/x/PayTest.java";
let root: string;

const put = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const plan = (): Partial<PlanInputs> => ({
  source: "text",
  no_program: true,
  module: "app",
  targets: [TARGET],
  files: [TEST_FILE],
  cases: [{ target: TARGET, method: "pay", requirement: "R1 한도 100원", normal: ["a", "b"], boundary: ["한도"], exception: ["초과"], mocks: [] }],
});
const done = (input: Parameters<typeof completeStage>[1]) => completeStage(SID, input);
const session = () => getSession(SID)!;
const approve = (): void => {
  expect(done({ stage: "plan", note: "계획", inputs: plan() })).toContain("Plan recorded");
  noteUserMessage(SID, Date.now() + 1);
  expect(done({ stage: "plan", user_approved: true })).toContain("Plan approved");
};
const GOOD = `package x;
@SpringBootTest @Transactional
class PayTest {
  @BeforeEach void setUp() {}
  @AfterEach void tearDown() {}
  // [요구사항] R1
  // [시나리오] 정상 1
  // [기대] ok
  @Test void pay_normal1() { assertEquals(1, 1); }
}
`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "futreq-"));
  put(TARGET, "package x; class Pay { void pay() { throw new UnsupportedOperationException(); } }");
  startSession(SID, "--req 결제 한도 100원", root);
});
afterEach(() => {
  endSession(SID);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plan", () => {
  test("a missing skeleton class asks the user to create it", () => {
    fs.rmSync(path.join(root, TARGET));
    const out = done({ stage: "plan", note: "계획", inputs: plan() });
    expect(out).toContain("does not exist");
    expect(out).toContain("skeleton");
    expect(session().inputs).toBeUndefined();
  });
  test("every case needs its requirement item", () => {
    const p = plan();
    p.cases![0]!.requirement = "";
    expect(done({ stage: "plan", note: "계획", inputs: p })).toContain("needs `requirement`");
  });
  test("a program plan needs the specification really fetched", () => {
    const p = { ...plan(), source: "program" as const, program_id: "SONAQ001", group_name: "ON" };
    expect(done({ stage: "plan", note: "계획", inputs: p })).toContain("not fetched");
    noteToolResult(SID, "read_mcp_resource", { server: "fico-mcp", uri: "fico://program-detail/ON/SONAQ001" }, "{}");
    expect(done({ stage: "plan", note: "계획", inputs: p })).toContain("Plan recorded");
  });
  test("a text plan with a program ID needs the specification fetched too", () => {
    const p = { ...plan(), no_program: undefined, program_id: "SONAQ001", group_name: "ON" };
    expect(done({ stage: "plan", note: "계획", inputs: p })).toContain("not fetched");
  });
  test("no program given and none confirmed asks the user for the ID", () => {
    const out = done({ stage: "plan", note: "계획", inputs: { ...plan(), no_program: undefined } });
    expect(out).toContain("ask the user");
  });
  test("a requirement file that names a program must not be planned without it", () => {
    put("loan-req.md", "# 요구사항\n프로그램 ID: SONAQ001\n한도 100원");
    const out = done({ stage: "plan", note: "계획", inputs: { ...plan(), source: "file", requirement_file: "loan-req.md" } });
    expect(out).toContain("names program SONAQ001");
  });
  test("a label followed by a plain word is not a program ID", () => {
    put("req.md", "# 요구사항\nProgram ID: PENDING\nPGM: Settings\n한도 100원");
    const out = done({ stage: "plan", note: "계획", inputs: { ...plan(), source: "file", requirement_file: "req.md" } });
    expect(out).toContain("Plan recorded");
  });
  test("a non-Korean script in the plan note is rejected", () => {
    expect(done({ stage: "plan", note: "计划 결제", inputs: plan() })).toContain("Rejected: Non-Korean script");
  });
  test("writes and tests are refused before approval and while the plan waits", () => {
    expect(gateTool(SID, "write", { filePath: path.join(root, TEST_FILE) })).toContain("not allowed");
    done({ stage: "plan", note: "계획", inputs: plan() });
    expect(gateTool(SID, "read", {})).toContain("waiting for the user's reply");
  });
});

describe("execute and verify", () => {
  test("only planned files may be written, and gradle test is refused", () => {
    approve();
    expect(gateTool(SID, "write", { filePath: path.join(root, TEST_FILE) })).toBeNull();
    expect(gateTool(SID, "write", { filePath: path.join(root, "app/src/main/java/x/Pay.java") })).toContain("not in the approved plan");
    expect(gateTool(SID, "bash", { command: "./gradlew :app:compileTestJava --offline" })).toBeNull();
    expect(gateTool(SID, "bash", { command: "./gradlew :app:test" })).toContain("not allowed");
  });
  const verifyWith = (compile: "ok" | "fail", test = GOOD): string => {
    approve();
    put(TEST_FILE, test);
    noteToolResult(SID, "write", {}, "", { filePath: path.join(root, TEST_FILE) });
    done({ stage: "execute" });
    expect(session().stage).toBe("verify");
    put(path.join(session().runDir!, "status.json"), JSON.stringify({ compile, log: compile === "fail" ? "PayTest.java:3: error: bad" : "" }));
    return done({ stage: "verify", note: "none" });
  };
  test("a clean build closes the workflow and lists the created tests, no report", () => {
    const out = verifyWith("ok");
    expect(out).toContain("pay_normal1");
    expect(out).toContain("Write no report file");
    expect(session().stage).toBe("done");
    expect(fs.existsSync(path.join(root, ".fico/report"))).toBe(false);
  });
  test("the user's next message after done ends the session and lifts the gate", () => {
    verifyWith("ok");
    expect(gateTool(SID, "write", { filePath: path.join(root, TARGET) })).not.toBeNull();
    noteUserMessage(SID, session().doneAt! + 1);
    expect(getSession(SID)).toBeUndefined();
    expect(gateTool(SID, "write", { filePath: path.join(root, TARGET) })).toBeNull();
  });
  test("a compile failure goes back to execute with the log", () => {
    const out = verifyWith("fail");
    expect(out).toContain("Back to execute");
    expect(out).toContain("PayTest.java:3");
    expect(session().stage).toBe("execute");
  });
  test("a test without a comment above it is a defect", () => {
    const out = verifyWith("ok", GOOD.replace(/  \/\/ \[.*\n/g, ""));
    expect(out).toContain("has no comment above it");
    expect(session().stage).toBe("execute");
  });
  test("verify without a fresh compile result is rejected", () => {
    approve();
    put(TEST_FILE, GOOD);
    noteToolResult(SID, "write", {}, "", { filePath: path.join(root, TEST_FILE) });
    done({ stage: "execute" });
    expect(done({ stage: "verify", note: "none" })).toContain("Rejected: run");
  });
});

describe("helpers", () => {
  test("uncommentedTests accepts a comment above annotations in between", () => {
    const src = "// c\n@DisplayName(\"x\")\n@Test\nvoid a() {}\n\n@Test\nvoid b() {}\n";
    expect(uncommentedTests(src)).toEqual(["b"]);
    expect(uncommentedTests(src, ["b"])).toEqual([]);
  });
  test("the verify command is exact and only the compile script passes the gate", () => {
    const ctx = { cwd: root, compile: { module: "app", out: ".fico/work/r" }, home: root };
    const cmd = compileCommandLine(ctx, "linux")!;
    expect(cmd).toContain("compile-tests.sh --module app --out .fico/work/r");
    expect(reqBashAllowed("verify", cmd, ctx)).toBe(true);
    expect(reqBashAllowed("verify", cmd + " --extra x", ctx)).toBe(false);
    const ps = compileCommandLine(ctx, "win32")!;
    expect(ps).toContain("-File ");
    expect(ps).toContain("compile-tests.ps1 -Module app -Out .fico/work/r");
    expect(reqBashAllowed("verify", ps, ctx)).toBe(true);
    expect(reqBashAllowed("verify", ps.replace("-Module app", "-Module other"), ctx)).toBe(false);
    expect(reqBashAllowed("verify", cmd.replace("compile-tests.sh", "run-coverage.sh"), ctx)).toBe(false);
    expect(reqBashAllowed("plan", "git diff", ctx)).toBe(true);
    expect(reqBashAllowed("done", "git diff", ctx)).toBe(false);
  });
  test("the plan guide names the command and the three input sources", () => {
    const guide = renderStageGuide("plan");
    for (const w of ["--req-file", "--req", "--program", STAGE_TOOL, COMMAND_NAME.replace("f-unit-test-req", "f-unit-test-req")]) expect(guide + COMMAND_NAME).toContain(w);
  });
});

// plan.md (shared with f-unit-test-code): saved at submission, followed at approval, closed at done.
describe("plan document", () => {
  test("a recorded plan is saved to .fico/f-unittest/runs/<id>/plan.md with a guide for the user", () => {
    const out = done({ stage: "plan", note: "계획", inputs: plan() });
    const doc = session().planDoc!;
    expect(doc).toMatch(/^\.fico\/f-unittest\/runs\/[^/]+\/plan\.md$/);
    expect(out).toContain(doc);
    const md = fs.readFileSync(path.join(root, doc), "utf-8");
    expect(md).toContain("/f-unit-test-req 계획");
    expect(md).toContain("- 상태: 승인 대기 (rev 1)");
    expect(md).toContain("R1 한도 100원");
  });
  test("a user's edit of the inputs in plan.md becomes the approved plan", () => {
    done({ stage: "plan", note: "계획", inputs: plan() });
    const abs = path.join(root, session().planDoc!);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("R1 한도 100원", "R1 한도 200원"));
    noteUserMessage(SID, Date.now() + 1);
    expect(done({ stage: "plan", user_approved: true })).toContain("Plan approved");
    expect(session().inputs!.cases[0]!.requirement).toBe("R1 한도 200원");
    expect(fs.readFileSync(abs, "utf-8")).toContain("- 상태: 승인됨");
  });
  test("an invalid edit is rejected and the run stays in plan", () => {
    done({ stage: "plan", note: "계획", inputs: plan() });
    const abs = path.join(root, session().planDoc!);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace('"module": "app",', '"module": app,'));
    noteUserMessage(SID, Date.now() + 1);
    expect(done({ stage: "plan", user_approved: true })).toContain("invalid");
    expect(session().stage).toBe("plan");
  });
  test("closing the workflow marks plan.md done", () => {
    approve();
    put(TEST_FILE, GOOD);
    noteToolResult(SID, "write", {}, "", { filePath: path.join(root, TEST_FILE) });
    done({ stage: "execute" });
    put(path.join(session().runDir!, "status.json"), JSON.stringify({ compile: "ok", log: "" }));
    done({ stage: "verify", note: "none" });
    expect(session().stage).toBe("done");
    expect(fs.readFileSync(path.join(root, session().planDoc!), "utf-8")).toContain("- 상태: 완료");
  });
});
