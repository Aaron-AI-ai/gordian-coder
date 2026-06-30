/**
 * Build the review checklist ({{system_rule}}) from `.aidlc-rule-details/`.
 *
 * Rather than dumping whole rule files into the prompt, we extract the bullet
 * lines under their "Critical Rules" / "Completion Criteria" sections — the
 * parts that read as review criteria. If a rule file is missing or has no such
 * section, a built-in default checklist is used so the rubric is never empty.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CATEGORIES, type Category } from "./contract";

const MAX_BULLETS_PER_CATEGORY = 12;

const SOURCES: Record<Category, { file: string; label: string; defaults: string[] }> = {
  security: {
    file: "extensions/security/baseline/security-baseline.md",
    label: "security-baseline.md",
    defaults: [
      "No hardcoded secrets, credentials, or tokens",
      "Inputs validated/sanitized at trust boundaries",
      "AuthN/AuthZ enforced on protected operations",
      "No injection (SQL/cmd/path) via unsanitized input",
    ],
  },
  nfr: {
    file: "construction/nfr-design.md",
    label: "nfr-design.md",
    defaults: [
      "No obvious performance regressions (N+1, unbounded loops/allocations)",
      "Resource usage bounded; no leaks (handles, connections)",
      "Scales with expected load; no single-point bottlenecks introduced",
    ],
  },
  correctness: {
    file: "construction/code-generation.md",
    label: "code-generation.md",
    defaults: [
      "Logic matches intent; edge/null/error cases handled",
      "No duplicate/dead code; modifies in place (no *_new, *_modified copies)",
      "Errors handled without data loss; failures surfaced",
    ],
  },
  tests: {
    file: "construction/build-and-test.md",
    label: "build-and-test.md",
    defaults: [
      "Changed logic is covered by tests",
      "Tests assert behavior, not implementation details",
      "Build/test passes; no skipped or commented-out tests",
    ],
  },
};

/** Extract bullet lines under "Critical Rules"/"Completion Criteria" sections. */
export function extractChecklist(md: string): string[] {
  const lines = md.split("\n");
  const bullets: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)/.exec(line);
    if (heading) {
      capturing = /critical rules|completion criteria/i.test(heading[1]);
      continue;
    }
    if (!capturing) continue;
    const bullet = /^\s*[-*]\s+(?:\[[ x]\]\s*)?(.+)/.exec(line);
    if (bullet) {
      const text = bullet[1].replace(/\*\*/g, "").trim();
      if (text) bullets.push(text);
    }
  }
  return bullets;
}

function checklistFor(cat: Category, baseDir: string): string[] {
  const src = SOURCES[cat];
  const path = join(baseDir, src.file);
  if (existsSync(path)) {
    const extracted = extractChecklist(readFileSync(path, "utf8"));
    if (extracted.length) return extracted.slice(0, MAX_BULLETS_PER_CATEGORY);
  }
  return src.defaults;
}

/**
 * Render the full rubric for all required categories.
 * `cwd` defaults to the process cwd; rules live in `<cwd>/.aidlc-rule-details`.
 */
export function buildRubric(
  cwd: string = process.cwd(),
  required: readonly Category[] = REQUIRED_CATEGORIES
): string {
  const baseDir = join(cwd, ".aidlc-rule-details");
  return required
    .map((cat) => {
      const items = checklistFor(cat, baseDir).map((b) => `  - ${b}`);
      return `**${cat}** (${SOURCES[cat].label})\n${items.join("\n")}`;
    })
    .join("\n\n");
}
