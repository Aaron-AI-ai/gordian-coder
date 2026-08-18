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
  MAX_MISS_STREAK,
  MAX_FAILED_SUBMITS,
  NO_ACTIVE_REVIEW,
} from "../loop";
import { REQUIRED_CATEGORIES } from "../contract";

function baseState(over: Partial<ReviewState> = {}): ReviewState {
  return {
    active: true,
    cwd: ".",
    targets: ["a.ts", "b.ts"],
    currentIndex: 0,
    submitToken: "test-token",
    categories: ["security"],
    diffRange: null,
    ref: null,
    diffMap: {},
    wholeFile: false,
    systemRule: "",
    frameworkRules: "",
    extraRules: [],
    evidenceCache: {},
    requirementBackground: "",
    planGuidance: "",
    findings: {},
    baseline: new Set<string>(),
    label: "L",
    language: "ko",
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 10,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
    recheckCount: {},
    failedSubmits: {},
    staleSubmits: {},
    lastSubmitHash: {},
    lastValidFindings: {},
    forcedNotes: {},
    assessedByTarget: {},
    deepPasses: 1,
    deepPassDone: {},
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

  // `n` varies the message so consecutive submits differ — resubmitting the
  // exact payload the final check bounced is accepted instead of re-bounced.
  const fullSubmit = (file: string, n = 0) => ({
    assessed: [...REQUIRED_CATEGORIES],
    findings: [
      {
        category: "correctness",
        severity: "major",
        file,
        line: 1,
        rule: "r1",
        message: `issue ${n}`,
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
      const nudged = await submitReview(fullSubmit("a.ts", i), "t");
      expect(nudged).toContain("Final check");
      expect(getState("t")!.currentIndex).toBe(0);
    }
    // 6th submit → recheck cap reached, advance to b.ts
    const advanced = await submitReview(fullSubmit("a.ts", 6), "t");
    expect(advanced).toContain("Next file: b.ts");

    // b.ts: exhaust its own 5 reworks
    for (let i = 1; i <= 5; i++) {
      const nudged = await submitReview(fullSubmit("b.ts", i), "t");
      expect(nudged).toContain("Final check");
      expect(getState("t")!.currentIndex).toBe(1);
    }

    // 6th → report written, verdict FAIL (one major ≥ major)
    const done = await submitReview(fullSubmit("b.ts", 6), "t");
    expect(done).toContain("Review complete");
    expect(done).toContain("Verdict: FAIL");
    expect(done).toContain("without exploration calls");
    expect(getState("t")).toBeUndefined();

    const report = /Report: (.+)$/.exec(done)![1];
    const md = readFileSync(join(d, report), "utf8");
    expect(md).toContain("**Verdict: FAIL**");
    expect(md).toContain("## a.ts");
    // manifest lives in its own tree (fcq/f-review/manifest/), not beside the report
    const manifestDir = join(d, "fcq/f-review/manifest");
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

  it("preserves progress when f_review_context is repeated in the same session", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const before = getState("t")!;
    before.currentIndex = 1;
    before.iterations = 7;
    const token = before.submitToken;

    const duplicate = await startReview({ files: ["a.ts"] }, d, "t");
    expect(duplicate).toContain("Duplicate f_review_context ignored");
    expect(duplicate).toContain(`CURRENT_SUBMIT_TOKEN=${token}`);
    expect(getState("t")!.currentIndex).toBe(1);
    expect(getState("t")!.iterations).toBe(7);
  });

  it("serializes concurrent context calls so the first session state is not overwritten", async () => {
    const d = gitRepo();
    const [first, duplicate] = await Promise.all([
      startReview({ files: ["a.ts"] }, d, "t"),
      startReview({ files: ["b.ts"] }, d, "t"),
    ]);
    expect(first).toContain("Queued 1 target(s)");
    expect(duplicate).toContain("Duplicate f_review_context ignored");
    expect(getState("t")!.targets).toEqual(["a.ts"]);
  });

  it("files-only review defaults to whole-file mode", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"] }, d, "t");
    expect(getState("t")!.wholeFile).toBe(true);
    // Explicit whole:false opts back into the (working-tree) diff mode.
    await startReview({ files: ["a.ts"], whole: false }, d, "t2");
    expect(getState("t2")!.wholeFile).toBe(false);
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

  it("caps invalid submissions, then force-advances with empty findings", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    for (let i = 1; i <= 5; i++) {
      const msg = await submitReview({ garbage: true }, "t");
      expect(msg).toContain("Invalid submission");
      expect(msg).toContain(`rejected submit ${i}/5`);
      expect(getState("t")!.currentIndex).toBe(0);
    }
    // cap exceeded → salvage nothing, advance anyway
    const forced = await submitReview({ garbage: true }, "t");
    expect(forced).toContain("forced after repeated invalid submissions");
    expect(forced).toContain("Next file: b.ts");
    expect(getState("t")!.findings["a.ts"]).toEqual([]);
  });

  it("caps coverage-missing submissions, then force-advances with the findings it has", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const partial = {
      assessed: ["security"],
      findings: [
        { category: "security", severity: "major", file: "a.ts", line: 1, rule: "r", message: "m" },
      ],
    };
    for (let i = 1; i <= 5; i++) {
      expect(await submitReview(partial, "t")).toContain("Incomplete");
    }
    const forced = await submitReview(partial, "t");
    expect(forced).toContain("forced with incomplete coverage");
    expect(getState("t")!.findings["a.ts"]).toHaveLength(1);
  });

  it("counts malformed submits consecutively and resets after recovery", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 3 }, d, "t");

    for (let round = 0; round < 2; round++) {
      expect(await submitReview({ garbage: true }, "t")).toContain("rejected submit 1/5");
      const st = getState("t")!;
      guardExploration(st, "file_read", "");
      const recovered = await submitReview(
        { assessed: [...REQUIRED_CATEGORIES], findings: [] },
        "t"
      );
      expect(recovered).toContain(`Deep review round ${round + 2}/3`);
      expect(getState("t")!.failedSubmits["a.ts"]).toBe(0);
    }
  });

  it("bounces degenerate findings (wrong script / looping text), then drops them at the cap", async () => {
    const d = gitRepo();
    await startReview({}, d, "t"); // language defaults to ko
    const submit = {
      assessed: [...REQUIRED_CATEGORIES],
      findings: [
        {
          category: "correctness",
          severity: "major",
          file: "a.ts",
          line: 1,
          rule: "r",
          message: "这个代码存在严重的安全问题需要立即修复没有验证输入参数", // Chinese in a ko review
        },
        { category: "security", severity: "minor", file: "a.ts", line: 1, rule: "r2", message: "정상 소견", suggestion: "s" },
      ],
    };
    for (let i = 1; i <= 5; i++) {
      const msg = await submitReview(submit, "t");
      expect(msg).toContain("degenerate output");
      expect(getState("t")!.currentIndex).toBe(0);
    }
    // cap exceeded → the degenerate finding is dropped; the final check still
    // gets its one bounce, then repeating the payload is accepted
    expect(await submitReview(submit, "t")).toContain("Final check");
    const forced = await submitReview(submit, "t");
    expect(forced).toContain("Next file: b.ts");
    const kept = getState("t")!.findings["a.ts"];
    expect(kept).toHaveLength(1);
    expect(kept[0].message).toBe("정상 소견");
  });

  it("truncates an oversized submission instead of rejecting it", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    guardExploration(getState("t")!, "file_read", ""); // keep the final check clean
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" "); // >2000 chars, non-repetitive
    const findings = Array.from({ length: 51 }, (_, i) => ({
      category: "correctness",
      severity: "minor",
      file: "a.ts",
      line: 1,
      rule: `r${i}`,
      message: i ? `issue ${i}` : long,
      suggestion: "s",
    }));
    const msg = await submitReview({ assessed: [...REQUIRED_CATEGORIES], findings }, "t");
    expect(msg).not.toContain("Invalid submission");
    expect(msg).toContain("Next file: b.ts");
    const kept = getState("t")!.findings["a.ts"];
    expect(kept).toHaveLength(50); // overflow dropped, review NOT discarded
    expect(kept[0].message).toHaveLength(2000); // runaway text truncated
  });

  it("salvages the last parseable findings when invalid submits hit the cap", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    // A parseable submit bounces on the final check …
    expect(await submitReview(fullSubmit("a.ts", 1), "t")).toContain("Final check");
    // … then the model degrades into schema garbage past the cap.
    for (let i = 1; i <= 5; i++) {
      expect(await submitReview({ garbage: true }, "t")).toContain("Invalid submission");
    }
    const forced = await submitReview({ garbage: true }, "t");
    expect(forced).toContain("forced after repeated invalid submissions");
    expect(forced).toContain("salvaged");
    expect(getState("t")!.findings["a.ts"]).toHaveLength(1); // earlier findings kept, not []
  });

  it("terminates but never reports completion/PASS when a target was force-advanced", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], failOn: "major" }, d, "t"); // single target → forced terminal result
    for (let i = 1; i <= 5; i++) await submitReview({ garbage: true }, "t");
    const done = await submitReview({ garbage: true }, "t");
    expect(done).toContain("Review incomplete");
    expect(done).toContain("Verdict: FAIL");
    expect(done).not.toContain("Verdict: PASS");
    expect(done).not.toContain("✅ Review complete");
    expect(done).toContain("force-advanced");
    expect(done).toContain("a.ts");

    const report = /Report: (.+)$/.exec(done)![1];
    const md = readFileSync(join(d, report), "utf8");
    expect(md).toContain("Status: **INCOMPLETE**");
    expect(md).toContain("**Verdict: FAIL**");
    expect(md).not.toContain("**Verdict: PASS**");
  });

  it("accepts a byte-identical resubmission instead of bouncing it again", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    // no exploration + major w/o suggestion → final check would normally bounce 5×
    expect(await submitReview(fullSubmit("a.ts", 1), "t")).toContain("Final check");
    // the model loops: same payload again → pointless to bounce, accept and move on
    const accepted = await submitReview(fullSubmit("a.ts", 1), "t");
    expect(accepted).toContain("Next file: b.ts");
  });

  it("ignores a replay carrying the previous target's submit token", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const first = getState("t")!;
    const payload = {
      submitToken: first.submitToken,
      assessed: [...REQUIRED_CATEGORIES],
      findings: [],
    };
    guardExploration(first, "file_read", "");
    expect(await submitReview(payload, "t")).toContain("Next file: b.ts");

    const replay = await submitReview(payload, "t");
    expect(replay).toContain("Stale/duplicate f_review_submit ignored");
    expect(getState("t")!.currentIndex).toBe(1);
    expect(getState("t")!.findings["b.ts"]).toBeUndefined();
  });

  it("resets the stale-token streak after the model recovers", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 3 }, d, "t");
    const st = getState("t")!;
    const staleToken = st.submitToken;
    guardExploration(st, "file_read", "");
    expect(
      await submitReview(
        { submitToken: staleToken, assessed: [...REQUIRED_CATEGORIES], findings: [] },
        "t"
      )
    ).toContain("Deep review round 2/3");

    expect(
      await submitReview(
        { submitToken: staleToken, assessed: [...REQUIRED_CATEGORIES], findings: [] },
        "t"
      )
    ).toContain("Stale/duplicate");
    const current = getState("t")!;
    expect(current.staleSubmits["a.ts"]).toBe(1);

    guardExploration(current, "file_read", "");
    expect(
      await submitReview(
        {
          submitToken: current.submitToken,
          assessed: [...REQUIRED_CATEGORIES],
          findings: [],
        },
        "t"
      )
    ).toContain("Deep review round 3/3");
    expect(getState("t")!.staleSubmits["a.ts"]).toBe(0);
  });

  it("terminates repeated stale-token replay as forced INCOMPLETE", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 2, failOn: "major" }, d, "t");
    const first = getState("t")!;
    const staleToken = first.submitToken;
    guardExploration(first, "file_read", "");
    expect(
      await submitReview(
        { submitToken: staleToken, assessed: [...REQUIRED_CATEGORIES], findings: [] },
        "t"
      )
    ).toContain("Deep review round 2/2");

    for (let i = 1; i <= MAX_FAILED_SUBMITS; i++) {
      const ignored = await submitReview(
        { submitToken: staleToken, assessed: [...REQUIRED_CATEGORIES], findings: [] },
        "t"
      );
      expect(ignored).toContain("Stale/duplicate f_review_submit ignored");
    }
    const terminal = await submitReview(
      { submitToken: staleToken, assessed: [...REQUIRED_CATEGORIES], findings: [] },
      "t"
    );
    expect(terminal).toContain("Review incomplete");
    expect(terminal).toContain("Verdict: FAIL");
    expect(terminal).not.toContain("Verdict: PASS");
    expect(terminal).not.toContain("✅ Review complete");
    const report = /Report: (.+)$/.exec(terminal)![1];
    expect(readFileSync(join(d, report), "utf8")).toContain(
      "repeated stale submit-token replays"
    );
    expect(getState("t")).toBeUndefined();
  });

  it("dedupes exact-duplicate findings on accept", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const f = { category: "correctness", severity: "minor", file: "a.ts", line: 1, rule: "r", message: "m", suggestion: "s" };
    guardExploration(getState("t")!, "file_read", ""); // keep the final check clean
    await submitReview({ assessed: [...REQUIRED_CATEGORIES], findings: [f, { ...f }, { ...f }] }, "t");
    expect(getState("t")!.findings["a.ts"]).toHaveLength(1);
  });

  it("withholds output for exact-duplicate exploration calls, resetting on advance", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const st = getState("t")!;
    expect(guardExploration(st, "code_search", "out1", { q: "X" })).toBe("out1");
    expect(guardExploration(st, "code_search", "out1", { q: "X" })).toBe("out1");
    const blocked = guardExploration(st, "code_search", "out1", { q: "X" });
    expect(blocked).toContain("Duplicate call");
    expect(blocked).not.toContain("out1"); // output withheld, not appended
    // different args → answered normally
    expect(guardExploration(st, "code_search", "out2", { q: "Y" })).toBe("out2");

    // advancing to the next target clears the ledger
    await submitReview(
      {
        assessed: [...REQUIRED_CATEGORIES],
        findings: [
          { category: "correctness", severity: "minor", file: "a.ts", line: 1, rule: "r", message: "m", suggestion: "s" },
        ],
      },
      "t"
    );
    expect(currentFile(getState("t")!)).toBe("b.ts");
    expect(guardExploration(getState("t")!, "code_search", "out1", { q: "X" })).toBe("out1");
  });

  it("gives the final-check rework round a fresh exploration budget", async () => {
    const d = gitRepo();
    await startReview({}, d, "t");
    const st = getState("t")!;
    // burn the round budget AND the duplicate ledger before submitting
    for (let i = 0; i <= MAX_ITER; i++) guardExploration(st, "file_read", "", { f: "a.ts" });
    expect(guardExploration(st, "file_read", "out", { f: "a.ts" })).toContain("withheld");

    // the bounce orders re-verification — the ordered re-read must be answerable
    expect(await submitReview(fullSubmit("a.ts", 1), "t")).toContain("Final check");
    expect(st.iterations).toBe(0);
    expect(guardExploration(st, "file_read", "out", { f: "a.ts" })).toBe("out");
  });

  it("withholds output after MAX_MISS_STREAK consecutive not-found results", () => {
    const st = baseState();
    // Varied hunts for a symbol that is nowhere in the repo — args all differ,
    // so the duplicate guard never fires; the miss streak must.
    for (let i = 1; i < MAX_MISS_STREAK; i++) {
      const out = guardExploration(st, "code_search", "No matches for: PBOnlineException", { q: i });
      expect(out).toContain("No matches");
    }
    const blocked = guardExploration(st, "file_find", "// No file matches \"PBOnlineException\"", { q: "x" });
    expect(blocked).toContain("consecutive lookups found NOTHING");
    expect(blocked).not.toContain("// No file matches");
    // A hit resets the streak; misses are answered normally again.
    expect(guardExploration(st, "file_read", "1|code", { f: "a.ts" })).toBe("1|code");
    expect(
      guardExploration(st, "code_search", "No matches for: Y", { q: "y" })
    ).toContain("No matches for: Y");
  });

  it("withholds tool output entirely past MAX_ITER", () => {
    const st = baseState({ iterations: MAX_ITER });
    const res = guardExploration(st, "file_read", "file content here", { f: "a.ts" });
    expect(res).toContain("Exploration limit reached");
    expect(res).not.toContain("file content here");
  });

  it("a state-level maxIter (config) overrides the MAX_ITER default", () => {
    const st = baseState({ maxIter: 2 });
    expect(guardExploration(st, "file_read", "a", { f: "1" })).toBe("a");
    expect(guardExploration(st, "file_read", "b", { f: "2" })).toBe("b");
    expect(guardExploration(st, "file_read", "c", { f: "3" })).toContain(
      "Exploration limit reached (2"
    );
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
