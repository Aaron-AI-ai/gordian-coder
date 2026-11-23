import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAssetsDir } from "../fico-setup";
import { SKILL_NAMES, UNIT_TEST_ANALYSIS_SKILL_NAME } from "../../../core/pb-online/names";

const dir = path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_ANALYSIS_SKILL_NAME);
const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf-8");

describe("f-unittest-analysis skill assets", () => {
  test("the skill is shipped and SKILL.md states the scope and the input", () => {
    expect(SKILL_NAMES).toContain(UNIT_TEST_ANALYSIS_SKILL_NAME);
    const text = read("SKILL.md");
    expect(/^---\nname: f-unittest-analysis\n/.test(text)).toBe(true);
    for (const w of ["--test", "No input: every test", "the plugin itself", "no report"]) expect(text.toLowerCase()).toContain(w.toLowerCase());
  });
  test("the guide asks for cause, judgment and fix, console only", () => {
    const g = read("docs/f-unittest-analysis-guide.md");
    for (const w of ["원인", "판단", "수정 방법", "Never edit"]) expect(g).toContain(w);
  });
  test("no script is shipped: the plugin runs the tests", () => {
    expect(fs.existsSync(path.join(dir, "scripts"))).toBe(false);
  });
});
