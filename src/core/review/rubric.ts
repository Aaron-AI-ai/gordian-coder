/**
 * Build the review checklist ({{system_rule}}) from `.aidlc-rule-details/`.
 *
 * Rather than dumping whole rule files into the prompt, we extract the bullet
 * lines under their "Critical Rules" / "Completion Criteria" sections — the
 * parts that read as review criteria. If a rule file is missing or has no such
 * section, a built-in default checklist is used so the rubric is never empty.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { REQUIRED_CATEGORIES, type Category } from "./contract";
import { loadConfig } from "./context";
import FRAMEWORK_DEFAULT from "./knowledge/framework.md" with { type: "text" };
import FRAMEWORK_KB_RULE from "./rules/framework_kb.md" with { type: "text" };
import JAVA_RULE from "./rules/java.md" with { type: "text" };
import MAPPER_RULE from "./rules/mapper_dao_xml.md" with { type: "text" };

const MAX_BULLETS_PER_CATEGORY = 12;

// `framework` is intentionally absent — it is injected from the framework
// guide (loadFrameworkGuide), not from .aidlc-rule-details.
const SOURCES: Partial<Record<Category, { file: string; label: string; defaults: string[] }>> = {
  correctness: {
    file: "construction/code-generation.md",
    label: "code-generation.md",
    defaults: [
      "Is the logic correct? Are there missing boundary conditions?",
      "Are exceptions handled properly?",
      "Is it thread-safe in concurrent scenarios?",
    ],
  },
  security: {
    file: "extensions/security/baseline/security-baseline.md",
    label: "security-baseline.md",
    defaults: [
      "Are there security vulnerabilities such as SQL injection or XSS?",
      "Are there hardcoded secrets, credentials, tokens, or API keys?",
      "Is input crossing a trust boundary (user, network, file) validated?",
      "Is sensitive information handled correctly (not leaked via logs or error messages)?",
      "Are authentication and permission checks enforced on protected operations?",
    ],
  },
  performance: {
    file: "construction/nfr-design.md",
    label: "nfr-design.md",
    defaults: [
      "Are there obvious performance issues (e.g., N+1 queries, unnecessary loops)?",
      "Are resources properly released?",
    ],
  },
  maintainability: {
    file: "construction/maintainability.md",
    label: "maintainability.md",
    defaults: [
      "Is the code clear and easy to understand?",
      "Do names accurately express intent?",
      "Does it follow the project's existing code style and architecture patterns?",
    ],
  },
  tests: {
    file: "construction/build-and-test.md",
    label: "build-and-test.md",
    defaults: [
      "Do critical logic paths have corresponding test cases?",
      "Do test cases cover boundary conditions?",
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

function checklistFor(
  src: { file: string; label: string; defaults: string[] },
  baseDir: string
): { items: string[]; fromFile: boolean } {
  const path = join(baseDir, src.file);
  if (existsSync(path)) {
    const extracted = extractChecklist(readFileSync(path, "utf8"));
    if (extracted.length)
      return { items: extracted.slice(0, MAX_BULLETS_PER_CATEGORY), fromFile: true };
  }
  return { items: src.defaults, fromFile: false };
}

/** Where each category's checklist came from: the rule file, or built-in
 * defaults (so a silent fallback is visible in the target manifest). */
export function rubricSources(cwd: string = process.cwd()): Record<string, string> {
  const baseDir = join(cwd, ".aidlc-rule-details");
  const out: Record<string, string> = {};
  for (const [cat, src] of Object.entries(SOURCES)) {
    if (!src) continue;
    out[cat] = checklistFor(src, baseDir).fromFile ? src.label : "built-in defaults";
  }
  const rel = rulesDirOf(cwd);
  const extraDir = join(cwd, rel);
  if (existsSync(extraDir)) {
    const n = readdirSync(extraDir, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".md")
    ).length;
    if (n) out["project-rules"] = `${rel} (${n} file(s))`;
  }
  return out;
}

// ponytail: total cap on injected project rules per file; split/scope your md files if you hit it.
const MAX_EXTRA_RULES_CHARS = 20_000;

/** One project rule file from `review/rules/`: `globs` gates which review
 * targets it applies to (empty = every file). `reference: true` lists the file
 * as a pointer the reviewer reads on demand (file_read) instead of injecting
 * its content into the prompt. */
