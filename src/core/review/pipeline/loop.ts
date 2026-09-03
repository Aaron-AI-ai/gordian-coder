/**
 * The reviewer session in flight: exploration guard, submission, completion.
 *
 * guardExploration counts every tool call against the session budget and
 * starves a degenerate loop — past the budget the output is withheld entirely,
 * because returning content keeps a runaway loop fed.
 *
 * submitReview validates a submission, runs the pre-report final check, and
 * advances to the next target; when the last one passes, the session either
 * writes its per-file artifact (run mode) or renders the whole report.
 * onSessionIdle is the watchdog for the case where the model simply stops.
 *
 * Starting a session is start.ts; the per-round prompt is prompt.ts.
 */

import { REQUIRED_CATEGORIES, SubmitSchema, coverage, degenerateReason, verdict, type Finding, type Severity,
  hasFix,
} from "../contract";

import { resolveOutputPath, writeReport, renderReport } from "../report/output";
import { writeFileReview } from "./run-store";
import { type FileReviewResult } from "./artifact";

import { getState, clearState, currentFile, isDone, rotateSubmitToken, type ReviewState } from "./state";
import { fileRead, renderFileContent, sanitizeFindingLines, MAX_ITER } from "../tools/read";
import { languageName } from "./prompt";

import { targetPath } from "./segment";

export const NO_ACTIVE_REVIEW = "No active review. Call f_review_context first.";

/** Max times a single file can be sent back for rework by the final check.
 * The file passes as soon as the check is clean, or once this cap is hit. */
export const MAX_FINAL_RECHECKS = 5;

/** Max times the idle watchdog re-drives an incomplete review (LLM stopped
 * before submitting every file). Past this, finalize a partial report. */
export const MAX_RESUMES = 3;

/** Max rejected submits (schema-invalid / coverage-missing / degenerate text)
 * per file. Past this, salvage what parsed and force-advance — a small model
 * looping on the same broken payload must not stall the review forever. */
export const MAX_FAILED_SUBMITS = 5;

/** Max times the SAME tool call (identical args) is answered per target/round;
 * past this, the output is withheld — a looping model gets no new content. */
export const MAX_DUP_CALLS = 2;

/** Max CONSECUTIVE not-found exploration results; past this, output is
 * withheld. Catches the "hunt an external symbol with endless pattern
 * variations" loop that exact-duplicate detection cannot see — each attempt
 * differs, but they all miss. Any hit resets the streak. */
export const MAX_MISS_STREAK = 4;

/** Not-found openings of the reader ops (see reader.ts / evidence.ts). */
const MISS_PREFIXES = [
  "No matches for:", // code_search
  "// No file matches", // file_find
  "Error: file not found", // file_read
  "Error: diff not found", // file_read_diff
  "No related code candidates", // related_code
  "No git history found", // git_history
];

/** Count an exploration call (logged per file/tool for the final check) and
 * guard against degenerate loops: past MAX_ITER the output is withheld entirely
 * (returning content past the budget keeps a runaway loop fed), and an exact
 * duplicate call (same tool + args, tracked when the adapter passes `args`) is
 * answered at most MAX_DUP_CALLS times. The op itself still runs — it's local
 * and cheap; the defense is starving the loop of fresh tokens. */
export function guardExploration(
  st: ReviewState,
  tool: string,
  out: string,
  args?: unknown
): string {
  if (st.explorationSealed) {
    return (
      `⚠️ Exploration is sealed for this reviewer session (${st.toolCalls}/${st.maxToolCalls} ` +
      `tool calls used). Output withheld. Call f_review_submit now.`
    );
  }
  const file = currentFile(st);
  if (file) {
    const log = (st.callLog[file] ??= {});
    log[tool] = (log[tool] ?? 0) + 1;
  }
  st.iterations++;
  const budget = st.maxIter ?? MAX_ITER;
  if (st.iterations > budget) {
    return `⚠️ Exploration limit reached (${budget} calls this round) — output withheld. Review with what you have and call f_review_submit now. Do not fetch more context through any other tool.`;
  }
  if (args !== undefined) {
    const key = JSON.stringify([file ?? "", tool, Bun.hash(JSON.stringify(args)).toString()]);
    const n = (st.dupCalls[key] = (st.dupCalls[key] ?? 0) + 1);
    if (n > MAX_DUP_CALLS) {
      return (
        `⚠️ Duplicate call — this exact ${tool} call already ran ${MAX_DUP_CALLS} times and its result does not change; output withheld. ` +
        `Explore something different or call f_review_submit for ${file ?? "the current file"} — do not re-fetch this content through any other tool.`
      );
    }
  }
  const miss = MISS_PREFIXES.some((p) => out.startsWith(p));
  st.missStreak = miss ? st.missStreak + 1 : 0;
  if (miss && st.missStreak >= MAX_MISS_STREAK) {
    return (
      `⚠️ ${st.missStreak} consecutive lookups found NOTHING — output withheld. What you are ` +
      `hunting was not resolved by the allowed targeted lookups; it may be external, generated, ` +
      `or a local alias the resolver cannot map. STOP retrying path/name variations with any tool. ` +
      `Review with the evidence you already have and call f_review_submit.`
    );
  }
  return out;
}

