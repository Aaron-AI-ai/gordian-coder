import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractChecklist,
  buildRubric,
  rubricSources,
  loadExtraRules,
  renderExtraRules,
} from "../rubric";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "k-rubric-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("extractChecklist", () => {
  it("captures bullets under Critical Rules", () => {
    const md = [
      "# Title",
      "intro text",
      "## Critical Rules",
      "- First rule",
      "- [ ] Second **rule**",
      "## Other",
      "- ignored",
    ].join("\n");
    expect(extractChecklist(md)).toEqual(["First rule", "Second rule"]);
  });

  it("captures Completion Criteria too", () => {
    const md = "## Completion Criteria\n- done when green\n";
    expect(extractChecklist(md)).toEqual(["done when green"]);
  });

  it("returns empty when no relevant section", () => {
    expect(extractChecklist("## Overview\n- nope")).toEqual([]);
  });
});

describe("buildRubric", () => {
  it("default security checklist covers secrets, trust-boundary input, and authz", () => {
    const rubric = buildRubric(tmp());
    expect(rubric).toContain("hardcoded secrets");
    expect(rubric).toContain("trust boundary");
    expect(rubric).toContain("permission checks");
  });

  it("falls back to defaults when rule files are absent", () => {
    const out = buildRubric(tmp());
    expect(out).toContain("**security**");
    expect(out).toContain("**performance**");
    expect(out).toContain("**correctness**");
    expect(out).toContain("**maintainability**");
    expect(out).toContain("**tests**");
    expect(out).toContain("SQL injection");
  });

  it("uses extracted bullets when a rule file exists", () => {
    const d = tmp();
    const dir = join(d, ".aidlc-rule-details", "extensions", "security", "baseline");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "security-baseline.md"),
      "## Critical Rules\n- Custom security rule X\n"
    );
    const out = buildRubric(d);
    expect(out).toContain("Custom security rule X");
  });
});

describe("rubricSources", () => {
  it("reports built-in defaults when no rule files exist", () => {
    const src = rubricSources(tmp());
    expect(src.security).toBe("built-in defaults");
    expect(src.tests).toBe("built-in defaults");
  });

  it("reports the rule file label when it provides the checklist", () => {
    const d = tmp();
    const dir = join(d, ".aidlc-rule-details", "extensions", "security", "baseline");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "security-baseline.md"),
      "## Critical Rules\n- Custom security rule X\n"
    );
    const src = rubricSources(d);
    expect(src.security).toBe("security-baseline.md");
    expect(src.performance).toBe("built-in defaults");
  });

  it("reports review/rules file count when present", () => {
    const d = tmp();
    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(join(d, "review", "rules", "a.md"), "rule");
    expect(rubricSources(d)["project-rules"]).toBe("review/rules (1 file(s))");
  });
});

