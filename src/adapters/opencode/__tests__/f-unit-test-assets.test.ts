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

  test("rule docs exist and the format rule covers mocks, profiles and Boot versions", () => {
    for (const d of ["format", "case", "verification"]) {
      expect(fs.existsSync(path.join(skill, `docs/f-unit-test-${d}-rule.md`))).toBe(true);
    }
    const fmt = read("docs/f-unit-test-format-rule.md");
    for (const word of ["외부 모듈", "프로필", "@MockBean"]) expect(fmt).toContain(word);
  });
});
