import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logJudgeContext, submitLogJudge, bestSubmission } from "../judge";
import { planLog } from "../plan";
import { logContext } from "../context";
import { submitLog } from "../submit";
import { getLogState } from "../state";
import { loadJudgments } from "../run-store";
import { MAX_INVALID_JUDGE_SUBMISSIONS } from "../../review/pipeline/judge-store";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-judge-"));
  mkdirSync(join(cwd, ".fico/config"), { recursive: true });
  writeFileSync(join(cwd, ".fico/config/fico_ai.json"), JSON.stringify({ log: { judgeThreshold: 70, judgeRounds: 1 } }));
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { map.get(k).size(); }\n}\n");
  const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
  return cwd;
}
const LOG = "java.lang.NullPointerException: x\n\tat a.Svc.run(Svc.java:2)\n";

function submitted(cwd: string, tag: string, summary = "map.get(k) is null") {
  const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: LOG }, cwd))![1];
  const sid = `sess-${tag}`;
  logContext(runId, sid, cwd);
  const st = getLogState(sid)!;
  submitLog({
    runId, submitToken: st.submitToken,
    cause: { file: "src/a/Svc.java", line: 2, summary, mechanism: "m" },
    evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "w" }],
    observations: [{ observation: "예외 1/1: java.lang.NullPointerException: x", explained: true }],
    alternatives: [{ hypothesis: "h", rejectedBecause: "r" }],
    resolution: { summary: "s", changes: [], kind: "root-cause" }, confidence: 70,
  }, sid);
  return runId;
}

const scores = (o: number, a: number, r: number) => ({ observation: o, alternatives: a, rootCause: r });

describe("judge", () => {
  test("context issues a token and shows log, observations and the submission", () => {
    const cwd = repo();
    const runId = submitted(cwd, "ctx");
    const out = logJudgeContext(runId, cwd);
    expect(out).toContain("JUDGE_TOKEN=");
    expect(out).toContain("map.get(k) is null");
    expect(out).toContain("예외 1/1");
    expect(loadJudgments(runId, cwd).pendingToken).toBeTruthy();
    expect(logJudgeContext("nope", cwd)).toContain("Unknown run");
  });

  test("pass when total ≥ threshold; verdict computed by code", () => {
    const cwd = repo();
    const runId = submitted(cwd, "pass");
    const tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
    const out = submitLogJudge({ runId, judgeToken: tok, scores: scores(30, 20, 20), unexplained: [], feedback: "ok" }, cwd);
    expect(out).toContain("PASS");
    expect(out).toContain("f_log_finalize");
    const j = loadJudgments(runId, cwd);
    expect(j.attempts[0]).toMatchObject({ round: 1, total: 70, verdict: "pass" });
    expect(bestSubmission(runId, cwd)?.attempt?.verdict).toBe("pass");
  });

  test("rework below threshold: rejected hypothesis accumulated, analyst re-spawn instructed; cap → terminal", () => {
    const cwd = repo();
    const runId = submitted(cwd, "rework");
    let tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
    let out = submitLogJudge({ runId, judgeToken: tok, scores: scores(10, 10, 10), unexplained: ["예외 1/1"], feedback: "no" }, cwd);
    expect(out).toContain("REWORK");
    expect(out).toContain("f-log-analyst");
    expect(loadJudgments(runId, cwd).rejected[0]).toMatchObject({ round: 1, cause: "map.get(k) is null", feedback: "no" });
    // second round submission then judged below threshold again → judgeRounds=1 exceeded → terminal
    const sid = "sess-rework-2";
    logContext(runId, sid, cwd);
    const st = getLogState(sid)!;
    submitLog({
      runId, submitToken: st.submitToken,
      cause: { file: "src/a/Svc.java", line: 2, summary: "k missing", mechanism: "m" },
      evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "w" }],
      observations: [{ observation: "예외 1/1: java.lang.NullPointerException: x", explained: true }],
      alternatives: [{ hypothesis: "h", rejectedBecause: "r" }],
      resolution: { summary: "s", changes: [], kind: "root-cause" }, confidence: 60,
    }, sid);
    tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
    out = submitLogJudge({ runId, judgeToken: tok, scores: scores(20, 20, 20), unexplained: [], feedback: "still no" }, cwd);
    expect(out).toContain("TERMINAL");
    expect(out).toContain("f_log_finalize");
    expect(loadJudgments(runId, cwd).terminal).toBe(true);
    expect(bestSubmission(runId, cwd)?.submission.cause.summary).toBe("k missing"); // higher total (60 > 30)
  });

  test("stale token ignored; malformed payloads capped → judge skipped", () => {
    const cwd = repo();
    const runId = submitted(cwd, "bad");
    logJudgeContext(runId, cwd);
    expect(submitLogJudge({ runId, judgeToken: "wrong", scores: scores(1, 1, 1), unexplained: [], feedback: "" }, cwd)).toContain("JUDGE_TOKEN");
    let out = "";
    for (let i = 0; i < MAX_INVALID_JUDGE_SUBMISSIONS; i++) out = submitLogJudge({ runId, nonsense: 1 }, cwd);
    expect(out).toContain("skipped");
    expect(loadJudgments(runId, cwd).skipped).toBeTruthy();
    expect(out).toContain("f_log_finalize");
  });

  test("scores out of range rejected as malformed", () => {
    const cwd = repo();
    const runId = submitted(cwd, "range");
    const tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
    expect(submitLogJudge({ runId, judgeToken: tok, scores: scores(41, 0, 0), unexplained: [], feedback: "" }, cwd)).toContain("Invalid");
  });
});
