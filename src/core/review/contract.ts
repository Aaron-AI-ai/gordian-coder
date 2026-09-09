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

// ── duplicate collapsing ─────────────────────────────────────────
//
// A file over SEGMENT_THRESHOLD is reviewed as overlapping segments, each its
// own target with its own submit, so an issue inside an overlap band — or in a
// declaration that inFileRelated surfaces to a later segment — is reported
// twice, with the two passes wording it slightly differently. Per-target dedup
// cannot see across targets, so the collapse runs where segments merge back
// into one file (finalizeReport / writeRunReview / run finalize).
//
// Precision over recall throughout: a duplicate that slips through is a
// repeated row, an over-merge silently deletes a real finding. When in doubt,
// both rows are kept.

/** Normalized text for duplicate matching: case, whitespace and punctuation
 * carry no meaning when two passes describe the same issue. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** How much fix detail a finding carries. The tiebreak when duplicates
 * collapse, so a bare restatement never displaces the copy holding the code. */
function fixWeight(f: Finding): number {
  const { asIs, toBe } = splitFix(f);
  return (toBe ? 2 : 0) + (asIs ? 1 : 0);
}

/**
 * Identity keys for a finding. Two findings are the same issue when they share
 * an anchor — file, line and category — AND agree on their rule OR on their
 * message.
 *
 * The anchor alone is deliberately NOT enough: two unrelated issues routinely
 * sit on one line (a null check and a naming violation), and collapsing those
 * would delete a real finding. Category is part of the anchor for the same
 * reason. What this is built to catch is wording drift between two passes over
 * the same lines, not "anything reported here".
 *
 * ponytail: an issue the two passes anchor to DIFFERENT lines (off-by-one on a
 * multi-line statement) survives as two rows. Anchoring a tolerance window
 * would start merging neighbouring issues; leave it until it shows up.
 */
function dupKeys(f: Finding): string[] {
  const anchor = `${f.file}\u001f${f.line ?? "-"}\u001f${f.category}`;
  const rule = normalizeText(f.rule);
  const message = normalizeText(f.message);
  return [
    ...(rule ? [`${anchor}\u001fr:${rule}`] : []),
    ...(message ? [`${anchor}\u001fm:${message}`] : []),
  ];
}

/** Fold `b` into the already-kept `a`: the copy with the most fix detail (then
 * the fuller message) wins, but the merge never softens the severity — the CI
 * gate reads it, and one pass rating the issue `major` is enough. */
function mergeDuplicate(a: Finding, b: Finding): Finding {
  const wa = fixWeight(a);
  const wb = fixWeight(b);
  const winner = wb > wa || (wb === wa && b.message.length > a.message.length) ? b : a;
  const severity =
    SEVERITIES[Math.min(SEVERITIES.indexOf(a.severity), SEVERITIES.indexOf(b.severity))];
  return winner.severity === severity ? winner : { ...winner, severity };
}

/**
 * Collapse duplicate findings, keeping the richest copy of each issue in first-
 * seen order. Findings that share no identity key are all kept untouched.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const slotOf = new Map<string, number>();
  const out: Finding[] = [];
  for (const f of findings) {
    const keys = dupKeys(f);
    const slot = keys.map((k) => slotOf.get(k)).find((i) => i !== undefined);
    if (slot === undefined) {
      out.push(f);
      for (const k of keys) slotOf.set(k, out.length - 1);
      continue;
    }
    out[slot] = mergeDuplicate(out[slot], f);
    // Register the keys this copy adds, so a third phrasing that matches only
    // the newly-seen rule/message still lands in the same slot.
    for (const k of keys) if (!slotOf.has(k)) slotOf.set(k, slot);
  }
  return out;
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
