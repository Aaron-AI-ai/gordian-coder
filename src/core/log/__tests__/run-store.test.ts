import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId, runDir, runExists, writeRunText, writeRunJson, readRunText, readRunJson,
  loadJudgments, saveJudgments, submissionCount, mergeCallLog,
} from "../run-store";
import { newLogSession, setLogState, getLogState, clearLogState } from "../state";

describe("run-store", () => {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-run-"));

  test("run id is stamp + 4 hex, run dir under the configured runsDir", () => {
    const id = newRunId(new Date("2026-09-16T01:45:12Z"));
    expect(id).toMatch(/^20260916-014512-[0-9a-f]{4}$/);
    expect(runDir(id, cwd)).toBe(join(cwd, ".fico/f-log/runs/", id));
    expect(runExists(id, cwd)).toBe(false);
  });

  test("text and json round-trip, missing → null", () => {
    const id = newRunId();
    writeRunText(id, cwd, "input.log", "boom");
    writeRunJson(id, cwd, "plan.json", { a: 1 });
    expect(runExists(id, cwd)).toBe(true);
    expect(readRunText(id, cwd, "input.log")).toBe("boom");
    expect(readRunJson<{ a: number }>(id, cwd, "plan.json")).toEqual({ a: 1 });
    expect(readRunJson(id, cwd, "nope.json")).toBeNull();
    expect(existsSync(join(runDir(id, cwd), "plan.json"))).toBe(true);
  });

  test("judgments default and persist; submission count; call log merges", () => {
    const id = newRunId();
    expect(loadJudgments(id, cwd)).toEqual({ attempts: [], rejected: [], invalid: 0 });
    saveJudgments(id, cwd, { attempts: [], rejected: [{ round: 1, cause: "x", feedback: "y" }], invalid: 1 });
    expect(loadJudgments(id, cwd).rejected).toHaveLength(1);
    writeRunJson(id, cwd, "submission-1.json", {});
    writeRunJson(id, cwd, "submission-2.json", {});
    expect(submissionCount(id, cwd)).toBe(2);
    mergeCallLog(id, cwd, { [id]: { f_log_read: 2 } });
    mergeCallLog(id, cwd, { [id]: { f_log_read: 1, f_log_search: 1 } });
    expect(readRunJson<Record<string, Record<string, number>>>(id, cwd, "callLog.json")).toEqual({ [id]: { f_log_read: 3, f_log_search: 1 } });
  });
});

describe("state", () => {
  test("session lifecycle and guard fields", () => {
    const st = newLogSession("/repo", "run-1", 1, 10, 20);
    expect(st.active).toBe(true);
    expect(st.toolCalls).toBe(1); // the context call is call #1, as in f-review
    expect(st.maxToolCalls).toBe(10);
    expect(st.maxIter).toBe(20);
    expect(st.submitToken).toHaveLength(36);
    setLogState("s1", st);
    expect(getLogState("s1")).toBe(st);
    clearLogState("s1");
    expect(getLogState("s1")).toBeUndefined();
  });
});
