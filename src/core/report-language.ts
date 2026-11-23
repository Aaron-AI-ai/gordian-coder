/**
 * Report language checks shared by every command that writes a report for the developer (f-review, f-log,
 * f-unit-test-code): the language names, which scripts each language may use, and the detectors for the classic
 * small-model slip of switching to Chinese, Russian or Arabic mid-sentence.
 */

const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese" };

export function languageName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

/** Scripts a report in each language writes in, on top of the ones every
 * report may use: Latin (code identifiers, English terms), Greek (λ, μ, Δ are
 * technical symbols, not a language slip) and Hangul (the codebases and their
 * comments are Korean, so an English review still quotes Korean terms). A
 * language missing here is not checked — a false bounce costs more than a
 * missed slip. */
export const REPORT_SCRIPTS: Record<string, string[]> = {
  ko: [],
  en: [],
  ja: ["Hiragana", "Katakana", "Han"],
  zh: ["Han"],
};

/** Letters outside the language's scripts, as one regex; null when unchecked. */
function foreignLetters(language: string): RegExp | null {
  const scripts = REPORT_SCRIPTS[language.split(/[-_]/)[0]];
  if (!scripts) return null;
  // Common/Inherited letters (ー, combining marks) belong to no one language
  const allowed = ["Common", "Inherited", "Latin", "Greek", "Hangul", ...scripts].map((s) => `\\p{Script=${s}}`).join("");
  return new RegExp(`[^\\P{L}${allowed}]+`, "gu");
}

/** True when `s` is largely written in a script the review language doesn't
 * use — the classic small-model "suddenly answers in Chinese" glitch. */
export function scriptMismatch(s: string, language: string): boolean {
  const re = foreignLetters(language);
  if (!re) return false;
  const letters = s.replace(/\s/g, "");
  if (letters.length < 20) return false; // too short to judge
  const foreign = (letters.match(re) ?? []).join("").length;
  return foreign / letters.length > 0.3;
}

/** Foreign-script runs in prose outside backtick code spans. scriptMismatch
 * only sees a wholesale switch; a small model also slips a few words of another
 * script into otherwise Korean text ("메서드入口处 최소한", "이유가 همین입니다"),
 * which the report never needs. Quoted code/log text in backticks may
 * legitimately carry any script. */
export function strayScript(s: string, language: string): string[] {
  const re = foreignLetters(language);
  if (!re) return [];
  return s.replace(/`[^`\n]*`/g, "").match(re) ?? [];
}

const SCRIPT_NAMES = ["Han", "Hiragana", "Katakana", "Hangul", "Cyrillic", "Arabic", "Hebrew", "Thai", "Devanagari"];

/** "همین (Arabic), 不得使用 (Han)" — tells the model what to rewrite. */
export function describeScripts(runs: string[]): string {
  return runs
    .map((r) => `${r} (${SCRIPT_NAMES.find((s) => new RegExp(`\\p{Script=${s}}`, "u").test(r)) ?? "other script"})`)
    .join(", ");
}

/** Post-write check of a markdown report: lines whose prose (fenced blocks and
 * inline code excluded) still carries a foreign script. "" when clean. A fence
 * closes only on the same character at least as long, so a 4-backtick block
 * holding a 3-backtick example stays code throughout. */
export function reportScriptWarning(md: string, language: string): string {
  const hits: string[] = [];
  let fence = "";
  md.split("\n").forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m && (!fence || (m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length)))) {
      fence = fence ? "" : m[1];
      return;
    }
    if (fence) return;
    const runs = strayScript(line, language);
    if (runs.length) hits.push(`L${i + 1} "${describeScripts([...new Set(runs)])}"`);
  });
  if (!hits.length) return "";
  return `⚠️ Non-${languageName(language)} script in report prose (${hits.length} line(s)): ${hits.slice(0, 5).join("; ")}${hits.length > 5 ? "; …" : ""}`;
}

/** Small models drift into Chinese — or Russian, Arabic, Japanese — mid-sentence;
 * say it outright. Empty for Japanese/Chinese, where Han is the language itself. */
export function scriptLine(code: string): string {
  return code.startsWith("zh") || code.startsWith("ja")
    ? ""
    : ` Write only in ${languageName(code)} — no Hanzi, kana, Cyrillic, Arabic or other scripts.`;
}

/**
 * Why `text` (prose a model wrote for a report or plan) must be rewritten, or null when clean: foreign-script words
 * inside it, outside backtick code spans. `what` names the text in the message. Used where a tool can bounce the model
 * (a plan or summary submit), the same check f-review and f-log run on findings and reports.
 */
export function foreignScriptProblem(text: string, language: string, what: string): string | null {
  const foreign = [...new Set(strayScript(text, language))];
  if (foreign.length === 0) return null;
  return `Non-${languageName(language)} script in ${what}: ${describeScripts(foreign.slice(0, 10))}. Rewrite those words in ${languageName(language)} (put quoted code or log text in backticks) and submit again.`;
}
