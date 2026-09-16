import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderContext, logContext, RAW_MAX_CHARS, OBS_MAX_CHARS, type ContextInput } from "../context";
import { parseStackTrace } from "../parse";
import { planLog } from "../plan";
import { getLogState } from "../state";
import { readRunText, saveJudgments, loadJudgments } from "../run-store";
import type { LogPlan } from "../plan";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-ctx-"));
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/Svc.java"), Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"));
  writeFileSync(join(cwd, "src/a/Ctl.java"), Array.from({ length: 60 }, (_, i) => `ctl ${i + 1}`).join("\n"));
  const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
  return cwd;
}
const LOG = "java.lang.IllegalStateException: boom\n\tat a.Svc.run(Svc.java:60)\n\tat a.Ctl.go(Ctl.java:30)\n";

function input(cwd: string, over: Partial<ContextInput> = {}): ContextInput {
  const parsed = parseStackTrace(LOG);
  const plan: LogPlan = {
    runId: "r1", entry: parsed.chain[0].frames[1], observations: ["예외 1/1: java.lang.IllegalStateException: boom"], kbDocs: [],
    ruleFiles: [], kinds: { "a.Svc": "app", "a.Ctl": "app" },
    suspects: [
      { path: "src/a/Svc.java", frame: parsed.chain[0].frames[0], block: 0, rank: 1, source: "frame" },
      { path: "src/a/Ctl.java", frame: parsed.chain[0].frames[1], block: 0, rank: 0.5, source: "frame" },
    ],
  };
  return { plan, parsed, raw: LOG, rules: [], rejected: [], round: 1, submitToken: "tok-1", language: "ko", cwd, maxChars: 40_000, ...over };
}

describe("renderContext", () => {
  const cwd = repo();

  test("sections in priority order; primary ±40 lines, others ±10; token present", () => {
    const out = renderContext(input(cwd));
    const idx = (s: string) => out.indexOf(s);
    expect(idx("## 로그")).toBeLessThan(idx("## 관측"));
    expect(idx("## 관측")).toBeLessThan(idx("## 1순위 용의 코드"));
    expect(idx("## 1순위 용의 코드")).toBeLessThan(idx("## 나머지 용의 파일"));
    expect(out).toContain("line 20");  // 60-40
    expect(out).toContain("line 100"); // 60+40
    expect(out).not.toContain("line 101");
    expect(out).toContain("ctl 20");   // 30-10
    expect(out).not.toContain("ctl 19");
    expect(out).toContain("CURRENT_SUBMIT_TOKEN=tok-1");
  });

  test("observations are never cut; lower sections are dropped first under a tight budget", () => {
    const rules = [{ file: "r.md", exceptions: [], globs: [], reference: false, content: "R".repeat(2000), specificity: 1 }];
    const out = renderContext(input(cwd, { rules, maxChars: 9_000 }));
    expect(out).toContain("예외 1/1");
    expect(out).not.toContain("ctl 20");         // other snippets dropped
    expect(out.length).toBeLessThanOrEqual(9_000 + 200);
  });

  test("raw log is trimmed to RAW_MAX_CHARS with a pointer to input.log", () => {
    const raw = LOG + "x".repeat(RAW_MAX_CHARS * 2);
    const out = renderContext(input(cwd, { raw }));
    expect(out).toContain("runs/r1/input.log");
    expect(out.indexOf("x".repeat(100))).toBeGreaterThan(-1);
  });

  test("rework round: rejected hypotheses injected, rules and KB replaced by one line", () => {
    const rules = [{ file: "r.md", exceptions: [], globs: [], reference: false, content: "RULEBODY", specificity: 1 }];
    const out = renderContext(input(cwd, { rules, round: 2, rejected: [{ round: 1, cause: "null map", feedback: "map is never null here" }] }));
    expect(out).toContain("기각된 가설");
    expect(out).toContain("null map");
    expect(out).not.toContain("RULEBODY");
    expect(out).toContain("이전 라운드와 동일");
  });

  test("OBS_MAX_CHARS is honoured by truncating only the rejected list tail", () => {
    const rejected = Array.from({ length: 50 }, (_, i) => ({ round: i, cause: "c".repeat(100), feedback: "f".repeat(100) }));
    const out = renderContext(input(cwd, { round: 2, rejected }));
    const obs = out.slice(out.indexOf("## 관측"), out.indexOf("## 1순위"));
    expect(obs.length).toBeLessThanOrEqual(OBS_MAX_CHARS + 100);
    expect(obs).toContain("예외 1/1");
  });
});

describe("logContext (tool entry)", () => {
  const cwd = repo();
  test("creates the session, writes context-<n>.md, is idempotent per session, unknown run refused", () => {
    const planOut = planLog({ log: LOG }, cwd);
    const runId = /runId[:=]\s*(\S+)/.exec(planOut)![1];
    const first = logContext(runId, "sess-1", cwd);
    expect(first).toContain("CURRENT_SUBMIT_TOKEN=");
    expect(getLogState("sess-1")?.runId).toBe(runId);
    expect(getLogState("sess-1")?.round).toBe(1);
    expect(readRunText(runId, cwd, "context-1.md")).toContain("## 로그");
    expect(logContext(runId, "sess-1", cwd)).toContain("Duplicate f_log_context ignored");
    expect(logContext("nope", "sess-2", cwd)).toContain("Unknown run");
  });
  test("round follows the judgments: one rejection → round 2 with the rejected list", () => {
    const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: LOG + "\n" }, cwd))![1];
    const j = loadJudgments(runId, cwd);
    j.rejected.push({ round: 1, cause: "wrong", feedback: "nope" });
    saveJudgments(runId, cwd, j);
    const out = logContext(runId, "sess-3", cwd);
    expect(getLogState("sess-3")?.round).toBe(2);
    expect(out).toContain("wrong");
  });
});
