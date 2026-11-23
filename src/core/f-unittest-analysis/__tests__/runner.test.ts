import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { endSession, getSession, runExecute, startSession, completeStage } from "../workflow";
import { runTests, windowsCmdLine } from "../runner";

describe("windowsCmdLine", () => {
  test("quotes only args that need it, inside one outer pair for cmd /s /c", () => {
    const line = windowsCmdLine("gradlew.bat", [":app:test", "--offline", "-I", "C:\\Users\\Hong Gil\\init.gradle", "-Pfut.exec=C:\\My Proj\\jacoco.exec", "--tests", "x.PayTest"]);
    expect(line).toBe('"gradlew.bat :app:test --offline -I "C:\\Users\\Hong Gil\\init.gradle" "-Pfut.exec=C:\\My Proj\\jacoco.exec" --tests x.PayTest"');
  });
  test("cmd metacharacters and quotes cannot break out of an argument", () => {
    expect(windowsCmdLine("gradlew.bat", ["a&b", 'say "hi"'])).toBe('"gradlew.bat "a&b" "say ""hi""""');
  });
});

const posix = process.platform !== "win32";
let root: string;
const out = (): string => path.join(root, ".fico/work/r");
const status = (): { compile: string; tests: string; log: string } => JSON.parse(fs.readFileSync(path.join(out(), "status.json"), "utf-8"));
const calls = (): string[] => (fs.existsSync(path.join(root, "calls.log")) ? fs.readFileSync(path.join(root, "calls.log"), "utf-8").trim().split("\n") : []);

