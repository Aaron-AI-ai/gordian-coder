/**
 * The `.fico/config/fico_ai.json` document and the run parameters derived
 * from it.
 *
 * Config is read by every layer — evidence/ for rules and fcq, pipeline/ for
 * budgets, report/ for the output location — so it sits at the root rather
 * than inside any one of them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_ITER } from "./tools/read";

// Config is external, hand-written JSON — validate at runtime (CLAUDE.md rule).
// A wrong-typed field degrades to "unset" (per-field .catch) instead of
// crashing the review (e.g. `"rulesDir": 5` reaching path.join) or silently
// dropping the whole file.
const field = <T extends z.ZodType>(t: T) => t.optional().catch(undefined);

/** One git wiki to mirror. Shorthand string = the clone URL with every other
 * field defaulted. */
export const WikiKbSourceSchema = z.union([
  z.string(),
  z.object({
    url: z.string(),
    tokenEnv: z.string().optional(), // env var NAME holding the token — never the token itself
    branch: z.string().optional(),
    dest: z.string().optional(), // repo-relative; defaults to ".fico/kb/<name>"
  }),
]);
export type WikiKbSource = z.infer<typeof WikiKbSourceSchema>;

export const ReviewConfigSchema = z.object({
  exclude: field(z.array(z.string())),
  output: field(z.string()),
  language: field(z.string()), // report/findings language, e.g. "ko" (default), "en"
  frameworkGuide: field(z.string()), // path to a framework conventions md (overrides bundled default)
  failOn: field(z.string()), // CI gate: FAIL when any finding is at/above this severity ("blocker"|"major"|"minor"|"nit")
  debug: field(z.boolean()), // emit `[f-review:*]` trace logs (alternative to F_REVIEW_DEBUG env)
  deepPasses: field(z.number()), // review rounds per file/segment (clamped 1..5; 1 = single pass)
  maxIter: field(z.number()), // exploration tool calls per round before forced convergence (default MAX_ITER)
  maxToolCalls: field(z.number()), // total tool calls per reviewer session, including context/submit
  rulesDir: field(z.string()), // project rules directory, relative to root (default "review/rules")
  frameworkKb: field(z.record(z.string())), // import prefix → KB dir map; replaces the framework_kb rule's table
  frameworkKbFile: field(z.string()), // path to an md replacing the bundled framework_kb.md entirely (frontmatter globs respected)
  judge: field(z.boolean()), // run mode: judge each file's review with an independent agent
  judgeThreshold: field(z.number()), // judge pass score 0..100 (default 70)
  judgeRounds: field(z.number()), // max rework (re-review) rounds per file (0..5, default 2; 0 = judge once, never re-review)
  fcq: field(z.boolean()), // run mode: run the fcq static analyzer at plan time and merge its report
  fcqOptions: field(z.record(z.unknown())), // fcq CLI options (see fcq.ts FcqOptionsSchema)
  fcqFix: field(z.boolean()), // make reviewers write a TO-BE fix for EVERY fcq hit, not just CRITICAL/MAJOR
  wikiKb: field(z.record(WikiKbSourceSchema)), // name -> git wiki to mirror into the KB (see kb-sync.ts)
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/**
 * Config locations, highest priority first.
 *
 * `.fico/config/fico_ai.json` is the current home: one file for every
 * gordian feature, not just review. The two `.f-review.json` paths stay for
 * back-compat — projects configured before the move keep working untouched.
 */
export const CONFIG_PATHS = [
  ".fico/config/fico_ai.json",
  ".f-review.json",
  "fcq/config/.f-review.json",
] as const;

/**
 * Flatten one config document.
 *
 * `fico_ai.json` groups settings by feature — review options live under
 * `"review"`, alongside siblings like `"wikiKb"`. The legacy `.f-review.json`
 * files are flat. Both shapes reduce to the same object here: the `review`
 * section wins over a same-named top-level key, so a half-migrated file
 * behaves the way its author intended rather than silently ignoring the
 * section.
 */
function flattenConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const section = (raw as Record<string, unknown>).review;
  if (typeof section !== "object" || section === null || Array.isArray(section)) return raw;
  return { ...(raw as Record<string, unknown>), ...(section as Record<string, unknown>) };
}

/** First config file that exists AND parses wins; missing → try the next
 * location; unparseable/non-object → also fall through (an invalid
 * higher-priority file must not shadow a valid fallback); nothing valid → {}. */
export function loadConfig(cwd: string = process.cwd()): ReviewConfig {
  for (const rel of CONFIG_PATHS) {
    const p = join(cwd, rel);
    if (!existsSync(p)) continue;
    try {
      const parsed = ReviewConfigSchema.safeParse(
        flattenConfig(JSON.parse(readFileSync(p, "utf8")))
      );
      if (parsed.success) return parsed.data;
    } catch {
      /* unparseable JSON — fall through to the next location */
    }
  }
  return {};
}

/** Hard ceiling on review rounds per target (deep-pass iteration). */
export const MAX_DEEP_PASSES = 5;

/** Total review rounds per target: arg wins, else config `deepPasses`, else 1
 * (single pass). Always clamped to [1, MAX_DEEP_PASSES] — the submit gate can
 * never loop unbounded. */
export function resolveDeepPasses(arg: number | undefined, cwd: string): number {
  const v = arg ?? loadConfig(cwd).deepPasses ?? 1;
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(MAX_DEEP_PASSES, Math.trunc(v)));
}

/** Exploration budget per round: config `maxIter`, else MAX_ITER. Clamped to
 * >=1 — 0 would withhold every exploration result from the first call. */
export function resolveMaxIter(cwd: string): number {
  const v = loadConfig(cwd).maxIter;
  if (typeof v !== "number" || !Number.isFinite(v)) return MAX_ITER;
  return Math.max(1, Math.trunc(v));
}

/** Hard reviewer-session tool-call ceiling. Three is the smallest useful
 * value: one context call plus two submit/recovery slots. Unlike maxIter this
 * budget never resets between files, deep passes, or final-check retries. */
export const DEFAULT_MAX_TOOL_CALLS = 10;
export const MIN_MAX_TOOL_CALLS = 3;

export function resolveMaxToolCalls(cwd: string): number {
  const v = loadConfig(cwd).maxToolCalls;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_TOOL_CALLS;
  return Math.max(MIN_MAX_TOOL_CALLS, Math.trunc(v));
}
