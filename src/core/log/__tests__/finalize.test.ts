import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGaps, badgeFor, renderLogReport, reportPath, finalizeRun, type FinalizeInput } from "../finalize";
import { loadLogConfig } from "../config";
import type { LogPlan } from "../plan";
import type { StoredSubmission } from "../submit";
import type { LogJudgments } from "../run-store";
import { planLog } from "../plan";
import { logContext } from "../context";
import { submitLog } from "../submit";
import { getLogState } from "../state";
import { runLogTool } from "../tools";
import { logJudgeContext, submitLogJudge } from "../judge";
import { runDir } from "../run-store";

const plan: LogPlan = {
  runId: "r1", entry: { cls: "a.Ctl", method: "go", file: "Ctl.java", line: 3, raw: "" },
  observations: ["예외 1/2: a.Outer: wrap", "예외 2/2: java.lang.NullPointerException: x", "핸들러 errorCode=1001"],
  kbDocs: [{ specifier: "k.Fw", path: ".fico/kb/Fw.md", content: "kb" }], ruleFiles: ["npe.md"],
  kinds: { "a.Svc": "app", "a.Ctl": "app" },
  suspects: [
    { path: "src/a/Svc.java", frame: { cls: "a.Svc", method: "run", file: "Svc.java", line: 2, raw: "" }, block: 1, rank: 1, source: "frame" },
    { path: "src/a/Ctl.java", frame: { cls: "a.Ctl", method: "go", file: "Ctl.java", line: 3, raw: "" }, block: 0, rank: 0.5, source: "frame" },
  ],
};
const sub: StoredSubmission = {
  runId: "r1", submitToken: "", round: 1, submittedAt: "2026-09-16T00:00:00Z",
  cause: { file: "src/a/Svc.java", line: 2, summary: "map.get(k) is null", mechanism: "k never inserted" },
  evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "deref" }],
  observations: [
    { observation: "예외 1/2: a.Outer: wrap", explained: true, how: "wrapper" },
    { observation: "예외 2/2: java.lang.NullPointerException: x", explained: true },
    { observation: "핸들러 errorCode=1001", explained: false },
  ],
  alternatives: [{ hypothesis: "map null", rejectedBecause: "ctor" }],
  resolution: { summary: "guard", changes: [{ file: "src/a/Svc.java", description: "Optional" }], kind: "root-cause" },
  confidence: 80,
};
const judged: LogJudgments = { attempts: [{ round: 1, scores: { observation: 30, alternatives: 20, rootCause: 25 }, total: 75, verdict: "pass", unexplained: ["핸들러 errorCode=1001"], feedback: "ok" }], rejected: [], invalid: 0 };

describe("computeGaps", () => {
  test("three set differences", () => {
    const g = computeGaps(plan, sub, judged, { r1: { f_log_read: 1 } }, ["src/a/Svc.java"]);
    expect(g.unexplainedExceptions).toEqual([]);            // both exception observations explained
    expect(g.unreadSuspects).toEqual(["src/a/Ctl.java"]);   // never read
    expect(g.unresolvedObservations).toEqual(["핸들러 errorCode=1001"]);
    const g2 = computeGaps(plan, { ...sub, observations: sub.observations.slice(0, 1) }, judged, {}, []);
    expect(g2.unexplainedExceptions).toEqual(["java.lang.NullPointerException"]);
  });
});

describe("badgeFor", () => {
  test("states", () => {
    expect(badgeFor(sub, judged, judged.attempts[0])).toBe("PASS");
    expect(badgeFor(sub, { ...judged, terminal: true }, { ...judged.attempts[0], verdict: "rework" })).toBe("TERMINAL");
    expect(badgeFor({ ...sub, forced: " — x" }, judged, judged.attempts[0])).toBe("FORCED");
    expect(badgeFor({ ...sub, partial: true }, judged)).toBe("PARTIAL");
    expect(badgeFor(sub, { ...judged, attempts: [], skipped: "s" })).toBe("JUDGE SKIPPED");
    expect(badgeFor(sub, { attempts: [], rejected: [], invalid: 0 })).toBe("UNJUDGED");
  });
});

describe("renderLogReport", () => {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-report-"));
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { map.get(k).size(); }\n}\n");
  const input: FinalizeInput = { plan, input: "java.lang.NullPointerException: x\n\tat a.Svc.run(Svc.java:2)\n", submission: sub, judgments: judged, attempt: judged.attempts[0], session: { toolCalls: 4, maxToolCalls: 10, rounds: 1 }, cwd };
  const gaps = computeGaps(plan, sub, judged, {}, ["src/a/Svc.java"]);

  test("nine sections, ko labels, evidence quoted from the actual file, gaps listed", () => {
    const md = renderLogReport(input, gaps, "PASS", "ko", new Date("2026-09-16T01:00:00Z"));
    for (const h of ["## 요약", "## 스택 원문", "## 진입점 → 원인 경로", "## 원인 상세와 근거", "## 해결 방안", "## 검토한 대안", "## 못 본 것", "## 심사 이력", "## 실행 정보"]) expect(md).toContain(h);
    expect(md).toContain("PASS");
    expect(md).toContain("map.get(k).size()");       // quoted from src/a/Svc.java
    expect(md).toContain("src/a/Ctl.java");          // unread suspect
    expect(md).toContain("핸들러 errorCode=1001");   // unresolved
    expect(md).toContain("a.Ctl.go");                // entry
    expect(md).toContain("75");                      // judge total
    expect(md).toContain("4/10");                    // tool calls
    expect(md).toContain("npe.md");
  });
  test("en labels, mitigation warning, envCause line, empty gaps text", () => {
    const md = renderLogReport({ ...input, submission: { ...sub, envCause: true, resolution: { ...sub.resolution, kind: "mitigation" } } }, { unexplainedExceptions: [], unreadSuspects: [], unresolvedObservations: [] }, "PASS", "en", new Date());
    expect(md).toContain("## Summary");
    expect(md).toContain("mitigation");
    expect(md).toContain("environment");
    expect(md).toContain("No gaps");
  });
  test("FORCED with empty submission renders placeholders instead of crashing", () => {
    const empty: StoredSubmission = { ...sub, forced: " — after 5 invalid submissions", cause: { file: "", summary: "", mechanism: "" }, evidence: [], observations: [], alternatives: [], resolution: { summary: "", changes: [], kind: "mitigation" }, confidence: 0 };
    const md = renderLogReport({ ...input, submission: empty, attempt: undefined }, gaps, "FORCED", "ko", new Date());
    expect(md).toContain("FORCED");
    expect(md).toContain("제출 없음");
  });
});

