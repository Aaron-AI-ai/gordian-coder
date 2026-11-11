import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
function runCoverage({ compile = "ok", xml = jacoco(0, 0), failed = [], log = "BUILD SUCCESSFUL" }: RunFacts = {}): void {
  const out = path.join(cwd, session().runDir!);
  fs.mkdirSync(path.join(out, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(out, "status.json"), JSON.stringify({ compile, log, coverage: xml === null ? "missing" : "ok" }));
  fs.rmSync(path.join(out, "jacoco.xml"), { force: true });
  if (xml !== null) fs.writeFileSync(path.join(out, "jacoco.xml"), xml);
  const cases = failed.map((m) => `<testcase classname="${FQCN}" name="${m}"><failure message="x"/></testcase>`).join("");
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

  test("full coverage reports as covered", () => {
    reachVerify();
    runCoverage();
    done({ stage: "verify", note: "n" });
    expect(session().stage).toBe("report");
    expect(session().verification).toBe("covered");
  });

  test("failed tests are listed in the report but do not block", () => {
    reachVerify();
    runCoverage({ failed: ["inquire_normal2"] });
    done({ stage: "verify", note: "n" });
    expect(session().verification).toBe("covered");
    expect(session().failedTests).toEqual([`${FQCN}.inquire_normal2`]);
    const out = done({ stage: "report", note: "summary" });
    const report = fs.readFileSync(out.match(/Report written: (\S+)/)![1]!, "utf-8");
    expect(report).toContain(`${FQCN}.inquire_normal2`);
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
    expect(getSession(SID)).toBeUndefined();
  });
});

