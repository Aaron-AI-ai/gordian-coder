/**
 * Output location resolution + report rendering/writing.
 *
 * Path precedence: --output param > .k-codereview.json "output" > ./k-codereview/
 * A directory target gets an auto-named `review-<label>.md`; a file target is
 * used as-is.
 */

import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { loadConfig } from "./context";
import { verdict, type Finding, type Severity } from "./contract";

function isDirSync(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** Filesystem-safe label used when no commit sha is available. */
export function defaultLabel(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export function resolveOutputPath(
  opt: string | undefined,
  label: string,
  cwd: string = process.cwd()
): string {
  const p = opt ?? loadConfig(cwd).output ?? "k-codereview/";
  const full = isAbsolute(p) ? p : join(cwd, p);
  const looksDir = p.endsWith("/") || isDirSync(full);
  return looksDir ? join(p, `review-${label}.md`) : p;
}

function counts(all: Finding[]): string {
  const by = (s: string) => all.filter((f) => f.severity === s).length;
  return `blocker ${by("blocker")}, major ${by("major")}, minor ${by("minor")}, nit ${by("nit")}`;
}

interface ReportLabels {
  title: string;
  findings: (n: number) => string;
  noIssues: string;
  header: string;
}

const LABELS: Record<string, ReportLabels> = {
  ko: {
    title: "# 코드 리뷰 리포트",
    findings: (n) => `**${n}건 발견**`,
    noIssues: "_이슈 없음._",
    header: "| 심각도 | 분류 | 라인 | 규칙 | 내용 | 제안 |",
  },
  en: {
    title: "# Code Review Report",
    findings: (n) => `**${n} finding(s)**`,
    noIssues: "_No issues._",
    header: "| severity | category | line | rule | message | suggestion |",
  },
};

/** Escape a value for a markdown table cell: pipes and newlines. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function renderReport(
  findings: Record<string, Finding[]>,
  label: string = "",
  language: string = "en",
  failOn?: Severity
): string {
  const L = LABELS[language] ?? LABELS.en;
  const files = Object.keys(findings).sort();
  const all = files.flatMap((f) => findings[f]);
  const lines: string[] = [L.title, ""];
  if (label) lines.push(`> ${label}`, "");
  lines.push(`${L.findings(all.length)} — ${counts(all)}`, "");
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
      lines.push(
        `| ${x.severity} | ${x.category} | ${x.line ?? "-"} | ${cell(x.rule)} | ${cell(x.message)} | ${x.suggestion ? cell(x.suggestion) : "-"} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Write the report; Bun.write creates parent directories. Returns the path. */
export async function writeReport(
  path: string,
  findings: Record<string, Finding[]>,
  label: string = "",
  cwd: string = process.cwd(),
  language: string = "en",
  failOn?: Severity
): Promise<string> {
  await Bun.write(
    isAbsolute(path) ? path : join(cwd, path),
    renderReport(findings, label, language, failOn)
  );
  return path;
}

export interface ManifestMeta {
  mode: string;
  range: string | null;
  excludes: string[];
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
    `- Mode: ${meta.mode}`,
    `- Range: ${meta.range ?? "— (working tree)"}`,
    `- Excludes: ${meta.excludes.length ? meta.excludes.join(", ") : "none"}`,
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