/** Content of a review RULE file listed in the prompt (reference mode), or
 * null when `path` is not a loaded rule. Rules are review INPUTS read from the
 * working tree at load time — the git-ref-scoped file_read would miss
 * untracked/uncommitted rule files, silently no-op'ing the reference feature —
 * so adapters serve them from state before falling back to fileRead. */
export function ruleFileContent(
  st: ReviewState,
  path: string,
  startLine?: number,
  endLine?: number
): string | null {
  const norm = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const rule = st.extraRules.find((r) => r.file === norm);
  return rule ? renderFileContent(norm, rule.content, startLine, endLine) : null;
}

/** One-shot pre-report check, driven by the session's tool-call log. Only
 * flags what the model can still fix by resubmitting the last file. */
function finalCheckNotes(
  st: ReviewState,
  file: string,
  findings: { severity: Severity; asIs?: string; toBe?: string; suggestion?: string }[]
): string[] {
  const notes: string[] = [];
  if (!Object.keys(st.callLog[file] ?? {}).length) {
    notes.push(
      `- ${file} was submitted without any exploration call (auto-injected evidence only). ` +
        `If the change is non-trivial, verify with file_read / related_code first.`
    );
  }
  const noFix = findings.filter(
    (f) => (f.severity === "blocker" || f.severity === "major") && !hasFix(f)
  ).length;
  if (noFix) notes.push(`- ${noFix} blocker/major finding(s) lack a concrete \`suggestion\`.`);
  return notes;
}

/** The rework message driving one deep-review round: echoes what was just
 * submitted and focuses the round — 2: refute/hunt, middle: edge cases,
 * last: calibrate & polish. The resubmission REPLACES the previous findings. */
function deepPassInstruction(
  file: string,
  round: number,
  total: number,
  findings: Finding[]
): string {
  const echo = findings.length
    ? findings.map((f) => `  - [${f.severity}/${f.category}] L${f.line ?? "?"} ${f.rule}`).join("\n")
    : "  (none)";
  // Round focuses compose: 2 = adversarial refute, middle = deepen, last =
  // calibrate. A round can be both (e.g. 2/2 gets refute AND calibrate).
  const focus: string[] = [];
  if (round === 2) {
    focus.push(
      `- Try to REFUTE each finding above: re-read the code (file_read / code_search) and drop any that don't hold.`,
      `- Hunt for what round 1 missed — go category by category (correctness, security, performance, maintainability, tests, framework).`,
      `- Verify every line anchor against the actual file.`
    );
  }
  if (round > 2 && round < total) {
    focus.push(
      `- Deepen the analysis: edge cases, error/exception paths, boundary values, concurrency, resource leaks.`,
      `- Follow one caller/callee you have not read yet (related_code / code_search) and check the contract holds.`
    );
  }
  if (round === total) {
    focus.push(
      `- Calibrate each severity honestly (blocker | major | minor | nit) — no inflation, no burying.`,
      `- Give every blocker/major a concrete \`suggestion\` (code or exact steps).`,
      `- Merge duplicates; drop anything you cannot defend with evidence.`
    );
  }
  return [
    `🔁 Deep review round ${round}/${total} for ${file}. Your previous findings:`,
    echo,
    ``,
    ...focus,
    ``,
    `Then call f_review_submit again with the COMPLETE, refined finding set for ${file}`,
    `(your resubmission replaces the previous one).`,
  ].join("\n");
}

/** Commit `findings` for `file` and advance the loop; on the last file, write
 * the report and clear the session. `note` marks a forced (salvage) accept. */
