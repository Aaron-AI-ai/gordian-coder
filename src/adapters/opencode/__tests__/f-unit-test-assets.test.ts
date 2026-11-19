import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAssetsDir } from "../fico-setup";
import { UNIT_TEST_SKILL_NAME } from "../../../core/pb-online/names";

const skill = path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_SKILL_NAME);
const read = (rel: string): string => fs.readFileSync(path.join(skill, rel), "utf8");

describe("f-unit-test-code skill assets", () => {
  test("SKILL.md frontmatter names the skill and has a description", () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(read("SKILL.md"))?.[1] ?? "";
    expect(fm).toMatch(/^name: f-unit-test-code$/m);
    expect(fm).toMatch(/^description: \S+/m);
  });

  test.each(["ServiceTestTemplate.java", "ControllerTestTemplate.java"])("%s has the required elements", (name) => {
    const src = read(`templates/${name}`);
    for (const token of ["@SpringBootTest", "@Transactional", "@BeforeEach", "@AfterEach", "@MockitoBean"]) {
      expect(src).toContain(token);
    }
    for (const suffix of ["_normal1", "_normal2", "_boundary", "_exception"]) {
      expect(src).toMatch(new RegExp(`@Test[\\s\\S]*?void \\w+${suffix}\\(`));
    }
    expect(src).toContain("{PackagePath}");
    expect(src).toContain("{ClassName}");
    expect(src).toContain("{TargetClass}");
  });

  test("MapperTestTemplate.java hits the real DB: transactional, profile, real mapper, no mock", () => {
    const src = read("templates/MapperTestTemplate.java");
    for (const token of ["@SpringBootTest", "@ActiveProfiles", "@Transactional", "@Autowired", "@BeforeEach", "@AfterEach", "UT_"]) {
      expect(src).toContain(token);
    }
    expect(src).not.toMatch(/@MockitoBean|@MockBean/);
    for (const suffix of ["_normal1", "_normal2", "_boundary", "_exception"]) {
      expect(src).toMatch(new RegExp(`@Test[\\s\\S]*?void \\w+${suffix}\\(`));
    }
    for (const token of ["{PackagePath}", "{ClassName}", "{TargetClass}"]) expect(src).toContain(token);
    expect(src).not.toMatch(/\{Profile|\{profile/i);
  });

  test("the docs and SKILL.md state the Mapper exception", () => {
    expect(read("docs/f-unit-test-format-rule.md")).toContain("Mapper 테스트");
    expect(read("docs/f-unit-test-case-rule.md")).toContain("Mapper");
    expect(read("docs/f-unit-test-verification-rule.md")).toContain("JaCoCo");
    const skillMd = read("SKILL.md");
    expect(skillMd).toContain("MapperTestTemplate.java");
    expect(skillMd).toMatch(/Mapper test is the one exception/);
  });

  test("rule docs exist and the format rule covers mocks, profiles and Boot versions", () => {
    for (const d of ["format", "case", "verification"]) {
      expect(fs.existsSync(path.join(skill, `docs/f-unit-test-${d}-rule.md`))).toBe(true);
    }
    const fmt = read("docs/f-unit-test-format-rule.md");
    for (const word of ["외부 모듈", "프로필", "@MockBean"]) expect(fmt).toContain(word);
  });
});

describe("f-unit-test-code Mapper and datasource wording", () => {
  test("the Mapper rule names the package condition", () => {
    expect(read("docs/f-unit-test-format-rule.md")).not.toContain("`@Mapper` 인터페이스 또는 `*Mapper.java`)");
    expect(read("docs/f-unit-test-format-rule.md")).toContain("dao");
    for (const s of ["scripts/run-coverage.sh", "scripts/run-coverage.ps1"]) expect(read(s)).toContain("separate daemon");
  });

  test("the description triggers for Mapper tests and limits real-DB tests to them", () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(read("SKILL.md"))?.[1] ?? "";
    expect(fm).toMatch(/Mapper \(MyBatis\)/);
    expect(fm).not.toContain("integration tests against a real DB");
    expect(fm).toMatch(/real DB only for (?:MyBatis )?Mapper tests/);
    expect(read("SKILL.md")).not.toContain("no real resource is touched");
  });

  test("a Mapper of a non-primary datasource names its transaction manager; bulk deletes may be skipped", () => {
    for (const doc of ["docs/f-unit-test-format-rule.md", "templates/MapperTestTemplate.java"]) {
      expect(read(doc)).toContain('@Transactional("');
      expect(read(doc)).toMatch(/transactionManager|트랜잭션 매니저/);
    }
    expect(read("docs/f-unit-test-case-rule.md")).toContain("조건 없는 일괄 삭제");
  });
});

describe("f-unit-test-code coverage scripts", () => {
  test("run-coverage.ps1 exists, declares its parameters and finds tools/ from its own folder", () => {
    const ps = read("scripts/run-coverage.ps1");
    expect(ps).toContain("param(");
    for (const p of ["$Module", "$Tests", "$Out", "$Project"]) expect(ps).toContain(p);
    expect(ps).toContain("PSScriptRoot");
    expect(ps).toContain("init.gradle");
    // PowerShell 7-only syntax would break Windows PowerShell 5.1.
    expect(ps).not.toMatch(/\?\?|&&|\|\||-AsHashTable|\$IsWindows/);
  });

  test("SKILL.md and the verification rule document both scripts and the unverified Windows run", () => {
    for (const doc of ["SKILL.md", "docs/f-unit-test-verification-rule.md"]) {
      const text = read(doc);
      expect(text).toContain("run-coverage.sh --module");
      expect(text).toContain("run-coverage.ps1 -Module");
      expect(text).not.toContain("POSIX shell");
    }
    expect(read("SKILL.md")).toContain("not verified in the development environment");
    const rule = read("docs/f-unit-test-verification-rule.md");
    for (const w of ["--offline", "src/main/java", "--refresh-dependencies", "status code 429"]) expect(rule).toContain(w);
    expect(read("SKILL.md")).toContain("--refresh-dependencies");
    expect(read("SKILL.md")).toContain("status code 429");
  });
});

describe("f-unit-test-code bundled JaCoCo", () => {
  test.each(["jacocoagent.jar", "jacococli.jar"])("%s is a real jar", (name) => {
    const buf = fs.readFileSync(path.join(skill, "tools", name));
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.length).toBeGreaterThan(100 * 1024);
  });

  test("NOTICE.md states the license", () => {
    expect(read("tools/NOTICE.md")).toContain("EPL-2.0");
  });
});
