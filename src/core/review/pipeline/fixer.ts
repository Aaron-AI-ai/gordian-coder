/**
 * The fcq fix pass: a subagent whose only job is turning static-analysis
 * violations into corrected code.
 *
 * It exists because asking the reviewer to do it did not work. With `fcqFix`
 * on, a reviewer handed 19 violations — 24 of 28 of them MINOR style rules —
 * spent its whole submission writing AS-IS/TO-BE pairs for them and reported
 * nothing else. The same file reviewed without that list had produced a real
 * null-dereference blocker. The budget was never the constraint (1 of 20 tool
 * calls used); a concrete checklist next to an abstract "also look for real
 * bugs" simply wins.
 *
 *   f_review_fix_context(runId, file) → the file plus every violation in it
 *   f_review_fix_submit(fixes)        → corrected code per violation
 *
 * Fixes land in `<runDir>/fixes/<slug>.json` and finalize merges them onto the
 * matching fcq rows, so MINOR hits still ship with real code — the reviewer
 * just no longer writes it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { capped } from "../contract";
import { loadRun, reviewSlug, runDir } from "./artifact";
import { FCQ_SEVERITIES, readFcqFile, type FcqFileViolation } from "../evidence/fcq";
import { planJudgeParts } from "./judge-parts";
import { fileLineCount, fileRead } from "../tools/read";

/** Violations shown per request. Beyond this the file is a lint failure, not a
 * review target, and a fixer session cannot hold them all anyway. */
export const FIX_MAX_ITEMS = 60;
/** Lines of source handed to the fixer. It has no read tools — this context is
 * the only code it will ever see — so the cap is generous and a file past it is
 * called out rather than silently cut. */
export const FIX_FILE_MAX_LINES = 2000;
/**
 * Byte ceiling for the whole context.
 *
 * The host truncates a tool result before the model sees it — OpenCode's store
 * cuts at 51200 bytes — and the fixer has no read tools to recover what was
 * dropped. A 1431-line Java file was cut mid-source at ~697 lines while this
 * context still claimed to be the complete file. Budget below that ceiling and
 * hand over violation-anchored windows when the whole file will not fit.
 */
