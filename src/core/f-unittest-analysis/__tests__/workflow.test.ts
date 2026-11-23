import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND_NAME, completeStage, runExecute, endSession, gateTool, getSession, renderStageGuide, selectionNames, startSession } from "../workflow";
import { analysisBashAllowed } from "../bash-gate";
import { gradleCommandText } from "../runner";

const SID = "a1";
const TEST_FILE = "app/src/test/java/x/PayTest.java";
let root: string;

const put = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const session = () => getSession(SID)!;
const xml = (cases: string): string => `<testsuite name="x.PayTest">${cases}</testsuite>`;
const ok = `<testcase name="a()" classname="x.PayTest" time="0.5"/>`;
const bad = `<testcase name="b()" classname="x.PayTest" time="0.1"><failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="org.opentest4j.AssertionFailedError">at x.Pay.pay(Pay.java:9)\nat x.PayTest.b(PayTest.java:12)</failure></testcase>`;
const planOk = (tests: unknown[] = []) => completeStage(SID, { stage: "plan", note: "계획", inputs: { module: "app", tests } as never });
/** What the runner leaves behind. */
const ran = (status: object, results?: string): void => {
  const dir = session().runDir!;
  if (results !== undefined) put(`${dir}/test-results/TEST-x.PayTest.xml`, xml(results));
  put(`${dir}/status.json`, JSON.stringify(status));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "futan-"));
  put(TEST_FILE, "package x; class PayTest { @Test void a() {} @Test void b() {} }");
  startSession(SID, "--test PayTest", root);
});
afterEach(() => {
  endSession(SID);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plan", () => {
  test("no input plans every test and goes straight to execute", () => {
    startSession(SID, "", root);
    const out = planOk();
    expect(out).toContain("all tests");
    expect(session().stage).toBe("execute");
    expect(selectionNames(session().inputs)).toEqual([]);
    expect(out).not.toContain("--tests");
  });
  test("a selection becomes full names and a method is checked", () => {
    expect(planOk([{ file: TEST_FILE, methods: ["b"] }])).toContain("x.PayTest.b");
    expect(gradleCommandText("app", selectionNames(session().inputs))).toContain(":app:test --continue --tests x.PayTest.b");
    startSession(SID, "", root);
    expect(planOk([{ file: TEST_FILE, methods: ["zzz"] }])).toContain("has no @Test method zzz");
  });
  test("a missing test file or module is rejected", () => {
    expect(planOk([{ file: "app/src/test/java/x/NoTest.java" }])).toContain("does not exist");
    expect(completeStage(SID, { stage: "plan", note: "계획", inputs: { module: "nope", tests: [] } })).toContain("existing module");
  });
});

describe("gates", () => {
  test("no write, no task, bash only read-only git while planning", () => {
    expect(gateTool(SID, "write", { filePath: path.join(root, TEST_FILE) })).toContain("never creates or changes files");
    planOk();
    expect(gateTool(SID, "edit", {})).toContain("refused");
    expect(gateTool(SID, "task", {})).toContain("refused");
    expect(gateTool(SID, "bash", { command: "./gradlew test" })).toContain("not allowed in the execute stage");
    expect(analysisBashAllowed("plan", "git diff")).toBe(true);
    expect(analysisBashAllowed("plan", "git diff; rm -rf x")).toBe(false);
    expect(analysisBashAllowed("execute", "git diff")).toBe(false);
    expect(analysisBashAllowed("report", "git diff")).toBe(false);
  });
  test("the execute guide says the plugin runs the tests", () => {
    planOk();
    expect(renderStageGuide("execute", session())).toContain("Do not use bash");
  });
});

describe("execute", () => {
  beforeEach(() => void planOk([{ file: TEST_FILE }]));
  test("a green run writes the report with the input values", () => {
    ran({ compile: "ok", log: "", tests: "run" }, ok);
    const out = completeStage(SID, { stage: "execute" });
    const o = session().outcome!;
    expect(o.kind).toBe("pass");
    expect(out).toContain("report.md");
    const md = fs.readFileSync(path.join(root, (o as { reportFile: string }).reportFile), "utf-8");
    expect(md).toContain("- 입력: --test PayTest");
    expect(md).toContain("- 실행 대상: x.PayTest");
    expect(md).toContain("| a | 통과 | 0.50 |");
    expect(fs.existsSync(path.join(root, (o as { reportFile: string }).reportFile.replace("md", "html")))).toBe(true);
  });
  test("a full run says 전체 in the input section", () => {
    startSession(SID, "", root);
    planOk();
    ran({ compile: "ok", log: "", tests: "run" }, ok);
    completeStage(SID, { stage: "execute" });
    const md = fs.readFileSync(path.join(root, (session().outcome as { reportFile: string }).reportFile), "utf-8");
    expect(md).toContain("- 입력: (없음)");
    expect(md).toContain("전체 (입력 없음)");
  });
  test("a failing test still writes a report (failures marked) plus console guidance", () => {
    ran({ compile: "ok", log: "", tests: "run" }, ok + bad);
    const out = completeStage(SID, { stage: "execute" });
    expect(session().outcome!.kind).toBe("failed");
    expect(out).toContain("PayTest.b");
    expect(out).toContain("Pay.java:9");
    expect(out).toContain("expected: <1> but was: <2>");
    expect(out).toContain("wrote the report anyway");
    const reportFile = (session().outcome as { reportFile: string }).reportFile;
    expect(reportFile).toBeTruthy();
    const md = fs.readFileSync(path.join(root, reportFile), "utf-8");
    expect(md).toContain("- 결과: FAIL");
    expect(md).toContain("실패 1");
    expect(md).toContain("## 실패 내역");
    expect(md).toContain("단언 실패");
  });
  test("a compile failure and an empty run get guidance without a report", () => {
    ran({ compile: "fail", log: "PayTest.java:3: error: bad" });
    expect(completeStage(SID, { stage: "execute" })).toContain("did not compile");
    expect(fs.existsSync(path.join(root, ".fico/report"))).toBe(false);
    fs.rmSync(path.join(root, ".fico"), { recursive: true, force: true });
    startSession(SID, "", root);
    planOk();
    ran({ compile: "ok", log: "No tests found", tests: "none" });
    expect(completeStage(SID, { stage: "execute" })).toContain("No test ran");
  });
  test("a dependency problem stays in execute and tells the user", () => {
    ran({ compile: "fail", log: "Could not resolve org.x:y:1" });
    const out = completeStage(SID, { stage: "execute" });
    expect(out).toContain("dependency/network");
    expect(session().stage).toBe("execute");
  });
  test("execute without a fresh status.json is rejected", () => {
    expect(completeStage(SID, { stage: "execute" })).toContain("left no fresh result");
  });
  test("the command name is the one the user types", () => {
    expect(COMMAND_NAME).toBe("f-unittest-analysis");
  });
});
