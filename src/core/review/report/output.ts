/**
 * Output location resolution + report rendering/writing.
 *
 * Reports and manifests live in separate trees:
 *   report   → --output param > .f-review.json "output" > fcq/report/f-review/
 *   manifest → fcq/f-review/manifest/ (fixed)
 * A directory report target gets an auto-named
 * `review-<label>-<yyyymmdd-hhmmss>.md` — unique per run/session; a file
 * target is used as-is (and is overwritten). Writing into a dedicated
 * `f-review` folder first archives the existing folder to
 * `f-review.<yyyymmdd-hhmmss>`, so `f-review/` holds only the fresh report.
 */

import { existsSync, statSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, isAbsolute, dirname, basename } from "node:path";
import { loadConfig } from "../config";
import { SEVERITIES, splitFix, verdict, type Finding, type Severity } from "../contract";
import { renderHtmlReport } from "./html";

const DEFAULT_REPORT_DIR = "fcq/report/f-review/";
const DEFAULT_MANIFEST_DIR = "fcq/f-review/manifest/";

function isDirSync(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** yyyymmdd-hhmmss (UTC), for report filenames. */
function stamp(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 19).replace(/:/g, "")}`;
}

/** Human-readable UTC timestamp recorded in the manifest body. */
export function manifestTimestamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Filesystem-safe label used when no commit sha is available. */
export function defaultLabel(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export function resolveOutputPath(
  opt: string | undefined,
  label: string,
  cwd: string = process.cwd(),
  date: Date = new Date()
): string {
  const p = opt ?? loadConfig(cwd).output ?? DEFAULT_REPORT_DIR;
  const full = isAbsolute(p) ? p : join(cwd, p);
  const looksDir = p.endsWith("/") || isDirSync(full);
  // Second-resolution stamp: each run/session writes its own report file
  // instead of overwriting the previous one of the same commit + day.
  return looksDir ? join(p, `review-${label}-${stamp(date)}.md`) : p;
}

/** Manifest path — its own fixed tree, independent of the report location. */
export function resolveManifestPath(label: string): string {
  return join(DEFAULT_MANIFEST_DIR, `review-${label}-targets.md`);
}

function counts(all: Finding[]): string {
  const by = (s: string) => all.filter((f) => f.severity === s).length;
  return `blocker ${by("blocker")}, major ${by("major")}, minor ${by("minor")}, nit ${by("nit")}`;
}

/** Per-category tallies for the summary, skipping empty categories. */
function categoryCounts(all: Finding[]): string {
  const by = new Map<string, number>();
  for (const f of all) by.set(f.category, (by.get(f.category) ?? 0) + 1);
  return [...by].map(([c, n]) => `${c} ${n}`).join(", ");
}

interface ReportLabels {
  title: string;
  findings: (n: number) => string;
  noIssues: string;
  header: string;
  existing: string; // marker for findings already present in the baseline report
  seeBelow: string; // table cell standing in for a multi-line suggestion
  detailsTitle: string; // heading of the section holding those suggestions
  asIs: string; // label above the offending code
  toBe: string; // label above the corrected code
}

const LABELS: Record<string, ReportLabels> = {
  ko: {
    title: "# 코드 리뷰 리포트",
    findings: (n) => `**${n}건 발견**`,
    noIssues: "_이슈 없음._",
    header: "| 심각도 | 분류 | 라인 | 규칙 | 내용 | 제안 |",
    existing: "기존",
    seeBelow: "↓ 아래 참조",
    detailsTitle: "제안 상세",
    asIs: "현재 코드 (AS-IS)",
    toBe: "수정 코드 (TO-BE)",
  },
  en: {
    title: "# Code Review Report",
    findings: (n) => `**${n} finding(s)**`,
    noIssues: "_No issues._",
    header: "| severity | category | line | rule | message | suggestion |",
    existing: "existing",
    seeBelow: "↓ see below",
    detailsTitle: "Suggestions",
    asIs: "AS-IS",
    toBe: "TO-BE",
  },
  ja: {
    title: "# コードレビューレポート",
    findings: (n) => `**${n}件検出**`,
    noIssues: "_問題なし。_",
    header: "| 深刻度 | 分類 | 行 | ルール | 内容 | 提案 |",
    existing: "既存",
    seeBelow: "↓ 下記参照",
    detailsTitle: "提案の詳細",
    asIs: "現状 (AS-IS)",
    toBe: "修正後 (TO-BE)",
  },
};

/** Escape a value for a markdown table cell: pipes and newlines. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** A fix carrying real code (or any multi-line text) cannot live in a table
 * cell: markdown has no cell newline, so cell() flattens it into a wall of
 * `<br>` that is unreadable and unpastable. Those move under the table as
 * their own block; single-line fixes stay inline where they read fine. */
function isBlockSuggestion(s: string | undefined): s is string {
  return !!s && /\r?\n/.test(s);
}

/** Fence a code block, unless the model already fenced it. Models emit both
 * shapes, and a double fence renders the backticks as literal text. */
function fenced(code: string, lang: string): string {
  const t = code.trim();
  return /^```/.test(t) ? t : `\`\`\`${lang}\n${t}\n\`\`\``;
}

