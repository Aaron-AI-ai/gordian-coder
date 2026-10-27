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
  category: string | string[];
  min_severity: string;
  line_range?: [number, number];
  anchor?: string | string[]; // 결함이 여러 줄에 걸쳐 드러나면 목록으로 — 어느 줄 근처든 인정
  keywords_any: string[];
  kb_ref?: string;
  // 수정안(TO-BE) 검사: 검출한 finding의 TO-BE가 이 정규식에 하나라도 걸리면 FAIL (예: 기존 fallback을 throw로 바꿈)
  fix_forbid_any?: string[];
  // 검출한 finding 중 하나의 TO-BE에 이 문자열 중 하나가 있어야 PASS (예: 기존 fallback 값 유지)
  fix_require_any?: string[];
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
  toBe?: string; // `### 제안 상세`의 TO-BE 코드 블록
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
        category: y.category as string | string[],
        min_severity: y.min_severity as string,
        line_range: y.line_range as [number, number] | undefined,
        anchor: y.anchor as string | string[] | undefined,
        keywords_any: (y.keywords_any ?? []) as string[],
        kb_ref: y.kb_ref as string | undefined,
        fix_forbid_any: y.fix_forbid_any as string[] | undefined,
        fix_require_any: y.fix_require_any as string[] | undefined,
        commit: y.commit as string,
      });
    }
  }
  return cases;
}

