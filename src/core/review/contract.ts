/**
 * Review contract: the categories a review MUST cover, the shape of a
 * submitted result, and the coverage check that gates loop termination.
 *
 * Coverage is judged on `assessed` (which categories the reviewer actually
 * evaluated), NOT on `findings`. A category with zero issues is still
 * "covered" once the reviewer assesses it — otherwise a clean category could
 * never satisfy the gate and the review loop would never terminate.
 */

import { z } from "zod";

export const REQUIRED_CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "maintainability",
  "tests", // test coverage
  "framework", // framework-convention compliance — always enforced
] as const;

export type Category = (typeof REQUIRED_CATEGORIES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;

export type Severity = (typeof SEVERITIES)[number];

// Length caps guard against runaway generation (a degenerate model repeating
// one sentence for thousands of characters) — no legitimate finding needs more.
// Oversized text is TRUNCATED, not rejected: a rejection would funnel a valid
// but verbose review into the failed-submit loop, whose force-advance discards
// every finding.
export const capped = (max: number) => z.string().transform((s) => s.slice(0, max));

export const FindingSchema = z.object({
  category: z.enum(REQUIRED_CATEGORIES),
  severity: z.enum(SEVERITIES),
  file: capped(500),
  line: z.number().int().positive().optional(),
  rule: capped(500), // which rule/checklist item this violates
  message: capped(2000),
  // The fix, in two fields with SEPARATE budgets. They used to share one
  // `suggestion`, and a long AS-IS starved the part that matters: a real
  // review was observed cut at exactly 4000 characters mid-token — `...```\nTO`
  // — losing the entire corrected code. `suggestion` stays accepted so a model
  // (or an artifact written before the split) that sends one still works;
  // splitFix() below turns it into the two fields.
  asIs: capped(3000).optional(), // the offending code as it stands
  toBe: capped(4000).optional(), // the corrected code — never truncated to fit AS-IS
  suggestion: capped(7000).optional(), // legacy single field: "AS-IS: … TO-BE: …"
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * The fix of a finding, however it was supplied.
 *
 * Prefers the explicit fields; falls back to parsing a legacy `suggestion` on
 * its AS-IS/TO-BE markers. A `suggestion` with no marker is all TO-BE: that is
 * what a bare suggestion has always meant to a reader.
 */
export function splitFix(f: {
  asIs?: string;
  toBe?: string;
  suggestion?: string;
}): { asIs?: string; toBe?: string } {
  if (f.asIs || f.toBe) return { asIs: f.asIs, toBe: f.toBe };
  const s = f.suggestion?.trim();
  if (!s) return {};
  // Tolerate what models actually write around the markers: bold, headings,
  // list bullets, a missing hyphen or colon. Anchored to a line start so the
  // words cannot match inside prose or inside the code itself.
  const TO_BE = /(?:^|\n)[ \t]*(?:[*_#>-]+[ \t]*)*TO[ _-]?BE[ \t]*:?[*_]*[ \t]*\r?\n?/i;
  const AS_IS = /^[ \t]*(?:[*_#>-]+[ \t]*)*AS[ _-]?IS[ \t]*:?[*_]*[ \t]*\r?\n?/i;
  const m = TO_BE.exec(s);
  if (!m) return { toBe: s };
  const head = s.slice(0, m.index).replace(AS_IS, "").trim();
  const tail = s.slice(m.index + m[0].length).trim();
  return { ...(head ? { asIs: head } : {}), ...(tail ? { toBe: tail } : {}) };
}

/** True when a finding carries any fix text at all. */
export function hasFix(f: { asIs?: string; toBe?: string; suggestion?: string }): boolean {
  const { asIs, toBe } = splitFix(f);
  return !!(asIs || toBe);
}

export const SubmitSchema = z.object({
  // Opaque identity injected for the current target/round. It prevents a
  // repeated state-changing call from being applied to the next target.
  submitToken: capped(100).optional(),
  // Categories the reviewer evaluated for the current file (gates termination).
  assessed: z.array(z.enum(REQUIRED_CATEGORIES)),
  // Issues found; may be empty when a category is clean. Overflow past 50 is
  // dropped (runaway-generation cap), never grounds for rejecting the submit.
  findings: z.array(FindingSchema).transform((a) => a.slice(0, 50)),
});

export type SubmitPayload = z.infer<typeof SubmitSchema>;

/** True when `s` looks like runaway repetition (a small model looping on one
 * phrase): most fixed-size chunks of a long string are duplicates of each other.
 * ponytail: chunk-uniqueness heuristic — misses short loops, never legit prose. */
export function repetitiveText(s: string): boolean {
  const CHUNK = 24;
  if (s.length < CHUNK * 5) return false; // too short to loop meaningfully
  const chunks: string[] = [];
  for (let i = 0; i + CHUNK <= s.length; i += CHUNK) chunks.push(s.slice(i, i + CHUNK));
  // Looping text with period p yields ~min(p, n) unique chunks out of n; real
  // prose stays near 1.0. 0.6 catches short-period loops (e.g. one word) that
  // land exactly on 0.5 without ever reaching legitimate writing.
  return new Set(chunks).size / chunks.length < 0.6;
}

/** True when `s` is largely Han (Chinese) characters while the review language
 * isn't Han-based — the classic small-model "suddenly answers in Chinese" glitch.
 * Japanese/Chinese reviews legitimately contain Han, so they are exempt. */
export function scriptMismatch(s: string, language: string): boolean {
  if (language.startsWith("zh") || language.startsWith("ja")) return false;
  const letters = s.replace(/\s/g, "");
  if (letters.length < 20) return false; // too short to judge
  const han = letters.match(/[一-鿿]/g)?.length ?? 0;
  return han / letters.length > 0.3;
}

/** Why a finding's prose reads as degenerate model output, or null when clean.
 * Checks `rule`/`message` only — `suggestion` is code, which repeats legitimately. */
export function degenerateReason(f: Finding, language: string): string | null {
  if (repetitiveText(f.rule) || repetitiveText(f.message)) return "repetitive looping text";
  if (scriptMismatch(`${f.rule} ${f.message}`, language))
    return `unexpected script for review language "${language}"`;
  return null;
}

/** True when `sev` is at least as severe as `threshold` (SEVERITIES is ordered most→least severe). */
export function atLeast(sev: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(sev) <= SEVERITIES.indexOf(threshold);
}

/** CI gate verdict: FAIL when any finding is at or above the `failOn` threshold. */
export function verdict(
  findings: readonly Finding[],
  failOn: Severity
): { pass: boolean; failing: number } {
  const failing = findings.filter((f) => atLeast(f.severity, failOn)).length;
  return { pass: failing === 0, failing };
}

/**
 * Return the required categories that were NOT assessed.
 * Empty array = full coverage = the review may finish this file.
 */
export function coverage(
  assessed: readonly Category[],
  required: readonly Category[] = REQUIRED_CATEGORIES
): Category[] {
  const seen = new Set(assessed);
  return required.filter((c) => !seen.has(c));
}