/** Language tag for the fence, from the reviewed file's extension. */
function fenceLang(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return { java: "java", ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python",
    kt: "kotlin", go: "go", rb: "ruby", cs: "csharp", sql: "sql", xml: "xml",
    yml: "yaml", yaml: "yaml", json: "json" }[ext] ?? "";
}

/** AS-IS and TO-BE as separate labelled blocks.
 *
 * They used to be one string in one box: unreadable, and the corrected code
 * was the half that got cut when the shared budget ran out. Each is now its
 * own fenced block, so the fix can be read and pasted on its own. */
function fixBlocks(f: Finding, L: ReportLabels): string[] {
  const { asIs, toBe } = splitFix(f);
  const lang = fenceLang(f.file);
  const out: string[] = [];
  if (asIs) out.push(`**${L.asIs}**`, "", fenced(asIs, lang), "");
  if (toBe) out.push(`**${L.toBe}**`, "", fenced(toBe, lang), "");
  return out;
}

// ── baseline (previous-report) support ───────────────────────────

/** Key identifying a finding across reviews: report file heading + rule.
 * `rule` goes through cell() so keys built from raw findings match keys
 * parsed back out of a rendered report. */
export function baselineKey(file: string, rule: string): string {
  return `${file}\u001f${cell(rule).trim()}`;
}

/** Parse (file, rule) keys out of a rendered report's tables. */
export function parseReportKeys(md: string): Set<string> {
  const keys = new Set<string>();
  let file = "";
  let inFence = false;
  for (const line of md.split("\n")) {
    // Suggestion blocks hold model-written code. A fenced line starting with
    // "## " or "|" is source, not report structure — parsing it would file the
    // next findings under a bogus heading and poison the next run's baseline.
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^## (.+)$/.exec(line);
    if (h) {
      file = h[1].trim();
      continue;
    }
    if (!file || !line.startsWith("|")) continue;
    const parts = line.split(/(?<!\\)\|/); // split on unescaped pipes only
    // Data rows start with a severity value — this skips header/separator rows.
    if (!(SEVERITIES as readonly string[]).includes(parts[1]?.trim() ?? "")) continue;
    const rule = parts[4]?.trim();
    if (rule) keys.add(`${file}\u001f${rule}`);
  }
  return keys;
}

/**
 * Load the baseline: finding keys from the most recent prior report at the
 * output location (same resolution as resolveOutputPath). Missing dir/file →
 * empty set. Target manifests (`*-targets.md`) are ignored.
 */