export const FIX_CONTEXT_MAX_BYTES = 45_000;
/** Lines of context each side of a violation when the file is windowed. */
export const FIX_WINDOW_LINES = 40;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** Violation lines → merged, clamped [start, end] windows, in file order. */
export function fixWindows(lines: number[], total: number, radius = FIX_WINDOW_LINES): [number, number][] {
  const merged: [number, number][] = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const start = Math.max(1, line - radius);
    const end = Math.min(total, line + radius);
    if (start > total) continue;
    const last = merged[merged.length - 1];
    // Touching windows join: two ranges one line apart read as a gap that is
    // not there, and the fixer is told to skip what it cannot see.
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export const FixSchema = z.object({
  line: z.number().int().nonnegative(),
  ruleId: capped(200),
  asIs: capped(3000).optional(),
  toBe: capped(4000).optional(),
  /** Set when the violation is wrong and no code change applies. */
  falsePositive: z.boolean().optional(),
  note: capped(500).optional(),
});
export type Fix = z.infer<typeof FixSchema>;

export const FixSubmitSchema = z.object({
  runId: z.string(),
  file: z.string(),
  /** The part this submission answers, as fixContext handed it over. Omitted by
   * an unsplit fix pass, and by every submission written before parts existed —
   * those fall back to guessing the scope from the anchors carried. */
  part: z.number().int().nonnegative().optional(),
  fixes: z.array(FixSchema).transform((a) => a.slice(0, FIX_MAX_ITEMS)),
});
export type FixSubmitPayload = z.infer<typeof FixSubmitSchema>;

export const FileFixesSchema = z.object({
  file: z.string(),
  fixes: z.array(FixSchema).default([]),
  /** Entries refused as outside the submitting part, summed over every
   * submission. Carried to finalize: the count is reported to the fixer, which
   * is told not to re-send them and then stops, so this file is the only place
   * a human can still learn that something was thrown away. Defaulted for the
   * fix files written before parts existed. */
  dropped: z.number().int().nonnegative().default(0),
});
export type FileFixes = z.infer<typeof FileFixesSchema>;

export function fixesPath(runId: string, file: string, cwd: string): string {
  return join(runDir(runId, cwd), "fixes", `${reviewSlug(file)}.json`);
}

/** Recorded fixes for one file (empty when the pass never ran or is corrupt). */
export function loadFixes(runId: string, file: string, cwd: string): FileFixes {
  const p = fixesPath(runId, file, cwd);
  if (existsSync(p)) {
    try {
      const parsed = FileFixesSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (parsed.success && parsed.data.file === file) return parsed.data;
    } catch {
      /* unreadable/corrupt — treat as not run */
    }
  }
  return { file, fixes: [], dropped: 0 };
}

/**
 * Head boilerplate, the source preamble and the submit instructions, held back
 * from the part budget. The planner measures only what scales with the part —
 * the violation list and its source windows — so the fixed prose needs its own
 * reservation. Measured at ~1600 bytes; rounded up because the prose changes.
 */
const FIX_PART_OVERHEAD_BYTES = 3_000;

/** One violation as the context lists it. fixContext's head and the part
 * planner share this, so the planner measures the bytes actually sent. */
function violationLines(rows: FcqFileViolation[]): string[] {
  return rows.map(
    (v) =>
      `- L${v.line ?? 0} [${v.severity}] ${v.analyzer}/${v.ruleId} — ${v.description}` +
      (v.message ? ` (${v.message})` : "") +
      (v.snippet?.length ? `\n  code:\n${v.snippet.map((l) => `    ${l}`).join("\n")}` : "")
  );
}

/**
 * Split the violations into parts that fit the budget, reusing the judge's
 * greedy fill. What is measured is the violation list PLUS the source windows
 * those violations need — together, against one budget.
 *
 * That pairing is the fix. The old assembly spent the budget on the list first
 * and gave the source whatever was left: 60 violations at ~700 bytes each ate
 * 42,000 of 45,000, the source loop broke on its first window, and the fixer
 * was handed "Only these line ranges are below: none" plus an instruction not
 * to fix what it cannot see. It submitted nothing, and a re-spawn recomputed
 * the identical budget and failed the identical way.
 */
function planFixParts(cwd: string, file: string, rows: FcqFileViolation[]): number[][] {
  const total = fileLineCount(cwd, null, file) ?? 0;
  const measure = (indices: number[]): number => {
    const picked = indices.map((index) => rows[index]!);
    const source = fixWindows(
      picked.map((v) => v.line ?? 0).filter((l) => l > 0),
      total
    ).reduce(
      (sum, [start, end]) => sum + byteLen(fileRead(cwd, null, file, start, end, end - start + 1)),
      0
    );
    return byteLen(violationLines(picked).join("\n")) + source;
  };
  const plan = planJudgeParts(rows.length, measure, FIX_CONTEXT_MAX_BYTES - FIX_PART_OVERHEAD_BYTES);
  // No violations is one empty part, not zero parts: every caller here indexes
  // by part, and `hasCoveragePart` has no meaning in the fix pass.
  return plan.findingParts.length ? plan.findingParts : [[]];
}

/** This file's fix-part plan: violation indices per part, in file order. The
 * orchestrator instructions and the submission scoping both recompute it, so
 * the same inputs must always yield the same plan. */
export function fixPartPlan(runId: string, file: string, cwd: string): number[][] {
  return planFixParts(cwd, file, readFcqFile(runDir(runId, cwd), file).slice(0, FIX_MAX_ITEMS));
}

/** Which parts of a file still have a violation nobody recorded a fix for. */
export interface FixPartGaps {
  /** Part numbers with at least one unfixed violation, ascending. */
  parts: number[];
  /** How many parts the file has at all. */
  total: number;
}

/**
 * The parts a recovery must actually spawn.
 *
 * finalize used to say "start at part=0 and follow what each submit names",
 * which re-serves every part that is already done and reaches the missing one
 * only after a chain of no-op f-fixers — if at all.
 */
export function unfixedFixParts(runId: string, file: string, cwd: string): FixPartGaps {
  const violations = readFcqFile(runDir(runId, cwd), file).slice(0, FIX_MAX_ITEMS);
  const plan = planFixParts(cwd, file, violations);
  const recorded = new Set(loadFixes(runId, file, cwd).fixes.map((f) => fixKey(f.line, f.ruleId)));
  const uncovered = (index: number): boolean =>
    !recorded.has(fixKey(violations[index]!.line, violations[index]!.ruleId));
  return {
    parts: plan.flatMap((indices, part) => (indices.some(uncovered) ? [part] : [])),
    total: plan.length,
  };
}

/** Everything the fixer subagent needs: the source, and every violation in it.
 * A file with more violations than fit the budget is fixed in several parts;
 * `part` selects one, and omitting it means the first (and, unsplit, the only). */
export function fixContext(runId: string, file: string, cwd: string, part?: number): string {
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}. Call f_review_plan first (or check the runId).`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  if (meta.fcq?.status !== "ok") {
    return `No static-analysis result for run ${runId} — nothing to fix. Skip this file.`;
  }
  // Second gate, independent of the plan's file list: a partial fcq run leaves
  // most targets with no shard at all, and a fixer spawned for one of those has
  // nothing to work on. Say so plainly instead of handing it an empty prompt.
  const rows = readFcqFile(runDir(runId, cwd), file);
  if (!rows.length) {
    return (
      `✅ ${file} has no fcq violations${meta.fcq.partial ? " (fcq ran only partially — this file may simply not have been analysed)" : ""}. ` +
      `Nothing to fix; do NOT call f_review_fix_submit for this file.`
    );
  }

  const eligible = rows.slice(0, FIX_MAX_ITEMS);
  const plan = planFixParts(cwd, file, eligible);
  const requested = part ?? 0;
  // Validated before assembly: in the judge path an out-of-range part reached
  // the prompt builder, came back as an overflow, and terminalized the review.
  if (!Number.isInteger(requested) || requested < 0 || requested >= plan.length) {
    return `❌ part ${requested} does not exist for ${file} — this fix pass has ${plan.length} part(s) (0..${plan.length - 1}).`;
  }
  const shown = plan[requested]!.map((index) => eligible[index]!);
  const head = [
    `# Fix pass — ${file} (run ${runId})`,
    "",
    `${rows.length} static-analysis violation(s)` +
      (plan.length > 1
        ? `, part ${requested + 1}/${plan.length} — the ${shown.length} listed below are yours; other parts own the rest.`
        : rows.length > shown.length
          ? `, first ${shown.length} shown.`
          : "."),
    "Write the corrected code for EVERY one, whatever its severity: a MINOR",
    "style rule ships with only the rule text unless you replace it. Where a",
    "violation is genuinely wrong, mark it `falsePositive` with a one-line note",
    "instead of inventing a change. Where it needs a structural refactor no",
    "snippet swap expresses — a 64-line method to split, say — submit the entry",
    "anyway with a `note` naming the blocks to extract and the methods to make.",
    "Every violation above needs an entry; a violation you leave out is the one",
    "that ships unfixed.",
    "",
    "## Violations",
    ...violationLines(shown),
    "",
    "## Source",
  ];
  const tail = [
    "",
    "## Submit",
    "Call `f_review_fix_submit` with runId, file, and one entry per violation:",
    "`line` and `ruleId` exactly as listed above (they anchor the merge), then",
    "`asIs` (the code as it stands) and `toBe` (the corrected code) — code only,",
    "no AS-IS:/TO-BE: labels. Do NOT report new issues here; that is the",
    "reviewer's job and duplicates are dropped.",
  ];
  const budget = FIX_CONTEXT_MAX_BYTES - byteLen(head.join("\n")) - byteLen(tail.join("\n"));
  const body = [...head, ...fixSource(cwd, file, shown, budget), ...tail].join("\n");
  // The part number has to travel back with the submission: without it the
  // scope is guessed from the anchors, and one stray anchor then silences the
  // next part's send-back.
  return plan.length > 1
    ? `${body}\n\nThis file is fixed in ${plan.length} parts; submit with part=${requested}. ` +
        `After you submit, the orchestrator spawns a NEW f-fixer for the next part.`
    : body;
}

