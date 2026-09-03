/**
 * HTML report renderer — the same visual system as the FCQ static report
 * (`fcq/report/static/index.html`): header, verdict banner, hero stats with a
 * severity spectrum, sticky tabs + filter toolbar, collapsible detail blocks,
 * search, and URL-hash state.
 *
 * Design lives in `report.template.html`, not here. This module only turns
 * findings into placeholder values, so restyling the report never touches
 * TypeScript. The template is imported as text and inlined by the bundler, so
 * dist stays a single file with no runtime asset lookup.
 *
 * Two deliberate departures from the FCQ report, because a review has
 * different data: there is no rule inventory (nothing "passes", so the rule
 * tab and the PASS/FAIL/NOT_RUN status filter are gone), and severity is the
 * review's own blocker/major/minor/nit.
 *
 * Written beside the markdown report, never instead of it — the markdown stays
 * the machine-readable artifact that loadBaseline parses back.
 */

import { SEVERITIES, verdict, type Finding, type Severity } from "../contract";
import TEMPLATE_HTML from "./report.template.html" with { type: "text" };

// bun-types types every *.html import as an HTMLBundle (its fullstack server);
// the `type: "text"` attribute makes this a plain string at runtime and an
// inlined string literal in the bundle, which the cast restates for tsc.
const TEMPLATE = TEMPLATE_HTML as unknown as string;

/** Most severe first, matching SEVERITIES. */
const SEV_ORDER: readonly Severity[] = SEVERITIES;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Lowercased haystack for the client-side search filter. */
function q(...parts: (string | number | undefined)[]): string {
  return esc(
    parts
      .filter((p) => p !== undefined)
      .join(" ")
      .toLowerCase()
  );
}

/**
 * Substitute `{{NAME}}` placeholders. An unknown name throws rather than
 * rendering blank: a renamed placeholder is a bug that must surface at the
 * first render, not as a silently empty section in a delivered report.
 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`report template: unknown placeholder {{${name}}}`);
    return vars[name];
  });
}

interface HtmlLabels {
  title: string;
  eyebrow: string;
  target: string;
  findings: string;
  maxSeverity: string;
  files: string;
  withFindings: string;
  cleanFiles: string;
  spectrum: string;
  tabCat: string;
  tabFiles: string;
  tabViol: string;
  category: string;
  fileCount: string;
  count: string;
  topSeverity: string;
  suggestion: string;
  all: string;
  severity: string;
  search: string;
  expandAll: string;
  collapseAll: string;
  noIssues: string;
  noMatch: string;
  existing: string;
  none: string;
  verdictPass: (s: string) => string;
  verdictFail: (n: number, s: string) => string;
  generated: string;
}

const LABELS: Record<string, HtmlLabels> = {
  ko: {
    title: "코드 리뷰 리포트",
    eyebrow: "F-REVIEW · CODE REVIEW",
    target: "대상",
    findings: "지적",
    maxSeverity: "최고",
    files: "대상 파일",
    withFindings: "지적 있음",
    cleanFiles: "깨끗한 파일",
    spectrum: "심각도 분포",
    tabCat: "분류별 현황",
    tabFiles: "파일별 현황",
    tabViol: "지적 상세",
    category: "분류",
    fileCount: "파일",
    count: "지적",
    topSeverity: "최고 심각도",
    suggestion: "제안",
    all: "전체",
    severity: "심각도",
    search: "검색 (파일·규칙·내용)",
    expandAll: "모두 펼치기",
    collapseAll: "모두 접기",
    noIssues: "이슈 없음",
    noMatch: "조건에 맞는 지적이 없습니다.",
    existing: "기존",
    none: "없음",
    verdictPass: (s) => `판정: 통과 — 기준(${s} 이상) 위반 없음`,
    verdictFail: (n, s) => `판정: 실패 — ${s} 이상 ${n}건`,
    generated: "생성",
  },
  en: {
    title: "Code Review Report",
    eyebrow: "F-REVIEW · CODE REVIEW",
    target: "Target",
    findings: "findings",
    maxSeverity: "top",
    files: "files",
    withFindings: "with findings",
    cleanFiles: "clean files",
    spectrum: "Severity spread",
    tabCat: "By category",
    tabFiles: "By file",
    tabViol: "Findings",
    category: "category",
    fileCount: "files",
    count: "findings",
    topSeverity: "top severity",
    suggestion: "suggestion",
    all: "All",
    severity: "Severity",
    search: "Search (file, rule, message)",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    noIssues: "No issues",
    noMatch: "No findings match the filter.",
    existing: "existing",
    none: "none",
    verdictPass: (s) => `Verdict: PASS — nothing at or above ${s}`,
    verdictFail: (n, s) => `Verdict: FAIL — ${n} finding(s) at or above ${s}`,
    generated: "Generated",
  },
  ja: {
    title: "コードレビューレポート",
    eyebrow: "F-REVIEW · CODE REVIEW",
    target: "対象",
    findings: "指摘",
    maxSeverity: "最高",
    files: "対象ファイル",
    withFindings: "指摘あり",
    cleanFiles: "問題なしファイル",
    spectrum: "深刻度の分布",
    tabCat: "分類別",
    tabFiles: "ファイル別",
    tabViol: "指摘の詳細",
    category: "分類",
    fileCount: "ファイル",
    count: "指摘",
    topSeverity: "最高深刻度",
    suggestion: "提案",
    all: "すべて",
    severity: "深刻度",
    search: "検索 (ファイル・ルール・内容)",
    expandAll: "すべて展開",
    collapseAll: "すべて折りたたむ",
    noIssues: "問題なし",
    noMatch: "条件に一致する指摘がありません。",
    existing: "既存",
    none: "なし",
    verdictPass: (s) => `判定: 合格 — ${s} 以上の違反なし`,
    verdictFail: (n, s) => `判定: 不合格 — ${s} 以上 ${n}件`,
    generated: "生成",
  },
};

/** Most severe entry of a set, or null when it is empty. */
function topSeverity(items: Finding[]): Severity | null {
  return SEV_ORDER.find((s) => items.some((f) => f.severity === s)) ?? null;
}

