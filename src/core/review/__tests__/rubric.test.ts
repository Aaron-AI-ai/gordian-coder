import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChecklist, buildRubric, rubricSources } from "../rubric";

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
  it("falls back to defaults when rule files are absent", () => {
    const out = buildRubric(tmp());
    expect(out).toContain("**security**");
    expect(out).toContain("**nfr**");
    expect(out).toContain("**correctness**");
    expect(out).toContain("**tests**");
    expect(out).toContain("hardcoded secrets");
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
    expect(src.nfr).toBe("built-in defaults");
  });
});