/**
 * The code the fixer is shown: the whole file when it fits the byte budget,
 * otherwise the windows around the violations, dropped from the end until it
 * does. Either way the note above it says exactly what is visible — the fixer
 * has no way to check, so it must be told rather than guess.
 */
function fixSource(
  cwd: string,
  file: string,
  shown: FcqFileViolation[],
  budget: number
): string[] {
  // Working tree, not the ref: the fix is written against the code as it is now.
  // The 6th argument is the line cap; passing FIX_FILE_MAX_LINES only as
  // end_line left the reader's 500-line default in force and truncated a
  // 900-line file despite the constant saying 2000.
  const whole = fileRead(cwd, null, file, 1, FIX_FILE_MAX_LINES, FIX_FILE_MAX_LINES);
  // Counted, not read off the rendered header: asking for lines 1..2000 of a
  // 2050-line file is "exactly what you asked for" to the reader, so its
  // IS_TRUNCATED says false while 50 lines are missing.
  const total = fileLineCount(cwd, null, file) ?? 0;
  if (total <= FIX_FILE_MAX_LINES && byteLen(whole) <= budget) {
    return ["This is the complete file. You have no read tools — everything you need is here.", whole];
  }

  const windows = fixWindows(
    shown.map((v) => v.line ?? 0).filter((l) => l > 0),
    total
  );
  const rendered: string[] = [];
  const visible: [number, number][] = [];
  let used = 0;
  for (const [start, end] of windows) {
    const chunk = fileRead(cwd, null, file, start, end, end - start + 1);
    if (used + byteLen(chunk) > budget) break;
    used += byteLen(chunk);
    rendered.push(chunk);
    visible.push([start, end]);
  }
  const covers = (line: number) => visible.some(([s, e]) => line >= s && line <= e);
  const unseen = shown.map((v) => v.line ?? 0).filter((l) => !covers(l));
  return [
    `⚠️ ${file} is ${total} lines — too large to show whole, and you have no read tools.`,
    `Only these line ranges are below: ${visible.map(([s, e]) => `L${s}-${e}`).join(", ") || "none"}.`,
    unseen.length
      ? `Do NOT enter fixes for the violation(s) at ${unseen.map((l) => `L${l}`).join(", ")} — that code is not shown. Submit only what you can see.`
      : "Every listed violation is inside a range above.",
    ...rendered,
  ];
}