describe("extra rules (review/rules)", () => {
  function rulesDir(): string {
    const d = tmp();
    mkdirSync(join(d, "review", "rules", "team"), { recursive: true });
    return d;
  }

  it("always ships the bundled rules, glob-gated", () => {
    const rules = loadExtraRules(tmp()); // no project review/rules
    // no default.md: the category checklist is already injected by buildRubric
    expect(rules.map((r) => r.file)).toEqual([
      "framework_kb.md",
      "java.md",
      "mapper_dao_xml.md",
    ]);
    expect(rules[0].globs).toEqual(["*.java"]);
    expect(rules[1].globs).toEqual(["*.java"]);
    expect(rules[2].globs).toContain("*Mapper.xml");
  });

  it("appends project md files recursively, sorted, with frontmatter globs parsed out", () => {
    const d = rulesDir();
    writeFileSync(join(d, "review", "rules", "always.md"), "Never use var.\n");
    writeFileSync(
      join(d, "review", "rules", "team", "sql.md"),
      '---\nglobs: "**/*.sql", db/**\n---\nNo SELECT *.\n'
    );
    const rules = loadExtraRules(d);
    expect(rules.slice(3)).toEqual([
      { file: "review/rules/always.md", globs: [], content: "Never use var.", reference: false },
      {
        file: "review/rules/team/sql.md",
        globs: ["**/*.sql", "db/**"],
        content: "No SELECT *.",
        reference: false,
      },
    ]);
  });

  it("loads from a custom rulesDir set in .f-review.json", () => {
    const d = tmp();
    mkdirSync(join(d, "fcq", "config", "rules"), { recursive: true });
    writeFileSync(join(d, ".f-review.json"), '{"rulesDir": "fcq/config/rules"}');
    writeFileSync(
      join(d, "fcq", "config", "rules", "guide.md"),
      "---\nmode: reference\n---\n# Order guide\nbody\n"
    );
    const rules = loadExtraRules(d);
    expect(rules.at(-1)?.file).toBe("fcq/config/rules/guide.md");
    expect(renderExtraRules(rules, "src/a.ts")).toContain("- fcq/config/rules/guide.md: Order guide");
    expect(rubricSources(d)["project-rules"]).toBe("fcq/config/rules (1 file(s))");
  });

  it("gates bundled rules per reviewed file", () => {
    const rules = loadExtraRules(tmp());
    const java = renderExtraRules(rules, "src/main/java/UserService.java");
    expect(java).toContain("Dead Code"); // java.md
    expect(java).not.toContain("JOIN Condition Errors"); // mapper_dao_xml.md
    const mapper = renderExtraRules(rules, "src/main/resources/mapper/UserMapper.xml");
    expect(mapper).toContain("JOIN Condition Errors");
    expect(mapper).not.toContain("Dead Code");
    const ts = renderExtraRules(rules, "src/a.ts");
    expect(ts).toBe(""); // no bundled rule targets .ts — the rubric covers it
  });

  it("injects glob-less rules for every file, glob rules only on match", () => {
    const rules = [
      { file: "always.md", globs: [], content: "Never use var." },
      { file: "sql.md", globs: ["*.sql"], content: "No SELECT *." },
    ];
    const ts = renderExtraRules(rules, "src/a.ts");
    expect(ts).toContain("Never use var.");
    expect(ts).not.toContain("No SELECT *.");
    // a glob without "/" matches by basename at any depth
    const sql = renderExtraRules(rules, "db/migrations/001.sql");
    expect(sql).toContain("No SELECT *.");
  });

  it("returns empty string when nothing applies", () => {
    expect(renderExtraRules([{ file: "s.md", globs: ["*.sql"], content: "x" }], "a.ts")).toBe("");
  });

  it("keeps brace globs intact — {ts,tsx} is one glob, not a broken split", () => {
    const d = rulesDir();
    writeFileSync(
      join(d, "review", "rules", "web.md"),
      '---\nglobs: "src/**/*.{ts,tsx}", *.md\n---\nNo any.\n'
    );
    const rules = loadExtraRules(d);
    expect(rules.at(-1)?.globs).toEqual(["src/**/*.{ts,tsx}", "*.md"]);
    expect(renderExtraRules(rules, "src/app/x.tsx")).toContain("No any.");
    expect(renderExtraRules(rules, "src/app/x.css")).not.toContain("No any.");
  });

  it("parses CRLF and BOM'd frontmatter (Windows-authored rule files)", () => {
    const d = rulesDir();
    writeFileSync(
      join(d, "review", "rules", "win.md"),
      '\uFEFF---\r\nglobs: "*.java"\r\nmode: reference\r\n---\r\n# Java guide\r\nbody\r\n'
    );
    const rule = loadExtraRules(d).at(-1)!;
    expect(rule.globs).toEqual(["*.java"]); // NOT [] — the rule must stay Java-only
    expect(rule.reference).toBe(true);
    expect(rule.content).not.toContain("---"); // frontmatter stripped, not injected as content
    expect(renderExtraRules(loadExtraRules(d), "a.ts")).not.toContain("win.md");
  });

  it("lists mode:reference rules as an on-demand index instead of injecting", () => {
    const d = rulesDir();
    writeFileSync(
      join(d, "review", "rules", "arch.md"),
      '---\nmode: reference\nglobs: "*.java"\n---\n# Architecture guide\nLayers must not skip.\n'
    );
    const rules = loadExtraRules(d);
    const out = renderExtraRules(rules, "src/A.java");
    expect(out).toContain("review/rules/arch.md: Architecture guide");
    expect(out).toContain("file_read");
    expect(out).not.toContain("Layers must not skip."); // content stays out of the prompt
    expect(renderExtraRules(rules, "a.ts")).not.toContain("arch.md"); // still glob-gated
  });
});
