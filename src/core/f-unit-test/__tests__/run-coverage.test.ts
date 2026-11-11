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
    expect(s).toEqual({ compile: "ok", log: "tests ran", coverage: "missing" });
  });

  test("log keeps only the last 40 lines", () => {
    const { proj, out } = project();
    fs.writeFileSync(path.join(proj, "gradlew"), "i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; exit 1\n");
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj]);
    const s = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8"));
    expect(s.log.split("\n")).toHaveLength(40);
    expect(s.log.startsWith("line61")).toBe(true);
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

  test("stale results in --out are removed before a failing compile", () => {
    const { proj, out } = project();
    fs.mkdirSync(path.join(out, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(out, "test-results/x.xml"), "<x/>");
    fs.writeFileSync(path.join(out, "jacoco.xml"), "<r/>");
    run(["--module", "app", "--tests", "a.B", "--out", out, "--project", proj], { FAKE_TESTCLASSES: "1" });
    expect(fs.existsSync(path.join(out, "jacoco.xml"))).toBe(false);
    expect(fs.existsSync(path.join(out, "test-results"))).toBe(false);
  });

  test("missing or empty --tests exits 2", () => {
    expect(run(["--module", "app", "--out", "/nonexistent-out"]).exitCode).toBe(2);
    expect(run(["--module", "app", "--tests", "", "--out", "/nonexistent-out"]).exitCode).toBe(2);
  });
});