/** Line + rule id, the anchor the fixer is given and the merge matches on.
 * The analyzer prefix is dropped so `checkstyle/MethodLength` and
 * `MethodLength` are the same violation.
 *
 * The byte between the two halves is an invisible U+001F, not a missing
 * separator: without one L1 + `1Foo` and L11 + `Foo` would both key `11foo`, and
 * since submitFix started MERGING on this key a collision would make one stored
 * fix silently overwrite another. U+001F rather than `:` because a rule id can
 * contain punctuation but never a control character. */
function fixKey(line: number | undefined, rule: string): string {
  return `${line ?? 0}${rule.slice(rule.lastIndexOf("/") + 1).toLowerCase()}`;
}

/**
 * The orchestrator instruction that keeps a split fix pass moving — the fix-side
 * mirror of the judge's nextPartInstruction.
 *
 * Without it, no tool result the orchestrator ever sees names a next part:
 * fixContext's "N parts" note goes to the FIXER, and the fixer is told to submit
 * once and stop. So part 0 was fixed, the orchestrator moved on, and parts
 * 1..N-1 shipped with the rule's own text — the precise failure the split was
 * built to prevent. Finalize's recovery could not undo it either: re-spawning
 * with no part just re-serves part 0.
 */
function nextFixPartInstruction(runId: string, file: string, next: number): string[] {
  return [
    `Spawn a NEW f-fixer subagent (fresh session) with this prompt:`,
    `  "Call f_review_fix_context with runId=\"${runId}\", file=\"${file}\", part=${next}, ` +
      `write the corrected code for every violation it lists, then call ` +
      `f_review_fix_submit with part=${next}."`,
  ];
}

/**
 * Persist one file's fixes, MERGED into what is already recorded.
 *
 * Not an overwrite: a file split across parts gets one submission per part, and
 * overwriting made part 2 erase part 1's work. Anchored on line + rule id, so
 * the same anchor resubmitted still wins (a retry stays idempotent) while a new
 * anchor is appended.
 */
