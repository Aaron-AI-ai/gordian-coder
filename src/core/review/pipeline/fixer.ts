/**
 * The fcq fix pass: a subagent whose only job is turning static-analysis
 * violations into corrected code.
 *
 * It exists because asking the reviewer to do it did not work. With `fcqFix`
 * on, a reviewer handed 19 violations — 24 of 28 of them MINOR style rules —
 * spent its whole submission writing AS-IS/TO-BE pairs for them and reported
 * nothing else. The same file reviewed without that list had produced a real
 * null-dereference blocker. The budget was never the constraint (1 of 20 tool
 * calls used); a concrete checklist next to an abstract "also look for real
 * bugs" simply wins.
 *
 *   f_review_fix_context(runId, file) → the file plus every violation in it
 *   f_review_fix_submit(fixes)        → corrected code per violation
 *
 * Fixes land in `<runDir>/fixes/<slug>.json` and finalize merges them onto the
 * matching fcq rows, so MINOR hits still ship with real code — the reviewer
 * just no longer writes it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { capped } from "../contract";
import { loadRun, reviewSlug, runDir } from "./artifact";
import { FCQ_SEVERITIES, readFcqFile, type FcqFileViolation } from "../evidence/fcq";
import { fileRead } from "../tools/read";

/** Violations shown per request. Beyond this the file is a lint failure, not a
 * review target, and a fixer session cannot hold them all anyway. */
export const FIX_MAX_ITEMS = 60;
/** Lines of source handed to the fixer. It has no read tools — this context is
 * the only code it will ever see — so the cap is generous and a file past it is
 * called out rather than silently cut. */
export const FIX_FILE_MAX_LINES = 2000;

export const FixSchema = z.object({
  line: z.number().int().nonnegative(),
  ruleId: capped(200),
  asIs: capped(3000).optional(),
  toBe: capped(4000).optional(),
  /** Set when the violation is wrong and no code change applies. */
  falsePositive: z.boolean().optional(),
  note: capped(500).optional(),
});
export type Fix = z.infer<typeof FixSchema>;

export const FixSubmitSchema = z.object({
  runId: z.string(),
  file: z.string(),
  fixes: z.array(FixSchema).transform((a) => a.slice(0, FIX_MAX_ITEMS)),
});
export type FixSubmitPayload = z.infer<typeof FixSubmitSchema>;

export const FileFixesSchema = z.object({
  file: z.string(),
  fixes: z.array(FixSchema).default([]),
});
export type FileFixes = z.infer<typeof FileFixesSchema>;

export function fixesPath(runId: string, file: string, cwd: string): string {
  return join(runDir(runId, cwd), "fixes", `${reviewSlug(file)}.json`);
}

/** Recorded fixes for one file (empty when the pass never ran or is corrupt). */
export function loadFixes(runId: string, file: string, cwd: string): FileFixes {
  const p = fixesPath(runId, file, cwd);
  if (existsSync(p)) {
    try {
      const parsed = FileFixesSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (parsed.success && parsed.data.file === file) return parsed.data;
    } catch {
      /* unreadable/corrupt — treat as not run */
    }
  }
  return { file, fixes: [] };
}

