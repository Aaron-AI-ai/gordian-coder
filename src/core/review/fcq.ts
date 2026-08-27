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
 * fcq has no report-path flag: report.json lands where the TARGET's fcq.yaml
 * `report.output` says (default fcq/report/static). ponytail: locate it by
 * parsing that yaml — swap `locateReport` for a `--report-dir` arg once fcq
 * grows one.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { type Category, type Finding, type Severity } from "./contract";
import { loadConfig } from "./context";
import { targetRange } from "./segment";

/** Default wall-clock cap for the fcq process (build + analysis), seconds. */
export const FCQ_DEFAULT_TIMEOUT_S = 900;
/** Violations rendered per file in the reviewer prompt (rest is counted). */
export const FCQ_EVIDENCE_MAX_ITEMS = 40;
export const FCQ_EVIDENCE_MAX_CHARS = 6_000;
/** Cap on the `code.lines` snippet turned into an AS-IS suggestion. */
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

/** Where fcq will write report.json, from the target's fcq.yaml `report`
 * section (same auto-discovery order as fcq itself). Returns an error string
 * when reports are not enabled — fcq gives us nothing structured otherwise. */
export function locateReport(cwd: string, configOpt?: string): { path: string } | { error: string } {
  const candidates = configOpt
    ? [abs(cwd, configOpt)]
    : ["fcq/config/fcq.yaml", "fcq.yaml", ".fcq/config.yaml"].map((p) => join(cwd, p));
  const yamlPath = candidates.find((p) => existsSync(p));
  if (!yamlPath) {
    return { error: "no fcq.yaml found (fcq/config/fcq.yaml) — a `report:` section is required for report.json" };
  }
  let report: unknown;
  try {
    const doc = Bun.YAML.parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown> | null;
    report = doc?.report;
  } catch (err) {
    return { error: `cannot parse ${yamlPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!report || typeof report !== "object") {
    return { error: `${yamlPath} has no \`report:\` section — enable it so fcq writes report.json` };
  }
  const r = report as { enabled?: unknown; output?: unknown };
  if (r.enabled === false) return { error: `${yamlPath} has report.enabled: false` };
  const out = typeof r.output === "string" && r.output ? r.output : "fcq/report/static";
  return { path: join(abs(cwd, out), "report.json") };
}

// ── run ──────────────────────────────────────────────────────────

export function fcqCommand(cwd: string, targets: string[], o: FcqOptions): string[] {
  const cmd = [o.bin ?? "fcq", "analyze", cwd, `--paths=${targets.join(",")}`];
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
  const cmd = fcqCommand(cwd, targets, o);
  const command = cmd.join(" ");
  const started = Date.now();
  const fail = (reason: string): FcqRunStatus => ({
    status: "failed",
    command,
    durationMs: Date.now() - started,
    reason,
  });

  const located = locateReport(cwd, o.config);
  if ("error" in located) return fail(located.error);

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
  if (!existsSync(located.path)) return fail(`fcq exited ${exitCode} but wrote no ${located.path}`);

  let report: FcqReport;
  try {
    const parsed = FcqReportSchema.safeParse(JSON.parse(readFileSync(located.path, "utf8")));
    if (!parsed.success) return fail(`report.json schema mismatch: ${parsed.error.issues[0]?.message}`);
    report = parsed.data;
  } catch (err) {
    return fail(`cannot read report.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A stale report from a previous run (fcq rotated nothing because it crashed
  // before reporting) must not be mistaken for this run's result.
  const ranAt = report.metadata.ranAt ? Date.parse(report.metadata.ranAt) : NaN;
  if (Number.isFinite(ranAt) && ranAt < started - 60_000) {
    return fail(`report.json is stale (ranAt ${report.metadata.ranAt} predates this run)`);
  }
  await shardReport(report, targets, runRoot);
  return {
    status: "ok",
    command,
    durationMs: Date.now() - started,
    reportPath: located.path,
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
export function renderFcqEvidence(violations: FcqFileViolation[]): string {
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
  const body = [
    "## Static analysis (fcq, already run for you)",
    ...lines,
    ...(rest > 0 ? [`… ${rest} more lower-severity violation(s) — already in the report.`] : []),
    "",
    "These are deterministic and already in the report — do NOT re-report them.",
    "Use them as leads: for CRITICAL/MAJOR hits, trace the actual data flow and",
    "give an AS-IS/TO-BE fix or state why it is a false positive (reference the",
    "rule id). Spend your budget on what the tools cannot see: logic, boundaries,",
    "transactions, framework-rule violations.",
  ].join("\n");
  return body.length > FCQ_EVIDENCE_MAX_CHARS
    ? `${body.slice(0, FCQ_EVIDENCE_MAX_CHARS)}\n… (truncated)`
    : body;
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

/** Findings for the report: one per violation, rule tagged `fcq:`. */
export function fcqFindings(file: string, violations: FcqFileViolation[]): Finding[] {
  return violations.map((v) => ({
    category: mapFcqCategory(v.category),
    severity: SEVERITY_MAP[v.severity],
    file,
    ...(v.line ? { line: v.line } : {}),
    rule: `fcq:${v.analyzer}/${v.ruleId}`,
    message: v.description && v.message !== v.description ? `${v.description} — ${v.message}` : v.message || v.description,
    ...(v.snippet?.length
      ? { suggestion: `AS-IS:\n\`\`\`\n${v.snippet.join("\n")}\n\`\`\`\nTO-BE: (apply ${v.ruleId})` }
      : {}),
  }));
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
