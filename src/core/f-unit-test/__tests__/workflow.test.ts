import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  COMMAND_TEMPLATE,
  MAX_COVERAGE_ROUNDS,
  MAX_FIX_RETRIES,
  MAX_WAIT_CALLS,
  REPORT_DIR,
  completeStage,
  endSession,
  gateTool,
  getSession,
  noteToolResult,
  noteUserMessage,
  renderStageGuide,
  startSession,
  takeAbortRequest,
  type PlanInputs,
  type StageInput,
} from "../workflow";

const SID = "fut-1";
const MODULE = "on-stk-ord-online";
const PKG = "kr/co/koscom/pb/on/stk/ord/online/qry/service";
const TARGET = `${MODULE}/src/main/java/${PKG}/SONAQ001Service.java`;
const TEST_FILE = `${MODULE}/src/test/java/${PKG}/SONAQ001ServiceTest.java`;
const FQCN = "kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001ServiceTest";

const GOOD_TEST = `package kr.co.koscom.pb.on.stk.ord.online.qry.service;
@SpringBootTest
@Transactional
class SONAQ001ServiceTest {
  @MockitoBean AccountBSM accountBSM;
  @BeforeEach void setUp() {}
  @AfterEach void tearDown() {}
  @Test void inquire_normal1() { assertEquals(1, service.inquire(1)); }
  @Test void inquire_normal2() { assertEquals(2, service.inquire(2)); }
}
`;

let cwd: string;

function okPlan(): PlanInputs {
  return {
    mode: "files",
    module: MODULE,
    targets: [TARGET],
    files: [TEST_FILE],
    cases: [
      {
        target: TARGET,
        method: "inquire",
        normal: ["single account", "several accounts"],
        boundary: ["account number of max length"],
        exception: ["AccountBSM throws PBOnlineException"],
        mocks: ["AccountBSM"],
      },
    ],
  };
}

function put(rel: string, content: string): string {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f-unit-test-"));
  put(TARGET, "package x;\nclass SONAQ001Service {}\n");
  startSession(SID, "--files SONAQ001Service.java", cwd);
});

afterEach(() => {
  endSession(SID);
  fs.rmSync(cwd, { recursive: true, force: true });
});

const done = (input: StageInput): string => completeStage(SID, input);
const session = () => getSession(SID)!;

function writeOk(tool: string, args: Record<string, unknown>): string | null {
  const rejection = gateTool(SID, tool, args);
  if (!rejection) noteToolResult(SID, tool, args);
  return rejection;
}

function approve(inputs: PlanInputs = okPlan()): void {
  expect(done({ stage: "plan", note: "the plan", inputs })).toContain("Plan recorded");
  noteUserMessage(SID, Date.now() + 1);
  done({ stage: "plan", user_approved: true });
  expect(session().stage).toBe("execute");
}

function writeTest(content = GOOD_TEST): void {
  put(TEST_FILE, content);
  expect(writeOk("write", { filePath: path.join(cwd, TEST_FILE) })).toBeNull();
}

