import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAssetsDir } from "../../../adapters/opencode/fico-setup";
import { UNIT_TEST_SKILL_NAME } from "../../pb-online/names";

const script = path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_SKILL_NAME, "scripts/run-coverage.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// fake gradlew: first arg decides behaviour via env FAKE_TESTCLASSES / FAKE_TEST exit codes
function project(): { proj: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  dirs.push(root);
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "gradlew"),
    `case "$*" in\n  *:testClasses*) echo 'say "hi" \\ back\ttab'; echo 'compile boom'; exit \${FAKE_TESTCLASSES:-0};;\n  *:cleanTest*) echo 'tests ran'; exit \${FAKE_TEST:-0};;\nesac\n`);
  return { proj, out: path.join(root, "out") };
}
function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync(["sh", script, ...args], { env: { ...process.env, ...env } });
}

describe("run-coverage.sh", () => {
  test("compile failure is recorded in status.json and exits 0", () => {
    const { proj, out } = project();
    const r = run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj], { FAKE_TESTCLASSES: "1" });
    expect(r.exitCode).toBe(0);
    const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
    expect(s.compile).toBe("fail");
    expect(s.log).toContain("compile boom");
    expect(s.log).toContain('say "hi" \\ back\ttab');
  });

  test("tests pass but no jacoco.exec => coverage missing", () => {
    const { proj, out } = project();
    const r = run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
    expect(r.exitCode).toBe(0);
    const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
    expect(s).toEqual({ compile: "ok", log: "tests ran\n[run-coverage] gradle mode: offline", coverage: "missing" });
  });

  test("log keeps only the last 40 lines", () => {
    const { proj, out } = project();
    fs.writeFileSync(path.join(proj, "gradlew"), "i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; exit 1\n");
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
    const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
    expect(s.log.split("\n")).toHaveLength(40);
    expect(s.log.startsWith("line62")).toBe(true);
    expect(s.log.endsWith("[run-coverage] gradle mode: offline")).toBe(true);
  });

  test("script passes sh -n", () => {
    expect(Bun.spawnSync(["sh", "-n", script]).exitCode).toBe(0);
  });

  test("missing --module exits 2 with usage", () => {
    const r = run(["--tests", "a.B", "--out", "/nonexistent-out"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage:");
  });

  test("non-UTF-8 bytes in the log do not truncate status.json", () => {
    const { proj, out } = project();
    fs.writeFileSync(path.join(proj, "gradlew"), "echo before; printf '\\377'; echo after; exit 1\n");
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
    const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
    expect(s.log).toContain("before");
    expect(s.log).toContain("after");
  });

  test("test run is preceded by cleanTest", () => {
    const { proj, out } = project();
    const rec = path.join(proj, "calls.txt");
    fs.writeFileSync(path.join(proj, "gradlew"), `echo "$@" >> '${rec}'\n`);
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
    const calls = fs.readFileSync(rec, "utf8").split("\n").filter((l) => l.includes(":app:test "));
    expect(calls).toHaveLength(1);
    expect(calls[0].indexOf(":app:cleanTest")).toBeGreaterThanOrEqual(0);
    expect(calls[0].indexOf(":app:cleanTest")).toBeLessThan(calls[0].indexOf(":app:test "));
  });

  test.each(["a/b", ":a:b", "a:b"])("module %s becomes the Gradle path :a:b in every task", (module) => {
    const { proj, out } = project();
    const rec = path.join(proj, "calls.txt");
    fs.writeFileSync(path.join(proj, "gradlew"), `echo "$@" >> '${rec}'\n`);
    run(["--module", module, "--tests", "a.B", "--out", out, "--project", proj]);
    const tasks = fs.readFileSync(rec, "utf8").split(/\s+/).filter((t) => /(testClasses|cleanTest|test)$/.test(t));
    expect(tasks).toEqual([":a:b:testClasses", ":a:b:cleanTest", ":a:b:test"]);
  });

  test("stale results in --out are removed before a failing compile", () => {
    const { proj, out } = project();
    fs.mkdirSync(path.join(out, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(out, "test-results/x.xml"), "<x/>");
    fs.writeFileSync(path.join(out, "jacoco.xml"), "<r/>");
    fs.mkdirSync(path.join(out, "jacoco-html"), { recursive: true });
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj], { FAKE_TESTCLASSES: "1" });
    expect(fs.existsSync(path.join(out, "jacoco.xml"))).toBe(false);
    expect(fs.existsSync(path.join(out, "jacoco-html"))).toBe(false);
    expect(fs.existsSync(path.join(out, "test-results"))).toBe(false);
  });

  test("missing or empty --tests exits 2", () => {
    expect(run(["--module", "app", "--out", "/nonexistent-out"]).exitCode).toBe(2);
    expect(run(["--module", "app", "--tests", "", "--out", "/nonexistent-out"]).exitCode).toBe(2);
  });
  describe("offline first", () => {
    const RESOLUTION = "> Could not HEAD 'http://nexus/m.xml'. Received status code 429 from server: Too many authentication attempts";
    /** Offline and online calls print and exit as given; every call is recorded. */
    function fake(proj: string, offline: [string, number], online: [string, number]): string {
      const rec = path.join(proj, "calls.txt");
      fs.writeFileSync(path.join(proj, "gradlew"),
        `echo "$@" >> '${rec}'\ncase "$*" in\n  *--offline*) echo "${offline[0]}"; exit ${offline[1]};;\n  *) echo "${online[0]}"; exit ${online[1]};;\nesac\n`);
      return rec;
    }
    const calls = (rec: string): string[] => fs.readFileSync(rec, "utf8").split("\n").filter(Boolean);

    test("offline success never goes online", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["offline ok", 0], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec).every((c) => c.includes("--offline"))).toBe(true);
      expect(calls(rec)).toHaveLength(2);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("ok");
      expect(s.log).toContain("[run-coverage] gradle mode: offline");
      expect(fs.readFileSync(path.join(out, "gradle.log"), "utf8")).toContain("[run-coverage] gradle mode: offline");
    });

    test("an offline resolution failure is retried once online", () => {
      const { proj, out } = project();
      const rec = fake(proj, [RESOLUTION, 1], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      // testClasses and the test run each: offline, then online
      expect(calls(rec).map((c) => c.includes("--offline"))).toEqual([true, false, true, false]);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("ok");
      expect(s.log).toContain("online ok");
      expect(s.log).toContain("[run-coverage] gradle mode: offline failed on dependency resolution -> retried online");
    });

    test("a javac error offline is not retried online", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["X.java:3: error: cannot find symbol", 1], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec)).toHaveLength(1);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("fail");
      expect(s.log).toContain("cannot find symbol");
      expect(s.log).toContain("[run-coverage] gradle mode: offline");
      expect(s.log).not.toContain("retried online");
    });

    test("a javac error that mentions a network word is not retried online", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["/p/app/src/test/java/x/AT.java:3: error: cannot find symbol import java.net.UnknownHostException", 1], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec)).toHaveLength(1);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("fail");
      expect(s.log).not.toContain("first environment line");
    });

    test("a Korean-locale javac error mentioning UnknownHost is not retried online", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["/p/app/src/test/java/x/AT.java:3: 오류: 심볼을 찾을 수 없습니다 UnknownHostException", 1], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec)).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8")).log).not.toContain("first environment line");
    });

    test("Gradle sees JAVA_TOOL_OPTIONS with an English locale appended to the caller's value", () => {
      const { proj, out } = project();
      const rec = path.join(proj, "jto.txt");
      fs.writeFileSync(path.join(proj, "gradlew"), `echo "$JAVA_TOOL_OPTIONS" >> '${rec}'\n`);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj], { JAVA_TOOL_OPTIONS: "-Xmx1g" });
      const seen = fs.readFileSync(rec, "utf8").split("\n").filter(Boolean);
      expect(seen).toHaveLength(2);
      for (const v of seen) expect(v).toBe("-Xmx1g -Duser.language=en -Duser.country=US");
      const { JAVA_TOOL_OPTIONS: _drop, ...env } = process.env;
      fs.writeFileSync(rec, "");
      Bun.spawnSync(["sh", script, ...["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]], { env });
      expect(fs.readFileSync(rec, "utf8").split("\n")[0]!.trim()).toBe("-Duser.language=en -Duser.country=US");
    });

    test("main-source javac errors offline (stale SNAPSHOT) are retried once online", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["/p/app/src/main/java/x/A.java:3: error: cannot find symbol", 1], ["online ok", 0]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      // the test run compiles too, so its offline call meets the same stale main source
      expect(calls(rec).map((c) => c.includes("--offline"))).toEqual([true, false, true, false]);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("ok");
      expect(s.log).toContain("main-source errors -> retried online");
    });

    test("main-source errors: the testClasses retry names its mode", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["/p/app/src/main/java/x/A.java:3: error: cannot find symbol", 1], ["/p/app/src/main/java/x/A.java:3: error: still", 1]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec)).toHaveLength(2);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("fail");
      expect(s.log).toContain("[run-coverage] gradle mode: offline failed with main-source errors -> retried online");
    });

    test("the first environment line leads the log tail even when it is older than the last 40 lines", () => {
      const { proj, out } = project();
      const many = Array.from({ length: 60 }, (_, i) => `noise${i}`).join("\\n");
      fs.writeFileSync(path.join(proj, "gradlew"), `case "$*" in\n  *--offline*) echo 'No cached version of a:b:1 available for offline mode.'; exit 1;;\n  *) printf '${RESOLUTION.replace(/'/g, "")}\\n${many}\\n'; exit 1;;\nesac\n`);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.log.split("\n")[0]).toStartWith("[run-coverage] first environment line: ");
      expect(s.log.split("\n")[0]).toContain("status code 429");
    });

    test("a resolution failure online too is a compile failure with the online output", () => {
      const { proj, out } = project();
      const rec = fake(proj, ["> No cached version of a:b:1 available for offline mode.", 1], [RESOLUTION, 1]);
      run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
      expect(calls(rec)).toHaveLength(2);
      const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
      expect(s.compile).toBe("fail");
      expect(s.log).toContain("status code 429");
      expect(s.log).not.toContain("No cached version");
      expect(s.log).toContain("retried online");
    });
  });
});
