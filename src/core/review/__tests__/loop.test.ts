import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  type ReviewState,
} from "../state";
import { MAX_ITER } from "../reader";
import {
  startReview,
  submitReview,
  reviewPromptFor,
  guardExploration,
  onSessionIdle,
  MAX_RESUMES,
  NO_ACTIVE_REVIEW,
} from "../loop";
import { REQUIRED_CATEGORIES } from "../contract";

function baseState(over: Partial<ReviewState> = {}): ReviewState {
  return {
    active: true,
    cwd: ".",
    targets: ["a.ts", "b.ts"],
    currentIndex: 0,
    categories: ["security"],
    diffRange: null,
    ref: null,
    diffMap: {},
    wholeFile: false,
    systemRule: "",
    frameworkRules: "",
    evidenceCache: {},
    requirementBackground: "",
    planGuidance: "",
    findings: {},
    baseline: new Set<string>(),
    label: "L",
    language: "ko",
    iterations: 0,
    callLog: {},
    recheckCount: {},
    resumes: 0,
    ...over,
  };
}

describe("state", () => {
  it("stores and retrieves by sessionId", () => {
    setState("s1", baseState());
    expect(getState("s1")?.targets).toEqual(["a.ts", "b.ts"]);
    clearState("s1");
    expect(getState("s1")).toBeUndefined();
  });

  it("currentFile/otherFiles track the pointer", () => {
    const st = baseState({ currentIndex: 1 });
    expect(currentFile(st)).toBe("b.ts");
    expect(otherFiles(st)).toEqual(["a.ts"]);
  });

  it("isDone when the index runs past targets", () => {
    expect(isDone(baseState({ currentIndex: 2 }))).toBe(true);
    expect(isDone(baseState({ currentIndex: 1 }))).toBe(false);
  });

  it("MAX_ITER is a positive guard", () => {
    expect(MAX_ITER).toBeGreaterThan(0);
  });

  it("caps the store and evicts oldest first, sparing the touched review", () => {
    for (let i = 0; i < 60; i++) setState(`e${i}`, baseState());
    getState("e10"); // bump an old one back to most-recent
    setState("e60", baseState()); // trigger one more eviction pass
    expect(getState("e0")).toBeUndefined(); // oldest untouched → evicted
    expect(getState("e10")).toBeDefined(); // touched → survives
    expect(getState("e60")).toBeDefined(); // newest → survives
    for (let i = 0; i < 61; i++) clearState(`e${i}`);
  });
});

