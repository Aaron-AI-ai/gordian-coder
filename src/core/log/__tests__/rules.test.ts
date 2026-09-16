import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogRule, loadLogRules, matchLogRules, renderLogRules, type LogRule } from "../rules";

const rule = (file: string, over: Partial<LogRule> = {}): LogRule => ({
  file, exceptions: [], globs: [], handler: [], reference: false, content: `body of ${file}`, ...over,
});

describe("parseLogRule", () => {
  test("frontmatter with exceptions, globs and mode", () => {
    const r = parseLogRule("x.md", `---\nexceptions: "org.springframework.dao.*", "*SQLException"\nglobs: "**/mapper/**/*.xml"\nmode: reference\n---\n# Title\nbody`);
    expect(r.exceptions).toEqual(["org.springframework.dao.*", "*SQLException"]);
    expect(r.globs).toEqual(["**/mapper/**/*.xml"]);
    expect(r.reference).toBe(true);
    expect(r.content).toBe("# Title\nbody");
  });
  test("no frontmatter → applies always", () => {
    const r = parseLogRule("y.md", "just text");
    expect(r.exceptions).toEqual([]);
    expect(r.globs).toEqual([]);
    expect(r.content).toBe("just text");
  });
  test("BOM and CRLF tolerated", () => {
    const r = parseLogRule("z.md", "﻿---\r\nexceptions: java.lang.NullPointerException\r\n---\r\nbody\r\n");
    expect(r.exceptions).toEqual(["java.lang.NullPointerException"]);
  });
});

describe("matchLogRules", () => {
  const rules = [
    rule("always.md"),
    rule("npe.md", { exceptions: ["java.lang.NullPointerException"] }),
    rule("dao.md", { exceptions: ["org.springframework.dao.*"] }),
    rule("mapper.md", { exceptions: ["org.apache.ibatis.*"], globs: ["**/mapper/**/*.xml"] }),
    rule("xmlonly.md", { globs: ["*.xml"] }),
    rule("handled.md", { handler: ["uri"] }),
  ];
  test("exception glob matches any exception in the chain", () => {
    const m = matchLogRules(rules, ["org.springframework.dao.DuplicateKeyException", "java.sql.SQLException"], []);
    expect(m.map((r) => r.file)).toEqual(["dao.md", "always.md"]); // specific first, always last
  });
  test("exceptions AND globs when both present", () => {
    expect(matchLogRules(rules, ["org.apache.ibatis.exceptions.PersistenceException"], []).map((r) => r.file)).toEqual(["always.md"]);
    expect(matchLogRules(rules, ["org.apache.ibatis.exceptions.PersistenceException"], ["src/main/resources/mapper/oracle/A.xml"]).map((r) => r.file)).toEqual(["mapper.md", "xmlonly.md", "always.md"]);
  });
  test("glob without slash matches basename", () => {
    expect(matchLogRules(rules, [], ["a/b/c.xml"]).map((r) => r.file)).toEqual(["xmlonly.md", "always.md"]);
  });
  test("specificity = longest matching pattern, sorted descending", () => {
    const m = matchLogRules(rules, ["java.lang.NullPointerException", "org.springframework.dao.X"], []);
    expect(m[0].file).toBe("npe.md"); // 31 chars beats 24
    expect(m[0].specificity).toBe("java.lang.NullPointerException".length);
  });
  test("handler gate: a rule with `handler` fires on a present field, not an absent one (I-4)", () => {
    expect(matchLogRules(rules, ["java.lang.NullPointerException"], [], { uri: "/ON/X" }).map((r) => r.file)).toContain("handled.md");
    expect(matchLogRules(rules, ["java.lang.NullPointerException"], [], {}).map((r) => r.file)).not.toContain("handled.md");
    expect(matchLogRules(rules, ["java.lang.NullPointerException"], []).map((r) => r.file)).not.toContain("handled.md");
  });
});

describe("renderLogRules", () => {
  test("inject mode verbatim, reference mode as an index, budget demotes overflow to reference", () => {
    const big = rule("big.md", { content: "x".repeat(500) });
    const small = rule("small.md", { content: "small body" });
    const ref = rule("ref.md", { reference: true, content: "# Ref title\nlong" });
    const out = renderLogRules([{ ...big, specificity: 9 }, { ...small, specificity: 5 }, { ...ref, specificity: 1 }], 300);
    expect(out).not.toContain("x".repeat(500));       // demoted — did not fit
    expect(out).toContain("small body");               // fit
    expect(out).toContain("- big.md");                 // listed for f_log_read
    expect(out).toContain("- ref.md: Ref title");
  });
  test("empty → empty string", () => {
    expect(renderLogRules([], 1000)).toBe("");
  });
});

describe("loadLogRules", () => {
  test("bundled rules include review's framework_kb and mapper rules plus the project dir", () => {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-rules-"));
    mkdirSync(join(cwd, "log/rules/sub"), { recursive: true });
    writeFileSync(join(cwd, "log/rules/sub/p.md"), "---\nexceptions: a.B\n---\nproject rule");
    const all = loadLogRules(cwd);
    const files = all.map((r) => r.file);
    expect(files).toContain("framework_kb.md");
    expect(files).toContain("mapper_dao_xml.md");
    expect(files.at(-1)).toBe("log/rules/sub/p.md");
    expect(all.find((r) => r.file === "framework_kb.md")!.content).toContain("Lookup is not required");
  });
});