async function acceptFile(
  st: ReviewState,
  file: string,
  findings: Finding[],
  sessionId: string,
  note = "",
  assessed: readonly (typeof REQUIRED_CATEGORIES)[number][] = st.categories
): Promise<string> {
  // A forced (salvage) accept must survive into the report/run result — the
  // chat string alone is lost when this is the last target (isDone below).
  if (note) st.forcedNotes[file] = note;
  const forcedNote = st.forcedNotes[file] ?? "";
  st.assessedByTarget[file] = [...new Set(assessed)];
  // Drop line numbers that point past the end of their file (hallucinated anchors).
  sanitizeFindingLines(findings, st.cwd, st.ref);
  // Dedupe exact repeats — a looping model may submit the same finding N times.
  const seen = new Set<string>();
  st.findings[file] = findings.filter((f) => {
    const key = JSON.stringify(f);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  st.currentIndex++;
  rotateSubmitToken(st);
  st.iterations = 0; // reset the exploration budget for the next file
  st.dupCalls = {}; // the next target may legitimately repeat earlier calls
  st.missStreak = 0;

  if (!isDone(st)) {
    const response = forcedNote
      ? `⚠️ ${file} force-advanced after bounded recovery (${st.findings[file].length} issue(s) salvaged)${forcedNote}. Next file: ${currentFile(st)}.`
      : `✅ ${file} reviewed (${st.findings[file].length} issue(s)). Next file: ${currentFile(st)}.`;
    return response;
  }

  // Run mode writes this file's own review under the run dir; the aggregate
  // report is written once, by f_review_finalize — never by a subagent.
  return st.runId ? writeRunReview(st, sessionId, false) : finalizeReport(st, sessionId, false);
}

/** Validate a submit payload, gate on category coverage, advance the loop.
 * On the last file: write the report and clear the session. */
export async function submitReview(payload: unknown, sessionId: string): Promise<string> {
  const st = getState(sessionId);
  if (!st?.active) return NO_ACTIVE_REVIEW;

  const file = currentFile(st);
  if (!file) return "No current file under review.";

  // Every rejection (schema / degenerate text / coverage) funnels through this
  // counter: within the cap it bounces back to the model, past the cap it
  // returns null and the caller salvages what it can and force-advances —
  // otherwise a degenerate model resubmitting the same broken payload loops forever.
  const reject = (msg: string): string | null => {
    const n = (st.failedSubmits[file] = (st.failedSubmits[file] ?? 0) + 1);
    return n <= MAX_FAILED_SUBMITS
      ? `${msg}\n(rejected submit ${n}/${MAX_FAILED_SUBMITS} for ${file} — past the cap the review force-advances.)`
      : null;
  };

  const parsed = SubmitSchema.safeParse(payload);
  if (!parsed.success) {
    const bounce = reject(`Invalid submission: ${parsed.error.message}`);
    if (bounce) return bounce;
    // Past the cap: salvage the findings of the last submit that DID parse
    // (bounced on coverage/degenerate/final check) — never commit an empty
    // review when real findings were already on the table.
    const salvaged = st.lastValidFindings[file] ?? [];
    const response = await acceptFile(
      st,
      file,
      salvaged,
      sessionId,
      ` — forced after repeated invalid submissions${salvaged.length ? " (salvaged an earlier submit's findings)" : ""}`,
      []
    );
    return response;
  }

  if (parsed.data.submitToken !== undefined && parsed.data.submitToken !== st.submitToken) {
    const stale = (st.staleSubmits[file] = (st.staleSubmits[file] ?? 0) + 1);
    if (stale <= MAX_FAILED_SUBMITS) {
      return (
        `ℹ️ Stale/duplicate f_review_submit ignored; no state changed ` +
        `(${stale}/${MAX_FAILED_SUBMITS}). Use CURRENT_SUBMIT_TOKEN=${st.submitToken} for ${file}.`
      );
    }
    return acceptFile(
      st,
      file,
      st.lastValidFindings[file] ?? [],
      sessionId,
      " — forced after repeated stale submit-token replays",
      []
    );
  }

  // A valid current-token submit proves the model recovered from any stale
  // replay. Count only a consecutive stale loop, not occasional one-step lag
  // across legitimate deep-pass/final-check token rotations.
  st.staleSubmits[file] = 0;

  const realFile = targetPath(file);
  const wrongFile = parsed.data.findings.find((finding) => finding.file !== realFile);
  if (wrongFile) {
    const bounce = reject(
      `❌ Finding file mismatch: current target ${JSON.stringify(file)} requires every finding.file ` +
        `to be the real path ${JSON.stringify(realFile)}, received ${JSON.stringify(wrongFile.file)}.`
    );
    if (bounce) return bounce;
    return acceptFile(
      st,
      file,
      st.lastValidFindings[file] ?? [],
      sessionId,
      " — forced after repeated finding-file mismatches",
      []
    );
  }

  // Identical-payload loop detection: the model resubmitted byte-for-byte the
  // payload the final check already bounced — re-bouncing with the same notes
  // is pointless, so accept instead. Only the final check arms this (see below):
  // deep-pass rounds each give a DIFFERENT instruction, and an identical
  // resubmission there is honest convergence, not a loop.
  const { submitToken: _submitToken, ...semanticSubmit } = parsed.data;
  const hash = Bun.hash(JSON.stringify(semanticSubmit)).toString();
  const repeat = st.lastSubmitHash[file] === hash;

  // Degenerate-output guard: drop findings whose prose is runaway repetition or
  // an unexpected script (e.g. Chinese text in a Korean review) — small-model
  // glitches. Bounce for a rewrite while the cap allows; past it, keep the
  // clean findings and continue.
  let findings = parsed.data.findings;
  const degenerate = findings
    .map((f) => ({ f, reason: degenerateReason(f, st.language) }))
    .filter((d) => d.reason);
  findings = findings.filter((f) => !degenerate.some((d) => d.f === f));
  // Salvage source for the invalid-submission force path above.
  st.lastValidFindings[file] = findings;
  if (degenerate.length) {
    const bounce = reject(
      `❌ ${degenerate.length} finding(s) rejected as degenerate output ` +
        `(${[...new Set(degenerate.map((d) => d.reason))].join("; ")}). ` +
        `Rewrite them in ${languageName(st.language)} and resubmit the full set for ${file}.`
    );
    if (bounce) return bounce;
    // The bounded escape continues with only the non-degenerate subset, but it
    // is not a clean quality pass: persist the degraded marker through final
    // acceptance so an empty salvaged set can never produce a findings-only PASS.
    st.forcedNotes[file] = " — forced after repeated degenerate outputs (invalid findings dropped)";
  }

  const missing = coverage(parsed.data.assessed, st.categories);
  if (missing.length) {
    const response = await (
      reject(
        `❌ Incomplete — categories not assessed: ${missing.join(
          ", "
        )}. Keep analyzing this file, then resubmit.`
      ) ??
        acceptFile(
          st,
          file,
          findings,
          sessionId,
          " — forced with incomplete coverage",
          parsed.data.assessed
        )
    );
    return response;
  }

  // A complete, non-degenerate submission proves recovery from earlier schema,
  // file, or coverage mistakes. Bound consecutive malformed output without
  // penalizing one corrected mistake in each legitimate review round.
  if (!degenerate.length) st.failedSubmits[file] = 0;

  // Deep-pass gate: with deepPasses > 1, the first (deepPasses - 1) clean
  // submissions for a target are NOT accepted — each one bounces back with a
  // round-specific instruction to re-analyze, so the model iterates on its own
  // findings. Bounded by deepPasses (≤ MAX_DEEP_PASSES), so it cannot loop —
  // which is also why an identical resubmission does NOT skip it: a converged
  // round still owes the user the remaining rounds' (different) instructions.
  const done = st.deepPassDone[file] ?? 0;
  if (done < st.deepPasses - 1) {
    st.deepPassDone[file] = done + 1;
    rotateSubmitToken(st);
    // MAX_ITER is a per-ROUND budget, not per-file: the round instruction below
    // explicitly orders a re-read ("REFUTE each finding: re-read the code"), so
    // carrying a spent budget over would answer that order with "exploration
    // limit reached — submit now". Still bounded: deepPasses ≤ MAX_DEEP_PASSES,
    // so a file can never exceed MAX_DEEP_PASSES × MAX_ITER exploration calls.
    st.iterations = 0;
    st.dupCalls = {}; // the round instruction orders re-reads — don't answer them with "duplicate"
    st.missStreak = 0;
    return deepPassInstruction(file, done + 2, st.deepPasses, findings);
  }

  // Per-file check before this file's findings are committed and the loop
  // advances: use the session call log to catch skipped essentials while a
  // resubmit can still fix THIS file. Sends the file back for rework up to
  // MAX_FINAL_RECHECKS times; it passes as soon as the check is clean, or once
  // the cap is hit — so it can never loop forever.
  const tries = st.recheckCount[file] ?? 0;
  const notes = finalCheckNotes(st, file, findings);
  if (!repeat && notes.length && tries < MAX_FINAL_RECHECKS) {
    st.recheckCount[file] = tries + 1;
    rotateSubmitToken(st);
    st.lastSubmitHash[file] = hash; // arm the repeat detector: same payload again → accept
    // The notes order re-verification ("verify with file_read", write concrete
    // suggestions) — like the deep-pass bounce, give the round a fresh budget
    // or the ordered re-reads come back "output withheld". Still bounded:
    // MAX_FINAL_RECHECKS × MAX_ITER.
    st.iterations = 0;
    st.dupCalls = {};
    st.missStreak = 0;
    return [
      `🔎 Final check for ${file} (attempt ${tries + 1}/${MAX_FINAL_RECHECKS}):`,
      ...notes,
      `Address what applies, then call f_review_submit again for ${file}.`,
    ].join("\n");
  }

  return acceptFile(st, file, findings, sessionId, "", parsed.data.assessed);
}

/** Run-mode completion: persist THIS session's single-file review (md + json)
 * into the run directory and end the session. `partial` marks a review the
 * watchdog cut off before every segment was submitted. */
async function writeRunReview(
  st: ReviewState,
  sessionId: string,
  partial: boolean
): Promise<string> {
  const file = targetPath(st.targets[0]); // single file per run session (segments share it)
  // Merge segment-keyed findings back under the real file path.
  const merged = Object.values(st.findings).flat();
  const explorationCalls = Object.values(st.callLog)
    .flatMap((byTool) => Object.values(byTool))
    .reduce((a, b) => a + b, 0);
  // A force-advanced (salvage) target must not persist as a clean, complete
  // review — carry the note into the run result so finalize can surface it.
  const forced = st.targets.map((t) => st.forcedNotes[t]).filter(Boolean).join(";").slice(0, 4000);
  const assessed = [
    ...new Set(st.targets.flatMap((target) => st.assessedByTarget[target] ?? [])),
  ];
  const result: FileReviewResult = {
    file,
    assessed,
    findings: merged,
    explorationCalls,
    partial,
    coverageComplete: !partial && !forced,
    ...(forced ? { forced } : {}),
  };
  const partialReason = st.toolBudgetExhausted
    ? `The reviewer reached maxToolCalls=${st.maxToolCalls} after ${st.toolCalls} tool calls.`
    : `Only ${Object.keys(st.findings).length}/${st.targets.length} segment(s) completed.`;
  const quality = partial || forced
    ? [
        "",
        "## Review Quality",
        "",
        "- Status: **INCOMPLETE**",
        ...(partial ? [`- ${partialReason}`] : []),
        ...(forced ? [`- Bounded recovery force-advanced one or more targets:${forced}`] : []),
        "",
      ].join("\n")
    : "";
  const md = `${renderReport({ [file]: merged }, `run ${st.runId} · ${st.label}`, st.language)}${quality}`;
  const path = await writeFileReview(st.runId!, result, md, st.cwd);
  st.active = false;
  clearState(sessionId);
  const head = partial
    ? st.toolBudgetExhausted
      ? `⚠️ ${file} review stopped at maxToolCalls=${st.maxToolCalls}; partial review saved.`
      : `⚠️ ${file} partially reviewed (${Object.keys(st.findings).length}/${st.targets.length} segment(s)); partial review saved.`
    : forced
      ? `⚠️ ${file} force-advanced after bounded recovery (${merged.length} issue(s) salvaged)${forced}; incomplete review saved with a forced marker.`
      : `✅ ${file} reviewed (${merged.length} issue(s)); review saved.`;
  return `${head} ${path}\nThis subagent's task is COMPLETE. Do not review any other file.`;
}

/** Write the report, clear the session, and build the summary line. Shared by
 * normal completion (submitReview) and the watchdog's partial finalize.
 * `partial` marks a finalize forced before every file was reviewed. */
async function finalizeReport(
  st: ReviewState,
  sessionId: string,
  partial: boolean
): Promise<string> {
  // Session id in the filename: the in-process clash suffix (startReview) can't
  // see sessions in OTHER processes, so two same-commit reviews finalizing in
  // the same second would otherwise collide.
  const path = resolveOutputPath(st.output, `${st.label}-${sessionId.slice(-6)}`, st.cwd);
  // Findings are keyed per target (a large file's segments each have their own
  // key); merge them back under the real file path so the report groups by file.
  const report: Record<string, Finding[]> = {};
  for (const [target, fs] of Object.entries(st.findings)) {
    (report[targetPath(target)] ??= []).push(...fs);
  }
  const all = Object.values(st.findings).flat();
  const forcedTargets = Object.keys(st.forcedNotes);
  const degraded = partial || forcedTargets.length > 0;
  // A partial/forced terminal result must never render a findings-only PASS in
  // the persisted artifact: failOn is suppressed for degraded runs and the
  // fail-closed verdict travels in the returned summary line. The report itself
  // stays findings-only (no quality appendix).
  await writeReport(
    path,
    report,
    st.label,
    st.cwd,
    st.language,
    degraded ? undefined : st.failOn,
    st.baseline,
    new Date(),
    st.reportContext
  );
  st.active = false;
  clearState(sessionId);
  let gate = "";
  if (st.failOn) {
    if (degraded) {
      gate = ` Verdict: FAIL — review incomplete (failOn: ${st.failOn}).`;
    } else {
      const v = verdict(all, st.failOn);
      gate = v.pass
        ? ` Verdict: PASS (failOn: ${st.failOn}).`
        : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${st.failOn}.`;
    }
  }
  // Informational: reviewed targets that used no exploration calls (auto-evidence
  // only). Scoped to reviewed targets so a partial report doesn't flag the ones
  // that were never reached.
  const reviewed = Object.keys(st.findings);
  const unexplored = reviewed.filter((f) => !Object.keys(st.callLog[f] ?? {}).length);
  const audit = unexplored.length
    ? ` ⚠️ ${unexplored.length} target(s) reviewed without exploration calls: ${unexplored.slice(0, 5).join(", ")}${unexplored.length > 5 ? ", …" : ""}.`
    : "";
  // Force-accepted targets (salvage path) — a clean-looking count must not
  // hide that some files never passed a real submit.
  const forcedWarn = forcedTargets.length
    ? ` ⚠️ ${forcedTargets.length} target(s) force-advanced after repeated rejected submits: ${forcedTargets.slice(0, 5).join(", ")}${forcedTargets.length > 5 ? ", …" : ""}.`
    : "";
  const fileCount = Object.keys(report).length; // distinct real files (segments merged)
  const head = partial
    ? st.toolBudgetExhausted
      ? `⚠️ Review incomplete — maxToolCalls=${st.maxToolCalls} reached; ${reviewed.length}/${st.targets.length} target(s) reviewed and partial report written.`
      : `⚠️ Review incomplete — ${reviewed.length}/${st.targets.length} target(s) reviewed after ${MAX_RESUMES} auto-resumes; partial report written.`
    : forcedTargets.length
      ? `⚠️ Review incomplete — bounded recovery force-advanced ${forcedTargets.length} target(s); ${fileCount} file(s), ${all.length} issue(s) salvaged.`
      : `✅ Review complete — ${fileCount} file(s), ${all.length} issue(s).`;
  return `${head}${gate}${audit}${forcedWarn} Report: ${path}`;
}

/** Turn-end watchdog. Called when the session goes idle (the LLM stopped). If a
 * review is active but not every file was submitted, re-drive it up to
 * MAX_RESUMES times; past the cap, finalize a partial report. Returns null when
 * there is nothing to do (no active review, or it already finished). */
export async function onSessionIdle(
  sessionId: string
): Promise<{ kind: "resume"; text: string } | { kind: "finalized"; text: string } | null> {
  const st = getState(sessionId);
  if (!st?.active || isDone(st)) return null;
  if (st.toolBudgetExhausted) {
    return {
      kind: "finalized",
      text: st.runId
        ? await writeRunReview(st, sessionId, true)
        : await finalizeReport(st, sessionId, true),
    };
  }
  if (st.resumes < MAX_RESUMES) {
    st.resumes++;
    return {
      kind: "resume",
      text:
        `Review incomplete: ${st.currentIndex}/${st.targets.length} file(s) submitted. ` +
        `Continue with ${currentFile(st)} and call f_review_submit for each remaining file ` +
        `(auto-resume ${st.resumes}/${MAX_RESUMES}).`,
    };
  }
  return {
    kind: "finalized",
    // Run mode: save what this subagent got through as a partial per-file
    // review — finalize's coverage check will surface it. Never write the
    // aggregate report from a subagent session.
    text: st.runId
      ? await writeRunReview(st, sessionId, true)
      : await finalizeReport(st, sessionId, true),
  };
}
