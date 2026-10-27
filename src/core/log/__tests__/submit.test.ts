import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitLog, onLogSessionIdle, type StoredSubmission } from "../submit";
import { planLog } from "../plan";
import { logContext } from "../context";
import { getLogState } from "../state";
import { runLogTool } from "../tools";
import { readRunJson } from "../run-store";
import { MAX_FAILED_SUBMITS, MAX_RESUMES } from "../../review/pipeline/loop";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-submit-"));
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { map.get(k).size(); }\n}\n");
  const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
  return cwd;
}
const LOG = "java.lang.NullPointerException: x\n\tat a.Svc.run(Svc.java:2)\n";

function start(cwd: string, sessionId: string) {
  // Each test gets its own mkdtempSync cwd, and planLog's idempotency window keys
  // on `${cwd}:${hash(raw)}` — no per-session suffix is needed to avoid a dedup
  // collision. A trailing comment line WOULD collide with one, though: parse.ts
  // (task 1, reviewed) treats any non-frame/non-header line after an exception
  // header as a continuation of that block's message (multi-line Java messages),
  // so appending one here would corrupt plan.observations against which the
  // valid() fixture below is matched verbatim (Gate 1).
  const runId = /runId[:=]\s*(\S+)/.exec(planLog({ log: LOG, judge: true }, cwd))![1]; // these tests cover the judged path
  logContext(runId, sessionId, cwd);
  const st = getLogState(sessionId)!;
  return { runId, st };
}

function valid(runId: string, token: string) {
  return {
    runId, submitToken: token,
    cause: { file: "src/a/Svc.java", line: 2, summary: "map.get(k) is null", mechanism: "k is never inserted" },
    evidence: [{ file: "src/a/Svc.java", lines: [1, 3], why: "the dereference" }],
    observations: [{ observation: "예외 1/1: java.lang.NullPointerException: x", explained: true, how: "null.size()" }],
    alternatives: [{ hypothesis: "map itself null", rejectedBecause: "constructed in ctor" }],
    resolution: { summary: "guard the get", changes: [{ file: "src/a/Svc.java", description: "Optional" }], kind: "root-cause" as const },
    confidence: 80,
  };
}

describe("submitLog", () => {
  test("valid submission is stored, session closes, next step names the judge", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-ok");
    const out = submitLog(valid(runId, st.submitToken), "s-ok");
    expect(out).toContain("✅");
    expect(out).toContain("f-log-judge");
    const stored = readRunJson<StoredSubmission>(runId, cwd, "submission-1.json")!;
    expect(stored.cause.summary).toBe("map.get(k) is null");
    expect(stored.round).toBe(1);
    expect(getLogState("s-ok")).toBeUndefined();
    expect(readRunJson(runId, cwd, "callLog.json")).toBeTruthy();
  });

  test("Chinese characters in Korean prose → rejected naming them; past the cap stored as written, not forced", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-han");
    const p = valid(runId, st.submitToken);
    p.cause.mechanism = "k가 삽入되지 않아 返回 값이 null";
    p.resolution.changes[0].description = "`中文` 인용은 허용";
    for (let i = 1; i <= MAX_FAILED_SUBMITS; i++) {
      const out = submitLog(p, "s-han");
      expect(out).toContain("Chinese characters");
      expect(out).toContain("返回");
      expect(out).not.toContain("中文");
    }
    expect(submitLog(p, "s-han")).toContain("✅");
    const stored = readRunJson<StoredSubmission>(runId, cwd, "submission-1.json")!;
    expect(stored.forced).toBeUndefined();
    expect(stored.cause.mechanism).toContain("返回");
  });

  test("missing observation → rejected with the missing line named", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-obs");
    const p = valid(runId, st.submitToken);
    p.observations = [];
    const out = submitLog(p, "s-obs");
    expect(out).toContain("observations");
    expect(out).toContain("예외 1/1");
    expect(out).toContain(`1/${MAX_FAILED_SUBMITS}`);
  });

  test("evidence on a file never read nor injected → rejected", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-ev");
    const p = valid(runId, st.submitToken);
    p.evidence = [{ file: "src/a/Other.java", lines: [1, 2], why: "?" }];
    expect(submitLog(p, "s-ev")).toContain("src/a/Other.java");
  });

  test("evidence path normalization: './src/a/Svc.java' matches the suspect 'src/a/Svc.java' (I-7)", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-norm");
    const p = valid(runId, st.submitToken);
    p.evidence = [{ file: "./src/a/Svc.java", lines: [1, 2], why: "the dereference" }];
    expect(submitLog(p, "s-norm")).toContain("✅");
  });

  test("evidence on a non-suspect file is accepted once the analyst read it", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "src/a/Extra.java"), "class Extra {}\n");
    const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    git(["add", "."]); git(["commit", "-qm", "add extra"]);
    const { runId, st } = start(cwd, "s-read");
    const p = valid(runId, st.submitToken);
    p.evidence = [{ file: "src/a/Extra.java", lines: [1, 1], why: "read it" }];
    expect(submitLog(p, "s-read")).toContain("src/a/Extra.java");
    runLogTool(st, "f_log_read", { file_path: "src/a/Extra.java" });
    expect(submitLog(p, "s-read")).toContain("✅");
  });

  test("stale token → ignored; past the cap → forced accept of the last valid payload", () => {
    const cwd = repo();
    const { runId, st } = start(cwd, "s-tok");
    submitLog({ ...valid(runId, st.submitToken), observations: [] }, "s-tok"); // parses, bounced → lastValid
    for (let i = 0; i < MAX_FAILED_SUBMITS; i++) expect(submitLog(valid(runId, "wrong"), "s-tok")).toContain("Stale");
    const out = submitLog(valid(runId, "wrong"), "s-tok");
    expect(out).toContain("forced");
    const stored = readRunJson<StoredSubmission>(runId, cwd, "submission-1.json")!;
    expect(stored.forced).toContain("stale");
  });

  test("schema-invalid past the cap with nothing valid → empty forced submission", () => {
    const cwd = repo();
    const { runId } = start(cwd, "s-bad");
    let out = "";
    for (let i = 0; i <= MAX_FAILED_SUBMITS; i++) out = submitLog({ runId, garbage: true }, "s-bad");
    expect(out).toContain("forced");
    const stored = readRunJson<StoredSubmission>(runId, cwd, "submission-1.json")!;
    expect(stored.cause.summary).toBe("");
    expect(stored.forced).toBeTruthy();
  });

  test("no session → NO_ACTIVE_LOG; wrong runId → refused", () => {
    const cwd = repo();
    expect(submitLog({}, "nobody")).toContain("No active log analysis");
    const { st } = start(cwd, "s-run");
    expect(submitLog(valid("other-run", st.submitToken), "s-run")).toContain("other-run");
  });
});

