import { describe, expect, it } from "bun:test";
import { fmtDuration, renderHtmlReport } from "../html";
import type { Finding } from "../../contract";

const finding = (over: Partial<Finding> = {}): Finding => ({
  category: "security",
  severity: "major",
  file: "src/a.ts",
  line: 3,
  rule: "no-secret",
  message: "hardcoded token",
  ...over,
});

const mixed = {
  "src/a.ts": [
    finding({ rule: "ai-rule", line: 3 }),
    finding({ rule: "fcq:pmd/R1", source: "fcq", line: 5, category: "maintainability", severity: "minor" }),
    finding({ rule: "fcq:pmd/R2", source: "merged", line: 7 }),
  ],
  "src/b.ts": [finding({ rule: "only-ai", line: 1 })],
};

describe("renderHtmlReport — source separation", () => {
  it("tags every finding item with its source and shows a badge", () => {
    const html = renderHtmlReport(mixed, "L", "en");
    expect(html).toContain('data-src="ai"');
    expect(html).toContain('data-src="fcq"');
    expect(html).toContain('data-src="merged"');
    expect(html).toContain('<span class="badge src ai">AI</span>');
    expect(html).toContain('<span class="badge src fcq">fcq</span>');
    expect(html).toContain('<span class="badge src merged">fcq+AI</span>');
  });

  it("offers a source filter next to the severity filter", () => {
    const html = renderHtmlReport(mixed, "L", "en");
    expect(html).toContain('data-group="src"');
    expect(html).toContain('<button class="fbtn active" data-src="">');
    expect(html).toContain('data-src="ai">AI');
    expect(html).toContain('data-src="fcq">fcq');
    // The client-side filter knows the new dimension.
    expect(html).toContain("state.src");
  });

  it("splits a file block into an AI group and a static-analysis group with a divider", () => {
    const html = renderHtmlReport(mixed, "L", "en");
    const block = html.slice(html.indexOf("<code>src/a.ts</code>"), html.indexOf("<code>src/b.ts</code>"));
    const ai = block.indexOf('data-src="ai"');
    const divider = block.indexOf('class="srcdiv"');
    const fcq = block.indexOf('data-src="fcq"');
    const merged = block.indexOf('data-src="merged"');
    expect(ai).toBeGreaterThan(-1);
    expect(divider).toBeGreaterThan(ai); // AI findings first, then the divider
    expect(fcq).toBeGreaterThan(divider); // then static analysis (merged rows belong here)
    expect(merged).toBeGreaterThan(divider);
    expect(block).toContain("AI review (1)");
    expect(block).toContain("Static analysis (2)");
    // A file with AI findings only gets no divider.
    const bBlock = html.slice(html.indexOf("<code>src/b.ts</code>"));
    expect(bBlock.slice(0, bBlock.indexOf("</details>"))).not.toContain('class="srcdiv"');
  });

  it("breaks the hero finding count down by source", () => {
    const html = renderHtmlReport(mixed, "L", "en");
    expect(html).toContain("AI 2");
    expect(html).toContain("fcq 2"); // the merged row counts on the static side
  });

  it("re-aligns AS-IS/TO-BE code in the fix boxes", () => {
    const html = renderHtmlReport(
      { "a.java": [finding({ file: "a.java", asIs: "if (x) {\n            y();\n        }", toBe: "```java\n        z();\n```" })] },
      "L",
      "en"
    );
    expect(html).toContain("if (x) {\n    y();\n}</span>");
    expect(html).toContain("z();</span>");
    expect(html).not.toContain("```");
  });

  it("uses localized labels", () => {
    const ko = renderHtmlReport(mixed, "L", "ko");
    expect(ko).toContain("AI 리뷰 (1)");
    expect(ko).toContain("정적 분석 (2)");
  });
});

describe("renderHtmlReport — run header and target table", () => {
  const ctx = {
    command: "f-review --files=src/**/*.ts --judge",
    settings: ["explicit files · whole-file", "judge ×2"],
    startedAt: new Date("2026-10-23T01:00:00Z"),
    finishedAt: new Date("2026-10-23T01:12:30Z"),
    files: [
      { path: "src/a.ts", status: "done" as const, units: 1 },
      { path: "src/b.ts", status: "done" as const, units: 3 },
      { path: "src/c.ts", status: "missing" as const, units: 1 },
    ],
  };
  const appendix =
    "## Static Analysis (fcq)\n\n- Command: `fcq analyze . --paths=src/a.ts,src/b.ts,src/c.ts --report-formats=json`\n\n" +
    "| category | rules | failed |\n| --- | --- | --- |\n| code-style | 20 | 7 |\n\n" +
    "## Review Context\n\n- Mode: explicit files\n\n### Files\n- src/a.ts\n- src/c.ts\n";
  const render = () =>
    renderHtmlReport(mixed, "L", "en", undefined, undefined, new Date(), appendix, undefined, ctx);

  it("shows the command, settings and elapsed time once, in the header", () => {
    const html = render();
    expect(html.split("f-review --files=src/**/*.ts --judge").length).toBe(2);
    expect(html).toContain("12m 30s");
    expect(html).toContain("judge ×2");
  });

  it("counts targets and reviewed files from the run, not from the findings map", () => {
    const html = render();
    expect(html).toContain('<div class="n">3</div><div class="l">files');
    expect(html).toContain('<div class="n">2</div><div class="l">reviewed &middot; 67% &middot; missing 1');
  });

  it("lists every target with its outcome and drops the appendix's repeat of it", () => {
    const html = render();
    expect(html).toContain('<span class="st missing">missing</span>');
    expect(html).toContain("(3 segments)");
    expect(html).not.toContain("Review Context");
    expect(html).toContain("--paths=&lt;3 files&gt;");
    expect(html.match(/src\/c\.ts/g)).toHaveLength(1); // the target table only
  });

  it("renders the appendix's markdown table as a table", () => {
    const html = render();
    expect(html).toContain("<table><thead><tr><th>category</th><th>rules</th><th>failed</th></tr></thead>");
    expect(html).toContain("<tr><td>code-style</td><td>20</td><td>7</td></tr>");
    expect(html).not.toContain("| ---");
  });

  it("keeps the findings-only header when no run context is given", () => {
    const html = renderHtmlReport(mixed, "L", "en");
    expect(html).toContain('class="meta"');
    expect(html).not.toContain('<details class="filelist">');
  });
});

describe("fmtDuration", () => {
  it("formats whole seconds at the largest unit needed", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(750_000)).toBe("12m 30s");
    expect(fmtDuration(3_725_000)).toBe("1h 02m 05s");
  });
});
