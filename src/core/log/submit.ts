/**
 * f_log_submit: validate the analyst's hypothesis against the plan's
 * observations and the session's call log, store it, close the session.
 * Every rejection is counted; past MAX_FAILED_SUBMITS the last parseable
 * payload (or an empty one) is accepted as `forced` so a degenerate model
 * cannot stall the run (spec §10). The idle watchdog stores a `partial`
 * submission when the model simply stops (spec §13 #12).
 */
import { z } from "zod";
import { capped, describeScripts, strayScript } from "../review/contract";
import { kbConfigMisses, kbDocsForCode, type KbDoc } from "../kb/framework-kb";
import { KB_DOC_MAX_CHARS, recordKbShown } from "./context";
import { normalizeRepoPath } from "../review/imports";
import { readFileAt } from "../review/tools/read";
import { MAX_FAILED_SUBMITS, MAX_RESUMES } from "../review/pipeline/loop";
import { languageName } from "../review/pipeline/prompt";
import { MAX_OBSERVATIONS, type LogPlan } from "./plan";
import { mergeCallLog, readRunJson, submissionCount, writeRunJson, type RunMeta } from "./run-store";
import { clearLogState, getLogState, type LogSession } from "./state";
import { NO_ACTIVE_LOG } from "./tools";

const lineRange = z.tuple([z.number().int().positive(), z.number().int().positive()]);

export const LogSubmitSchema = z.object({
  runId: z.string().min(1),
  submitToken: z.string().min(1),
  cause: z.object({
    file: capped(500),
    line: z.number().int().positive().optional(),
    summary: capped(500),
    mechanism: capped(3000),
  }),
  evidence: z.array(z.object({ file: capped(500), lines: lineRange, why: capped(500) })).min(1).max(20),
  observations: z.array(z.object({ observation: capped(500), explained: z.boolean(), how: capped(500).optional() })).max(MAX_OBSERVATIONS),
  alternatives: z.array(z.object({ hypothesis: capped(500), rejectedBecause: capped(500) })).min(1).max(10),
  resolution: z.object({
    summary: capped(1000),
    changes: z.array(z.object({
      file: capped(500),
      description: capped(1000),
      // 수정 후 모습 그대로의 코드/설정 조각. 설명만으로는 적용할 수 없다.
      code: capped(4000).optional(),
    })).max(20),
    kind: z.enum(["root-cause", "mitigation"]),
  }),
  confidence: z.number().min(0).max(100),
  envCause: z.boolean().optional(),
});
export type LogSubmission = z.infer<typeof LogSubmitSchema>;

export interface StoredSubmission extends LogSubmission {
  round: number;
  forced?: string;
  partial?: boolean;
  submittedAt: string;
}

export function nextStepText(runId: string, judge: boolean): string {
  return judge
    ? `Next: spawn ONE f-log-judge subagent — "Judge log run ${runId}: call f_log_judge_context with runId \\"${runId}\\", then f_log_judge."`
    : `Next: call f_log_finalize with runId ${runId}.`;
}

function emptySubmission(runId: string): LogSubmission {
  return {
    runId, submitToken: "",
    cause: { file: "", summary: "", mechanism: "" },
    evidence: [{ file: "", lines: [1, 1], why: "" }],
    observations: [], alternatives: [{ hypothesis: "", rejectedBecause: "" }],
    resolution: { summary: "", changes: [], kind: "mitigation" },
    confidence: 0,
  };
}

function store(st: LogSession, sub: LogSubmission, sessionId: string, extra: { forced?: string; partial?: boolean }): string {
  const meta = readRunJson<RunMeta>(st.runId, st.cwd, "run.json");
  const round = submissionCount(st.runId, st.cwd) + 1;
  const stored: StoredSubmission = { ...sub, submitToken: "", round, submittedAt: new Date().toISOString(), ...extra };
  writeRunJson(st.runId, st.cwd, `submission-${round}.json`, stored);
  mergeCallLog(st.runId, st.cwd, st.callLog);
  // Finalize (another session) needs which suspects were actually read.
  writeRunJson(st.runId, st.cwd, "readFiles.json", [...new Set([...(readRunJson<string[]>(st.runId, st.cwd, "readFiles.json") ?? []), ...Object.keys(st.readFiles ?? {})])]);
  st.active = false;
  st.submitted = true;
  clearLogState(sessionId);
  const badge = extra.partial ? "⚠️ Partial submission stored (analyst stopped)" : extra.forced ? `⚠️ Submission forced through${extra.forced}` : "✅ Submission recorded";
  return `${badge} for run ${st.runId}, round ${round}. ${nextStepText(st.runId, meta?.judge ?? true)}`;
}

/** KB pages one fix-code check may hand back — the bounce rides in a tool result. */
const KB_FIX_MAX_DOCS = 3;

interface ConstantUse {
  decl: string;
  /** The repository line that hands the constant to a framework method. */
  use: string;
  where: string;
  docs: KbDoc[];
}

/**
 * Constants the fix code (re)declares whose repository use site passes them to
 * a KB class's method: `MASK_TYPE = "8"` means nothing until
 * `StringUtils.masking(p, MASK_TYPE)` says which values that method accepts.
 * ponytail: use sites in the changed file only; constants shared across files are missed.
 */
