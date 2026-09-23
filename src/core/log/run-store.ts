/**
 * On-disk run state under `<runsDir>/<runId>/`. The analyst and judge are
 * subagents in their own sessions, so everything they share lives here, never
 * in process memory. Files are written whole and never rotated (spec §12).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLogConfig } from "./config";

export interface RunMeta {
  runId: string;
  createdAt: string;
  cwd: string;
  judge: boolean;
  output?: string;
  language: string;
}
export interface LogJudgeAttempt {
  round: number;
  scores: { observation: number; alternatives: number; rootCause: number };
  total: number;
  verdict: "pass" | "rework";
  unexplained: string[];
  feedback: string;
}
export interface LogJudgments {
  attempts: LogJudgeAttempt[];
  rejected: Array<{ round: number; cause: string; feedback: string }>;
  pendingToken?: string;
  invalid: number;
  skipped?: string;
  terminal?: boolean;
}

export function newRunId(now: Date = new Date()): string {
  const s = now.toISOString();
  const stamp = `${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 19).replace(/:/g, "")}`;
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${stamp}-${rand}`;
}

export function runDir(runId: string, cwd: string): string {
  return join(cwd, loadLogConfig(cwd).runsDir, runId);
}

export function runExists(runId: string, cwd: string): boolean {
  return existsSync(join(runDir(runId, cwd), "run.json")) || existsSync(runDir(runId, cwd));
}

export function writeRunText(runId: string, cwd: string, name: string, text: string): void {
  const dir = runDir(runId, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

export function writeRunJson(runId: string, cwd: string, name: string, value: unknown): void {
  writeRunText(runId, cwd, name, JSON.stringify(value, null, 2));
}

export function readRunText(runId: string, cwd: string, name: string): string | null {
  const p = join(runDir(runId, cwd), name);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function readRunJson<T>(runId: string, cwd: string, name: string): T | null {
  const text = readRunText(runId, cwd, name);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function loadJudgments(runId: string, cwd: string): LogJudgments {
  return readRunJson<LogJudgments>(runId, cwd, "judgments.json") ?? { attempts: [], rejected: [], invalid: 0 };
}

export function saveJudgments(runId: string, cwd: string, j: LogJudgments): void {
  writeRunJson(runId, cwd, "judgments.json", j);
}

export function submissionCount(runId: string, cwd: string): number {
  try {
    return readdirSync(runDir(runId, cwd)).filter((f) => /^submission-\d+\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** Add this session's call counts to the run's cumulative log (finalize's
 * "unread suspects" check reads it, in another session). */
export function mergeCallLog(runId: string, cwd: string, log: Record<string, Record<string, number>>): void {
  const merged = readRunJson<Record<string, Record<string, number>>>(runId, cwd, "callLog.json") ?? {};
  for (const [scope, tools] of Object.entries(log)) {
    const target = (merged[scope] ??= {});
    for (const [tool, n] of Object.entries(tools)) target[tool] = (target[tool] ?? 0) + n;
  }
  writeRunJson(runId, cwd, "callLog.json", merged);
}
