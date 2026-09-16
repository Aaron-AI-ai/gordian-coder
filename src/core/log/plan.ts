/**
 * Stage 1 of f-log: turn a parsed trace into a run — which repository files
 * are suspect and in what order, what the log's observations are (the list
 * the submission and the judge are held to), which KB pages and rules apply.
 * Everything here is computed by code; the model gets the result.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isExternalImport, normalizeRepoPath, resolveImport } from "../review/imports";
import { isGitRepo, listFilesAt, sh } from "../review/tools/read";
import { frameworkKbDocs, type KbDoc } from "../review/evidence/framework-kb";
import { loadLogConfig } from "./config";
import { parseStackTrace, type HandlerInfo, type ParsedLog, type StackFrame } from "./parse";
import { loadLogRules, matchLogRules } from "./rules";
import { newRunId, saveJudgments, writeRunJson, writeRunText, type RunMeta } from "./run-store";

export type FrameKind = "app" | "framework" | "external";
export interface Suspect {
  path: string;
  frame: StackFrame | null;
  block: number;
  rank: number;
  source: "frame" | "svcId" | "errorCode";
}
export interface LogPlan {
  runId: string;
  suspects: Suspect[];
  entry: StackFrame | null;
  observations: string[];
  kbDocs: KbDoc[];
  ruleFiles: string[];
  kinds: Record<string, FrameKind>;
}
export interface PlanOptions {
  log?: string;
  file?: string;
  output?: string;
  judge?: boolean;
}

export const MAX_SUSPECTS = 8;
const ENTRY_SUFFIX = /(Controller|Job|Tasklet|Consumer|Listener|Runnable)$/;
const REPEAT_MIN = 3;

function allFrames(p: ParsedLog): StackFrame[] {
  return [...p.chain, ...p.suppressed].flatMap((b) => b.frames);
}

function kbPrefixes(frameworkKb: Record<string, string>): string[] {
  return Object.keys(frameworkKb).map((p) => (p.endsWith(".*") ? p.slice(0, -1) : p.endsWith(".") ? p : `${p}.`));
}

/** Repository resolution first (the app and the framework share the
 * `kr.co.koscom.pb.` prefix), then the configured KB prefixes, else external. */
export function classifyFrames(cwd: string, parsed: ParsedLog, frameworkKb: Record<string, string>) {
  const all = new Set(listFilesAt(cwd, null).map(normalizeRepoPath));
  const prefixes = kbPrefixes(frameworkKb);
  const kinds: Record<string, FrameKind> = {};
  const paths: Record<string, string> = {};
  for (const f of allFrames(parsed)) {
    if (kinds[f.cls]) continue;
    const outer = f.cls.replace(/\$.*$/, ""); // inner class → its outer file
    if (isExternalImport(outer)) { kinds[f.cls] = "external"; continue; }
    // fromFile only picks the language branch by extension — a fake .java path is enough.
    const hit = resolveImport(cwd, null, outer, "x.java", all)[0];
    if (hit) { kinds[f.cls] = "app"; paths[f.cls] = hit; continue; }
    kinds[f.cls] = prefixes.some((p) => outer.startsWith(p)) ? "framework" : "external";
  }
  return { kinds, paths };
}

/** Root-cause block first, then outward; 1/k inside a block (spec §6). */
export function rankSuspects(parsed: ParsedLog, paths: Record<string, string>): Suspect[] {
  const out: Suspect[] = [];
  const seen = new Set<string>();
  for (let b = parsed.chain.length - 1; b >= 0; b--) {
    parsed.chain[b].frames.forEach((frame, i) => {
      const path = paths[frame.cls];
      if (!path || seen.has(path) || out.length >= MAX_SUSPECTS) return;
      seen.add(path);
      out.push({ path, frame, block: b, rank: 1 / (i + 1), source: "frame" });
    });
  }
  return out;
}