/** Everything the fixer subagent needs: the source, and every violation in it. */
export function fixContext(runId: string, file: string, cwd: string): string {
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  if (meta.fcq?.status !== "ok") {
    return `No static-analysis result for run ${runId} — nothing to fix. Skip this file.`;
  }
  const rows = readFcqFile(runDir(runId, cwd), file);
  if (!rows.length) return `✅ ${file} has no fcq violations. Nothing to fix; do not submit.`;

  const shown = rows.slice(0, FIX_MAX_ITEMS);
  // Working tree, not the ref: the fix is written against the code as it is now.
  const source = fileRead(cwd, null, file, 1, FIX_FILE_MAX_LINES);
  const truncated = source.includes("IS_TRUNCATED: true");
  return [
    `# Fix pass — ${file} (run ${runId})`,
    "",
    `${rows.length} static-analysis violation(s)${rows.length > shown.length ? `, first ${shown.length} shown` : ""}.`,
    "Write the corrected code for EVERY one, whatever its severity: a MINOR",
    "style rule ships with only the rule text unless you replace it. Where a",
    "violation is genuinely wrong, mark it `falsePositive` with a one-line note",
    "instead of inventing a change.",
    "",
    "## Violations",
    ...shown.map(
      (v) =>
        `- L${v.line ?? 0} [${v.severity}] ${v.analyzer}/${v.ruleId} — ${v.description}` +
        (v.message ? ` (${v.message})` : "") +
        (v.snippet?.length ? `\n  code:\n${v.snippet.map((l) => `    ${l}`).join("\n")}` : "")
    ),
    "",
    "## Source",
    truncated
      ? `⚠️ Only the first ${FIX_FILE_MAX_LINES} lines are shown and you have no read tools. Enter fixes ONLY for violations you can see here; leave the rest out.`
      : "This is the complete file. You have no read tools — everything you need is here.",
    source,
    "",
    "## Submit",
    "Call `f_review_fix_submit` with runId, file, and one entry per violation:",
    "`line` and `ruleId` exactly as listed above (they anchor the merge), then",
    "`asIs` (the code as it stands) and `toBe` (the corrected code) — code only,",
    "no AS-IS:/TO-BE: labels. Do NOT report new issues here; that is the",
    "reviewer's job and duplicates are dropped.",
  ].join("\n");
}

/** Persist one file's fixes. Overwrites — a retry is idempotent. */
export async function submitFix(payload: unknown, cwd: string): Promise<string> {
  const parsed = FixSubmitSchema.safeParse(payload);
  if (!parsed.success) return `Invalid fix submission: ${parsed.error.message}`;
  const { runId, file, fixes } = parsed.data;
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}.`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}.`;
  }
  const violations = readFcqFile(runDir(runId, cwd), file);
  const body: FileFixes = { file, fixes };
  await Bun.write(fixesPath(runId, file, cwd), JSON.stringify(body, null, 2));

  const withCode = fixes.filter((f) => f.toBe?.trim()).length;
  const fp = fixes.filter((f) => f.falsePositive).length;
  const missing = violations.length - fixes.length;
  return [
    `✅ ${file}: ${fixes.length} fix(es) recorded (${withCode} with code, ${fp} false positive(s)).`,
    missing > 0
      ? `⚠️ ${missing} violation(s) received no entry — they ship with the rule text only.`
      : "",
    "This subagent's task is COMPLETE.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Apply recorded fixes to the fcq findings of one file.
 *
 * Anchored on line + rule id, the same pair the fixer was given. A false
 * positive keeps the row (the violation is real to fcq) but replaces the fix
 * with the reason, so the report never silently drops a hit.
 */
export function applyFixes<T extends { line?: number; rule: string; asIs?: string; toBe?: string }>(
  findings: T[],
  fixes: Fix[]
): T[] {
  if (!fixes.length) return findings;
  const key = (line: number | undefined, rule: string) =>
    `${line ?? 0}${rule.slice(rule.lastIndexOf("/") + 1).toLowerCase()}`;
  const byKey = new Map(fixes.map((f) => [key(f.line, f.ruleId), f]));
  return findings.map((f) => {
    const fix = byKey.get(key(f.line, f.rule));
    if (!fix) return f;
    if (fix.falsePositive) {
      return { ...f, toBe: `(false positive) ${fix.note ?? "no change required"}` };
    }
    return {
      ...f,
      ...(fix.asIs?.trim() ? { asIs: fix.asIs } : {}),
      ...(fix.toBe?.trim() ? { toBe: fix.toBe } : {}),
    };
  });
}

/** Per-file fix coverage for the finalize summary. */
export function fixCoverage(
  runId: string,
  files: string[],
  cwd: string
): { file: string; violations: number; fixed: number }[] {
  return files.map((file) => ({
    file,
    violations: readFcqFile(runDir(runId, cwd), file).length,
    fixed: loadFixes(runId, file, cwd).fixes.filter((f) => f.toBe?.trim() || f.falsePositive).length,
  }));
}

/** Severities the fix pass is expected to cover — every one fcq reports. */
export const FIX_SEVERITIES = FCQ_SEVERITIES;
export type { FcqFileViolation };
