/**
 * Offline kb_search ranker comparison: hit@1/2/5 and MRR per query language.
 *
 *   bun scripts/kb-search-bench.ts --cwd <project with .fico/config/fico_ai.json>
 *     [--queries scripts/kb-bench/queries.json] [--kiwi <dir>] [--misses]
 *
 * `--kiwi` points at a directory holding `node_modules/kiwi-nlp` and the Kiwi
 * base model under `models/cong/base` — measured only, never bundled.
 * hit@2 matters most: kb_search returns the top two pages in full.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type HangulSplit, hangulBigrams, rankKbPaths } from "../src/core/kb/framework-kb";

interface Query {
  case: string;
  gold: string;
  en: string;
  ko: string;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const cwd = arg("--cwd");
if (!cwd) throw new Error("--cwd is required");
const queries: Query[] = JSON.parse(readFileSync(arg("--queries") ?? join(import.meta.dir, "kb-bench/queries.json"), "utf8"));

// ponytail: suffix list is a heuristic; a word whose stem would drop under two syllables is kept whole
const SUFFIXES = [
  "에서는", "에서도", "으로는", "으로서", "으로써", "이라는", "에게서", "합니다", "됩니다", "입니다",
  "에서", "으로", "에게", "까지", "부터", "처럼", "보다", "이나", "이란", "이며", "에는", "에도", "와는", "과는",
  "와의", "과의", "라는", "하는", "되는", "하며", "하고", "하여", "해야", "하면", "해서", "한다", "된다", "했다",
  "하지", "하기", "되기", "할", "한", "된", "될", "함", "됨",
  "을", "를", "이", "가", "은", "는", "의", "에", "와", "과", "도", "로", "만",
];
const hangulStrip: HangulSplit = (word) => {
  for (const s of SUFFIXES) if (word.endsWith(s) && word.length - s.length >= 2) return [word.slice(0, -s.length)];
  return word.length >= 2 ? [word] : [];
};

const KIWI_KEEP = new Set(["NNG", "NNP", "NNB", "VV", "VA", "XR", "SL", "SH", "SN"]);
async function kiwiSplit(dir: string): Promise<HangulSplit> {
  const { KiwiBuilder } = await import(join(dir, "node_modules/kiwi-nlp/dist/index.js"));
  const modelDir = join(dir, "models/cong/base");
  const modelFiles: Record<string, Uint8Array> = {};
  for (const f of readdirSync(modelDir)) modelFiles[f] = readFileSync(join(modelDir, f));
  const builder = await KiwiBuilder.create(join(dir, "node_modules/kiwi-nlp/dist/kiwi-wasm.wasm"));
  const kiwi = await builder.build({ modelFiles, modelType: "cong" });
  const memo = new Map<string, string[]>();
  return (word) => {
    let out = memo.get(word);
    if (!out) {
      out = kiwi
        .tokenize(word)
        .filter((t: { tag: string }) => KIWI_KEEP.has(t.tag))
        .map((t: { str: string }) => t.str.toLowerCase());
      memo.set(word, out);
    }
    return out;
  };
}

const stripBigram = union(hangulStrip, hangulBigrams);
const rankers: { name: string; rank: (q: string) => string[] }[] = [
  { name: "keyword", rank: (q) => rankKbPaths(cwd, q, "keyword") },
  { name: "bm25-bigram", rank: (q) => rankKbPaths(cwd, q, "bm25", hangulBigrams) },
  { name: "bm25-strip", rank: (q) => rankKbPaths(cwd, q, "bm25", hangulStrip) },
  { name: "bm25-strip+bigram", rank: (q) => rankKbPaths(cwd, q, "bm25", stripBigram) },
];
const kiwiDir = arg("--kiwi");
if (kiwiDir) {
  const split = await kiwiSplit(kiwiDir);
  const both = union(split, hangulBigrams);
  rankers.push({ name: "bm25-kiwi", rank: (q) => rankKbPaths(cwd, q, "bm25", split) });
  rankers.push({ name: "bm25-kiwi+bigram", rank: (q) => rankKbPaths(cwd, q, "bm25", both) });
}

/** Both splits' tokens, deduped per word. Built once so the term cache holds. */
function union(a: HangulSplit, b: HangulSplit): HangulSplit {
  return (word) => [...new Set([...a(word), ...b(word)])];
}

const misses: string[] = [];
const rows: string[] = ["| ranker | lang | n | hit@1 | hit@2 | hit@5 | MRR | ms/query |", "|---|---|---|---|---|---|---|---|"];
for (const { name, rank } of rankers) {
  for (const lang of ["en", "ko"] as const) {
    let h1 = 0, h2 = 0, h5 = 0, rr = 0;
    rank("warm up"); // build the per-ranker term cache outside the timing
    const t0 = performance.now();
    for (const q of queries) {
      const paths = rank(q[lang]);
      const at = paths.findIndex((p) => p.endsWith(q.gold));
      if (at === 0) h1++;
      if (at >= 0 && at < 2) h2++;
      if (at >= 0 && at < 5) h5++;
      if (at >= 0) rr += 1 / (at + 1);
      if (at < 0 || at >= 2) misses.push(`${name} ${lang} ${q.case} rank=${at < 0 ? "-" : at + 1} "${q[lang]}" → ${paths.slice(0, 2).map((p) => p.split("/").at(-1)).join(", ")}`);
    }
    const ms = (performance.now() - t0) / queries.length;
    rows.push(`| ${name} | ${lang} | ${queries.length} | ${h1} | ${h2} | ${h5} | ${(rr / queries.length).toFixed(3)} | ${ms.toFixed(1)} |`);
  }
}
console.log(rows.join("\n"));
if (process.argv.includes("--misses")) console.log(`\n${misses.join("\n")}`);