/** 리포트 마크다운에서 `## <file>` 섹션의 finding 표를 파싱한다. 섹션이 없으면 빈 배열(클린). */
export function parseFileFindings(md: string, file: string): FindingRow[] {
  const sections = md.split(/^## /m).slice(1);
  // diff 모드는 git 루트 기준 경로로 제목을 쓴다: 대상이 저장소 하위 디렉터리면 앞에 상위 경로가 붙는다
  const section = sections.find((s) => {
    const head = s.split("\n")[0].trim();
    return head === file || head.endsWith(`/${file}`);
  });
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
  const fixes = parseToBeBlocks(section);
  for (const r of rows) {
    r.toBe = (fixes.find((x) => x.line === r.line && x.rule === r.rule) ?? fixes.find((x) => x.line === r.line))?.toBe;
  }
  return rows;
}

/** `#### <rule> (L<n>)` 상세 블록마다 TO-BE 라벨 다음 첫 코드 펜스의 내용을 뽑는다. */
export function parseToBeBlocks(section: string): { rule: string; line: number | null; toBe: string }[] {
  const out: { rule: string; line: number | null; toBe: string }[] = [];
  for (const block of section.split(/^#### /m).slice(1)) {
    const lines = block.split("\n");
    const head = lines[0].trim().match(/^(.*?)(?: \(L(\d+)\))?$/)!;
    const label = lines.findIndex((l) => l.startsWith("**") && l.includes("TO-BE"));
    if (label < 0) continue;
    const open = lines.findIndex((l, i) => i > label && /^`{3,}/.test(l));
    if (open < 0) continue;
    const fence = lines[open].match(/^`+/)![0];
    const close = lines.findIndex((l, i) => i > open && l.trim() === fence);
    out.push({
      rule: head[1], line: head[2] ? Number(head[2]) : null,
      toBe: lines.slice(open + 1, close < 0 ? undefined : close).join("\n"),
    });
  }
  return out;
}

/** 정답의 줄 범위들을 구한다. anchor(문자열 또는 목록)마다 소스에서 그 문자열이 든 줄을 찾는다(각각 정확히 1줄이어야 함). */
export function resolveLineRanges(c: BugCase, source: string): [number, number][] {
  if (!c.anchor || (Array.isArray(c.anchor) && c.anchor.length === 0)) {
    if (!c.line_range) throw new Error(`${c.id}: needs anchor or line_range`);
    return [c.line_range];
  }
  const lines = source.split("\n");
  return (Array.isArray(c.anchor) ? c.anchor : [c.anchor]).map((a) => {
    const hits = lines.flatMap((l, i) => (l.includes(a) ? [i + 1] : []));
    if (hits.length !== 1) throw new Error(`${c.id}: anchor "${a}" matched ${hits.length} lines (need exactly 1)`);
    return [hits[0], hits[0]] as [number, number];
  });
}

/** 첫 번째 정답 줄 범위 (anchor가 하나인 케이스용). */
export function resolveLineRange(c: BugCase, source: string): [number, number] {
  return resolveLineRanges(c, source)[0];
}

export function scoreBugCase(c: BugCase, rows: FindingRow[], range?: [number, number] | [number, number][]): boolean {
  const ranges: [number, number][] = range
    ? Array.isArray(range[0]) ? (range as [number, number][]) : [range as [number, number]]
    : resolveLineRanges(c, "");
  const cats = Array.isArray(c.category) ? c.category : [c.category];
  const hits = rows.filter((r) =>
    cats.includes(r.category) &&
    SEVERITY_RANK[r.severity] <= SEVERITY_RANK[c.min_severity] &&
    r.line !== null &&
    ranges.some(([lo, hi]) => r.line! >= lo - LINE_TOLERANCE && r.line! <= hi + LINE_TOLERANCE) &&
    c.keywords_any.some((k) => (r.message + " " + r.suggestion).toLowerCase().includes(k.toLowerCase()))
  );
  if (!hits.length) return false;
  const forbid = (c.fix_forbid_any ?? []).map((p) => new RegExp(p, "i"));
  if (hits.some((r) => forbid.some((re) => re.test(r.toBe ?? "")))) return false;
  const need = c.fix_require_any ?? [];
  return !need.length || hits.some((r) => need.some((k) => (r.toBe ?? "").includes(k)));
}

/** 대조군은 minor 이상 finding이 없어야 통과. `tests` 카테고리는 샘플 코드에 테스트가 없어서 항상 뜨는 노이즈라 제외한다. */
export function scoreControlCase(rows: FindingRow[]): boolean {
  return !rows.some((r) => r.category !== "tests" && SEVERITY_RANK[r.severity] <= SEVERITY_RANK.minor);
}

function runFReview(target: string, c: EvalCase, mode: "whole" | "diff", report: string, model?: string): void {
  rmSync(join(target, report), { force: true });
  mkdirSync(join(target, ".fico/report/freview-eval"), { recursive: true });
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
    const report = `.fico/report/freview-eval/${c.id}-${mode}.md`;
    if (!noRun) runFReview(target, c, mode, report, model);
    const full = join(target, report);
    if (!existsSync(full)) { rows.push(`| ${c.id} | – | 리포트 없음 |`); failed++; continue; }
    const md = await Bun.file(full).text();
    const findings = parseFileFindings(md, c.file);
    let pass: boolean;
    let note = "";
    if (c.kind === "bug") {
      try {
        const src = await Bun.file(join(target, c.file)).text();
        const ranges = resolveLineRanges(c, src);
        pass = scoreBugCase(c, findings, ranges);
        // 검출은 됐는데 수정안이 의도를 바꿨는지 구분해 보여준다
        if (!pass && (c.fix_forbid_any || c.fix_require_any) &&
            scoreBugCase({ ...c, fix_forbid_any: undefined, fix_require_any: undefined }, findings, ranges)) {
          note = "검출 O, 수정안이 기존 의도 변경";
        }
      } catch (e) {
        console.error((e as Error).message);
        pass = false;
      }
    } else {
      pass = scoreControlCase(findings);
    }
    if (!pass) failed++;
    rows.push(`| ${c.id} | ${pass ? "PASS" : `FAIL${note ? ` (${note})` : ""}`} | ${report} |`);
  }
  console.log(`\n| case | result | report |`);
  console.log(`|---|---|---|`);
  for (const row of rows) console.log(row);
  const bugCases = cases.filter((c) => c.kind === "bug").length;
  console.log(`\n${cases.length - failed}/${cases.length} cases PASS (bug: ${bugCases}, control: ${cases.length - bugCases})`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