/** The run-coverage.sh command for the current session, from a project-installed skill. */
function coverageCmd(): string {
  const s = session();
  const tests = s.inputs!.files.filter((f) => f.endsWith(".java")).map((f) => f.replace(/^.*src\/test\/java\//, "").replace(/\.java$/, "").replace(/\//g, "."));
  return `sh .opencode/skills/f-unit-test-code/scripts/run-coverage.sh --module ${s.inputs!.module} --tests ${tests.join(",")} --out ${s.runDir}`;
}

function reachVerify(content = GOOD_TEST): void {
  approve();
  writeTest(content);
  done({ stage: "execute" });
  expect(session().stage).toBe("verify");
}

interface RunFacts {
  compile?: "ok" | "fail";
  xml?: string | null;
  failed?: string[];
  passed?: string[];
  log?: string;
}

let lastStamp = 0;
/** Strictly increasing mtimes: a rerun must be newer than the verify-entry baseline even within one clock tick. */
function stampNow(...files: string[]): void {
  lastStamp = Math.max(Date.now(), lastStamp + 10);
  const at = new Date(lastStamp);
  for (const f of files) if (fs.existsSync(f)) fs.utimesSync(f, at, at);
}

/** What run-coverage.sh leaves behind. */
function runCoverage({ compile = "ok", xml = jacoco(0, 0), failed = [], passed = [], log = "BUILD SUCCESSFUL" }: RunFacts = {}): void {
  const out = path.join(cwd, session().runDir!);
  fs.mkdirSync(path.join(out, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(out, "status.json"), JSON.stringify({ compile, log, coverage: xml === null ? "missing" : "ok" }));
  fs.rmSync(path.join(out, "jacoco.xml"), { force: true });
  if (xml !== null) fs.writeFileSync(path.join(out, "jacoco.xml"), xml);
  const cases =
    failed.map((m) => `<testcase classname="${FQCN}" name="${m}"><failure message="x"/></testcase>`).join("") +
    passed.map((m) => `<testcase classname="${FQCN}" name="${m}"/>`).join("");
  fs.writeFileSync(path.join(out, "test-results", "TEST-x.xml"), `<testsuite>${cases}<testcase classname="${FQCN}" name="ok"/></testsuite>`);
  stampNow(path.join(out, "status.json"), path.join(out, "jacoco.xml"));
}

/** A JaCoCo report for SONAQ001Service with the given missed lines/branches (lines 12.. missed). */
function jacoco(missedLines: number, missedBranches: number): string {
  const lines = [`<line nr="10" mi="0" ci="3" mb="0" cb="0"/>`];
  for (let i = 0; i < missedLines; i++) lines.push(`<line nr="${12 + i}" mi="2" ci="0" mb="0" cb="0"/>`);
  if (missedBranches > 0) lines.push(`<line nr="30" mi="0" ci="2" mb="${missedBranches}" cb="1"/>`);
  return `<report name="x"><package name="${PKG}"><sourcefile name="SONAQ001Service.java">${lines.join("")}<counter type="LINE" missed="${missedLines}" covered="1"/><counter type="BRANCH" missed="${missedBranches}" covered="1"/></sourcefile></package></report>`;
}

describe("plan", () => {
  test("plan rejects a case set without two normal, one boundary and one exception cases", () => {
    const plan = okPlan();
    plan.cases[0]!.normal = ["only one", "  "];
    plan.cases[0]!.exception = [];
    const out = done({ stage: "plan", note: "p", inputs: plan });
    expect(out).toStartWith("Rejected:");
    expect(out).toContain("normal");
    expect(out).toContain("exception");
    expect(session().plan).toBeUndefined();
  });

  test("plan guide tells the model to ask the user when a required input is missing", () => {
    const guide = renderStageGuide("plan", session());
    expect(guide).toContain("ASK THE USER and END YOUR TURN");
    expect(guide).toContain("--program ID matches no");
    expect(guide).toContain("Gradle module");
  });

  test("a rejected plan tells the model to ask the user for what it cannot determine, not to guess", () => {
    const missing = done({ stage: "plan", note: "p", inputs: { ...okPlan(), module: "" } });
    expect(missing).toStartWith("Rejected:");
    expect(missing).toContain("ask the user");
    expect(missing).toContain("END YOUR TURN");
    expect(done({ stage: "plan", note: "  ", inputs: okPlan() })).toContain("ask the user");
    expect(session().plan).toBeUndefined();
  });

  test("plan accepts skip_reason instead of cases", () => {
    const plan = okPlan();
    plan.cases[0] = { target: TARGET, method: "toString", normal: [], boundary: [], exception: [], mocks: [], skip_reason: "generated getter" };
    expect(done({ stage: "plan", note: "p", inputs: plan })).toContain("Plan recorded");
  });

  test("plan rejects a module directory that does not exist", () => {
    const out = done({ stage: "plan", note: "p", inputs: { ...okPlan(), module: "no-such-online" } });
    expect(out).toStartWith("Rejected:");
    expect(out).toContain("module");
  });

  test("plan rejects files outside src/test", () => {
    const out = done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: [`${MODULE}/src/main/java/${PKG}/SONAQ001ServiceTest.java`] } });
    expect(out).toStartWith("Rejected:");
    expect(out).toContain("files");
  });

  test("plan rejects a target that is not under src/main/java", () => {
    const stray = `${MODULE}/src/test/java/${PKG}/Helper.java`;
    put(stray, "class Helper {}");
    const plan = okPlan();
    plan.targets = [stray];
    plan.cases[0]!.target = stray;
    const out = done({ stage: "plan", note: "p", inputs: plan });
    expect(out).toStartWith("Rejected:");
    expect(out).toContain("targets");
    // A target that does not exist is rejected too.
    const missing = okPlan();
    missing.targets = [`${MODULE}/src/main/java/${PKG}/Nope.java`];
    missing.cases[0]!.target = missing.targets[0]!;
    expect(done({ stage: "plan", note: "p", inputs: missing })).toStartWith("Rejected:");
  });

  test("plan normalizes backslash paths", () => {
    const back = (p: string): string => p.replace(/\//g, "\\");
    const plan = okPlan();
    plan.targets = [back(TARGET)];
    plan.files = [back(TEST_FILE)];
    plan.cases[0]!.target = back(TARGET);
    expect(done({ stage: "plan", note: "p", inputs: plan })).toContain("Plan recorded");
    expect(session().inputs!.targets).toEqual([TARGET]);
    expect(session().inputs!.files).toEqual([TEST_FILE]);
    expect(session().inputs!.cases[0]!.target).toBe(TARGET);
  });

  test("plan waits for the user: a reply is required before approval", () => {
    done({ stage: "plan", note: "p", inputs: okPlan() });
    expect(done({ stage: "plan", user_approved: true })).toContain("has not replied");
    expect(session().stage).toBe("plan");
    for (let i = 1; i < MAX_WAIT_CALLS; i++) expect(gateTool(SID, "read", { filePath: "x" })).toContain("END YOUR TURN");
    expect(takeAbortRequest(SID)).toBe(true);
    noteUserMessage(SID, Date.now() + 1);
    expect(gateTool(SID, "read", { filePath: "x" })).toBeNull();
    done({ stage: "plan", user_approved: true });
    expect(session().stage).toBe("execute");
  });

  test("plan allows only read-only git in bash", () => {
    expect(gateTool(SID, "bash", { command: "git diff HEAD" })).toBeNull();
    expect(gateTool(SID, "bash", { command: "  git status --short" })).toBeNull();
    expect(gateTool(SID, "bash", { command: "git checkout -- ." })).toContain("plan");
    expect(gateTool(SID, "bash", { command: "./gradlew test" })).toContain("plan");
    expect(gateTool(SID, "write", { filePath: "x" })).toContain("plan");
    expect(gateTool(SID, "task", {})).toContain("plan");
    expect(gateTool(SID, "read", { filePath: "x" })).toBeNull();
  });

  test("plan records the existing @Test methods of planned test files", () => {
    put(TEST_FILE, GOOD_TEST);
    done({ stage: "plan", note: "p", inputs: okPlan() });
    expect(session().previousMethods[TEST_FILE]).toEqual(["inquire_normal1", "inquire_normal2"]);
  });

  test("the command template starts with the plan guide and the skill name", () => {
    expect(COMMAND_TEMPLATE).toContain("f-unit-test-code");
    expect(COMMAND_TEMPLATE).toContain("$ARGUMENTS");
    expect(renderStageGuide("plan")).toContain("Current stage: plan");
  });
});

describe("execute", () => {
  test("execute refuses to write a file that is not in the plan", () => {
    approve();
    expect(gateTool(SID, "write", { filePath: path.join(cwd, TARGET) })).toContain("not in the approved plan");
    expect(gateTool(SID, "edit", { filePath: path.join(cwd, TEST_FILE) })).toBeNull();
    // Windows-style path to the planned file still matches.
    expect(gateTool(SID, "edit", { filePath: TEST_FILE.replace(/\//g, "\\") })).toBeNull();
    expect(gateTool(SID, "task", {})).toContain("execute");
  });

  test("execute allows bash for gradle only", () => {
    approve();
    expect(gateTool(SID, "bash", { command: `./gradlew :${MODULE}:compileTestJava` })).toBeNull();
    expect(gateTool(SID, "bash", { command: "gradlew.bat test" })).toBeNull();
    expect(gateTool(SID, "bash", { command: "git diff" })).toBeNull();
    expect(gateTool(SID, "bash", { command: "rm -rf src" })).toContain("execute");
  });

  test("execute needs at least one written file to finish", () => {
    approve();
    expect(done({ stage: "execute" })).toContain("Rejected");
    writeTest();
    const out = done({ stage: "execute" });
    expect(session().stage).toBe("verify");
    expect(session().runDir).toStartWith(`${REPORT_DIR}/report-`);
    expect(out).toContain(`--out ${session().runDir}`);
    expect(out).toContain(`--tests ${FQCN}`);
    expect(out).toContain(`--module ${MODULE}`);
  });
});

describe("verify", () => {
  test("verify blocks writes and allows bash only for run-coverage.sh", () => {
    reachVerify();
    expect(gateTool(SID, "edit", { filePath: TEST_FILE })).toContain("verify");
    expect(gateTool(SID, "bash", { command: "./gradlew test" })).toContain("verify");
    expect(gateTool(SID, "bash", { command: coverageCmd() })).toBeNull();
    expect(gateTool(SID, "bash", { command: "sh .opencode/skills/f-unit-test-code/scripts/run-coverage.sh --module x" })).toContain("verify");
  });

  test("verify needs a note", () => {
    reachVerify();
    runCoverage();
    expect(done({ stage: "verify" })).toContain("note");
  });

  test("verify refuses a status.json older than the stage entry", () => {
    reachVerify();
    expect(done({ stage: "verify", note: "n" })).toContain("run run-coverage.sh first");
    runCoverage();
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(cwd, session().runDir!, "status.json"), old, old);
    expect(done({ stage: "verify", note: "n" })).toContain("run run-coverage.sh first");
    // A fresh status.json with a stale jacoco.xml is refused the same way.
    runCoverage();
    fs.utimesSync(path.join(cwd, session().runDir!, "jacoco.xml"), old, old);
    expect(done({ stage: "verify", note: "n" })).toContain("run run-coverage.sh first");
    expect(session().stage).toBe("verify");
  });

  test("compile failure returns to execute and does not use a coverage round", () => {
    reachVerify();
    runCoverage({ compile: "fail", xml: null, log: "error: cannot find symbol AccountBSM" });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("cannot find symbol");
    expect(session().fixRetries).toBe(1);
    expect(session().gapRounds).toBe(0);
  });

  test("a dependency/network failure stays in verify, counts a retry and tells the model to stop", () => {
    reachVerify();
    const line = "> Could not HEAD 'http://nexus/m.xml'. Received status code 429 from server: Too many authentication attempts";
    runCoverage({ compile: "fail", xml: null, log: `FAILURE: Build failed\n${line}\nBUILD FAILED in 6s` });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("verify");
    expect(session().fixRetries).toBe(1);
    expect(out).toContain(line.trim());
    expect(out).toContain("END YOUR TURN");
    expect(out).toContain("do NOT edit the tests");
    expect(out).not.toContain("defects in the tests");
    // No new write is needed: a fresh rerun of the script is judged again in verify.
    runCoverage();
    expect(done({ stage: "verify", note: "n" })).toContain("fully covered");
    expect(session().stage).toBe("report");
  });

  test("a javac error naming UnknownHostException is a test-code error, not the environment", () => {
    reachVerify();
    const log = `${MODULE}/src/test/java/x/AT.java:5: error: cannot find symbol\n  symbol: class UnknownHostException\nimport java.net.UnknownHostException;`;
    runCoverage({ compile: "fail", xml: null, log });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("cannot find symbol");
    expect(out).not.toContain("END YOUR TURN");
  });

  test("compiled but no coverage because the test step hit the network is an environment failure too", () => {
    reachVerify();
    runCoverage({ compile: "ok", xml: null, log: "> Could not resolve org.junit.platform:junit-platform-launcher:1.10.0.\nReceived status code 429 from server" });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("verify");
    expect(session().fixRetries).toBe(1);
    expect(out).toContain("Could not resolve org.junit.platform");
    expect(out).toContain("END YOUR TURN");
  });

  test("after an environment failure the old status.json is not judged again", () => {
    reachVerify();
    runCoverage({ compile: "fail", xml: null, log: "> Could not resolve a:b:1." });
    done({ stage: "verify", note: "n" });
    expect(done({ stage: "verify", note: "n" })).toContain("run run-coverage.sh first");
    expect(session().fixRetries).toBe(2);
  });

  test("environment failures over the cap end incomplete with the reason in report.md", () => {
    reachVerify();
    for (let i = 1; i <= MAX_FIX_RETRIES; i++) {
      runCoverage({ compile: "fail", xml: null, log: "> Could not resolve a:b:1." });
      done({ stage: "verify", note: "n" });
      expect(session().stage).toBe("verify");
    }
    runCoverage({ compile: "fail", xml: null, log: "> Could not resolve a:b:1." });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("incomplete");
    const out = done({ stage: "report", note: "s" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain("Could not resolve a:b:1.");
    expect(report).toMatch(/dependency\/network/);
  });

  test("fix retries over the cap end the run as incomplete", () => {
    reachVerify();
    for (let i = 1; i <= MAX_FIX_RETRIES; i++) {
      runCoverage({ compile: "fail", xml: null });
      done({ stage: "verify", note: "n" });
      expect(session().stage).toBe("execute");
      writeTest();
      done({ stage: "execute" });
    }
    runCoverage({ compile: "fail", xml: null });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("incomplete");
  });

  test("a lost existing test method is returned as a defect", () => {
    put(TEST_FILE, GOOD_TEST);
    approve();
    writeTest(GOOD_TEST.replace(/\s*@Test void inquire_normal2[^\n]*/, ""));
    done({ stage: "execute" });
    runCoverage();
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("inquire_normal2");
    expect(session().fixRetries).toBe(1);
  });

  test("coverage gap returns to execute with uncovered lines up to three rounds then reports with gaps", () => {
    reachVerify();
    for (let round = 1; round <= MAX_COVERAGE_ROUNDS; round++) {
      runCoverage({ xml: jacoco(2, 1) });
      const out = done({ stage: "verify", note: "n" });
      expect(session().stage).toBe("execute");
      expect(out).toContain("12, 13");
      expect(out).toContain("30");
      expect(session().gapRounds).toBe(round);
      writeTest();
      done({ stage: "execute" });
    }
    runCoverage({ xml: jacoco(2, 1) });
    done({ stage: "verify", note: "line 13 is defensive code" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("gaps");
    expect(session().fixRetries).toBe(0);
  });

  test("a target missing from the jacoco xml counts as a gap, not a crash", () => {
    reachVerify();
    runCoverage({ xml: `<report name="x"></report>` });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain(TARGET);
    expect(session().gapRounds).toBe(1);
  });

  // run-coverage writes JaCoCo's HTML next to jacoco.xml; the report links it only when it is there.
  test("the report links the JaCoCo HTML report when the run produced one", () => {
    reachVerify();
    runCoverage();
    done({ stage: "verify", note: "n" });
    const html = path.join(cwd, session().runDir!, "jacoco-html");
    fs.mkdirSync(html, { recursive: true });
    fs.writeFileSync(path.join(html, "index.html"), "<html/>");
    const out = done({ stage: "report", note: "s" });
    const md = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(md).toContain("(jacoco-html/index.html)");
    expect(fs.readFileSync(md.length ? out.match(/Report written: (\S+)/)![1]!.replace(/\.md$/, ".html") : "", "utf-8")).toContain('href="jacoco-html/index.html"');
  });

  test("without a JaCoCo HTML report the report has no link", () => {
    reachVerify();
    runCoverage();
    done({ stage: "verify", note: "n" });
    const out = done({ stage: "report", note: "s" });
    expect(fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8")).not.toContain("jacoco-html");
  });

  test("full coverage reports as covered", () => {
    reachVerify();
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("covered");
  });

  test("the report separates broken pre-existing tests from failing new ones, each with its cause", () => {
    reachVerify();
    runCoverage();
    session().previousMethods = { [TEST_FILE]: ["inquire_normal1"] };
    const dir = path.join(cwd, session().runDir!, "test-results");
    fs.writeFileSync(
      path.join(dir, "TEST-y.xml"),
      `<testsuite>` +
        `<testcase classname="${FQCN}" name="inquire_normal1"><failure message="expected: &lt;3000&gt; but was: &lt;3500&gt;" type="org.opentest4j.AssertionFailedError">x\n\tat ${FQCN}.inquire_normal1(SONAQ001ServiceTest.java:34)\n</failure></testcase>` +
        `<testcase classname="${FQCN}" name="inquire_new"><error message="boom | pipe" type="java.lang.IllegalStateException"/></testcase>` +
        `</testsuite>`,
    );
    // The new test keeps failing: once the fix retries are used up the run is reported, failures included.
    for (let i = 0; i <= MAX_FIX_RETRIES && session().stage !== "report"; i++) {
      if (session().stage === "execute") { writeTest(); done({ stage: "execute" }); runCoverage(); }
      fs.writeFileSync(
        path.join(dir, "TEST-y.xml"),
        `<testsuite>` +
          `<testcase classname="${FQCN}" name="inquire_normal1"><failure message="expected: &lt;3000&gt; but was: &lt;3500&gt;" type="org.opentest4j.AssertionFailedError">x\n\tat ${FQCN}.inquire_normal1(SONAQ001ServiceTest.java:34)\n</failure></testcase>` +
          `<testcase classname="${FQCN}" name="inquire_new"><error message="boom | pipe" type="java.lang.IllegalStateException"/></testcase>` +
          `</testsuite>`,
      );
      done({ stage: "verify", note: "n" });
    }
    expect(session().verification).toBe("incomplete");
    const out = done({ stage: "report", note: "summary" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    const section = report.slice(report.indexOf("## 확인 필요"), report.indexOf("## 요약"));
    const lines = section.split("\n");
    const oldLine = lines.find((l) => l.includes("inquire_normal1"))!;
    expect(oldLine).toContain("기대 3000, 실제 3500");
    expect(oldLine).toContain("SONAQ001ServiceTest.java:34");
    expect(oldLine).toContain("기존 테스트");
    const newLine = lines.find((l) => l.includes("inquire_new"))!;
    expect(newLine).toContain("IllegalStateException: boom | pipe");
    expect(newLine).toContain("이번에 생성");
  });

  test("the report describes each test from the plan by its kind and number", () => {
    reachVerify();
    runCoverage({ passed: ["inquire_normal2", "inquire_boundary", "inquire_exception"] });
    done({ stage: "verify", note: "n" });
    const out = done({ stage: "report", note: "s" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain(`파일: ${TEST_FILE}`); // the eval checker looks for the test file name
    expect(report).toMatch(/\| inquire_normal2 \| 정상 \| several accounts \|/);
    expect(report).toMatch(/\| inquire_boundary \| 경계값 \| account number of max length \|/);
    expect(report).toMatch(/작업 일시: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d ~ \d\d:\d\d:\d\d \(/);
    expect(report).toMatch(/\| inquire_exception \| 예외 \| AccountBSM throws PBOnlineException \|/);
  });

  // A test generated in this run must pass: a failure is a wrong expectation to fix in the test, never in production code.
  test("a failing test generated in this run sends the run back to execute to fix the test", () => {
    reachVerify();
    runCoverage({ failed: ["inquire_normal2"] });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(session().fixRetries).toBe(1);
    expect(out).toContain("inquire_normal2");
    expect(out).toContain("never change production code");
  });

  test("a failing pre-existing test is reported but does not block", () => {
    reachVerify();
    runCoverage({ failed: ["inquire_normal2"] });
    session().previousMethods = { [TEST_FILE]: ["inquire_normal2"] };
    done({ stage: "verify", note: "n" });
    expect(session().verification).toBe("covered");
    expect(session().failedTests).toEqual([`${FQCN}.inquire_normal2`]);
    const out = done({ stage: "report", note: "summary" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain("SONAQ001ServiceTest.inquire_normal2");
  });
});

describe("report", () => {
  test("report writes report.md with the coverage table and ends the session", () => {
    reachVerify();
    for (let i = 0; i <= MAX_COVERAGE_ROUNDS; i++) {
      runCoverage({ xml: jacoco(1, 0) });
      done({ stage: "verify", note: "line 12 is unreachable" });
      if (session().stage === "execute") {
        writeTest();
        done({ stage: "execute" });
      }
    }
    expect(session().stage).toBe("report");
    expect(done({ stage: "report" })).toContain("note");
    const runDir = session().runDir!;
    const out = done({ stage: "report", note: "all methods tested" });
    const file = path.join(cwd, runDir, "report.md");
    expect(out).toContain(file);
    const report = fs.readFileSync(file, "utf-8");
    expect(report).toContain("| 대상 |");
    expect(report).toContain(TARGET);
    expect(report).toContain("1/2"); // lines covered/total
    expect(report).toContain("12");
    expect(report).toContain("line 12 is unreachable");
    expect(report).toContain("all methods tested");
    expect(report).toContain("## 실행 명령");
    expect(report).toContain("## 만든 테스트");
    expect(report).toMatch(/작업 일시: .* ~ /);
    expect(out).toContain("report.html");
    const html = fs.readFileSync(path.join(cwd, runDir, "report.html"), "utf-8");
    expect(html).toContain("실행 명령");
    expect(html).toContain("all methods tested");
    expect(html).not.toContain("{{");
    expect(getSession(SID)).toBeUndefined();
  });
});

describe("review round 1: gate bypasses", () => {
  test("bash in each stage goes through the bash gate with this session's context", () => {
    expect(gateTool(SID, "bash", { command: 'git diff "--output=x"' })).toContain("bash runs one plain command");
    approve();
    expect(gateTool(SID, "bash", { command: `./gradlew :${MODULE}:testClasses` })).toBeNull();
    expect(gateTool(SID, "bash", { command: "./gradlew wrapper" })).toContain("not allowed in the execute stage");
    writeTest();
    done({ stage: "execute" });
    // The guide prints the global path when the project has no skill install; the gate accepts it.
    const run = renderStageGuide("verify", session()).split("\n").find((l) => l.startsWith("Run exactly"))!;
    const command = run.slice(run.indexOf("sh "));
    expect(command).toContain(`--module ${MODULE} --tests ${FQCN} --out ${session().runDir}`);
    expect(command).toContain(".config/opencode/skills/f-unit-test-code/scripts/run-coverage.sh");
    expect(gateTool(SID, "bash", { command })).toBeNull();
    expect(gateTool(SID, "bash", { command: coverageCmd() })).toBeNull();
    expect(gateTool(SID, "bash", { command: `${coverageCmd()} --project ..` })).toContain("not allowed in the verify stage");
    // With a project install the guide switches to the project-relative path.
    put(".opencode/skills/f-unit-test-code/scripts/run-coverage.sh", "#!/bin/sh\n");
    expect(renderStageGuide("verify", session())).toContain(`Run exactly (no quotes, no extra arguments): ${coverageCmd()}`);
  });


  test("plan refuses module '..', module '.', a module with whitespace and files escaping the project", () => {
    for (const module of ["..", ".", "./", `${MODULE}/..`, "mod a"]) {
      expect(done({ stage: "plan", note: "p", inputs: { ...okPlan(), module } })).toContain("module:");
    }
    const out = done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: ["../../x/src/test/A.java"] } });
    expect(out).toStartWith("Rejected:");
    expect(out).toContain("files:");
    const escaping = okPlan();
    escaping.targets = [`../elsewhere/${TARGET}`];
    escaping.cases[0]!.target = escaping.targets[0]!;
    expect(done({ stage: "plan", note: "p", inputs: escaping })).toContain("targets:");
  });

  test("plan refuses a planned file named like run-coverage.sh", () => {
    for (const name of ["run-coverage.sh", "evilrun-coverage.sh", "Run-Coverage.SH", "run-coverage.ps1", "Run-Coverage.PS1"]) {
      const out = done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: [TEST_FILE, `${MODULE}/src/test/resources/${name}`] } });
      expect(out).toContain("run-coverage");
      expect(out).toStartWith("Rejected:");
    }
  });

  test("plan needs a .java test file and plain module and package names", () => {
    expect(done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: [`${MODULE}/src/test/resources/application-test.yml`] } })).toContain(".java test file");
    expect(done({ stage: "plan", note: "p", inputs: { ...okPlan(), module: `${MODULE}'` } })).toContain("module:");
    expect(done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: [`${MODULE}/src/test/java/a b/XTest.java`] } })).toContain("plain package path");
  });

  test("an absolute write outside the project that ends in a planned path is refused", () => {
    approve();
    expect(gateTool(SID, "write", { filePath: `/etc/${TEST_FILE}` })).toContain("not in the approved plan");
    expect(gateTool(SID, "write", { filePath: path.join(cwd, "nested", TEST_FILE) })).toContain("not in the approved plan");
    expect(gateTool(SID, "write", { filePath: path.join(cwd, TEST_FILE).replace(/\//g, "\\") })).toBeNull();
  });

  test("after a gap, execute with no new write cannot finish", () => {
    reachVerify();
    runCoverage({ xml: jacoco(1, 0) });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(done({ stage: "execute" })).toContain("nothing was written in this round");
    expect(session().stage).toBe("execute");
  });

  test("verify re-entered without re-running the script is refused", () => {
    reachVerify();
    runCoverage({ xml: jacoco(1, 0) });
    done({ stage: "verify", note: "n" });
    writeTest();
    done({ stage: "execute" });
    expect(session().stage).toBe("verify");
    expect(done({ stage: "verify", note: "n" })).toContain("run run-coverage.sh first");
    expect(session().gapRounds).toBe(1);
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().verification).toBe("covered");
  });

  test("a blank plan note is refused", () => {
    expect(done({ stage: "plan", note: "  ", inputs: okPlan() })).toContain("note");
    expect(session().plan).toBeUndefined();
  });
});

describe("final review fixes", () => {
  test("a legacy test file is extended without being blamed for its old shape", () => {
    const legacy = `class SONAQ001ServiceTest {\n  @Disabled\n  @Test void old1() { service.run(); }\n  @Test void old2() { service.run(); }\n}\n`;
    put(TEST_FILE, legacy);
    approve();
    expect(session().previousMethods[TEST_FILE]).toEqual(["old1", "old2"]);
    writeTest(legacy.replace(/\n}\n$/, "\n  @MockitoBean AccountBSM accountBSM;\n  @Test void inquire_normal1() { assertEquals(1, service.inquire(1)); }\n}\n"));
    done({ stage: "execute" });
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().fixRetries).toBe(0);
  });

  test("plan rejects mocks that are not class names", () => {
    for (const mock of ["AccountBSM.getAccount(", "AccountBSM (on-stk-ord-bsm)"]) {
      const plan = okPlan();
      plan.cases[0]!.mocks = [mock];
      const out = done({ stage: "plan", note: "p", inputs: plan });
      expect(out).toStartWith("Rejected:");
      expect(out).toContain("class name only");
    }
    const fq = okPlan();
    fq.cases[0]!.mocks = ["kr.co.koscom.pb.bsm.AccountBSM"];
    expect(done({ stage: "plan", note: "p", inputs: fq })).toContain("Plan recorded");
  });

  test("a skip_reason-only case needs no case lists", () => {
    const plan = okPlan();
    plan.cases.push({ target: TARGET, method: "toString", skip_reason: "generated" } as unknown as (typeof plan.cases)[number]);
    expect(done({ stage: "plan", note: "p", inputs: plan })).toContain("Plan recorded");
  });

  test("verify calls without fresh results burn fix retries and end as incomplete", () => {
    reachVerify();
    for (let i = 1; i <= MAX_FIX_RETRIES; i++) {
      expect(done({ stage: "verify", note: "n" })).toContain(`fix retry (${i}/${MAX_FIX_RETRIES})`);
      expect(session().stage).toBe("verify");
    }
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("incomplete");
    const out = done({ stage: "report", note: "s" });
    expect(fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8")).toContain("without fresh run-coverage.sh results");
  });

  test("the plan guide asks for the transaction manager of a non-primary datasource Mapper", () => {
    const guide = renderStageGuide("plan");
    expect(guide).toContain("transaction manager");
    expect(guide).toContain('@Transactional("<transactionManager bean>")');
  });

  test("the verify guide names the PowerShell script for Windows and that it is unverified", () => {
    const guide = renderStageGuide("verify");
    expect(guide).toContain("run-coverage.ps1");
    expect(guide).toContain("not verified in the development environment");
    expect(guide).not.toContain("POSIX shell");
  });

  test("the verify guide prints the PowerShell command on win32 and the sh command elsewhere; the gate accepts both", () => {
    approve();
    writeTest();
    done({ stage: "execute" });
    const runLine = (platform: NodeJS.Platform): string => {
      const line = renderStageGuide("verify", session(), platform).split("\n").find((l) => l.startsWith("Run exactly"))!;
      return line.slice(line.indexOf(": ") + 2);
    };
    const win = runLine("win32");
    expect(win).toStartWith("powershell -NoProfile -ExecutionPolicy Bypass -File ");
    expect(win).toContain(`run-coverage.ps1 -Module ${MODULE} -Tests ${FQCN} -Out ${session().runDir}`);
    expect(gateTool(SID, "bash", { command: win })).toBeNull();
    const posix = runLine("darwin");
    expect(posix).toStartWith("sh ");
    expect(posix).toContain(`run-coverage.sh --module ${MODULE}`);
    expect(gateTool(SID, "bash", { command: posix })).toBeNull();
  });

  test("a target whose cases are all skipped is not a coverage gap and is listed as skipped", () => {
    const other = `${MODULE}/src/main/java/${PKG}/SONAQ001Out.java`;
    put(other, "class SONAQ001Out {}");
    const plan = okPlan();
    plan.targets.push(other);
    plan.cases.push({ target: other, method: "getX", normal: [], boundary: [], exception: [], mocks: [], skip_reason: "plain VO getter" });
    plan.cases.push({ target: TARGET, method: "toString", normal: [], boundary: [], exception: [], mocks: [], skip_reason: "Lombok" });
    approve(plan);
    writeTest();
    done({ stage: "execute" });
    runCoverage(); // jacoco has SONAQ001Service only
    done({ stage: "verify", note: "n" });
    expect(session().verification).toBe("covered");
    expect(session().coverage.map((c) => c.target)).toEqual([TARGET]);
    const out = done({ stage: "report", note: "s" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain(`제외: ${other}#getX — plain VO getter (대상 전체 제외`);
    expect(report).toContain(`제외: ${TARGET}#toString — Lombok`);
  });

  test("a write whose target cannot be determined is refused", () => {
    approve();
    expect(gateTool(SID, "write", { content: "x" })).toContain("could not be determined");
    expect(gateTool(SID, "multiedit", { edits: [] })).toContain("could not be determined");
    expect(gateTool(SID, "patch", { patchText: "garbage" })).toContain("could not be determined");
    expect(gateTool(SID, "patch", { patchText: `*** Begin Patch\n*** Update File: ${TEST_FILE}\n*** End Patch` })).toBeNull();
  });

  test("the guide tells the user to run gdc fico-init when the global path cannot be typed", () => {
    const home = spyOn(os, "homedir").mockReturnValue("/Users/Jane Doe");
    try {
      reachVerify();
      expect(renderStageGuide("verify", session())).toContain("gdc fico-init");
      expect(renderStageGuide("verify", session())).not.toContain("Run exactly");
    } finally {
      home.mockRestore();
    }
  });
});

describe("interface targets", () => {
  test("a plain interface (not a Mapper) is not measured by JaCoCo and is reported as such", () => {
    put(TARGET, "package x;\npublic interface SONAQ001Service { Out inquire(In in); }\n");
    reachVerify();
    runCoverage({ xml: jacoco(3, 1) });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().gapRounds).toBe(0);
    expect(session().verification).toBe("covered");
    const out = done({ stage: "report", note: "s" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain(`${TARGET}: 커버리지 측정 안 함 (인터페이스)`);
  });

  test("an annotation type (@interface) is still measured like a class", () => {
    put(TARGET, "package x;\npublic @interface SONAQ001Service { String value(); }\n");
    reachVerify();
    runCoverage({ xml: jacoco(1, 0) });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(session().gapRounds).toBe(1);
  });

});

describe("Mapper targets", () => {
  const MAPPER = `${MODULE}/src/main/java/kr/co/koscom/pb/on/stk/ord/online/mapper/AccountOnlineMapper.java`;
  const MAPPER_TEST = `${MODULE}/src/test/java/kr/co/koscom/pb/on/stk/ord/online/mapper/AccountOnlineMapperTest.java`;
  const MAPPER_SRC = `package x;
import org.apache.ibatis.annotations.Mapper;
/** doc */
@Mapper
public interface AccountOnlineMapper {
  List<R> selectAccountList(P parameter, RowBounds rowBounds);
  long countAccountList(@Param("p") P parameter);
  int insert(P parameter);
}
`;
  const mapperTest = (calls: string[]): string => `@SpringBootTest
@ActiveProfiles("test")
@Transactional
class AccountOnlineMapperTest {
  @Autowired AccountOnlineMapper mapper;
  @BeforeEach void setUp() {}
  @AfterEach void tearDown() {}
  @Test void a_normal1() { assertEquals(1, mapper.${calls[0] ?? "noop"}(null)); }
${calls.slice(1).map((c, i) => `  @Test void b${i}_normal2() { assertEquals(1, mapper.${c}(null)); }`).join("\n")}
}
`;
  const mapperCase = {
    target: MAPPER,
    method: "all",
    normal: ["a", "b"],
    boundary: ["c"],
    exception: ["d"],
    mocks: [] as string[],
  };

  function mapperPlan(withService: boolean): PlanInputs {
    const plan = okPlan();
    if (!withService) {
      plan.targets = [];
      plan.cases = [];
    }
    plan.targets.push(MAPPER);
    plan.files.push(MAPPER_TEST);
    plan.cases.push(mapperCase);
    return plan;
  }

  function toVerify(withService: boolean, calls: string[]): void {
    put(MAPPER, MAPPER_SRC);
    approve(mapperPlan(withService));
    if (withService) writeTest();
    put(MAPPER_TEST, mapperTest(calls));
    expect(writeOk("write", { filePath: path.join(cwd, MAPPER_TEST) })).toBeNull();
    done({ stage: "execute" });
    expect(session().stage).toBe("verify");
  }

  test("a Mapper test that mocks its own Mapper is a defect", () => {
    put(MAPPER, MAPPER_SRC);
    approve(mapperPlan(false));
    put(MAPPER_TEST, mapperTest(["selectAccountList", "countAccountList", "insert"]).replace("@Autowired AccountOnlineMapper", "@MockitoBean AccountOnlineMapper"));
    expect(writeOk("write", { filePath: path.join(cwd, MAPPER_TEST) })).toBeNull();
    done({ stage: "execute" });
    runCoverage({ xml: `<report name="x"></report>` });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("AccountOnlineMapper");
    expect(out).toContain("실제");
  });

  test("an extended Mapper test must still carry @Transactional and @ActiveProfiles", () => {
    put(MAPPER, MAPPER_SRC);
    const noProfile = (calls: string[]): string => mapperTest(calls).replace('@ActiveProfiles("test")\n', "");
    put(MAPPER_TEST, noProfile(["selectAccountList"]));
    approve(mapperPlan(false));
    put(MAPPER_TEST, noProfile(["selectAccountList", "countAccountList", "insert"]));
    expect(writeOk("write", { filePath: path.join(cwd, MAPPER_TEST) })).toBeNull();
    done({ stage: "execute" });
    runCoverage({ xml: `<report name="x"></report>` });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("@ActiveProfiles");
  });

  test("a test calling only some methods is a defect: fix retry, no coverage round", () => {
    toVerify(false, ["selectAccountList", "insert"]);
    runCoverage({ xml: `<report name="x"></report>` });
    const out = done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(out).toContain("countAccountList");
    expect(out).not.toContain("selectAccountList,");
    expect(session().fixRetries).toBe(1);
    expect(session().gapRounds).toBe(0);
  });

  test("all methods called: covered, no gap for the Mapper, report lists per-method calls", () => {
    toVerify(false, ["selectAccountList", "countAccountList", "insert"]);
    runCoverage({ xml: `<report name="x"></report>` });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("covered");
    expect(session().coverage).toEqual([]);
    const out = done({ stage: "report", note: "s" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain("커버리지 측정 안 함 (XML SQL은 JaCoCo가 보지 않음)");
    expect(report).toContain("selectAccountList: 호출함");
  });

  test("a mixed plan judges only the Service by JaCoCo", () => {
    toVerify(true, ["selectAccountList", "countAccountList", "insert"]);
    runCoverage({ xml: jacoco(1, 0) });
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("execute");
    expect(session().gapRounds).toBe(1);
    expect(session().coverage.map((c) => c.target)).toEqual([TARGET]);
  });

  test("the plan guide asks for the Mapper test profile", () => {
    const guide = renderStageGuide("plan");
    expect(guide).toContain("test profile");
    expect(guide).toContain("real DB");
  });
});

describe("update_existing (변경으로 깨지는 기존 테스트 수정)", () => {
  const OLD = `class SONAQ001ServiceTest {\n  @Test void old1() { assertEquals(1, service.run()); }\n  @Test void old2() { assertEquals(2, service.run()); }\n}\n`;
  const withUpdate = (test: string, reason = "run() now returns 9"): PlanInputs => ({ ...okPlan(), update_existing: [{ file: TEST_FILE, test, reason }] });

  test("없는 테스트 이름이나 빈 사유는 계획에서 거절", () => {
    put(TEST_FILE, OLD);
    expect(done({ stage: "plan", note: "p", inputs: withUpdate("nope") })).toContain("must be an existing @Test method");
    expect(done({ stage: "plan", note: "p", inputs: withUpdate("old1", " ") })).toContain("needs a reason");
  });

  test("update_existing이 case 안이나 배열이 아닌 값이면 계획에서 거절", () => {
    put(TEST_FILE, OLD);
    const nested = okPlan();
    (nested.cases[0] as unknown as Record<string, unknown>).update_existing = [{ file: TEST_FILE, test: "old1", reason: "r" }];
    expect(done({ stage: "plan", note: "p", inputs: nested })).toContain("top level of `inputs`");
    expect(done({ stage: "plan", note: "p", inputs: { ...okPlan(), update_existing: "old1" as never } })).toContain("must be an array");
  });

  test("승인 안 된 기존 테스트를 고치면 되돌리라는 결함, 승인된 것은 통과하고 리포트에 남는다", () => {
    put(TEST_FILE, OLD);
    approve(withUpdate("old1"));
    const extra = "  @MockitoBean AccountBSM accountBSM;\n  @Test void inquire_normal1() { assertEquals(1, service.inquire(1)); }\n}\n";
    writeTest(OLD.replace("1, service.run()", "9, service.run()").replace("2, service.run()", "8, service.run()").replace(/}\n$/, extra));
    done({ stage: "execute" });
    runCoverage();
    expect(done({ stage: "verify", note: "n" })).toContain("old2의 본문이 바뀌었습니다");
    expect(session().stage).toBe("execute");
    writeTest(OLD.replace("1, service.run()", "9, service.run()").replace(/}\n$/, extra));
    done({ stage: "execute" });
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    const runDir = session().runDir!;
    done({ stage: "report", note: "done" });
    const report = fs.readFileSync(path.join(cwd, runDir, "report.md"), "utf-8");
    expect(report).toContain("## 수정한 기존 테스트");
    expect(report).toContain(`${TEST_FILE}#old1: run() now returns 9`);
  });
});

describe("보고 언어 (한국어 외 문자 점검)", () => {
  test("계획 note에 한자·키릴 문자가 섞이면 거절하고 백틱 안은 허용", () => {
    expect(done({ stage: "plan", note: "메서드入口处 검증 계획", inputs: okPlan() })).toContain("Rejected: Non-Korean script in the plan note");
    expect(done({ stage: "plan", note: "이유가 материализ 입니다", inputs: okPlan() })).toContain("Rejected: Non-Korean script");
    expect(done({ stage: "plan", note: "로그 `error=조회 失败` 를 그대로 인용하는 계획", inputs: okPlan() })).toContain("Plan recorded");
  });
  test("요약에 다른 문자가 섞이면 report 단계에서 거절하고, 고치면 통과", () => {
    reachVerify();
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(done({ stage: "report", note: "요약 返回值 확인" })).toContain("Rejected: Non-Korean script in the summary");
    expect(getSession(SID)).toBeDefined();
    expect(done({ stage: "report", note: "요약: 반환값 확인" })).toContain("Report written");
  });
});

describe("execute 중 계획 보정 (update_existing 추가)", () => {
  const OLD = `class SONAQ001ServiceTest {\n  @Test void old1() { assertEquals(1, service.run()); }\n  @Test void old2() { assertEquals(2, service.run()); }\n}\n`;
  test("execute에서 plan으로 되돌아가 승인받으면 이미 쓴 파일의 기준 본문은 그대로이고 old2를 고칠 수 있다", () => {
    put(TEST_FILE, OLD);
    approve(okPlan());
    writeTest(OLD.replace("2, service.run()", "8, service.run()"));
    const out = done({ stage: "plan", note: "amended", inputs: { ...okPlan(), update_existing: [{ file: TEST_FILE, test: "old2", reason: "run() changed" }] } });
    expect(out).toContain("amends the approved plan");
    expect(session().stage).toBe("plan");
    noteUserMessage(SID, Date.now() + 1);
    done({ stage: "plan", user_approved: true });
    expect(session().stage).toBe("execute");
    expect(session().previousBodies[TEST_FILE]!.old2).toContain("2, service.run()");
  });
  test("보정 뒤 plan 단계에서 계획을 다시 내도 기준 본문은 다시 기록되지 않는다", () => {
    put(TEST_FILE, OLD);
    approve(okPlan());
    writeTest(OLD.replace("2, service.run()", "8, service.run()"));
    done({ stage: "plan", note: "amended", inputs: { ...okPlan(), update_existing: [{ file: TEST_FILE, test: "old2", reason: "run() changed" }] } });
    expect(session().stage).toBe("plan");
    done({ stage: "plan", note: "amended again", inputs: { ...okPlan(), update_existing: [{ file: TEST_FILE, test: "old2", reason: "run() changed" }] } });
    expect(session().previousBodies[TEST_FILE]!.old2).toContain("2, service.run()");
  });
  test("보정 계획에 첫 계획에 없던 테스트 파일을 넣으면 거절 (기준 본문이 없다)", () => {
    put(TEST_FILE, OLD);
    approve(okPlan());
    const extra = { ...okPlan(), files: [...okPlan().files, "src/test/java/x/OtherTest.java"] };
    const out = done({ stage: "plan", note: "amended", inputs: extra });
    expect(out).toContain("cannot add test files");
    expect(session().stage).toBe("execute");
  });
});

describe("approval call that changes the plan", () => {
  test("user_approved with changed inputs re-records the plan and says how to approve", () => {
    expect(done({ stage: "plan", note: "the plan", inputs: okPlan() })).toContain("Plan recorded");
    noteUserMessage(SID, Date.now() + 1);
    const changed = okPlan();
    changed.cases[0]!.boundary = ["a different wording"];
    const out = done({ stage: "plan", note: "the plan", inputs: changed, user_approved: true });
    expect(out).toContain("NEW plan");
    expect(out).toContain("ONLY stage");
    expect(session().stage).toBe("plan");
    noteUserMessage(SID, Date.now() + 2);
    done({ stage: "plan", user_approved: true });
    expect(session().stage).toBe("execute");
  });
});
