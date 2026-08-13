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
  suggestion: capped(4000).optional(), // concrete fix (code or steps), when the reviewer can offer one
});

export type Finding = z.infer<typeof FindingSchema>;

export const SubmitSchema = z.object({
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
