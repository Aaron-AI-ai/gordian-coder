import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAssetsDir } from "../../../adapters/opencode/fico-setup";
import { UNIT_TEST_SKILL_NAME } from "../../pb-online/names";

// Mirrors run-coverage.test.ts for the PowerShell port. Skipped where PowerShell is absent (the
// development Mac) and on Windows, where the script would call gradlew.bat instead of these sh fakes.
const shell = Bun.which("pwsh") ?? Bun.which("powershell");
const skip = !shell || process.platform === "win32";
const script = path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_SKILL_NAME, "scripts/run-coverage.ps1");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function project(): { proj: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rcps-"));
  dirs.push(root);
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "gradlew"),
    `case "$*" in\n  *:testClasses*) echo 'say "hi" \\ back\ttab'; echo 'compile boom'; exit \${FAKE_TESTCLASSES:-0};;\n  *:cleanTest*) echo 'tests ran'; exit \${FAKE_TEST:-0};;\nesac\n`);
  return { proj, out: path.join(root, "out") };
}
function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([shell!, "-NoProfile", "-File", script, ...args], { env: { ...process.env, ...env } });
}
const status = (out: string) => JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));

describe.skipIf(skip)("run-coverage.ps1", () => {
  test("compile failure is recorded in status.json and exits 0", () => {
    const { proj, out } = project();
    const r = run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj], { FAKE_TESTCLASSES: "1" });
    expect(r.exitCode).toBe(0);
    const s = status(out);
    expect(s.compile).toBe("fail");
    expect(s.log).toContain("compile boom");
    expect(s.log).toContain('say "hi" \\ back\ttab');
  });

  test("tests pass but no jacoco.exec => coverage missing", () => {
    const { proj, out } = project();
    expect(run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj]).exitCode).toBe(0);
    expect(status(out)).toEqual({ compile: "ok", log: "tests ran", coverage: "missing" });
  });

  test("log keeps only the last 40 lines", () => {
    const { proj, out } = project();
    fs.writeFileSync(path.join(proj, "gradlew"), "i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; exit 1\n");
    run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj]);
    const s = status(out);
    expect(s.log.split("\n")).toHaveLength(40);
    expect(s.log.startsWith("line61")).toBe(true);
  });

  test("missing -Module, missing -Tests or an unknown argument exits 2 with usage", () => {
    const r = run(["-Tests", "a.B", "-Out", "/nonexistent-out"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage:");
    expect(run(["-Module", "app", "-Out", "/nonexistent-out"]).exitCode).toBe(2);
    expect(run(["-Module", "app", "-Tests", "", "-Out", "/nonexistent-out"]).exitCode).toBe(2);
    expect(run(["-Module", "app", "-Tests", "a.B", "-Out", "/nonexistent-out", "-Evil", "x"]).exitCode).toBe(2);
  });

  test("non-UTF-8 bytes in the log do not truncate status.json", () => {
    const { proj, out } = project();
    fs.writeFileSync(path.join(proj, "gradlew"), "echo before; printf '\\377'; echo after; exit 1\n");
    run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj]);
    const s = status(out);
    expect(s.log).toContain("before");
    expect(s.log).toContain("after");
  });

  test("test run is preceded by cleanTest and gets the agent, exec and tests properties", () => {
    const { proj, out } = project();
    const rec = path.join(proj, "calls.txt");
    fs.writeFileSync(path.join(proj, "gradlew"), `echo "$@" >> '${rec}'\n`);
    run(["-Module", "app", "-Tests", "a.B,c.D", "-Out", out, "-Project", proj]);
    const calls = fs.readFileSync(rec, "utf8").split("\n").filter((l) => l.includes(":app:test "));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.indexOf(":app:cleanTest")).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.indexOf(":app:cleanTest")).toBeLessThan(calls[0]!.indexOf(":app:test "));
    expect(calls[0]).toContain("-Pfut.tests=a.B,c.D");
    expect(calls[0]).toMatch(/-Pfut\.agent=\S+\/tools\/jacocoagent\.jar/);
    expect(calls[0]).toMatch(/-I \S+\/scripts\/init\.gradle/);
  });

  test.each(["a/b", ":a:b", "a:b"])("module %s becomes the Gradle path :a:b in every task", (module) => {
    const { proj, out } = project();
    const rec = path.join(proj, "calls.txt");
    fs.writeFileSync(path.join(proj, "gradlew"), `echo "$@" >> '${rec}'\n`);
    run(["-Module", module, "-Tests", "a.B", "-Out", out, "-Project", proj]);
    const tasks = fs.readFileSync(rec, "utf8").split(/\s+/).filter((t) => /(testClasses|cleanTest|test)$/.test(t));
    expect(tasks).toEqual([":a:b:testClasses", ":a:b:cleanTest", ":a:b:test"]);
  });

  test("stale results in -Out are removed before a failing compile", () => {
    const { proj, out } = project();
    fs.mkdirSync(path.join(out, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(out, "test-results/x.xml"), "<x/>");
    fs.writeFileSync(path.join(out, "jacoco.xml"), "<r/>");
    run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj], { FAKE_TESTCLASSES: "1" });
    expect(fs.existsSync(path.join(out, "jacoco.xml"))).toBe(false);
    expect(fs.existsSync(path.join(out, "test-results"))).toBe(false);
    expect(status(out).compile).toBe("fail");
  });

  test("status.json is written without a BOM", () => {
    const { proj, out } = project();
    run(["-Module", "app", "-Tests", "a.B", "-Out", out, "-Project", proj]);
    expect(fs.readFileSync(path.join(out, "status.json"))[0]).toBe(0x7b);
  });
});
