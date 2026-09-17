#!/usr/bin/env bun
/**
 * f-log 평가 러너 + 채점기.
 *
 *   bun scripts/flog-eval.ts <target-dir> [--model <provider/model>] [--case <id>] [--no-run]
 *
 * <target-dir>/f-log-cases/<id>.yaml 마다 target-dir에서 `opencode run --command f-log`를 돌려
 * .fico/report/f-log/<id>.md 를 만들고, 리포트 절을 정답과 대조해 PASS/FAIL 표를 찍는다.
 * FAIL 또는 리포트 없음이 하나라도 있으면 exit 1. --no-run 은 기존 리포트만 채점한다.
 * exit 2: 사용법 오류(target 누락) 또는 케이스 없음(f-log-cases/ 없거나 비어 있음).
 * 설계: docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md §6
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export interface GoldenCase {
  id: string;
  log: string;
  exception: string;
  cause_files: string[];
  cause_symbol: string;
  fix_keywords_any: string[];
  rule?: string;
}

// 리포트 절 헤더 (finalize.ts L 상수의 ko/en). 순서: summary, path, cause, fix, run
const SECTIONS = {
  summary: ["요약", "Summary"],
  path: ["진입점 → 원인 경로", "Entry point → cause path"],
  cause: ["원인 상세와 근거", "Cause and evidence"],
  fix: ["해결 방안", "Resolution"],
  run: ["실행 정보", "Run info"],
};

export function splitSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { key = h[1]; out[key] = ""; continue; }
    if (key !== null) out[key] += line + "\n";
  }
  return out;
}

function pick(sections: Record<string, string>, names: string[]): string {
  return names.map((n) => sections[n] ?? "").join("\n").toLowerCase();
}

export function score(c: GoldenCase, md: string) {
  const s = splitSections(md);
  const where = pick(s, [...SECTIONS.summary, ...SECTIONS.path, ...SECTIONS.cause]);
  const fix = pick(s, SECTIONS.fix);
  const run = pick(s, SECTIONS.run);
  const has = (hay: string, needle: string) => hay.includes(needle.toLowerCase());
  return {
    // FQCN(예: java.lang.NullPointerException) 또는 단순 클래스명(NullPointerException) 중 하나만
    // 있어도 통과 — 요약문은 보통 단순 클래스명만 쓴다.
    exception: has(where, c.exception) || has(where, c.exception.split(".").pop()!),
    cause_file: c.cause_files.some((f) => has(where, f) || has(where, basename(f))),
    cause_symbol: has(where, c.cause_symbol),
    fix: c.fix_keywords_any.some((k) => has(fix, k)),
    fix_code: fix.includes("```"),
    rule: c.rule ? has(run, c.rule) : true,
  };
}

async function loadCases(target: string, only?: string): Promise<GoldenCase[]> {
  const dir = join(target, "f-log-cases");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const cases: GoldenCase[] = [];
  for (const f of files) {
    const id = f.replace(/\.yaml$/, "");
    if (only && id !== only) continue;
    const y = Bun.YAML.parse(await Bun.file(join(dir, f)).text()) as Omit<GoldenCase, "id">;
    cases.push({ id, ...y });
  }
  return cases;
}

function runFLog(target: string, c: GoldenCase, report: string, model?: string): void {
  // finalize는 같은 --output 이 이미 있으면 log-<runId>.md 로 비켜 쓴다(I-5). 미리 지운다.
  rmSync(join(target, report), { force: true });
  mkdirSync(join(target, ".fico/report/f-log"), { recursive: true });
  const cmd = ["opencode", "run", "--command", "f-log", ...(model ? ["-m", model] : []), "--", `--file=${c.log} --output=${report}`];
  console.log(`\n$ ${cmd.join(" ")}`);
  // opencode resolves its project root from the inherited PWD env var, not getcwd();
  // Bun.spawnSync's cwd alone leaves PWD pointing at this repo.
  const r = Bun.spawnSync(cmd, { cwd: target, env: { ...process.env, PWD: target }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) console.error(`opencode exited ${r.exitCode} for ${c.id}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--model" && args[i - 1] !== "--case");
  if (!target) { console.error("usage: bun scripts/flog-eval.ts <target-dir> [--model <id>] [--case <id>] [--no-run]"); process.exit(2); }
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const model = flag("--model");
  const only = flag("--case");
  const noRun = args.includes("--no-run");

  const cases = await loadCases(target, only);
  if (!cases.length) { console.error(`no cases in ${join(target, "f-log-cases")}`); process.exit(2); }

  const rows: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const report = `.fico/report/f-log/${c.id}.md`;
    if (!noRun) runFLog(target, c, report, model);
    const full = join(target, report);
    if (!existsSync(full)) { rows.push(`| ${c.id} | – | – | – | – | – | – | 리포트 없음 |`); failed++; continue; }
    const r = score(c, await Bun.file(full).text());
    const cell = (b: boolean) => (b ? "PASS" : "FAIL");
    if (Object.values(r).some((b) => !b)) failed++;
    rows.push(`| ${c.id} | ${cell(r.exception)} | ${cell(r.cause_file)} | ${cell(r.cause_symbol)} | ${cell(r.fix)} | ${cell(r.fix_code)} | ${cell(r.rule)} | ${report} |`);
  }
  console.log("\n| case | exception | cause_file | cause_symbol | fix | fix_code | rule | report |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log(`\n${cases.length - failed}/${cases.length} cases fully PASS`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
