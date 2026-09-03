/**
 * fcq (fico-code-q) static-analysis integration for parallel runs.
 *
 * `f_review_plan` runs the fcq CLI ONCE over the run's target files before the
 * fan-out, then shards its `report.json` per target file under the run dir:
 *
 *   fcq/f-review/runs/<runId>/fcq/
 *     summary.json          run-level summary + analyzer status (finalize)
 *     files/<slug>.json     violations of ONE target file (reviewer/judge)
 *
 * Each reviewer subagent reads only its own shard and gets the violations
 * injected as deterministic evidence ("already found — do not re-report; use
 * as leads"). finalize merges every shard into the report as findings.
 *
 * fcq failure never stops the LLM review: the run records the failure, the
 * evidence section is simply absent, and finalize fails closed on `failOn`
 * (an unverified static-analysis gate must not read as PASS).
 *
 * The report is written straight into the run dir via fcq's `--report-output`,
 * so nothing depends on the target's own `fcq.yaml`: a project with no
 * `report:` section — or none disabled — still yields a report, and two runs
 * never share a path. `--report-formats=json` skips the HTML/Markdown views
 * that nothing here reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { splitFix, type Category, type Finding, type Severity } from "../contract";
import { loadConfig } from "../config";
import { targetRange } from "../pipeline/segment";

/** Default wall-clock cap for the fcq process (build + analysis), seconds. */
export const FCQ_DEFAULT_TIMEOUT_S = 900;
/** Violations rendered per file in the reviewer prompt (rest is counted). */
export const FCQ_EVIDENCE_MAX_ITEMS = 40;
export const FCQ_EVIDENCE_MAX_CHARS = 6_000;
/** Cap on the `code.lines` snippet used as a violation's `asIs`. */
const FCQ_SNIPPET_MAX_LINES = 12;

export const FCQ_SEVERITIES = ["INFO", "MINOR", "MAJOR", "CRITICAL", "BLOCKER"] as const;
export type FcqSeverity = (typeof FCQ_SEVERITIES)[number];

// Per-field .catch keeps a mistyped option from discarding the whole block.
const opt = <T extends z.ZodType>(t: T) => t.optional().catch(undefined);
export const FcqOptionsSchema = z.object({
  bin: opt(z.string()), // fcq executable (default: `fcq` on PATH)
  analyzers: opt(z.array(z.string())), // -a
  module: opt(z.string()), // -m
  config: opt(z.string()), // -c (also where report.output is read from)
  maxSeverity: opt(z.enum(FCQ_SEVERITIES)), // --max-severity
  noBuild: opt(z.boolean()),
  buildTimeout: opt(z.number()), // --build-timeout (seconds)
  timeout: opt(z.number()), // f-review-side process cap (seconds)
});
export type FcqOptions = z.infer<typeof FcqOptionsSchema>;

// ── report.json (external state: validate) ───────────────────────

const FcqViolationSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional().nullable(),
  column: z.number().int().optional().nullable(),
  severity: z.enum(FCQ_SEVERITIES),
  message: z.string().default(""),
  code: z
    .object({ startLine: z.number().int().optional().nullable(), lines: z.array(z.string()).default([]) })
    .optional()
    .nullable(),
});

const FcqRuleSchema = z.object({
  analyzer: z.string(),
  ruleId: z.string(),
  description: z.string().default(""),
  category: z.string().default("uncategorized"),
  severity: z.enum(FCQ_SEVERITIES),
  status: z.string(),
  violations: z.array(FcqViolationSchema).default([]),
});

const FcqReportSchema = z.object({
  summary: z.object({
    totalRules: z.number(),
    passed: z.number(),
    failed: z.number(),
    notRun: z.number(),
    totalViolations: z.number(),
    maxSeverity: z.enum(FCQ_SEVERITIES).nullable().optional(),
    passRate: z.number().optional(),
  }),
  metadata: z.object({
    ranAt: z.string().optional(),
    analyzers: z
      .array(z.object({ name: z.string(), status: z.string(), durationMillis: z.number().optional() }))
      .default([]),
    build: z.object({ status: z.string(), durationMillis: z.number().optional() }).optional().nullable(),
  }),
  categories: z
    .array(
      z.object({
        category: z.string(),
        ruleCount: z.number(),
        passed: z.number(),
        failed: z.number(),
        notRun: z.number(),
        violationCount: z.number(),
        maxSeverity: z.enum(FCQ_SEVERITIES).nullable().optional(),
      })
    )
    .default([]),
  rules: z.array(FcqRuleSchema),
});
export type FcqReport = z.infer<typeof FcqReportSchema>;

