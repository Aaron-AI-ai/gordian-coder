/**
 * Output location resolution + report rendering/writing.
 *
 * Reports and manifests live in separate trees:
 *   report   → --output param > .f-review.json "output" > fcq/report/f-review/
 *   manifest → fcq/f-review/manifest/ (fixed)
 * A directory report target gets an auto-named `review-<label>-<yyyymmdd>.md`;
 * a file target is used as-is. Writing a report archives any existing
 * `f-review` report folder to `f-review.<yyyymmdd-hhmmss>` first.
 */

import { existsSync, statSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, isAbsolute, dirname, basename } from "node:path";
import { loadConfig } from "./context";
import { SEVERITIES, verdict, type Finding, type Severity } from "./contract";

const DEFAULT_REPORT_DIR = "fcq/report/f-review/";
const DEFAULT_MANIFEST_DIR = "fcq/f-review/manifest/";

function isDirSync(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** yyyymmdd, for report filenames. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** yyyymmdd-hhmmss (UTC), for backup-dir suffixes. */
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
  return looksDir ? join(p, `review-${label}-${ymd(date)}.md`) : p;
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
}

const LABELS: Record<string, ReportLabels> = {
  ko: {
    title: "# 코드 리뷰 리포트",
    findings: (n) => `**${n}건 발견**`,
    noIssues: "_이슈 없음._",
    header: "| 심각도 | 분류 | 라인 | 규칙 | 내용 | 제안 |",
    existing: "기존",
  },
  en: {
    title: "# Code Review Report",
    findings: (n) => `**${n} finding(s)**`,
    noIssues: "_No issues._",
    header: "| severity | category | line | rule | message | suggestion |",
    existing: "existing",
  },
  ja: {
    title: "# コードレビューレポート",
    findings: (n) => `**${n}件検出**`,
    noIssues: "_問題なし。_",
    header: "| 深刻度 | 分類 | 行 | ルール | 内容 | 提案 |",
    existing: "既存",
  },
};

/** Escape a value for a markdown table cell: pipes and newlines. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
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
  for (const line of md.split("\n")) {
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
    for (const x of fs) {
      const old = baseline?.has(baselineKey(file, x.rule)) ? `**[${L.existing}]** ` : "";
      lines.push(
        `| ${x.severity} | ${x.category} | ${x.line ?? "-"} | ${cell(x.rule)} | ${old}${cell(x.message)} | ${x.suggestion ? cell(x.suggestion) : "-"} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Write the report; Bun.write creates parent directories. Returns the path.
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
  return path;
}

/**
 * Archive an existing dedicated report folder before writing a fresh report:
 * `.../f-review` → `.../f-review.<yyyymmdd-hhmmss>`. Gated on the
 * folder name so an arbitrary `--output` directory is never renamed.
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

/** Render the collected target list (written at review start). */
export function renderManifest(
  targets: string[],
  meta: ManifestMeta,
  label: string = ""
): string {
  const lines = ["# Code Review Targets", ""];
  if (label) lines.push(`> ${label}`, "");
  lines.push(
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
    "## Files",
    ...targets.map((t) => `- ${t}`),
    ""
  );
  return lines.join("\n");
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