export async function submitFix(payload: unknown, cwd: string): Promise<string> {
  const parsed = FixSubmitSchema.safeParse(payload);
  if (!parsed.success) return `Invalid fix submission: ${parsed.error.message}`;
  const { runId, file, fixes, part: declared } = parsed.data;
  const meta = loadRun(runId, cwd);
  if (!meta) return `Unknown run: ${runId}.`;
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}.`;
  }
  const violations = readFcqFile(runDir(runId, cwd), file).slice(0, FIX_MAX_ITEMS);
  const plan = planFixParts(cwd, file, violations);
  // Refused before the write, like the context's own range check: a part that
  // is not in the plan names no scope, and guessing one would put this
  // submission back on the anchor heuristic it was added to replace.
  if (declared !== undefined && declared >= plan.length) {
    return (
      `❌ part ${declared} does not exist for ${file} — this fix pass has ${plan.length} part(s) ` +
      `(0..${plan.length - 1}). Nothing was recorded; re-submit with the part f_review_fix_context gave you.`
    );
  }
  // The scoping below only holds if the part is actually declared, and a prompt
  // telling the fixer to declare it is not a gate: one submission that omits it
  // merges a stray anchor and silently reopens the case the scoping closes. So
  // a split file refuses an undeclared submission. An unsplit one — the only
  // shape that existed before parts — is untouched by this.
  if (declared === undefined && plan.length > 1) {
    return (
      `❌ ${file} is fixed in ${plan.length} part(s) and this submission names none — nothing was recorded. ` +
      `Re-submit with the \`part\` number f_review_fix_context gave you: without it these entries cannot be ` +
      `scoped to the violations you were actually shown.`
    );
  }
  const keyOf = (index: number): string => fixKey(violations[index]!.line, violations[index]!.ruleId);
  // A declared part IS the scope. An entry anchored outside it is a violation
  // this fixer was never shown, so it is dropped rather than stored: kept, it
  // made the owning part's violation read as already fixed, which both ate that
  // part's send-back and shipped invented code for a line nobody reviewed.
  const own = declared === undefined ? null : new Set(plan[declared]!.map(keyOf));
  const accepted = own ? fixes.filter((f) => own.has(fixKey(f.line, f.ruleId))) : fixes;
  const ignored = fixes.length - accepted.length;
  // Read before the write: what this part already recorded decides whether its
  // fixer is sent back for its gaps, and it must not be lost by the merge.
  const stored = loadFixes(runId, file, cwd);
  const previous = stored.fixes;
  const merged = new Map(previous.map((f) => [fixKey(f.line, f.ruleId), f]));
  for (const fix of accepted) merged.set(fixKey(fix.line, fix.ruleId), fix);
  const nextFixes = [...merged.values()];
  const body: FileFixes = { file, fixes: nextFixes, dropped: stored.dropped + ignored };
  await Bun.write(fixesPath(runId, file, cwd), JSON.stringify(body, null, 2));

  const withCode = accepted.filter((f) => f.toBe?.trim()).length;
  const fp = accepted.filter((f) => f.falsePositive).length;
  // Matched by anchor, not by count: two entries for one line while another
  // violation has none is exactly the gap a count comparison reports as clean.
  const entered = new Set(accepted.map((f) => fixKey(f.line, f.ruleId)));
  const already = new Set(previous.map((f) => fixKey(f.line, f.ruleId)));
  // A gap is a violation with no fix in the MERGED state — this submission's
  // entries plus what was already stored. Measuring against this submission
  // alone was right while submitFix overwrote; now that it merges, it reported
  // an earlier part's recorded fixes back as missing ("19 recorded, ⚠️ 20 have
  // no entry" for a file whose fixes were nearly complete).
  const gaps = (indices: number[]): FcqFileViolation[] =>
    indices
      .map((index) => violations[index]!)
      .filter((v) => !entered.has(fixKey(v.line, v.ruleId)) && !already.has(fixKey(v.line, v.ruleId)));
  // The part this submission answered — the declared one, or the only one there
  // is. A split fixer never saw another part's violations, so listing them back
  // at it is an instruction to write code for lines it was never shown. (The old
  // guess from the anchors is gone: with the guard above, an undeclared
  // submission can only ever belong to a single-part file.)
  const scope = plan[declared ?? 0]!;
  const missing = gaps(scope);
  // The next part to spawn: the first one no fixer has recorded anything for.
  // `declared + 1` walked the numbers instead, so a late resubmission of part 0
  // — now permitted — named part 1, which re-served, found its own work already
  // stored, took this same COMPLETE branch and named part 2, and so on: four
  // wasted f-fixer spawns on a five-part file. Skipping a part that HAS been
  // worked (rather than every part with a gap) is also what makes this
  // terminate — a part already sent back once is never re-served here.
  const worked = (indices: number[]): boolean => indices.some((index) => already.has(keyOf(index)));
  const nextPart = plan.findIndex(
    (indices, part) => part !== (declared ?? 0) && indices.length > 0 && !worked(indices)
  );
  // A fixer already sent back once is not sent back again — decided on this
  // part's OWN prior state, never on another part's recorded fixes.
  const fresh = scope.some((index) => already.has(keyOf(index))) ? [] : missing;
  const recorded = [
    `✅ ${file}: ${accepted.length} fix(es) recorded (${withCode} with code, ${fp} false positive(s)).`,
    ignored
      ? `ℹ️ ${ignored} entry(ies) were not for part ${declared} and were dropped — another f-fixer owns those violations. Do NOT re-send them.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!fresh.length) {
    return [
      recorded,
      missing.length
        ? `⚠️ ${missing.length} violation(s) still have no entry — they ship with the rule text only.`
        : "",
      "This subagent's task is COMPLETE.",
      ...(nextPart === -1 ? [] : nextFixPartInstruction(runId, file, nextPart)),
    ]
      .filter(Boolean)
      .join("\n");
  }
  // Not complete, and saying so is the point: this message used to report the
  // gap and declare the task done in consecutive lines, so a violation needing
  // a refactor rather than a snippet swap was simply dropped.
  return [
    recorded,
    `⚠️ ${fresh.length} violation(s) got NO entry and would ship with the rule text only:`,
    ...fresh.map(
      (v) => `- L${v.line ?? 0} [${v.severity}] ${v.analyzer}/${v.ruleId} — ${v.description}`
    ),
    `Call f_review_fix_submit again with the SAME entries PLUS one for each of these.`,
    `A violation needing a structural refactor no snippet swap expresses still gets`,
    `an entry — with a \`note\` naming the blocks to extract; a wrong one gets`,
    `\`falsePositive\`. Do NOT stop here; this is your last chance to enter them.`,
  ].join("\n");
}

