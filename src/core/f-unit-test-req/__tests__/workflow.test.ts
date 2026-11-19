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
    expect(reqBashAllowed("plan", "git diff", ctx)).toBe(true);
    expect(reqBashAllowed("done", "git diff", ctx)).toBe(false);
  });
  test("the plan guide names the command and the three input sources", () => {
    const guide = renderStageGuide("plan");
    for (const w of ["--req-file", "--req", "--program", STAGE_TOOL, COMMAND_NAME.replace("f-unit-test-req", "f-unit-test-req")]) expect(guide + COMMAND_NAME).toContain(w);
  });
});