/** Inline markdown the run appendix uses: **bold** and `code`. */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** The run-quality appendix is markdown built for the .md report; render its
 * headings and bullets rather than dumping it as preformatted text. */
function appendixHtml(md: string): string {
  const out: string[] = [];
  let list = false;
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("- ")) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return `<section class="runsum">\n${out.join("\n")}\n</section>`;
}

/** Drop markdown code fences from a suggestion. The `.fix` box is already
 * preformatted, so fence lines would render as literal backticks — and a
 * suggestion often mixes prose with a fenced block, so this strips the markers
 * wherever they appear rather than only unwrapping a wholly-fenced value. */
function unfence(s: string): string {
  return s
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();
}

/** One finding as a list item, shared by the by-file and by-rule tabs. `head`
 * identifies it within that tab's grouping (the other coordinate). */
function findingItem(f: Finding, head: string, old: boolean, L: HtmlLabels): string {
  return [
    `<li data-sev="${f.severity}" data-cat="${esc(f.category)}" data-q="${q(head, f.rule, f.message, f.suggestion && unfence(f.suggestion), f.category)}">`,
    `<code>${esc(head)}</code>`,
    `<span class="sev ${f.severity}">${f.severity}</span>`,
    `<code>${esc(f.category)}</code>`,
    old ? `<span class="badge old">${esc(L.existing)}</span>` : "",
    `<b>${esc(f.rule)}</b> &mdash; ${esc(f.message)}`,
    f.suggestion
      ? `<span class="fix"><span class="fixlbl">${esc(L.suggestion)}</span>${esc(unfence(f.suggestion))}</span>`
      : "",
    `</li>`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Render the standalone HTML report. Mirrors renderReport's inputs so both
 * views describe the same run; `appendix` is the run-quality markdown that
 * finalizeRun appends to the markdown report, and `baselineKeyOf` is injected
 * so this module does not import back into output.ts (which calls it).
 */
export function renderHtmlReport(
  findings: Record<string, Finding[]>,
  label: string = "",
  language: string = "en",
  failOn?: Severity,
  baselineKeys?: Set<string>,
  now: Date = new Date(),
  appendix?: string,
  baselineKeyOf: (file: string, rule: string) => string = (file, rule) => `${file}${rule}`
): string {
  const L = LABELS[language] ?? LABELS.en;
  const files = Object.keys(findings).sort();
  const all = files.flatMap((f) => findings[f]);
  const isOld = (file: string, f: Finding) => !!baselineKeys?.has(baselineKeyOf(file, f.rule));

  const sevCount = (s: Severity) => all.filter((f) => f.severity === s).length;
  const categories = [...new Set(all.map((f) => f.category))].sort();
  const cleanFiles = files.filter((f) => findings[f].length === 0).length;
  const rate = files.length ? Math.round((cleanFiles / files.length) * 1000) / 10 : 100;
  const top = topSeverity(all);
  const stamp = `${now.toISOString().slice(0, 19).replace("T", " ")} UTC`;

  // Rows are click targets that jump to the findings tab, filtered.
  const categoryRows = categories.length
    ? categories
        .map((c) => {
          const items = all.filter((f) => f.category === c);
          const cTop = topSeverity(items);
          const nFiles = files.filter((file) =>
            findings[file].some((f) => f.category === c)
          ).length;
          return [
            `<tr class="catrow fail" data-cat="${esc(c)}" tabindex="0" title="${esc(L.tabViol)}">`,
            `<td>${esc(c)}</td>`,
            `<td class="num">${items.length}</td>`,
            ...SEV_ORDER.map(
              (s) => `<td class="num">${items.filter((f) => f.severity === s).length}</td>`
            ),
            `<td class="num">${nFiles}</td>`,
            `<td>${cTop ? `<span class="sev ${cTop}">${cTop}</span>` : "-"}</td>`,
            `</tr>`,
          ].join("");
        })
        .join("\n      ")
    : `<tr class="catrow pass"><td colspan="${SEV_ORDER.length + 4}">${esc(L.noIssues)}</td></tr>`;

  // Files reviewed clean are counted in the hero, not listed as empty blocks.
  const fileBlocks =
    files
      .filter((file) => findings[file].length > 0)
      .map((file) => {
        const items = findings[file];
        const fTop = topSeverity(items)!;
        return [
          `<details class="vblk">`,
          `<summary><code>${esc(file)}</code> <span class="desc">(${items.length})</span> <span class="sev ${fTop}">${fTop}</span></summary>`,
          `<ul>`,
          ...items.map((f) => findingItem(f, f.line ? `L${f.line}` : "-", isOld(file, f), L)),
          `</ul>`,
          `</details>`,
        ].join("\n    ");
      })
      .join("\n  ") || `<div class="empty-note">${esc(L.noIssues)}</div>`;

  // Grouped by rule, most severe first, so the worst repeated problem leads.
  const byRule = new Map<string, { file: string; finding: Finding }[]>();
  for (const file of files) {
    for (const f of findings[file]) {
      const list = byRule.get(f.rule) ?? [];
      list.push({ file, finding: f });
      byRule.set(f.rule, list);
    }
  }
  type RuleEntry = [string, { file: string; finding: Finding }[]];
  const ruleRank = (e: RuleEntry) => SEV_ORDER.indexOf(topSeverity(e[1].map((x) => x.finding))!);
  const ruleBlocks =
    [...byRule.entries()]
      .sort(
        (a, b) => ruleRank(a) - ruleRank(b) || b[1].length - a[1].length || a[0].localeCompare(b[0])
      )
      .map(([rule, entries]) => {
        const rTop = topSeverity(entries.map((e) => e.finding))!;
        return [
          `<details class="vblk">`,
          `<summary><span class="sev ${rTop}">${rTop}</span> <b>${esc(rule)}</b> <span class="desc">(${entries.length})</span></summary>`,
          `<ul>`,
          ...entries.map((e) =>
            findingItem(
              e.finding,
              e.finding.line ? `${e.file}:${e.finding.line}` : e.file,
              isOld(e.file, e.finding),
              L
            )
          ),
          `</ul>`,
          `</details>`,
        ].join("\n    ");
      })
      .join("\n  ") || `<div class="empty-note">${esc(L.noIssues)}</div>`;

  return fill(TEMPLATE, {
    LANG: esc(language),
    TITLE: `${esc(L.title)}${label ? ` &middot; ${esc(label)}` : ""}`,
    HEADING: esc(L.title),
    EYEBROW: esc(L.eyebrow),
    STAMP: esc(stamp),
    META: [
      `${esc(L.target)} <b>${label ? esc(label) : "-"}</b><br>`,
      `${esc(L.files)} <b>${files.length}</b> &middot;`,
      `${esc(L.findings)} <b>${all.length}</b> &middot;`,
      `${esc(L.maxSeverity)} <b>${top ?? esc(L.none)}</b>`,
    ].join(" "),
    VERDICT: failOn
      ? (() => {
          const v = verdict(all, failOn);
          return `<div class="verdict ${v.pass ? "pass" : "fail"}" role="status">${esc(
            v.pass ? L.verdictPass(failOn) : L.verdictFail(v.failing, failOn)
          )}</div>`;
        })()
      : "",
    STATS: [
      `<div class="stat rate"><div class="n">${rate}%</div><div class="l">${esc(L.cleanFiles)} &middot; ${cleanFiles}/${files.length}</div></div>`,
      `<div class="stat"><div class="n">${files.length}</div><div class="l">${esc(L.files)} &middot; ${esc(L.withFindings)} ${files.length - cleanFiles}</div></div>`,
      `<div class="stat${all.length ? " bad" : ""}"><div class="n">${all.length}</div><div class="l">${esc(L.findings)} &middot; ${esc(L.maxSeverity)} ${top ?? esc(L.none)}</div></div>`,
    ].join("\n      "),
    SPECTRUM_LABEL: esc(L.spectrum),
    SPECTRUM_EMPTY: all.length ? "" : " empty",
    SPECTRUM: SEV_ORDER.filter((s) => sevCount(s) > 0)
      .map((s) => `<span class="seg ${s}" style="flex-grow:${sevCount(s)}"></span>`)
      .join(""),
    LEGEND: SEV_ORDER.map(
      (s) =>
        `<span class="lg"><span class="dot" style="background:var(--${s})"></span><b>${sevCount(s)}</b> ${s}</span>`
    ).join(""),
    TABS: [
      `<button class="tab active" data-tab="cat" role="tab">${esc(L.tabCat)} <span class="c">${categories.length}</span></button>`,
      `<button class="tab" data-tab="files" role="tab">${esc(L.tabFiles)} <span class="c">${files.length}</span></button>`,
      `<button class="tab" data-tab="viol" role="tab">${esc(L.tabViol)} <span class="c">${all.length}</span></button>`,
    ].join("\n      "),
    CHIPS: [
      `<button class="chip active" data-cat="">${esc(L.all)} <b>${all.length}</b></button>`,
      ...categories.map(
        (c) =>
          `<button class="chip" data-cat="${esc(c)}">${esc(c)} <b>${all.filter((f) => f.category === c).length}</b></button>`
      ),
    ].join("\n        "),
    SEVERITY_LABEL: esc(L.severity),
    SEVERITY_BUTTONS: [
      `<button class="fbtn active" data-sev="">${esc(L.all)}</button>`,
      ...SEV_ORDER.map((s) => `<button class="fbtn" data-sev="${s}">${s}</button>`),
    ].join("\n          "),
    SEARCH_LABEL: esc(L.search),
    CATEGORY_HEAD: [
      `<th>${esc(L.category)}</th>`,
      `<th class="num">${esc(L.count)}</th>`,
      ...SEV_ORDER.map((s) => `<th class="num">${s}</th>`),
      `<th class="num">${esc(L.fileCount)}</th>`,
      `<th>${esc(L.topSeverity)}</th>`,
    ].join(""),
    CATEGORY_ROWS: categoryRows,
    EXPAND_CONTROLS: [
      `<div class="viol-controls">`,
      `<button class="fbtn" data-expand="1">${esc(L.expandAll)}</button>`,
      `<button class="fbtn" data-expand="0">${esc(L.collapseAll)}</button>`,
      `</div>`,
    ].join("\n      "),
    FILE_BLOCKS: fileBlocks,
    NO_MATCH: esc(L.noMatch),
    RULE_BLOCKS: ruleBlocks,
    APPENDIX: appendix ? appendixHtml(appendix) : "",
    FOOTER: `f-review &middot; ${esc(L.generated)} ${esc(stamp)}`,
  });
}