/** One violation, flattened with its rule identity — the per-file shard row. */
export const FcqFileViolationSchema = z.object({
  analyzer: z.string(),
  ruleId: z.string(),
  description: z.string(),
  category: z.string(),
  severity: z.enum(FCQ_SEVERITIES),
  line: z.number().int().optional(),
  message: z.string(),
  snippet: z.array(z.string()).optional(),
});
export type FcqFileViolation = z.infer<typeof FcqFileViolationSchema>;

export const FcqSummarySchema = z.object({
  summary: FcqReportSchema.shape.summary,
  metadata: FcqReportSchema.shape.metadata,
  categories: FcqReportSchema.shape.categories,
  targetViolations: z.number(),
  outsideTargetViolations: z.number(),
  files: z.array(z.string()), // targets that have at least one violation
});
export type FcqSummary = z.infer<typeof FcqSummarySchema>;

/** Persisted in run.json — what happened to the fcq step. */
export const FcqRunStatusSchema = z.object({
  status: z.enum(["ok", "failed"]),
  command: z.string(),
  durationMs: z.number(),
  reason: z.string().optional(),
  reportPath: z.string().optional(),
});
export type FcqRunStatus = z.infer<typeof FcqRunStatusSchema>;

// ── paths ────────────────────────────────────────────────────────

// Mirrors run.ts reviewSlug so the fcq shard and the review artifact of the
// same file sit side by side under matching names.
function slug(file: string): string {
  const readable = file.replace(/[\\/]/g, "__").replace(/[^\w.__-]/g, "_").slice(0, 180);
  return `${readable}--${Bun.hash(file).toString(36)}`;
}

function fcqDir(runRoot: string): string {
  return join(runRoot, "fcq");
}

