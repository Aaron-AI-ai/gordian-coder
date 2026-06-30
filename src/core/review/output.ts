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
import type { Finding } from "./contract";

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

export function renderReport(
  findings: Record<string, Finding[]>,
  label: string = ""
): string {
  const files = Object.keys(findings).sort();
  const all = files.flatMap((f) => findings[f]);
  const lines: string[] = ["# Code Review Report", ""];
  if (label) lines.push(`> ${label}`, "");
  lines.push(`**${all.length} finding(s)** — ${counts(all)}`, "");

  for (const file of files) {
    lines.push(`## ${file}`, "");
    const fs = findings[file];
    if (!fs.length) {
      lines.push("_No issues._", "");
      continue;
    }
    lines.push("| severity | category | line | rule | message |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const x of fs) {
      lines.push(
        `| ${x.severity} | ${x.category} | ${x.line ?? "-"} | ${x.rule} | ${x.message.replace(/\|/g, "\\|")} |`
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
  cwd: string = process.cwd()
): Promise<string> {
  await Bun.write(isAbsolute(path) ? path : join(cwd, path), renderReport(findings, label));
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