describe("submitLog KB check on fix code", () => {
  function kbRepo(svcImports: boolean): string {
    const cwd = mkdtempSync(join(tmpdir(), "f-log-submit-kb-"));
    const w = (rel: string, body: string) => { mkdirSync(join(cwd, rel, ".."), { recursive: true }); writeFileSync(join(cwd, rel), body); };
    w("src/a/Svc.java", `${svcImports ? "import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;\n" : ""}class Svc {\n  void run() { map.get(k).size(); }\n}\n`);
    w(".fico/config/fico_ai.json", JSON.stringify({ review: { frameworkKb: { "kr.co.koscom.pb.framework.site.ext.*": ".fico/kb/site-ext/" } } }));
    w(".fico/kb/site-ext/exception/PBOnlineException.md", "# PBOnlineException\nKBBODY: create(String code, Object... args)");
    const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
    return cwd;
  }
  const withFix = (runId: string, token: string) => {
    const p = valid(runId, token);
    p.resolution.changes = [{ file: "src/a/Svc.java", description: "null 가드", code: 'if (v == null) throw PBOnlineException.create("1002");' } as never];
    return p;
  };

  test("fix code using a framework class whose KB page the analyst never saw → one bounce carrying that page", () => {
    const cwd = kbRepo(false);
    const { runId, st } = start(cwd, "s-kb");
    const first = submitLog(withFix(runId, st.submitToken), "s-kb");
    expect(first).toContain("PBOnlineException");
    expect(first).toContain("KBBODY: create(String code, Object... args)");
    expect(submitLog(withFix(runId, st.submitToken), "s-kb")).toContain("✅"); // once only
  });

  test("the page was already in the context → no bounce", () => {
    const cwd = kbRepo(true);
    const { runId, st } = start(cwd, "s-kb2");
    expect(submitLog(withFix(runId, st.submitToken), "s-kb2")).toContain("✅");
  });
});

describe("onLogSessionIdle", () => {
  test("resumes up to MAX_RESUMES, then stores a partial submission", async () => {
    const cwd = repo();
    const { runId } = start(cwd, "s-idle");
    for (let i = 0; i < MAX_RESUMES; i++) {
      const a = await onLogSessionIdle("s-idle");
      expect(a?.kind).toBe("resume");
      expect(a?.text).toContain("f_log_submit");
    }
    const last = await onLogSessionIdle("s-idle");
    expect(last?.kind).toBe("finalized");
    const stored = readRunJson<StoredSubmission>(runId, cwd, "submission-1.json")!;
    expect(stored.partial).toBe(true);
    expect(await onLogSessionIdle("s-idle")).toBeNull();
  });
  test("exhausted budget → finalized immediately", async () => {
    const cwd = repo();
    const { st } = start(cwd, "s-exh");
    st.toolBudgetExhausted = true;
    expect((await onLogSessionIdle("s-exh"))?.kind).toBe("finalized");
  });
});