/** A fake gradle wrapper: records its arguments, then behaves as `mode` says. */
function fakeGradle(body: string): void {
  fs.writeFileSync(path.join(root, "gradlew"), `#!/bin/sh\necho "$*" >> "${root}/calls.log"\n${body}\n`);
}
const PASS = `echo "> Task :app:testClasses"
case "$*" in *:app:test\\ *) mkdir -p app/build/test-results/test; echo '<testsuite><testcase name="a()" classname="x.PayTest" time="0.1"/></testsuite>' > app/build/test-results/test/TEST-x.PayTest.xml; sleep 1.3;; esac`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "futrun-"));
  fs.mkdirSync(path.join(root, "app"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!posix)("runTests (fake gradle wrapper)", () => {
  test("builds, runs the selected tests, copies results and reports progress", async () => {
    fakeGradle(PASS);
    const seen: string[] = [];
    await runTests({ cwd: root, module: "app", tests: ["x.PayTest.a"], outDir: out(), onProgress: (t) => seen.push(t) });
    expect(status()).toMatchObject({ compile: "ok", tests: "run" });
    expect(fs.existsSync(path.join(out(), "test-results/TEST-x.PayTest.xml"))).toBe(true);
    expect(calls()[0]).toBe(":app:testClasses --offline");
    expect(calls()[1]).toContain(":app:cleanTest :app:test --continue --offline");
    expect(calls()[1]).toContain("-I ");
    expect(calls()[1]).toContain("init.gradle");
    expect(calls()[1]).toContain("-Pfut.agent=");
    expect(calls()[1]).toContain(`-Pfut.exec=${path.join(out(), "jacoco.exec")}`);
    expect(calls()[1]).toContain("--tests x.PayTest.a");
    expect(seen[0]).toContain("[1/2] 컴파일 중");
    expect(seen.some((t) => t.includes("[2/2] 테스트 실행 중") && t.includes("클래스 1/1개 완료"))).toBe(true);
  });
  test("each gradle run detaches its abort listener when it exits", async () => {
    fakeGradle(PASS);
    const live = new Set<unknown>();
    const signal = {
      aborted: false,
      addEventListener: (_: string, fn: unknown) => void live.add(fn),
      removeEventListener: (_: string, fn: unknown) => void live.delete(fn),
    } as unknown as AbortSignal;
    await runTests({ cwd: root, module: "app", tests: [], outDir: out(), signal });
    expect(calls()).toHaveLength(2);
    expect(live.size).toBe(0);
  });
  test("the root project (module \".\") runs root tasks and reads root results", async () => {
    fakeGradle(`case "$*" in *\\ :test\\ *) mkdir -p build/test-results/test; echo '<testsuite><testcase name="a()" classname="x.PayTest" time="0.1"/></testsuite>' > build/test-results/test/TEST-x.PayTest.xml;; esac`);
    await runTests({ cwd: root, module: ".", tests: [], outDir: out() });
    expect(calls()[0]).toBe(":testClasses --offline");
    expect(calls()[1]).toStartWith(":cleanTest :test --continue --offline");
    expect(status()).toMatchObject({ compile: "ok", tests: "run" });
  });
  test("no selection passes no --tests", async () => {
    fakeGradle(PASS);
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(calls()[1]).not.toContain("--tests");
  });
  test("a test-source compile error never goes online", async () => {
    fakeGradle(`echo "src/test/java/x/PayTest.java:3: error: bad"; exit 1`);
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(status()).toMatchObject({ compile: "fail", tests: "missing" });
    expect(status().log).toContain("PayTest.java:3: error: bad");
    expect(calls()).toHaveLength(1);
  });
  test("a test run with no result and an unresolved dependency is retried online once", async () => {
    fakeGradle(`case "$*" in *:app:testClasses*) ;; *--offline*) echo "No cached version of com.h2database:h2 available for offline mode"; exit 1;; *) mkdir -p app/build/test-results/test; echo '<testsuite><testcase name="a()" classname="x.PayTest" time="0.1"/></testsuite>' > app/build/test-results/test/TEST-x.PayTest.xml;; esac`);
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(calls()).toHaveLength(3);
    expect(calls()[1]).toContain("--offline");
    expect(calls()[2]).not.toContain("--offline");
    expect(status()).toMatchObject({ compile: "ok", tests: "run" });
  });
  test("a failing test run that wrote results is never retried online", async () => {
    fakeGradle(`case "$*" in *:app:testClasses*) ;; *) mkdir -p app/build/test-results/test; echo '<testsuite><testcase name="a()" classname="x.PayTest"><failure message="Could not resolve host db"/></testcase></testsuite>' > app/build/test-results/test/TEST-x.PayTest.xml; echo "Could not resolve host db"; exit 1;; esac`);
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(calls()).toHaveLength(2);
  });
  test("a dependency problem is retried online once, then judged from that log", async () => {
    fakeGradle(`case "$*" in *--offline*) echo "No cached version of org.x:y available for offline mode"; exit 1;; *) echo "Could not resolve org.x:y:1"; exit 1;; esac`);
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(calls()).toEqual([":app:testClasses --offline", ":app:testClasses"]);
    expect(status().compile).toBe("fail");
    expect(status().log).toContain("Could not resolve");
  });
  test("no test result means tests none", async () => {
    fakeGradle(`echo "> Task :app:testClasses"; echo "No tests found for given includes"`);
    await runTests({ cwd: root, module: "app", tests: ["x.Nope"], outDir: out() });
    expect(status()).toMatchObject({ compile: "ok", tests: "none" });
  });
  test("a missing wrapper and gradle is a failed build with a reason", async () => {
    await runTests({ cwd: root, module: "app", tests: [], outDir: out() });
    expect(status().compile).toBe("fail");
  });
});

describe.skipIf(!posix)("runExecute", () => {
  const SID = "r1";
  afterEach(() => endSession(SID));
  test("runs the planned tests, writes the report, and refuses a second call while running", async () => {
    fakeGradle(PASS);
    fs.mkdirSync(path.join(root, "app/src/test/java/x"), { recursive: true });
    fs.writeFileSync(path.join(root, "app/src/test/java/x/PayTest.java"), "package x; class PayTest { @Test void a() {} }");
    startSession(SID, "--test PayTest", root);
    expect(completeStage(SID, { stage: "plan", note: "계획", inputs: { module: "app", tests: [{ file: "app/src/test/java/x/PayTest.java" }] } })).toContain("Plan recorded");
    const titles: string[] = [];
    const first = runExecute(SID, (t) => titles.push(t));
    expect(await runExecute(SID)).toContain("already running");
    const result = await first;
    expect(getSession(SID)!.outcome!.kind).toBe("pass");
    expect(result).toContain("리포트:");
    expect(titles.length).toBeGreaterThan(0);
  });
});