export function findEntry(parsed: ParsedLog, kinds: Record<string, FrameKind>): StackFrame | null {
  const app = (parsed.chain[0]?.frames ?? []).filter((f) => kinds[f.cls] === "app");
  const preferred = app.filter((f) => ENTRY_SUFFIX.test(f.cls));
  return preferred.at(-1) ?? app.at(-1) ?? null;
}

/** The list the analyst must answer and the judge scores against. Strings are
 * deterministic so a submission can echo them verbatim. */
export function buildObservations(parsed: ParsedLog): string[] {
  const o: string[] = [];
  parsed.chain.forEach((b, i) => {
    o.push(`예외 ${i + 1}/${parsed.chain.length}: ${b.type}${b.message ? `: ${b.message.slice(0, 200)}` : ""}`);
    if (b.omitted) o.push(`예외 ${i + 1}: ${b.omitted}개 프레임 생략(바깥 블록과 공통)`);
  });
  parsed.suppressed.forEach((b) => o.push(`Suppressed: ${b.type}${b.message ? `: ${b.message.slice(0, 120)}` : ""}`));
  const counts = new Map<string, number>();
  for (const f of allFrames(parsed)) {
    const k = `${f.cls}.${f.method}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) if (n >= REPEAT_MIN) o.push(`반복 프레임: ${k} ×${n} (재귀/루프 가능)`);
  const h = parsed.handler;
  if (h.errorCode) o.push(`핸들러 errorCode=${h.errorCode}`);
  if (h.svcId) o.push(`핸들러 svcId=${h.svcId}`);
  if (h.uri) o.push(`핸들러 URI=${h.uri}`);
  if (h.even) o.push(`핸들러 even=${h.even}`);
  if (h.logger) o.push(`핸들러 로거: ${h.logger}`);
  return o;
}

function gitGrepFiles(cwd: string, needle: string): string[] {
  if (!isGitRepo(cwd)) return [];
  const r = sh(["git", "grep", "-l", "-F", "--", needle, "*.java", "*.xml", "*.yml"], cwd);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean).map(normalizeRepoPath) : [];
}

/** No frames? Derive suspects from what the handler line carried (spec §6). */
export function searchStackless(cwd: string, handler: HandlerInfo): Suspect[] {
  const out: Suspect[] = [];
  const push = (path: string, source: Suspect["source"]) => {
    if (!out.some((s) => s.path === path && s.source === source))
      out.push({ path, frame: null, block: 0, rank: 0.5, source });
  };
  if (handler.uri || handler.svcId) {
    const svcId = handler.svcId ?? posix.basename(handler.uri!);
    if (handler.uri) for (const p of gitGrepFiles(cwd, `"${handler.uri}"`)) push(p, "svcId");
    const files = listFilesAt(cwd, null).map(normalizeRepoPath);
    for (const suffix of [`${svcId}Controller.java`, `${svcId}Service.java`, `${svcId}ServiceImpl.java`]) {
      for (const p of files) if (posix.basename(p) === suffix) push(p, "svcId");
    }
  }
  if (handler.errorCode) {
    for (const needle of [`create("${handler.errorCode}"`, `withExceptionCode("${handler.errorCode}"`]) {
      for (const p of gitGrepFiles(cwd, needle)) push(p, "errorCode");
    }
  }
  return out;
}

// Idempotency window: a looping orchestrator re-planning the same log gets
// the same run back instead of a fresh directory each time.
const recentPlans = new Map<string, { runId: string; at: number }>();
const REPLAN_WINDOW_MS = 60_000;

export function planLog(opts: PlanOptions, cwd: string): string {
  let raw = opts.log;
  if (!raw && opts.file) {
    try {
      raw = readFileSync(join(cwd, opts.file), "utf8");
    } catch {
      return `⚠️ f_log_plan: cannot read file ${opts.file}.`;
    }
  }
  if (!raw?.trim()) return "⚠️ f_log_plan needs `log` (the pasted trace) or `file` (a path under the project).";

  const key = `${cwd}:${Bun.hash(raw).toString()}`;
  const recent = recentPlans.get(key);
  if (recent && Date.now() - recent.at < REPLAN_WINDOW_MS) {
    return `ℹ️ Duplicate f_log_plan ignored — this log was planned ${Math.round((Date.now() - recent.at) / 1000)}s ago as runId: ${recent.runId}. Continue with that run: spawn ONE f-log-analyst subagent and tell it to call f_log_context with runId ${recent.runId}.`;
  }

  const parsed = parseStackTrace(raw);
  if (!parsed.chain.length) {
    return "⚠️ No exception found in the input. Paste the stack trace including its header line (`…Exception: message`) — or, for a stack-less fico handler line, the line that carries `errorCode=` / `URI=`.";
  }

  const cfg = loadLogConfig(cwd);
  const runId = newRunId();
  const { kinds, paths } = classifyFrames(cwd, parsed, cfg.frameworkKb);
  const suspects = rankSuspects(parsed, paths);
  for (const s of searchStackless(cwd, parsed.handler)) {
    if (suspects.length >= MAX_SUSPECTS) break;
    if (!suspects.some((x) => x.path === s.path)) suspects.push(s);
  }
  const entry = findEntry(parsed, kinds);
  const observations = buildObservations(parsed);
  const rootFqcns = (parsed.chain.at(-1)?.frames ?? []).map((f) => f.cls).filter((c) => kinds[c] === "framework");
  const kbDocs = frameworkKbDocs(cwd, [...new Set(rootFqcns)]);
  const types = [...parsed.chain, ...parsed.suppressed].map((b) => b.type);
  const ruleFiles = matchLogRules(loadLogRules(cwd), types, suspects.map((s) => s.path)).map((r) => r.file);

  const plan: LogPlan = { runId, suspects, entry, observations, kbDocs, ruleFiles, kinds };
  const meta: RunMeta = {
    runId, createdAt: new Date().toISOString(), cwd,
    judge: opts.judge ?? cfg.judge, output: opts.output, language: cfg.language,
  };
  writeRunText(runId, cwd, "input.log", raw);
  writeRunJson(runId, cwd, "run.json", meta);
  writeRunJson(runId, cwd, "plan.json", plan);
  saveJudgments(runId, cwd, { attempts: [], rejected: [], invalid: 0 });
  recentPlans.set(key, { runId, at: Date.now() });

  const root = parsed.chain.at(-1)!;
  const lines = [
    `✅ f-log plan created — runId: ${runId}`,
    `Root cause exception: ${root.type}${root.message ? `: ${root.message.slice(0, 120)}` : ""} (${parsed.chain.length} in chain)`,
    `Entry point: ${entry ? `${entry.cls}.${entry.method}` : "(none — stack-less input)"}`,
    `Suspect files (${suspects.length}):`,
    ...suspects.map((s, i) => `  ${i + 1}. ${s.path}${s.frame?.line ? `:${s.frame.line}` : ""} [${s.source}]`),
    `Observations to explain: ${observations.length}; rules: ${ruleFiles.length}; KB pages: ${kbDocs.length}; judge: ${meta.judge ? "on" : "off"}`,
    "",
    "Next: spawn ONE f-log-analyst subagent with exactly this prompt:",
    `  "Analyze log run ${runId}. First call f_log_context with runId \\"${runId}\\", then investigate with the f_log_* tools and finish with f_log_submit."`,
    meta.judge
      ? "When it submits, spawn ONE f-log-judge subagent: \"Judge log run " + runId + ": call f_log_judge_context then f_log_judge.\" Obey its PASS/REWORK message; on REWORK spawn a NEW f-log-analyst with the same prompt."
      : `When it submits, call f_log_finalize with runId ${runId}.`,
  ];
  return lines.join("\n");
}