describe("reportPath", () => {
  test("directory vs file, override wins", () => {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-rp-"));
    const cfg = loadLogConfig(cwd);
    expect(reportPath(cwd, cfg, "r1")).toBe(join(cwd, ".fico/report/f-log/", "log-r1.md"));
    expect(reportPath(cwd, cfg, "r1", "out/custom.md")).toBe(join(cwd, "out/custom.md"));
    expect(reportPath(cwd, cfg, "r1", "out/dir/")).toBe(join(cwd, "out/dir/", "log-r1.md"));
  });
});

describe("finalizeRun end-to-end", () => {
  test("writes the report and finalize.json; second call returns the same response without rewriting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-fin-"));
    mkdirSync(join(cwd, "src/a"), { recursive: true });
    writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { map.get(k).size(); }\n}\n");
    const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
    const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: "java.lang.NullPointerException: x\n\tat a.Svc.run(Svc.java:2)\n" }, cwd))![1];
    logContext(runId, "fin-s", cwd);
    const st = getLogState("fin-s")!;
    runLogTool(st, "f_log_read", { file_path: "src/a/Svc.java" });
    submitLog({ runId, submitToken: st.submitToken, cause: { file: "src/a/Svc.java", line: 2, summary: "null", mechanism: "m" }, evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "w" }], observations: [{ observation: "예외 1/1: java.lang.NullPointerException: x", explained: true }], alternatives: [{ hypothesis: "h", rejectedBecause: "r" }], resolution: { summary: "s", changes: [], kind: "root-cause" }, confidence: 70 }, "fin-s");
    const tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
    submitLogJudge({ runId, judgeToken: tok, scores: { observation: 30, alternatives: 20, rootCause: 25 }, unexplained: [], feedback: "ok" }, cwd);
    const out = finalizeRun(runId, cwd);
    expect(out).toContain("f-log finished — PASS");
    expect(out).toContain(`log-${runId}.md`);
    expect(out).toContain("Gaps: none");
    const path = join(cwd, ".fico/report/f-log/", `log-${runId}.md`);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(runDir(runId, cwd), "finalize.json"))).toBe(true);
    const before = readFileSync(path, "utf8");
    expect(finalizeRun(runId, cwd)).toBe(out);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(finalizeRun("nope", cwd)).toContain("Unknown run");
  });
  test("--output=<file> reused across runs redirects the second run instead of hiding its report (I-5)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-fin-collide-"));
    mkdirSync(join(cwd, "src/a"), { recursive: true });
    writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { map.get(k).size(); }\n}\n");
    const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);

    // Different frame lines (still 1 and 2 in the 2-line Svc.java) keep the
    // observation string identical (built from type+message, not the line)
    // while giving each call a distinct hash so planLog's idempotency window
    // doesn't collapse them into the same run.
    const runOnce = (line: number) => {
      const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: `java.lang.NullPointerException: x\n\tat a.Svc.run(Svc.java:${line})\n`, output: "out/same.md" }, cwd))![1];
      const sessionId = `s-${runId}`;
      logContext(runId, sessionId, cwd);
      const st = getLogState(sessionId)!;
      runLogTool(st, "f_log_read", { file_path: "src/a/Svc.java" });
      submitLog({ runId, submitToken: st.submitToken, cause: { file: "src/a/Svc.java", line: 2, summary: "null", mechanism: "m" }, evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "w" }], observations: [{ observation: "예외 1/1: java.lang.NullPointerException: x", explained: true }], alternatives: [{ hypothesis: "h", rejectedBecause: "r" }], resolution: { summary: "s", changes: [], kind: "root-cause" }, confidence: 70 }, sessionId);
      const tok = /JUDGE_TOKEN=(\S+)/.exec(logJudgeContext(runId, cwd))![1];
      submitLogJudge({ runId, judgeToken: tok, scores: { observation: 30, alternatives: 20, rootCause: 25 }, unexplained: [], feedback: "ok" }, cwd);
      return { runId, out: finalizeRun(runId, cwd) };
    };

    const first = runOnce(2);
    expect(first.out).toContain("Report: out/same.md");
    const second = runOnce(1);
    expect(second.out).toContain(`Report: out/log-${second.runId}.md`);
    expect(second.out).toContain("already existed");
    const path = join(cwd, "out", `log-${second.runId}.md`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(second.runId);
    // first run's report is untouched
    expect(readFileSync(join(cwd, "out/same.md"), "utf8")).toContain(first.runId);
  });

  test("no submission yet → refusal naming the analyst", () => {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-fin2-"));
    const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: "java.lang.IllegalStateException: y\n\tat a.B.c(B.java:1)\n" }, cwd))![1];
    expect(finalizeRun(runId, cwd)).toContain("f-log-analyst");
  });
});