describe("startReview / submitReview (full loop)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    clearState("t");
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  function gitRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "k-loop-"));
    tmps.push(d);
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@t"]);
    sh(["git", "config", "user.name", "t"]);
    writeFileSync(join(d, "a.ts"), "a1\n");
    writeFileSync(join(d, "b.ts"), "b1\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    writeFileSync(join(d, "a.ts"), "a2\n");
    writeFileSync(join(d, "b.ts"), "b2\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "change"]);
    return d;
  }

  const fullSubmit = (file: string) => ({
    assessed: [...REQUIRED_CATEGORIES],
    findings: [
      {
        category: "correctness",
        severity: "major",
        file,
        line: 1,
        rule: "r1",
        message: "issue",
      },
    ],
  });

  it("runs start → gate → advance → report with verdict", async () => {
    const d = gitRepo();
    const msg = await startReview({ failOn: "major" }, d, "t");
    expect(msg).toContain("Queued 2 target(s)");
    const st = getState("t")!;
    expect(st.targets).toEqual(["a.ts", "b.ts"]);
    const firstPrompt = reviewPromptFor(st)!;
    expect(firstPrompt).toContain("<current_file_path>a.ts</current_file_path>");
    expect(firstPrompt).toContain("Related code");
    expect(firstPrompt).toContain("Git history");
    expect(st.evidenceCache["a.ts"]).toBeTruthy();

    // incomplete coverage → gate holds
    const gated = await submitReview({ assessed: ["security"], findings: [] }, "t");
    expect(gated).toContain("Incomplete");
    expect(getState("t")!.currentIndex).toBe(0);

    // full coverage but no exploration + major w/o suggestion → per-file final
    // check reworks the file up to 5 times before letting it through
    for (let i = 1; i <= 5; i++) {
      const nudged = await submitReview(fullSubmit("a.ts"), "t");
      expect(nudged).toContain("Final check");
      expect(getState("t")!.currentIndex).toBe(0);
    }
    // 6th submit → recheck cap reached, advance to b.ts
    const advanced = await submitReview(fullSubmit("a.ts"), "t");
    expect(advanced).toContain("Next file: b.ts");

    // b.ts: exhaust its own 5 reworks
    for (let i = 1; i <= 5; i++) {
      const nudged = await submitReview(fullSubmit("b.ts"), "t");
      expect(nudged).toContain("Final check");
      expect(getState("t")!.currentIndex).toBe(1);
    }

    // 6th → report written, verdict FAIL (one major ≥ major)
    const done = await submitReview(fullSubmit("b.ts"), "t");
    expect(done).toContain("Review complete");
    expect(done).toContain("Verdict: FAIL");
    expect(done).toContain("without exploration calls");
    expect(getState("t")).toBeUndefined();

    const report = /Report: (.+)$/.exec(done)![1];
    const md = readFileSync(join(d, report), "utf8");
    expect(md).toContain("**Verdict: FAIL**");
    expect(md).toContain("## a.ts");
    // manifest lives in its own tree (fcq/k-codereview/manifest/), not beside the report
    const manifestDir = join(d, "fcq/k-codereview/manifest");
    expect(readdirSync(manifestDir).some((f) => f.endsWith("-targets.md"))).toBe(true);
  });

  it("submit without an active review is rejected", async () => {
    expect(await submitReview({ assessed: [], findings: [] }, "nope")).toBe(NO_ACTIVE_REVIEW);
  });

  it("whole:true reviews full file content instead of the diff", async () => {
    const d = gitRepo();
    const msg = await startReview({ whole: true }, d, "t");
    expect(msg).toContain("whole-file");
    const st = getState("t")!;
    expect(st.wholeFile).toBe(true);
    const prompt = reviewPromptFor(st)!;
    expect(prompt).toContain("<current_file>");
    expect(prompt).toContain("1|a2"); // full (line-numbered) content at HEAD
    expect(prompt).not.toContain("<current_file_diff>");
  });

  it("records tool calls per file and skips the final check when clean", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const st = getState("t")!;

    guardExploration(st, "file_read", "");
    guardExploration(st, "file_read", "");
    guardExploration(st, "code_search", "");
    expect(st.callLog["a.ts"]).toEqual({ file_read: 2, code_search: 1 });

    const withFix = (file: string) => ({
      assessed: [...REQUIRED_CATEGORIES],
      findings: [
        {
          category: "correctness",
          severity: "major",
          file,
          line: 1,
          rule: "r1",
          message: "issue",
          suggestion: "fix it like this",
        },
      ],
    });
    await submitReview(withFix("a.ts"), "t");
    guardExploration(getState("t")!, "related_code", "");

    // last file explored + suggestions present → no nudge, straight to report
    const done = await submitReview(withFix("b.ts"), "t");
    expect(done).toContain("Review complete");
    expect(done).not.toContain("Final check");
    expect(done).not.toContain("without exploration calls");
  });

  it("idle watchdog re-drives an incomplete review, then finalizes a partial report", async () => {
    const d = gitRepo();
    await startReview({}, d, "t"); // 2 targets: a.ts, b.ts
    const withFix = {
      assessed: [...REQUIRED_CATEGORIES],
      findings: [
        { category: "correctness", severity: "minor", file: "a.ts", line: 1, rule: "r", message: "m", suggestion: "s" },
      ],
    };
    guardExploration(getState("t")!, "file_read", ""); // clear a.ts's final check
    await submitReview(withFix, "t"); // a.ts done → currentIndex 1, b.ts pending

    // idle with b.ts unsubmitted → resume nudge, up to MAX_RESUMES times
    for (let i = 1; i <= MAX_RESUMES; i++) {
      const action = await onSessionIdle("t");
      expect(action?.kind).toBe("resume");
      expect(action?.text).toContain("1/2 file(s) submitted");
      expect(getState("t")!.resumes).toBe(i);
    }

    // cap reached → finalize a partial report and clear the session
    const fin = await onSessionIdle("t");
    expect(fin?.kind).toBe("finalized");
    expect(fin?.text).toContain("Review incomplete");
    expect(fin?.text).toContain("1/2 target(s) reviewed");
    expect(getState("t")).toBeUndefined();
    const report = /Report: (.+)$/.exec(fin!.text)![1];
    expect(readFileSync(join(d, report), "utf8")).toContain("## a.ts");

    // idle after finalize / no active review → no-op
    expect(await onSessionIdle("t")).toBeNull();
    expect(await onSessionIdle("nope")).toBeNull();
  });

  it("idle watchdog does nothing when the review already finished", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const full = (file: string) => ({
      assessed: [...REQUIRED_CATEGORIES],
      findings: [
        { category: "correctness", severity: "minor", file, line: 1, rule: "r", message: "m", suggestion: "s" },
      ],
    });
    guardExploration(getState("t")!, "file_read", "");
    await submitReview(full("a.ts"), "t");
    guardExploration(getState("t")!, "file_read", "");
    await submitReview(full("b.ts"), "t"); // all done → state cleared
    expect(await onSessionIdle("t")).toBeNull();
  });

  it("concurrent reviews of the same commit get distinct report labels", async () => {
    const d = gitRepo();
    await startReview({}, d, "sessA");
    await startReview({}, d, "sessB"); // same commit, still active → must not clobber
    const a = getState("sessA")!;
    const b = getState("sessB")!;
    clearState("sessA");
    clearState("sessB");
    expect(a.label).not.toBe(b.label);
  });
});
