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
  "security",
  "nfr",
  "correctness",
  "tests",
  "framework", // framework-convention compliance — always enforced
] as const;

export type Category = (typeof REQUIRED_CATEGORIES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  category: z.enum(REQUIRED_CATEGORIES),
  severity: z.enum(SEVERITIES),
  file: z.string(),
  line: z.number().int().positive().optional(),
  rule: z.string(), // which rule/checklist item this violates
  message: z.string(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const SubmitSchema = z.object({
  // Categories the reviewer evaluated for the current file (gates termination).
  assessed: z.array(z.enum(REQUIRED_CATEGORIES)),
  // Issues found; may be empty when a category is clean.
  findings: z.array(FindingSchema),
});

export type SubmitPayload = z.infer<typeof SubmitSchema>;

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