/** Absolute path of a target's violation shard. */
export function fcqShardPath(runRoot: string, file: string): string {
  return join(fcqDir(runRoot), "files", `${slug(file)}.json`);
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

// ── run ──────────────────────────────────────────────────────────

export function fcqCommand(
  cwd: string,
  targets: string[],
  o: FcqOptions,
  reportDir: string
): string[] {
  const cmd = [
    o.bin ?? "fcq",
    "analyze",
    cwd,
    `--paths=${targets.join(",")}`,
    // Report into the run dir rather than wherever the target's fcq.yaml
    // points, and render only the json data source (fcq always writes it).
    `--report-output=${reportDir}`,
    "--report-formats=json",
  ];
  if (o.analyzers?.length) cmd.push(`--analyzers=${o.analyzers.join(",")}`);
  if (o.module) cmd.push(`--module=${o.module}`);
  if (o.config) cmd.push(`--config=${abs(cwd, o.config)}`);
  if (o.maxSeverity) cmd.push(`--max-severity=${o.maxSeverity}`);
  if (o.noBuild) cmd.push("--no-build");
  if (typeof o.buildTimeout === "number") cmd.push(`--build-timeout=${Math.trunc(o.buildTimeout)}`);
  return cmd;
}

/** Effective fcq options: `.f-review.json` `fcqOptions`, validated. */
export function fcqOptionsOf(cwd: string): FcqOptions {
  return FcqOptionsSchema.safeParse(loadConfig(cwd).fcqOptions ?? {}).data ?? {};
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Shard a parsed report into per-target files + summary. Exported for tests. */
export async function shardReport(
  report: FcqReport,
  targets: string[],
  runRoot: string
): Promise<FcqSummary> {
  const want = new Set(targets.map(normalizePath));
  const byFile = new Map<string, FcqFileViolation[]>();
  let outside = 0;
  for (const rule of report.rules) {
    for (const v of rule.violations) {
      // fcq reports repo-relative paths; tolerate an absolute one from the
      // analyzer by matching on the suffix.
      const rel = normalizePath(v.file);
      const file = want.has(rel) ? rel : [...want].find((t) => rel.endsWith(`/${t}`));
      if (!file) {
        outside++;
        continue;
      }
      const row: FcqFileViolation = {
        analyzer: rule.analyzer,
        ruleId: rule.ruleId,
        description: rule.description,
        category: rule.category,
        severity: v.severity,
        message: v.message,
        ...(v.line ? { line: v.line } : {}),
        ...(v.code?.lines?.length ? { snippet: v.code.lines.slice(0, FCQ_SNIPPET_MAX_LINES) } : {}),
      };
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(row);
    }
  }
  let total = 0;
  for (const [file, rows] of byFile) {
    rows.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    total += rows.length;
    await Bun.write(fcqShardPath(runRoot, file), JSON.stringify(rows, null, 2));
  }
  const summary: FcqSummary = {
    summary: report.summary,
    metadata: report.metadata,
    categories: report.categories,
    targetViolations: total,
    outsideTargetViolations: outside,
    files: [...byFile.keys()].sort(),
  };
  await Bun.write(join(fcqDir(runRoot), "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Run fcq over `targets`, shard the report under `runRoot`. Never throws —
 * every failure comes back as `{status:"failed", reason}` so the LLM review
 * proceeds without static-analysis evidence.
 */
export async function runFcq(cwd: string, targets: string[], runRoot: string): Promise<FcqRunStatus> {
  const o = fcqOptionsOf(cwd);
  // fcq owns this directory (it writes an ownership manifest there), so keep it
  // separate from the shards f-review writes under fcq/.
  const reportPath = join(fcqDir(runRoot), "raw", "report.json");
  const cmd = fcqCommand(cwd, targets, o, dirname(reportPath));
  const command = cmd.join(" ");
  const started = Date.now();
  const fail = (reason: string): FcqRunStatus => ({
    status: "failed",
    command,
    durationMs: Date.now() - started,
    reason,
  });

  const timeoutMs = Math.max(1, o.timeout ?? FCQ_DEFAULT_TIMEOUT_S) * 1000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    return fail(`cannot start ${cmd[0]}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) return fail(`timed out after ${timeoutMs / 1000}s`);
  // 0 = clean, 1 = findings at/above fcq's own fail-on — both are results.
  // 2 = usage/config error; anything else = crash.
  if (exitCode !== 0 && exitCode !== 1) {
    return fail(`exit ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500)}`);
  }
  if (!existsSync(reportPath)) return fail(`fcq exited ${exitCode} but wrote no ${reportPath}`);

  let report: FcqReport;
  try {
    const parsed = FcqReportSchema.safeParse(JSON.parse(readFileSync(reportPath, "utf8")));
    if (!parsed.success) return fail(`report.json schema mismatch: ${parsed.error.issues[0]?.message}`);
    report = parsed.data;
  } catch (err) {
    return fail(`cannot read report.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  await shardReport(report, targets, runRoot);
  return {
    status: "ok",
    command,
    durationMs: Date.now() - started,
    reportPath,
  };
}

// ── read (reviewer / judge / finalize) ───────────────────────────

/** Violations of one target file, or [] (no shard = clean or fcq failed). */
export function readFcqFile(runRoot: string, file: string): FcqFileViolation[] {
  const p = fcqShardPath(runRoot, file);
  if (!existsSync(p)) return [];
  try {
    return z.array(FcqFileViolationSchema).safeParse(JSON.parse(readFileSync(p, "utf8"))).data ?? [];
  } catch {
    return [];
  }
}

export function readFcqSummary(runRoot: string): FcqSummary | null {
  const p = join(fcqDir(runRoot), "summary.json");
  if (!existsSync(p)) return null;
  try {
    return FcqSummarySchema.safeParse(JSON.parse(readFileSync(p, "utf8"))).data ?? null;
  } catch {
    return null;
  }
}

const SEV_RANK: Record<FcqSeverity, number> = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };

/** Violations relevant to a target id: a segment (`path#start-end`) keeps only
 * rows anchored inside its window (unanchored rows are kept — they are
 * file-level). */
export function violationsForTarget(all: FcqFileViolation[], target: string): FcqFileViolation[] {
  const range = targetRange(target);
  if (!range) return all;
  return all.filter((v) => v.line === undefined || (v.line >= range.start && v.line <= range.end));
}

/**
 * The `<review_evidence>` section for a reviewer/judge: most severe first,
 * capped by count and chars, with the leftover counted. "" when nothing.
 */
export function renderFcqEvidence(violations: FcqFileViolation[], fixAll = false): string {
  if (!violations.length) return "";
  const sorted = [...violations].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0)
  );
  const shown = sorted.slice(0, FCQ_EVIDENCE_MAX_ITEMS);
  const lines = shown.map(
    (v) =>
      `- L${v.line ?? "?"} [${v.severity}] ${v.analyzer}/${v.ruleId} — ${v.description || v.message}` +
      (v.description && v.message && v.message !== v.description ? ` (${v.message})` : "")
  );
  const rest = sorted.length - shown.length;
  // fcq has no fix text, so an unfollowed hit reaches the report with the rule
  // DESCRIPTION as its TO-BE. `fixAll` buys real TO-BE code for every hit with
  // reviewer budget; the default spends that budget on what fcq cannot see.
  const scope = fixAll
    ? [
        "Use them as leads: for EVERY hit above, write the corrected code as a",
        "concrete fix in `asIs`/`toBe` — or state why it is a false positive. fcq has",
        "no fix text, so a hit you skip ships with only the rule description.",
      ]
    : [
        "Use them as leads: for CRITICAL/MAJOR hits, trace the actual data flow",
        "and give the fix in `asIs`/`toBe`, or state why it is a false positive.",
      ];
  const head = ["## Static analysis (fcq, already run for you)"];
  const tail = [
    "",
    "These are deterministic and already in the report — do NOT re-report them.",
    ...scope,
    "Anchor such a finding on the SAME `line` as the fcq hit (it is merged into",
    "that row) and name the rule id in `message`. Spend the rest of your budget",
    "on what the tools cannot see: logic, boundaries, transactions, framework rules.",
  ];
  // Cap the LIST, never the tail: slicing the joined body dropped the
  // instructions exactly when a file had enough violations to need them.
  const room = FCQ_EVIDENCE_MAX_CHARS - head.join("\n").length - tail.join("\n").length;
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > room) break;
    kept.push(l);
    used += l.length + 1;
  }
  const omitted = rest + (lines.length - kept.length);
  return [
    ...head,
    ...kept,
    ...(omitted > 0 ? [`… ${omitted} more violation(s) — in the report, not listed here.`] : []),
    ...tail,
  ].join("\n");
}

