import { describe, expect, it } from "bun:test";
import { renderHtmlReport } from "../html";
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

  it("uses localized labels", () => {
    const ko = renderHtmlReport(mixed, "L", "ko");
    expect(ko).toContain("AI 리뷰 (1)");
    expect(ko).toContain("정적 분석 (2)");
  });
});