function constantUses(cwd: string, changes: { file: string; code?: string }[]): ConstantUse[] {
  const uses: ConstantUse[] = [];
  for (const ch of changes) {
    const decls = [...(ch.code ?? "").matchAll(/\bfinal\s+[\w.<>[\]]+\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g)];
    if (!decls.length) continue;
    const text = readFileAt(cwd, null, ch.file); // contained in the repo, like every other f-log read
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (const [, name, value] of decls) {
      // the constant as an argument of `Cls.method(` — up to the first `)`, so nested calls before it are missed
      const call = new RegExp(`\\b([A-Z]\\w*)\\.\\w+\\s*\\([^;)]*\\b${name}\\b`, "g");
      lines.forEach((line, i) => {
        const classes = [...line.matchAll(call)].map((m) => m[1]).join(" ");
        const docs = classes ? kbDocsForCode(cwd, classes, KB_FIX_MAX_DOCS) : [];
        if (docs.length) uses.push({ decl: `${name} = ${value.trim()}`, use: line.trim(), where: `${ch.file}:${i + 1}`, docs });
      });
    }
  }
  return uses;
}

export function submitLog(payload: unknown, sessionId: string): string {
  const st = getLogState(sessionId);
  if (!st?.active) return NO_ACTIVE_LOG;

  const reject = (msg: string): string | null => {
    st.failedSubmits++;
    return st.failedSubmits <= MAX_FAILED_SUBMITS
      ? `${msg}\n(rejected submit ${st.failedSubmits}/${MAX_FAILED_SUBMITS} — past the cap the last valid payload is force-accepted.)`
      : null;
  };

  const parsed = LogSubmitSchema.safeParse(payload);
  if (!parsed.success) {
    const bounce = reject(`Invalid submission: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (bounce) return bounce;
    const last = (st.lastValid as LogSubmission | undefined) ?? emptySubmission(st.runId);
    return store(st, last, sessionId, { forced: ` — after ${MAX_FAILED_SUBMITS} invalid submissions${st.lastValid ? " (salvaged an earlier payload)" : " (nothing valid was ever submitted)"}` });
  }
  const sub = parsed.data;
  if (sub.runId !== st.runId) return `⚠️ This session analyzes run ${st.runId}, not ${sub.runId}. Use runId ${st.runId}.`;

  if (sub.submitToken !== st.submitToken) {
    st.staleSubmits++;
    if (st.staleSubmits <= MAX_FAILED_SUBMITS) {
      return `ℹ️ Stale/duplicate f_log_submit ignored; no state changed (${st.staleSubmits}/${MAX_FAILED_SUBMITS}). Use CURRENT_SUBMIT_TOKEN=${st.submitToken}.`;
    }
    const last = (st.lastValid as LogSubmission | undefined) ?? { ...sub, submitToken: st.submitToken };
    return store(st, last, sessionId, { forced: " — after repeated stale submit-token replays" });
  }
  st.lastValid = sub;

  const plan = readRunJson<LogPlan>(st.runId, st.cwd, "plan.json");
  if (!plan) return `⚠️ Run ${st.runId} has no plan.json — call f_log_plan again.`;

  // Gate 1: every plan observation must be addressed, verbatim.
  const given = new Set(sub.observations.map((o) => o.observation));
  const missing = plan.observations.filter((o) => !given.has(o));
  if (missing.length) {
    const bounce = reject(`observations[] must address every plan observation. Missing:\n${missing.map((m) => `- ${m}`).join("\n")}`);
    if (bounce) return bounce;
    return store(st, sub, sessionId, { forced: " — after repeated incomplete observation coverage" });
  }

  // Gate 2: evidence only from files actually seen (read/blamed) or injected as a suspect
  // snippet. Normalize both sides — the model's evidence path and a suspect/readFiles path
  // rarely disagree on separators or a leading "./", but they must not be treated as unseen
  // for it (I-7).
  const seen = new Set<string>(plan.suspects.map((s) => normalizeRepoPath(s.path)));
  for (const f of Object.keys(st.readFiles ?? {})) seen.add(normalizeRepoPath(f));
  const unseen = sub.evidence.filter((e) => !seen.has(normalizeRepoPath(e.file))).map((e) => e.file);
  if (unseen.length) {
    const bounce = reject(`evidence[] may only cite files you read with f_log_read/f_log_blame or that were injected as suspects. Not seen: ${unseen.join(", ")}`);
    if (bounce) return bounce;
    return store(st, sub, sessionId, { forced: " — after repeated evidence on unread files" });
  }

  // Gate 3: words of another script (Chinese, Arabic, Cyrillic…) slipped into the prose. Only text the analyst
  // wrote (observation strings are verbatim log text). Past the cap it is stored
  // as written, not forced — the analysis is sound, and finalize's report check
  // still names the characters.
  const language = readRunJson<RunMeta>(st.runId, st.cwd, "run.json")?.language ?? "ko";
  const prose = [
    sub.cause.summary, sub.cause.mechanism, sub.resolution.summary,
    ...sub.resolution.changes.map((c) => c.description),
    ...sub.evidence.map((e) => e.why),
    ...sub.observations.map((o) => o.how ?? ""),
    ...sub.alternatives.flatMap((a) => [a.hypothesis, a.rejectedBecause]),
  ];
  const foreign = [...new Set(prose.flatMap((t) => strayScript(t, language)))];
  if (foreign.length) {
    const bounce = reject(`Non-${languageName(language)} script in your text: ${describeScripts(foreign.slice(0, 10))}. Rewrite those words in ${languageName(language)} and resubmit.`);
    if (bounce) return bounce;
  }

  // Gate 4: fix code that uses a house class whose KB page the analyst never
  // saw is written from memory. Hand it exactly those pages, once — the
  // guide is served at the point the code is written, not guessed up front.
  if (!st.kbNudged) {
    const code = sub.resolution.changes.map((c) => c.code ?? "").join("\n");
    const unseen = kbDocsForCode(st.cwd, code, Infinity).filter((d) => !st.kbShown?.includes(d.path)).slice(0, KB_FIX_MAX_DOCS);
    if (unseen.length) {
      st.kbNudged = true;
      st.kbShown = [...(st.kbShown ?? []), ...unseen.map((d) => d.path)];
      recordKbShown(st.runId, st.cwd, st.kbShown);
      const bounce = reject([
        `resolution.changes[].code uses framework classes whose KB guide you have not seen: ${unseen.map((d) => d.specifier).join(", ")}.`,
        "Check each call/annotation against the page below (factory and constructor signatures, required arguments, error-code rules), correct the code, and resubmit the full payload.",
        ...unseen.map((d) => `### ${d.specifier} (${d.path})\n${d.content.slice(0, KB_DOC_MAX_CHARS)}`),
      ].join("\n\n"));
      if (bounce) return bounce;
    }
  }

  // Gate 4b: a constant the fix changes is checked only where it is declared,
  // never against the framework method it feeds. Point at that call and its
  // page once, seen before or not — the value was written from memory anyway.
  if (!st.constNudged) {
    const uses = constantUses(st.cwd, sub.resolution.changes);
    if (uses.length) {
      st.constNudged = true;
      const pages = [...new Map(uses.flatMap((u) => u.docs).map((d) => [d.path, d])).values()];
      st.kbShown = [...new Set([...(st.kbShown ?? []), ...pages.map((d) => d.path)])];
      recordKbShown(st.runId, st.cwd, st.kbShown);
      const bounce = reject([
        "resolution.changes[].code changes constants that are passed to framework methods. Check each new value against what the KB page says that method accepts:",
        ...uses.map((u) => `- \`${u.decl}\` → \`${u.use}\` (${u.where})`),
        "Correct the value if the page does not list it, and resubmit the full payload.",
        ...pages.map((d) => `### ${d.specifier} (${d.path})\n${d.content.slice(0, KB_DOC_MAX_CHARS)}`),
      ].join("\n"));
      if (bounce) return bounce;
    }
  }

  // Gate 5: a config key the fix sets outside the prefix its KB
  // @ConfigurationProperties class binds is silently ignored at runtime.
  if (!st.configNudged) {
    const misses = kbConfigMisses(st.cwd, sub.resolution.changes);
    if (misses.length) {
      st.configNudged = true;
      const pages = [...new Map(misses.map((m) => [m.path, m])).values()];
      st.kbShown = [...new Set([...(st.kbShown ?? []), ...pages.map((m) => m.path)])];
      recordKbShown(st.runId, st.cwd, st.kbShown);
      const bounce = reject([
        "resolution.changes[].code sets config keys that no KB @ConfigurationProperties class binds — Spring ignores them:",
        ...misses.map((m) => `- \`${m.key}\` → ${m.specifier} binds \`${m.bound}\``),
        "Fix the key paths (or explain in the description why the short key is right), and resubmit the full payload.",
        ...pages.map((m) => `### ${m.specifier} (${m.path})\n${m.content.slice(0, KB_DOC_MAX_CHARS)}`),
      ].join("\n"));
      if (bounce) return bounce;
    }
  }

  return store(st, sub, sessionId, {});
}

/** Turn-end watchdog for an analyst session that went idle without submitting. */
export async function onLogSessionIdle(sessionId: string): Promise<{ kind: "resume" | "finalized"; text: string } | null> {
  const st = getLogState(sessionId);
  if (!st?.active || st.submitted) return null;
  const partial = () => store(st, (st.lastValid as LogSubmission | undefined) ?? emptySubmission(st.runId), sessionId, { partial: true });
  if (st.toolBudgetExhausted) return { kind: "finalized", text: partial() };
  if (st.resumes < MAX_RESUMES) {
    st.resumes++;
    return {
      kind: "resume",
      text: `Log analysis for run ${st.runId} is not submitted yet. Call f_log_submit now with what you have (CURRENT_SUBMIT_TOKEN=${st.submitToken}) — auto-resume ${st.resumes}/${MAX_RESUMES}.`,
    };
  }
  return { kind: "finalized", text: partial() };
}