export function loadBaseline(
  opt: string | undefined,
  cwd: string = process.cwd()
): Set<string> {
  const p = opt ?? loadConfig(cwd).output ?? DEFAULT_REPORT_DIR;
  const full = isAbsolute(p) ? p : join(cwd, p);
  let report: string | null = null;
  if (isDirSync(full)) {
    const latest = readdirSync(full)
      .filter((f) => /^review-.*\.md$/.test(f) && !f.endsWith("-targets.md"))
      .map((f) => join(full, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    report = latest ?? null;
  } else if (!p.endsWith("/") && existsSync(full)) {
    report = full;
  }
  if (!report) return new Set();
  try {
    return parseReportKeys(readFileSync(report, "utf8"));
  } catch {
    return new Set();
  }
}

export function renderReport(
  findings: Record<string, Finding[]>,
  label: string = "",
  language: string = "en",
  failOn?: Severity,
  baseline?: Set<string>
): string {
  const L = LABELS[language] ?? LABELS.en;
  const files = Object.keys(findings).sort();
  const all = files.flatMap((f) => findings[f]);
  const lines: string[] = [L.title, ""];
  if (label) lines.push(`> ${label}`, "");
  lines.push(`${L.findings(all.length)} — ${counts(all)}`, "");
  if (all.length) lines.push(categoryCounts(all), "");
  if (failOn) {
    const v = verdict(all, failOn);
    lines.push(
      v.pass
        ? `**Verdict: PASS** — no findings at or above \`${failOn}\``
        : `**Verdict: FAIL** — ${v.failing} finding(s) at or above \`${failOn}\``,
      ""
    );
  }

  for (const file of files) {
    lines.push(`## ${file}`, "");
    const fs = findings[file];
    if (!fs.length) {
      lines.push(L.noIssues, "");
      continue;
    }
    lines.push(L.header);
    lines.push("| --- | --- | --- | --- | --- | --- |");
    const blocks: Finding[] = [];
    for (const x of fs) {
      const old = baseline?.has(baselineKey(file, x.rule)) ? `**[${L.existing}]** ` : "";
      const fix = splitFix(x);
      // An AS-IS always means there is code to show, so those go below too.
      const inline = !fix.asIs && fix.toBe && !isBlockSuggestion(fix.toBe) ? fix.toBe : undefined;
      if (!inline && (fix.asIs || fix.toBe)) blocks.push(x);
      const suggestion = inline ? cell(inline) : fix.asIs || fix.toBe ? L.seeBelow : "-";
      lines.push(
        `| ${x.severity} | ${x.category} | ${x.line ?? "-"} | ${cell(x.rule)} | ${old}${cell(x.message)} | ${suggestion} |`
      );
    }
    lines.push("");
    // Kept verbatim inside the fences: the point of moving them here is that
    // they stay pastable.
    if (blocks.length) {
      lines.push(`### ${L.detailsTitle}`, "");
      for (const x of blocks) {
        lines.push(`#### ${x.rule}${x.line ? ` (L${x.line})` : ""}`, "", ...fixBlocks(x, L));
      }
    }
  }
  return lines.join("\n");
}

/** Swap a report path's extension for `.html`. A target without `.md` (an
 * explicit `--output report.txt`) gets the suffix appended, so the html file
 * can never collide with the markdown one it accompanies. */
export function htmlReportPath(path: string): string {
  return path.endsWith(".md") ? `${path.slice(0, -3)}.html` : `${path}.html`;
}

/** Write the report; Bun.write creates parent directories. Returns the
 * markdown path — the machine-readable artifact loadBaseline reads back.
 * An HTML view of the same data is written beside it (see html.ts).
 * `appendix` (optional) is extra markdown appended after the body — used by
 * parallel runs to attach their coverage/quality summary. */
export async function writeReport(
  path: string,
  findings: Record<string, Finding[]>,
  label: string = "",
  cwd: string = process.cwd(),
  language: string = "en",
  failOn?: Severity,
  baseline?: Set<string>,
  now: Date = new Date(),
  appendix?: string
): Promise<string> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  backupReportDir(dirname(abs), now);
  const body = renderReport(findings, label, language, failOn, baseline);
  await Bun.write(abs, appendix ? `${body}\n${appendix}` : body);
  await Bun.write(
    htmlReportPath(abs),
    renderHtmlReport(findings, label, language, failOn, baseline, now, appendix, baselineKey)
  );
  return path;
}

/**
 * Archive an existing dedicated report folder before writing a fresh report:
 * `.../f-review` → `.../f-review.<yyyymmdd-hhmmss>`, leaving `f-review/` with
 * only the newly written report. Gated on the folder name so an arbitrary
 * `--output` directory is never renamed.
 */
function backupReportDir(dir: string, now: Date): void {
  if (basename(dir) === "f-review" && isDirSync(dir)) {
    // Two writes in the same second (e.g. a finalize retry) would collide on
    // the stamped name — pick the first free suffix instead of crashing.
    let dest = `${dir}.${stamp(now)}`;
    for (let n = 2; existsSync(dest); n++) dest = `${dir}.${stamp(now)}-${n}`;
    renameSync(dir, dest);
  }
}

export interface ManifestMeta {
  mode: string;
  range: string | null;
  excludes: string[];
  rubricSources?: Record<string, string>; // category → rule file | "built-in defaults"
  generatedAt?: string; // UTC timestamp recorded in the body (filename stays date-free)
}

/** The parameter/criteria bullet list shared by the manifest and the report's
 * Review Context appendix. `filesHeading` differs because the manifest is an
 * H1 document while the appendix nests under the report. */
function contextLines(targets: string[], meta: ManifestMeta, filesHeading: string): string[] {
  return [
    ...(meta.generatedAt ? [`- Generated: ${meta.generatedAt}`] : []),
    `- Mode: ${meta.mode}`,
    `- Range: ${meta.range ?? "— (working tree)"}`,
    `- Excludes: ${meta.excludes.length ? meta.excludes.join(", ") : "none"}`,
    ...(meta.rubricSources
      ? [
          `- Rubric: ${Object.entries(meta.rubricSources)
            .map(([c, s]) => `${c} ← ${s}`)
            .join(", ")}`,
        ]
      : []),
    `- Total: ${targets.length} file(s)`,
    "",
    filesHeading,
    ...targets.map((t) => `- ${t}`),
    "",
  ];
}

/** Render the collected target list (written at review start). */
export function renderManifest(
  targets: string[],
  meta: ManifestMeta,
  label: string = ""
): string {
  const lines = ["# Code Review Targets", ""];
  if (label) lines.push(`> ${label}`, "");
  lines.push(...contextLines(targets, meta, "## Files"));
  return lines.join("\n");
}

/** "## Review Context" report appendix: the run's input parameters and
 * criteria sources (same data as the manifest), so the report alone tells the
 * reader what was reviewed and against which rules. */
export function renderReviewContext(targets: string[], meta: ManifestMeta): string {
  return ["## Review Context", "", ...contextLines(targets, meta, "### Files")].join("\n");
}

/** Write the target manifest; returns the path. */
export async function writeManifest(
  path: string,
  targets: string[],
  meta: ManifestMeta,
  label: string = "",
  cwd: string = process.cwd()
): Promise<string> {
  await Bun.write(isAbsolute(path) ? path : join(cwd, path), renderManifest(targets, meta, label));
  return path;
}
