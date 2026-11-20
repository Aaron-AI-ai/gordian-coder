import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAssetsDir } from "../fico-setup";
import { UNIT_TEST_REQ_SKILL_NAME, UNIT_TEST_SKILL_NAME } from "../../../core/pb-online/names";

const skills = path.join(resolveAssetsDir(), "fico-ai/skills");
const req = path.join(skills, UNIT_TEST_REQ_SKILL_NAME);
const code = path.join(skills, UNIT_TEST_SKILL_NAME);
const read = (rel: string): string => fs.readFileSync(path.join(req, rel), "utf-8");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("f-unit-test-req skill assets", () => {
  test("SKILL.md names the skill, the three inputs and the build-only scope", () => {
    const text = read("SKILL.md");
    expect(/^---\nname: f-unit-test-req\n/.test(text)).toBe(true);
    for (const w of ["--req-file", "--req", "--program", "skeleton", "compile-tests.sh", "compile-tests.ps1", "not verified in the development environment"]) expect(text).toContain(w);
    expect(text).not.toContain("run-coverage");
    expect(text).not.toContain("JaCoCo");
  });

  test("the format rule and the templates are copies of f-unit-test-code's (they must not drift apart)", () => {
    expect(read("docs/f-unit-test-format-rule.md")).toBe(fs.readFileSync(path.join(code, "docs/f-unit-test-format-rule.md"), "utf-8"));
    for (const t of ["ServiceTestTemplate.java", "ControllerTestTemplate.java", "MapperTestTemplate.java"]) {
      const mine = read(`templates/${t}`);
      expect(mine).toContain("[요구사항]");
      expect(mine).toContain("[시나리오]");
      expect(mine).toContain("[기대]");
      // The code skeleton itself is unchanged: only the comments above @Test differ.
      const strip = (s: string): string => s.split("\n").filter((l) => !/^\s*\/\/ \[(요구사항|시나리오|기대)\]|^\s*\/\/ (정상|경계|예외|select|insert|update|delete)|요구사항 기반\(TDD\)|^\/\/ 예제/.test(l)).join("\n");
      expect(strip(mine)).toBe(strip(fs.readFileSync(path.join(code, "templates", t), "utf-8")));
    }
  });

  test("the case rule says expected values come from the requirements and where the comments go", () => {
    const rule = read("docs/f-unit-test-req-case-rule.md");
    for (const w of ["요구사항에서만", "뼈대", "[요구사항]", "[시나리오]", "[기대]", "_boundary", "_boundary2", "_exception"]) expect(rule).toContain(w);
  });

  test("compile-tests.sh writes status.json from the build only and never runs tests", () => {
    const script = path.join(req, "scripts/compile-tests.sh");
    expect(Bun.spawnSync(["sh", "-n", script]).exitCode).toBe(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
    dirs.push(root);
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "gradlew"), `echo "$*" >> "${root}/calls"; case "$*" in *:testClasses*) echo 'compile boom'; exit \${FAKE:-0};; esac\n`);
    const run = (fake: string) => Bun.spawnSync(["sh", script, "--module", "app", "--out", path.join(root, "out"), "--project", proj], { env: { ...process.env, FAKE: fake } });
    expect(run("1").exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "out/status.json"), "utf8")).compile).toBe("fail");
    expect(run("0").exitCode).toBe(0);
    const ok = JSON.parse(fs.readFileSync(path.join(root, "out/status.json"), "utf8"));
    expect(ok.compile).toBe("ok");
    expect(ok.log).toContain("[compile-tests] gradle mode: offline");
    const calls = fs.readFileSync(path.join(root, "calls"), "utf8");
    expect(calls).not.toMatch(/:test\b|cleanTest/);
    expect(Bun.spawnSync(["sh", script, "--out", "/x"]).exitCode).toBe(2);
  });

  test("compile-tests.ps1 declares its parameters and has no PowerShell 7-only syntax", () => {
    const ps = fs.readFileSync(path.join(req, "scripts/compile-tests.ps1"), "utf-8");
    for (const p of ["param(", "$Module", "$Out", "$Project", "testClasses"]) expect(ps).toContain(p);
    expect(ps).not.toMatch(/\?\?|&&|\|\||-AsHashTable|\$IsWindows|jacoco|\$Tests|\$testList/);
  });
});