// ── finalize: violations → findings ──────────────────────────────

const SEVERITY_MAP: Record<FcqSeverity, Severity> = {
  BLOCKER: "blocker",
  CRITICAL: "blocker",
  MAJOR: "major",
  MINOR: "minor",
  INFO: "nit",
};

/** fcq category → review category. Unknown ones read as maintainability. */
export function mapFcqCategory(c: string): Category {
  const k = c.toLowerCase();
  if (k === "bugs") return "correctness";
  if (k === "security" || k === "sql") return "security";
  if (k === "performance") return "performance";
  if (k === "architecture" || k.startsWith("framework")) return "framework";
  return "maintainability";
}

/** Findings for the report: one per violation, rule tagged `fcq:`. The
 * violation snippet is the AS-IS; fcq has no fix text, so the rule's own
 * description (what the rule demands) stands in as the TO-BE — a placeholder a
 * reviewer's real correction replaces at merge. The two are separate fields:
 * concatenated, a long snippet used to truncate away the fix entirely. */
export function fcqFindings(file: string, violations: FcqFileViolation[]): Finding[] {
  return violations.map((v) => {
    const toBe = v.description || `(apply ${v.ruleId})`;
    const asIs = v.snippet?.length ? v.snippet.join("\n") : undefined;
    return {
      category: mapFcqCategory(v.category),
      severity: SEVERITY_MAP[v.severity],
      file,
      ...(v.line ? { line: v.line } : {}),
      rule: `fcq:${v.analyzer}/${v.ruleId}`,
      message: v.message || v.description,
      ...(asIs ? { asIs } : {}),
      toBe,
    };
  });
}

