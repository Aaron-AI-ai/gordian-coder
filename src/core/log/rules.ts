/**
 * f-log rule files: the same md-with-frontmatter format f-review uses, gated
 * by exception type instead of (or in addition to) file glob. Loaded once per
 * plan; matched per run; rendered into the analyst context under a budget.
 *
 * ponytail: own 25-line frontmatter parser — rubric's `parseRule` is private
 * and knows nothing about `exceptions:`; merge the two when a third consumer
 * appears.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { basename } from "node:path/posix";
import { BUNDLED_RULES, frameworkKbRule, type ExtraRule } from "../review/evidence/rubric";
import { loadLogConfig } from "./config";
import type { HandlerInfo } from "./parse";
import { BUNDLED } from "./rules/bundled";

export interface LogRule {
  file: string;
  exceptions: string[];
  globs: string[];
  /** HandlerInfo field names (uri, errorCode, svcId, even) that gate this rule. */
  handler: string[];
  reference: boolean;
  content: string;
}
export interface MatchedRule extends LogRule {
  specificity: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function listField(fm: string, key: string): string[] {
  const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  if (!line) return [];
  return line[1]
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(/,(?![^{]*\})/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function parseLogRule(file: string, raw: string): LogRule {
  raw = raw.replace(/^﻿/, "");
  const m = FRONTMATTER.exec(raw);
  if (!m) return { file, exceptions: [], globs: [], handler: [], reference: false, content: raw.trim() };
  return {
    file,
    exceptions: listField(m[1], "exceptions"),
    globs: listField(m[1], "globs"),
    handler: listField(m[1], "handler"),
    reference: /^mode:\s*reference\s*$/m.test(m[1]),
    content: raw.slice(m[0].length).trim(),
  };
}

const fromReview = (r: ExtraRule): LogRule => ({
  file: r.file, exceptions: [], globs: r.globs, handler: [], reference: r.reference ?? false, content: r.content,
});

/** review's framework_kb (config table substituted) and mapper rules, then the fico set. */
export function bundledLogRules(cwd: string): LogRule[] {
  const mapper = BUNDLED_RULES.find((r) => r.file === "mapper_dao_xml.md");
  return [
    fromReview(frameworkKbRule(cwd)),
    ...(mapper ? [fromReview(mapper)] : []),
    ...BUNDLED.map(([file, raw]) => parseLogRule(file, raw)),
  ];
}

export function loadLogRules(cwd: string): LogRule[] {
  const rel = loadLogConfig(cwd).rulesDir;
  const dir = join(cwd, rel);
  const bundled = bundledLogRules(cwd);
  if (!existsSync(dir)) return bundled;
  const project = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseLogRule(`${rel}/${f}`, readFileSync(join(dir, f), "utf8")));
  return [...bundled, ...project];
}

function globMatch(pattern: string, value: string): boolean {
  return new Bun.Glob(pattern).match(value);
}

/** Rules whose gates hold for this log, most specific first (always-on last).
 * `exceptions` and `handler` form one OR'd gate (either fires the rule);
 * `globs` is a separate AND gate. A rule with none of the three always fires. */
export function matchLogRules(rules: LogRule[], exceptionTypes: string[], suspectPaths: string[], handler?: HandlerInfo): MatchedRule[] {
  const out: MatchedRule[] = [];
  for (const r of rules) {
    let specificity = 0;
    if (r.exceptions.length || r.handler.length) {
      const exHit = r.exceptions.filter((p) => exceptionTypes.some((t) => globMatch(p, t)));
      const handlerHit = r.handler.filter((f) => Boolean(handler?.[f as keyof HandlerInfo]));
      if (!exHit.length && !handlerHit.length) continue;
      specificity = Math.max(0, ...exHit.map((p) => p.length), ...handlerHit.map((f) => f.length));
    }
    if (r.globs.length) {
      const hit = r.globs.filter((p) => suspectPaths.some((f) => globMatch(p, p.includes("/") ? f : basename(f))));
      if (!hit.length) continue;
      specificity = Math.max(specificity, ...hit.map((p) => p.length));
    }
    out.push({ ...r, specificity });
  }
  return out.sort((a, b) => b.specificity - a.specificity);
}

function ruleTitle(content: string): string {
  const h = /^#+\s*(.+)$/m.exec(content);
  return (h?.[1] ?? content.split("\n")[0] ?? "").slice(0, 80);
}

/** Inject rules in specificity order until `maxChars`; whatever does not fit
 * is listed as a reference the analyst may f_log_read on demand. */
export function renderLogRules(matched: MatchedRule[], maxChars: number): string {
  if (!matched.length) return "";
  const injected: string[] = [];
  const refs: MatchedRule[] = [];
  let used = 0;
  for (const r of matched) {
    if (r.reference) { refs.push(r); continue; }
    const block = `**${r.file}**\n${r.content}`;
    if (used + block.length + 2 > maxChars) { refs.push(r); continue; }
    injected.push(block);
    used += block.length + 2;
  }
  const sections: string[] = [];
  if (injected.length) sections.push(`## 분석 규칙\n\n${injected.join("\n\n")}`);
  if (refs.length) {
    sections.push(
      ["## 참고 규칙 — 필요한 것만 `f_log_read`로 읽는다", ...refs.map((r) => `- ${r.file}: ${ruleTitle(r.content)}`)].join("\n")
    );
  }
  return sections.join("\n\n");
}