/**
 * Apply recorded fixes to the fcq findings of one file.
 *
 * Anchored on line + rule id, the same pair the fixer was given. A false
 * positive keeps the row (the violation is real to fcq) but replaces the fix
 * with the reason, so the report never silently drops a hit.
 */
export function applyFixes<
  T extends { line?: number; rule: string; message: string; asIs?: string; toBe?: string },
>(
  findings: T[],
  fixes: Fix[]
): T[] {
  if (!fixes.length) return findings;
  const byKey = new Map(fixes.map((f) => [fixKey(f.line, f.ruleId), f]));
  return findings.map((f) => {
    const fix = byKey.get(fixKey(f.line, f.rule));
    if (!fix) return f;
    // A false positive has no code, so it goes in the message rather than the
    // TO-BE the report renders as a code block.
    if (fix.falsePositive) {
      const why = fix.note ?? "no change required";
      return { ...f, message: `${f.message}\n(오탐) ${why}`, asIs: f.asIs, toBe: undefined } as T;
    }
    return {
      ...f,
      ...(fix.asIs?.trim() ? { asIs: fix.asIs } : {}),
      ...(fix.toBe?.trim() ? { toBe: fix.toBe } : {}),
    };
  });
}

/** Every file's recorded fixes, for the finalize fingerprint. */
export function loadAllFixes(runId: string, files: string[], cwd: string): FileFixes[] {
  return files.map((file) => loadFixes(runId, file, cwd));
}

/** Per-file fix coverage for the finalize summary. */
export function fixCoverage(
  runId: string,
  files: string[],
  cwd: string
): { file: string; violations: number; fixed: number; dropped: number }[] {
  return files.map((file) => {
    const recorded = loadFixes(runId, file, cwd);
    return {
      file,
      violations: readFcqFile(runDir(runId, cwd), file).length,
      fixed: recorded.fixes.filter((f) => f.toBe?.trim() || f.falsePositive).length,
      dropped: recorded.dropped,
    };
  });
}

/** Severities the fix pass is expected to cover — every one fcq reports. */
export const FIX_SEVERITIES = FCQ_SEVERITIES;
export type { FcqFileViolation };
