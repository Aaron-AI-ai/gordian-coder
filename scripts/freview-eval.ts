#!/usr/bin/env bun
/**
 * f-review 평가 러너 + 채점기 (f-log의 flog-eval.ts와 자매).
 *
 *   bun scripts/freview-eval.ts <target-dir> --mode whole|diff [--model <id>] [--case <id>[,<id-or-glob>...]] [--no-run]
 *
 * <target-dir>/f-review-cases/*.yaml을 읽어 각 케이스를 f-review로 리뷰하고,
 * 마크다운 리포트의 `## <파일>` 섹션 아래 finding 표를 파싱해 정답과 대조한다.
 * 버그 케이스 미검출 또는 대조군 오탐이 하나라도 있으면 exit 1.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
const LINE_TOLERANCE = 3;

export interface BugCase {
  id: string;
  kind: "bug";
  file: string;
  category: string;
  min_severity: string;
  line_range: [number, number];
  keywords_any: string[];
  kb_ref?: string;
  commit: string;
}
export interface ControlCase {
  id: string;
  kind: "control";
  file: string;
  expect_clean: true;
  commit: string;
}
export type EvalCase = BugCase | ControlCase;

export interface FindingRow {
  severity: string;
  category: string;
  line: number | null;
  rule: string;
  message: string;
  suggestion: string;
}

// selector: 콤마로 구분한 케이스 ID 목록, 각 항목은 정확한 ID이거나 `*` 와일드카드를 쓸 수 있다.
export function matchesCaseSelector(id: string, selector?: string): boolean {
  if (!selector || !selector.trim()) return true;
  return selector.split(",").map((p) => p.trim()).filter(Boolean).some((pattern) => {
    if (!pattern.includes("*")) return id === pattern;
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(id);
  });
}

async function loadCases(target: string, selector?: string): Promise<EvalCase[]> {
  const dir = join(target, "f-review-cases");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    const id = f.replace(/\.yaml$/, "");
    if (!matchesCaseSelector(id, selector)) continue;
    const y = Bun.YAML.parse(await Bun.file(join(dir, f)).text()) as Record<string, unknown>;
    if (y.expect_clean) {
      cases.push({ id, kind: "control", file: y.file as string, expect_clean: true, commit: y.commit as string });
    } else {
      cases.push({
        id, kind: "bug",
        file: y.file as string,
        category: y.category as string,
        min_severity: y.min_severity as string,
        line_range: y.line_range as [number, number],
        keywords_any: (y.keywords_any ?? []) as string[],
        kb_ref: y.kb_ref as string | undefined,
        commit: y.commit as string,
      });
    }
  }
  return cases;
}

/** 리포트 마크다운에서 `## <file>` 섹션의 finding 표를 파싱한다. 섹션이 없으면 빈 배열(클린). */
export function parseFileFindings(md: string, file: string): FindingRow[] {
  const sections = md.split(/^## /m).slice(1);
  const section = sections.find((s) => s.split("\n")[0].trim() === file);
  if (!section) return [];
  const rows: FindingRow[] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|[-\s|]+\|$/.test(t)) continue; // 구분선 제외
    const cells = t.split("|").map((c) => c.trim());
    const body = cells.slice(1, -1); // 앞뒤 빈 셀(leading/trailing `|`) 제거
    if (body.length < 5 || !(body[0] in SEVERITY_RANK)) continue; // 헤더/본문 아닌 행 제외
    const lineNum = Number(body[2]);
    rows.push({
      severity: body[0], category: body[1],
      line: Number.isFinite(lineNum) ? lineNum : null,
      rule: body[3], message: body[4], suggestion: body[5] ?? "",
    });
  }
  return rows;
}

export function scoreBugCase(c: BugCase, rows: FindingRow[]): boolean {
  return rows.some((r) =>
    r.category === c.category &&
    SEVERITY_RANK[r.severity] <= SEVERITY_RANK[c.min_severity] &&
    r.line !== null &&
    r.line >= c.line_range[0] - LINE_TOLERANCE && r.line <= c.line_range[1] + LINE_TOLERANCE &&
    c.keywords_any.some((k) => (r.message + " " + r.suggestion).toLowerCase().includes(k.toLowerCase()))
  );
}

export function scoreControlCase(rows: FindingRow[]): boolean {
  return !rows.some((r) => SEVERITY_RANK[r.severity] <= SEVERITY_RANK.minor);
}

function runFReview(target: string, c: EvalCase, mode: "whole" | "diff", report: string, model?: string): void {
  rmSync(join(target, report), { force: true });
  mkdirSync(join(target, ".fico/report/f-review"), { recursive: true });
  const reviewArgs = mode === "whole" ? `--files=${c.file} --whole` : c.commit;
  const cmd = ["opencode", "run", "--command", "f-review", ...(model ? ["-m", model] : []), "--", `${reviewArgs} --output=${report}`];
  console.log(`\n$ ${cmd.join(" ")}`);
  // opencode는 inherited PWD로 프로젝트 루트를 잡는다(getcwd가 아님) — f-log 평가기에서 확인된 동작.
  const r = Bun.spawnSync(cmd, { cwd: target, env: { ...process.env, PWD: target }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) console.error(`opencode exited ${r.exitCode} for ${c.id}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const target = args.find((a, i) => !a.startsWith("--") && !["--model", "--case", "--mode"].includes(args[i - 1] ?? ""));
  if (!target) {
    console.error("usage: bun scripts/freview-eval.ts <target-dir> --mode whole|diff [--model <id>] [--case <id>[,<id-or-glob>...]] [--no-run]");
    process.exit(2);
  }
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const mode = flag("--mode");
  if (mode !== "whole" && mode !== "diff") { console.error("--mode whole|diff is required"); process.exit(2); }
  const model = flag("--model");
  const only = flag("--case");
  const noRun = args.includes("--no-run");

  const cases = await loadCases(target, only);
  if (!cases.length) { console.error(`no cases in ${join(target, "f-review-cases")}`); process.exit(2); }

  const rows: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const report = `.fico/report/f-review/${c.id}-${mode}.md`;
    if (!noRun) runFReview(target, c, mode, report, model);
    const full = join(target, report);
    if (!existsSync(full)) { rows.push(`| ${c.id} | – | 리포트 없음 |`); failed++; continue; }
    const md = await Bun.file(full).text();
    const findings = parseFileFindings(md, c.file);
    const pass = c.kind === "bug" ? scoreBugCase(c, findings) : scoreControlCase(findings);
    if (!pass) failed++;
    rows.push(`| ${c.id} | ${pass ? "PASS" : "FAIL"} | ${report} |`);
  }
  console.log(`\n| case | result | report |`);
  console.log(`|---|---|---|`);
  for (const row of rows) console.log(row);
  const bugCases = cases.filter((c) => c.kind === "bug").length;
  console.log(`\n${cases.length - failed}/${cases.length} cases PASS (bug: ${bugCases}, control: ${cases.length - bugCases})`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