export interface ExtraRule {
  file: string; // path relative to review/rules
  globs: string[];
  content: string;
  reference?: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse optional frontmatter: `globs:` (comma-separated, quotes and
 * [brackets] tolerated; absent = applies to all files) and `mode: reference`.
 * Tolerates CRLF line endings and a BOM (Windows-authored rule files) — a
 * frontmatter that fails to parse would silently inject the rule everywhere. */
function parseRule(raw: string): { globs: string[]; content: string; reference: boolean } {
  raw = raw.replace(/^\uFEFF/, "");
  const m = FRONTMATTER.exec(raw);
  if (!m) return { globs: [], content: raw.trim(), reference: false };
  const line = /^globs:\s*(.+)$/m.exec(m[1]);
  const globs = line
    ? line[1]
        .trim()
        .replace(/^\[|\]$/g, "")
        // split on commas OUTSIDE {…} groups — "src/**/*.{ts,tsx}" is ONE glob
        .split(/,(?![^{]*\})/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : [];
  const reference = /^mode:\s*reference\s*$/m.test(m[1]);
  return { globs, content: raw.slice(m[0].length).trim(), reference };
}

/** Rules bundled with the plugin (src/core/review/rules/*.md), applied to every
 * reviewed project with the same frontmatter glob gating as project rules.
 * No default.md here: the always-on category checklist already comes from
 * SOURCES defaults via buildRubric — bundling it again injected the same
 * bullets twice into every prompt (and the two copies drifted).
 * ponytail: static imports — adding a bundled rule means adding a line here. */
const BUNDLED_RULES: ExtraRule[] = [
  { file: "framework_kb.md", ...parseRule(FRAMEWORK_KB_RULE) },
  { file: "java.md", ...parseRule(JAVA_RULE) },
  { file: "mapper_dao_xml.md", ...parseRule(MAPPER_RULE) },
];

/** Project rules directory, relative to the project root: `.f-review.json`
 * `rulesDir` if set, else `review/rules`. */
function rulesDirOf(cwd: string): string {
  return loadConfig(cwd).rulesDir ?? "review/rules";
}

/**
 * Load review rules: the bundled set, then every `.md` under the project's
 * rules directory (recursive, sorted by path). Project rule `file` paths are
 * root-relative so reference-mode entries are directly file_read-able. Loaded
 * once per session; which rules actually reach the prompt is decided per file
 * by `renderExtraRules`.
 */
export function loadExtraRules(cwd: string = process.cwd()): ExtraRule[] {
  const rel = rulesDirOf(cwd);
  const dir = join(cwd, rel);
  if (!existsSync(dir)) return [...BUNDLED_RULES];
  const project = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ file: `${rel}/${f}`, ...parseRule(readFileSync(join(dir, f), "utf8")) }));
  return [...BUNDLED_RULES, ...project];
}

/** First heading (or first line) of a rule body — the index blurb for
 * reference-mode guides. */
function ruleTitle(content: string): string {
  const h = /^#+\s*(.+)$/m.exec(content);
  return (h?.[1] ?? content.split("\n")[0] ?? "").slice(0, 80);
}

/** Rules applicable to `filePath`: no globs = always; a glob without "/"
 * matches by basename at any depth (same semantics as applyExclude).
 * Inject-mode rules go in verbatim; reference-mode rules are listed as an
 * index the reviewer reads on demand via file_read. */
export function renderExtraRules(rules: ExtraRule[], filePath: string): string {
  const applicable = rules.filter(
    (r) =>
      r.globs.length === 0 ||
      r.globs.some((p) => new Bun.Glob(p).match(p.includes("/") ? filePath : basename(filePath)))
  );
  if (!applicable.length) return "";
  const sections: string[] = [];
  const inject = applicable.filter((r) => !r.reference);
  if (inject.length) {
    let out = inject.map((r) => `**${r.file}**\n${r.content}`).join("\n\n");
    if (out.length > MAX_EXTRA_RULES_CHARS) {
      out = `${out.slice(0, MAX_EXTRA_RULES_CHARS)}\n\n… (truncated: applicable review/rules exceed ${MAX_EXTRA_RULES_CHARS} chars)`;
    }
    sections.push(`**Project review rules**\n\n${out}`);
  }
  const refs = applicable.filter((r) => r.reference);
  if (refs.length) {
    sections.push(
      [
        `**Project review guides** — before judging, read the relevant one(s) with`,
        `\`file_read\` and apply only the sections that concern this file:`,
        ...refs.map((r) => `- ${r.file}: ${ruleTitle(r.content)}`),
      ].join("\n")
    );
  }
  return `\n\n${sections.join("\n\n")}`;
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
    .map((cat) => ({ cat, src: SOURCES[cat] }))
    .filter((x): x is { cat: Category; src: NonNullable<typeof x.src> } => !!x.src)
    .map(({ cat, src }) => {
      const items = checklistFor(src, baseDir).items.map((b) => `  - ${b}`);
      return `**${cat}** (${src.label})\n${items.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Load the framework conventions guide: a project override
 * (`.f-review.json` "frameworkGuide") if present, else the bundled default.
 * These rules are AUTHORITATIVE and override general best practices.
 */
export function loadFrameworkGuide(cwd: string = process.cwd()): string {
  const p = loadConfig(cwd).frameworkGuide;
  if (p) {
    const abs = isAbsolute(p) ? p : join(cwd, p);
    if (existsSync(abs)) return readFileSync(abs, "utf8");
  }
  return FRAMEWORK_DEFAULT;
}
