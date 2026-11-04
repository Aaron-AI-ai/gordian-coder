/**
 * f-log settings: the `log` section of `.fico/config/fico_ai.json` layered
 * over the review-flattened config, so `frameworkKb`, `language` and the tool
 * budgets are written once (under `review`) and shared.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG_PATHS, loadConfig, projectRulesDirs, resolveMaxIter, resolveMaxToolCalls } from "../review/config";

export interface LogConfig {
  output: string;
  runsDir: string;
  /** Project rules dirs (log.rulesDir > top-level rulesDir > .fico/rules + legacy log/rules). */
  rulesDirs: string[];
  judgeThreshold: number;
  judgeRounds: number;
  contextMaxChars: number;
  judge: boolean;
  language: string;
  frameworkKb: Record<string, string>;
  maxToolCalls: number;
  maxIter: number;
}

export const LOG_DEFAULTS = {
  output: ".fico/report/f-log/",
  runsDir: ".fico/f-log/runs/",
  rulesDir: "log/rules", // legacy default, still read when nothing is configured
  judgeThreshold: 70,
  judgeRounds: 2,
  contextMaxChars: 40_000,
  judge: false, // same default as f-review: judging costs a second agent per run
} as const;

// Wrong-typed field → unset (per-field .catch), same policy as ReviewConfigSchema.
const field = <T extends z.ZodType>(t: T) => t.optional().catch(undefined);
const LogSectionSchema = z.object({
  output: field(z.string()),
  runsDir: field(z.string()),
  rulesDir: field(z.string()),
  judgeThreshold: field(z.number()),
  judgeRounds: field(z.number()),
  contextMaxChars: field(z.number()),
  judge: field(z.boolean()),
  language: field(z.string()),
});

/** The raw `log` section of the first parseable config file, or {}. A
 * top-level `rulesDir` (the project rules, shared with f-review) fills the
 * section's `rulesDir` when the section has none. */
function logSection(cwd: string): z.infer<typeof LogSectionSchema> {
  for (const rel of CONFIG_PATHS) {
    const p = join(cwd, rel);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { log?: unknown; rulesDir?: unknown };
      const section = typeof raw?.log === "object" && raw.log !== null ? raw.log : {};
      const parsed = LogSectionSchema.safeParse({ rulesDir: raw?.rulesDir, ...section });
      return parsed.success ? parsed.data : {};
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function loadLogConfig(cwd: string): LogConfig {
  const review = loadConfig(cwd);
  const log = logSection(cwd);
  return {
    output: log.output ?? LOG_DEFAULTS.output,
    runsDir: log.runsDir ?? LOG_DEFAULTS.runsDir,
    rulesDirs: projectRulesDirs(log.rulesDir, LOG_DEFAULTS.rulesDir),
    judgeThreshold: log.judgeThreshold ?? review.judgeThreshold ?? LOG_DEFAULTS.judgeThreshold,
    judgeRounds: log.judgeRounds ?? review.judgeRounds ?? LOG_DEFAULTS.judgeRounds,
    contextMaxChars: log.contextMaxChars ?? LOG_DEFAULTS.contextMaxChars,
    judge: log.judge ?? review.judge ?? LOG_DEFAULTS.judge,
    language: log.language ?? review.language ?? "ko",
    frameworkKb: review.frameworkKb ?? {},
    maxToolCalls: resolveMaxToolCalls(cwd),
    maxIter: resolveMaxIter(cwd),
  };
}