const SEV_ORDER: Severity[] = ["blocker", "major", "minor", "nit"];

/**
 * Merge the LLM review with fcq findings for one file. An LLM finding anchored
 * on the SAME line as an fcq violation AND naming its rule id is the reviewer's
 * follow-up on that hit (the prompt orders both), so the two collapse into one row: the
 * fcq rule identity stays (deterministic), the reviewer's message and
 * AS-IS/TO-BE fill in what fcq cannot say, and severity is the higher of the
 * two — fcq's rating is a floor, the reviewer may have found it worse.
 * Everything else passes through unchanged; LLM rows come first.
 */
export function mergeFcqFindings(llm: Finding[], fcq: Finding[]): Finding[] {
  const rest = [...llm];
  const merged = fcq.map((f) => {
    if (f.line === undefined) return f;
    // Same line alone is too loose (an unrelated logic finding can sit on a
    // LineLength row); the reviewer must also name the rule it follows up on.
    const ruleId = f.rule.slice(f.rule.lastIndexOf("/") + 1).toLowerCase();
    const i = rest.findIndex(
      (l) => l.line === f.line && `${l.rule} ${l.message}`.toLowerCase().includes(ruleId)
    );
    if (i < 0) return f;
    const [l] = rest.splice(i, 1);
    const severity = SEV_ORDER[Math.min(SEV_ORDER.indexOf(f.severity), SEV_ORDER.indexOf(l.severity))];
    // Per field, not wholesale: a reviewer who wrote only the corrected code
    // keeps fcq's snippet as the AS-IS instead of losing it.
    const mine = splitFix(l);
    const theirs = splitFix(f);
    return {
      ...f,
      severity,
      message: `${f.message}\n리뷰어: ${l.message}`,
      ...(mine.asIs || theirs.asIs ? { asIs: mine.asIs ?? theirs.asIs } : {}),
      ...(mine.toBe || theirs.toBe ? { toBe: mine.toBe ?? theirs.toBe } : {}),
      suggestion: undefined,
    };
  });
  return [...rest, ...merged];
}

/** "## Static Analysis (fcq)" report section. */
export function renderFcqSection(status: FcqRunStatus | undefined, summary: FcqSummary | null): string {
  if (!status) return "";
  const head = ["## Static Analysis (fcq)", ""];
  if (status.status === "failed" || !summary) {
    return [
      ...head,
      `- Status: **FAILED** — ${status.reason ?? "no result"}`,
      `- Command: \`${status.command}\``,
      "",
    ].join("\n");
  }
  const s = summary.summary;
  const analyzers = summary.metadata.analyzers
    .map((a) => `${a.name} ${a.status}${a.durationMillis != null ? ` (${(a.durationMillis / 1000).toFixed(1)}s)` : ""}`)
    .join(", ");
  const build = summary.metadata.build ? `- Build: ${summary.metadata.build.status}` : null;
  const table = summary.categories.filter((c) => c.violationCount > 0);
  return [
    ...head,
    `- Rules: ${s.totalRules} (pass ${s.passed} / fail ${s.failed} / not run ${s.notRun})` +
      (s.passRate != null ? ` · pass rate ${s.passRate}%` : ""),
    `- Violations in reviewed files: ${summary.targetViolations}` +
      (summary.outsideTargetViolations ? ` (+${summary.outsideTargetViolations} outside the target set, omitted)` : ""),
    `- Max severity: ${s.maxSeverity ?? "-"}`,
    ...(build ? [build] : []),
    `- Analyzers: ${analyzers || "-"}`,
    `- Command: \`${status.command}\` (${(status.durationMs / 1000).toFixed(1)}s)`,
    ...(table.length
      ? [
          "",
          "| category | rules | failed | violations | max severity |",
          "| --- | --- | --- | --- | --- |",
          ...table.map(
            (c) => `| ${c.category} | ${c.ruleCount} | ${c.failed} | ${c.violationCount} | ${c.maxSeverity ?? "-"} |`
          ),
        ]
      : []),
    "",
    "", // blank line so the following "## Review Context" heading is not glued to the table
  ].join("\n");
}