describe("review round 1: gate bypasses", () => {
  const MUST_REFUSE: [string, string][] = [
    ["plan", "git diff; rm x"],
    ["plan", "git diff && rm x"],
    ["plan", "git diff || rm x"],
    ["plan", "git diff | tee x"],
    ["plan", "git diff > x"],
    ["plan", "git diff >> x"],
    ["plan", "git log `rm x`"],
    ["plan", "git log $(rm x)"],
    ["plan", "git diff\nrm x"],
    ["plan", "git diff\rrm x"],
    ["plan", "git diff --output=evil.txt"],
    ["plan", "git diff --output evil.txt"],
    ["plan", "git show HEAD:a > src/main/java/X.java"],
    ["execute", "rm -rf src # gradle"],
    ["execute", "echo hi > src/main/java/X.java; ./gradlew"],
    ["execute", "cat > $HOME/x <<E\ngradle\nE"],
    ["execute", `./gradlew -I ${MODULE}/src/test/resources/evil.gradle test`],
    ["execute", "./gradlew --init-script evil.gradle test"],
    ["execute", "./gradlew -p ../other test"],
    ["execute", "./gradlew --project-dir ../other test"],
    ["execute", "git diff; rm x"],
    ["verify", "rm -rf x # run-coverage.sh"],
    ["verify", `echo '{"compile":"ok","coverage":"ok"}' > .fico/x/status.json; : run-coverage.sh`],
    ["verify", "sh run-coverage.sh; rm x"],
    ["verify", "sh run-coverage.sh > /tmp/q"],
    ["verify", "./gradlew test"],
    // round 2: quoting and escaping
    ["plan", 'git diff "--output=x"'],
    ["plan", "git diff '--output'=x"],
    ["plan", "git diff \\--output=x"],
    ["plan", "git diff --outp=x"],
    ["plan", "git diff --outpu x"],
    ["plan", "git log --ext"],
    ["plan", "git log --exec=x"],
    ["plan", "git diff --output-indicator-new=+"],
    ["plan", "git -c core.pager=sh log"],
    ["plan", "git log --ext-diff -p"],
    ["plan", "git log --textconv"],
    ["plan", "git log --git-dir=../x"],
    ["plan", "git log -C ../x"],
    ["plan", "git checkout -- ."],
    ["execute", './gradlew "-I" mod/src/test/resources/evil.gradle test'],
    ["execute", "./gradlew '--init-script' x test"],
    ["execute", './gradlew -"I"x test'],
    ["execute", "./gradlew \\-p ../other test"],
    ["execute", "./gradlew --init-script=x test"],
    ["execute", "./gradlew -Ix test"],
    ["execute", "./gradlew -Dgradle.user.home=/x test"],
    ["execute", "./gradlew -Dorg.gradle.java.home=/tmp/j test"],
    ["execute", "./gradlew -Pfoo=bar test"],
    ["execute", "./gradlew wrapper"],
    ["execute", "./gradlew init"],
    ["execute", "./gradlew tasks --console=plain"],
    ["execute", "./gradlew test --tests '*STest*'"],
    ["execute", "./gradlew --offline"],
    ["execute", "/abs/gradlew test"],
    ["execute", "X=1 ./gradlew test"],
    ["verify", "sh /tmp/x/run-coverage.sh --module m --tests a.B --out .fico/r"],
    ["verify", "bash evilrun-coverage.sh"],
    ["verify", "bash -xrun-coverage.sh"],
    ["verify", "bash run-coverage.sh.evil"],
    ["verify", "X=1 sh run-coverage.sh"],
  ];
  const MUST_ALLOW: [string, string][] = [
    ["plan", "git diff HEAD~1 -- src"],
    ["plan", "git log -3 --oneline"],
    ["execute", `./gradlew :${MODULE}:testClasses`],
    ["execute", "gradlew.bat test --parallel"],
    ["execute", "git status"],
    ["execute", "./gradlew :m:cleanTest :m:test --tests com.x.FooTest --offline"],
    ["execute", "gradle test --tests com.x.*Test -q --no-daemon --console=plain"],
  ];

  function reach(stage: string): void {
    if (stage === "execute") approve();
    if (stage === "verify") reachVerify();
  }

  test("verify refuses the right script with extra, missing or different arguments", () => {
    reachVerify();
    const good = coverageCmd();
    expect(gateTool(SID, "bash", { command: good })).toBeNull();
    const refused = [
      `${good} --project ..`,
      good.replace(session().runDir!, ".fico/report/f-unit-test/other"),
      good.replace(`--module ${MODULE}`, "--module other-online"),
      good.replace(FQCN, `${FQCN},${FQCN}`),
      good.replace(FQCN, "a.B"),
      good.replace(` --out ${session().runDir}`, ""),
      good.replace("sh .opencode", "sh ../.opencode").replace("skills/f-unit-test-code", "skills/../f-unit-test-code"),
      good.replace("f-unit-test-code/scripts", "x/scripts"),
      good.replace(/^sh /, "zsh "),
    ];
    for (const command of refused) expect(gateTool(SID, "bash", { command })).toContain("not allowed in the verify stage");
  });

  test("verify compares --tests as a set", () => {
    const other = `${MODULE}/src/test/java/${PKG}/SONAQ002ServiceTest.java`;
    approve({ ...okPlan(), files: [TEST_FILE, other] });
    writeTest();
    done({ stage: "execute" });
    const both = `${FQCN},${FQCN.replace("SONAQ001", "SONAQ002")}`;
    expect(coverageCmd()).toContain(`--tests ${both}`);
    const reversed = coverageCmd().replace(both, both.split(",").reverse().join(","));
    expect(gateTool(SID, "bash", { command: reversed })).toBeNull();
    expect(gateTool(SID, "bash", { command: coverageCmd().replace(both, FQCN) })).toContain("verify");
  });

  test.each(MUST_REFUSE)("%s refuses bash %j", (stage, command) => {
    reach(stage);
    expect(gateTool(SID, "bash", { command })).toContain(`not allowed in the ${stage} stage`);
  });

  test.each(MUST_ALLOW)("%s allows bash %j", (stage, command) => {
    reach(stage);
    expect(gateTool(SID, "bash", { command })).toBeNull();
  });

  test("verify allows the exact command the guide shows, with sh or bash and any skill dir", () => {
    reachVerify();
    const guide = renderStageGuide("verify", session());
    expect(guide).toContain(coverageCmd().replace(".opencode/skills", "<skill dir>").replace("<skill dir>/f-unit-test-code/", "<skill dir>/"));
    expect(gateTool(SID, "bash", { command: coverageCmd() })).toBeNull();
    expect(gateTool(SID, "bash", { command: coverageCmd().replace(/^sh /, "bash ") })).toBeNull();
    expect(gateTool(SID, "bash", { command: coverageCmd().replace(".opencode/skills", "/home/u/.config/opencode/skills") })).toBeNull();
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
    for (const name of ["run-coverage.sh", "evilrun-coverage.sh", "Run-Coverage.SH"]) {
      const out = done({ stage: "plan", note: "p", inputs: { ...okPlan(), files: [TEST_FILE, `${MODULE}/src/test/resources/${name}`] } });
      expect(out).toContain("run-coverage.sh");
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
