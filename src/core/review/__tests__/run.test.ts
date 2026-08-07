import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RUN_TARGETS,
  RUN_BATCH_SIZE,
  RUNS_DIR,
  createRun,
  finalizeRun,
  loadRun,
  planReview,
  pruneRuns,
  readRunResults,
  reviewSlug,
  runCoverage,
  runDir,
  writeFileReview,
  type FileReviewResult,
  type RunMeta,
} from "../run";
import { startReview, submitReview, guardExploration, onSessionIdle, MAX_RESUMES } from "../loop";
import { getState, clearState } from "../state";
import { REQUIRED_CATEGORIES } from "../contract";

const tmps: string[] = [];
afterEach(() => {
  clearState("rs");
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "f-run-"));
  tmps.push(d);
  return d;
}

/** Two-commit git repo with a.ts and b.ts changed in HEAD. */
function gitRepo(): string {
  const d = dir();
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

const baseMeta = (targets: string[]): Omit<RunMeta, "runId" | "createdAt"> => ({
  targets,
  range: "HEAD~1..HEAD",
  whole: false,
  label: "L",
  language: "ko",
});

const result = (file: string, over: Partial<FileReviewResult> = {}): FileReviewResult => ({
  file,
  assessed: [...REQUIRED_CATEGORIES],
  findings: [
    {
      category: "correctness",
      severity: "major",
      file,
      line: 1,
      rule: "r1",
      message: "issue",
      suggestion: "fix it",
    },
  ],
  explorationCalls: 2,
  partial: false,
  ...over,
});

describe("run store primitives", () => {
  it("createRun/loadRun round-trips the meta", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    expect(meta.runId.startsWith("L-")).toBe(true);
    expect(loadRun(meta.runId, d)).toEqual(meta);
  });

  it("same-second re-plan gets a suffixed runId instead of merging", async () => {
    const d = dir();
    const m1 = await createRun(baseMeta(["a.ts"]), d);
    const m2 = await createRun(baseMeta(["b.ts"]), d);
    expect(m2.runId).not.toBe(m1.runId);
    expect(loadRun(m1.runId, d)?.targets).toEqual(["a.ts"]);
    expect(loadRun(m2.runId, d)?.targets).toEqual(["b.ts"]);
  });

  it("loadRun rejects unknown and path-escaping runIds", () => {
    const d = dir();
    expect(loadRun("nope", d)).toBeNull();
    expect(loadRun("../../etc", d)).toBeNull();
    expect(loadRun("a/b", d)).toBeNull();
  });

  it("reviewSlug is filesystem-safe and distinct per path", () => {
    expect(reviewSlug("src/core/a.ts")).toBe("src__core__a.ts");
    expect(reviewSlug("src\\win.ts")).toBe("src__win.ts");
    expect(reviewSlug("weird name?.ts")).toBe("weird_name_.ts");
  });

  it("writeFileReview + readRunResults round-trip; overwrite is idempotent", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["src/a.ts"]), d);
    await writeFileReview(meta.runId, result("src/a.ts"), "# md v1", d);
    await writeFileReview(meta.runId, result("src/a.ts", { explorationCalls: 9 }), "# md v2", d);
    const results = readRunResults(meta.runId, d);
    expect(results).toHaveLength(1); // overwritten, not duplicated
    expect(results[0].explorationCalls).toBe(9);
    const md = readFileSync(join(runDir(meta.runId, d), "reviews", "src__a.ts.md"), "utf8");
    expect(md).toBe("# md v2");
  });

  it("readRunResults skips corrupt json instead of throwing", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# md", d);
    writeFileSync(join(runDir(meta.runId, d), "reviews", "broken.json"), "{not json");
    expect(readRunResults(meta.runId, d)).toHaveLength(1);
  });

  it("runCoverage reports reviewed vs missing", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts", "b.ts", "c.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# md", d);
    const cov = runCoverage(meta, readRunResults(meta.runId, d));
    expect(cov.reviewed).toEqual(["a.ts"]);
    expect(cov.missing).toEqual(["b.ts", "c.ts"]);
  });

  it("pruneRuns keeps only the newest N run dirs", async () => {
    const d = dir();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await createRun({ ...baseMeta(["a.ts"]), label: `r${i}` }, d);
      ids.push(m.runId);
      // Distinct mtimes so newest-first ordering is deterministic.
      const when = new Date(Date.now() - (4 - i) * 60_000);
      utimesSync(runDir(m.runId, d), when, when);
    }
    const removed = pruneRuns(d, 2);
    expect(removed.sort()).toEqual([ids[0], ids[1]].sort());
    expect(existsSync(runDir(ids[3], d))).toBe(true);
  });
});

describe("planReview", () => {
  it("creates a run and returns fan-out instructions", async () => {
    const d = gitRepo();
    const msg = await planReview({}, d);
    expect(msg).toContain("Run created:");
    expect(msg).toContain("2 file(s)");
    expect(msg).toContain(`at most ${RUN_BATCH_SIZE} subagents`);
    expect(msg).toContain("f_review_finalize");
    const runId = /Run created: (\S+)/.exec(msg)![1];
    expect(loadRun(runId, d)?.targets).toEqual(["a.ts", "b.ts"]);
  });

  it("defaults files-only runs to whole-file mode", async () => {
    const d = gitRepo();
    const msg = await planReview({ files: ["a.ts"] }, d);
    expect(msg).toContain("whole-file");
    const runId = /Run created: (\S+)/.exec(msg)![1];
    expect(loadRun(runId, d)?.whole).toBe(true);
    // A commit-range run keeps the diff default, even with explicit files added.
    const msg2 = await planReview({ commit: "HEAD", files: ["a.ts"] }, d);
    expect(msg2).not.toContain("whole-file");
  });

  it("refuses runs above MAX_RUN_TARGETS", async () => {
    const d = dir();
    const files = Array.from({ length: MAX_RUN_TARGETS + 1 }, (_, i) => `f${i}.ts`);
    const msg = await planReview({ files }, d);
    expect(msg).toContain("exceed the per-run cap");
    expect(existsSync(join(d, RUNS_DIR))).toBe(false); // nothing created
  });

  it("returns the empty-target message without creating a run", async () => {
    const d = gitRepo();
    const msg = await planReview({ files: [".hidden/x.ts"] }, d);
    expect(msg).toContain("No files to review");
  });
});

describe("run-mode session (startReview/submitReview with runId)", () => {
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
        suggestion: "fix",
      },
    ],
  });

  it("joins a run for exactly one target file", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts", "b.ts"]), d);
    const msg = await startReview({ runId: meta.runId, files: ["a.ts"] }, d, "rs");
    expect(msg).toContain(`Run ${meta.runId}: reviewing a.ts`);
    expect(getState("rs")?.runId).toBe(meta.runId);
    expect(getState("rs")?.targets).toEqual(["a.ts"]);
  });

  it("rejects zero or multiple files, non-target files, and unknown runs", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    expect(await startReview({ runId: meta.runId }, d, "rs")).toContain("exactly ONE file");
    expect(await startReview({ runId: meta.runId, files: ["a.ts", "b.ts"] }, d, "rs")).toContain(
      "exactly ONE file"
    );
    expect(await startReview({ runId: meta.runId, files: ["b.ts"] }, d, "rs")).toContain(
      "not a target of run"
    );
    expect(await startReview({ runId: "ghost", files: ["a.ts"] }, d, "rs")).toContain("Unknown run");
  });

  it("submit writes the per-file review and never the aggregate report", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts", "b.ts"]), d);
    await startReview({ runId: meta.runId, files: ["a.ts"] }, d, "rs");
    guardExploration(getState("rs")!, "file_read", ""); // pass the final check first try
    const done = await submitReview(fullSubmit("a.ts"), "rs");
    expect(done).toContain("✅ a.ts reviewed");
    expect(done).toContain("task is COMPLETE");
    expect(getState("rs")).toBeUndefined(); // session cleared

    const results = readRunResults(meta.runId, d);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("a.ts");
    expect(results[0].partial).toBe(false);
    expect(results[0].explorationCalls).toBe(1);
    const md = readFileSync(join(runDir(meta.runId, d), "reviews", "a.ts.md"), "utf8");
    expect(md).toContain("## a.ts");
    // Aggregate report dir untouched by the subagent:
    expect(existsSync(join(d, "fcq/report/f-review"))).toBe(false);
  });

  it("splits a large whole-mode target into segments within ONE session", async () => {
    const d = gitRepo();
    const big = Array.from({ length: 1200 }, (_, i) => `// l${i}`).join("\n") + "\n";
    writeFileSync(join(d, "big.ts"), big);
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "big"], { cwd: d });

    const meta = await createRun({ ...baseMeta(["big.ts"]), whole: true }, d);
    await startReview({ runId: meta.runId, files: ["big.ts"] }, d, "rs");
    const st = getState("rs")!;
    expect(st.targets.length).toBeGreaterThan(1); // segmented
    expect(st.targets.every((t) => t.startsWith("big.ts#"))).toBe(true);

    for (let i = 0; i < st.targets.length; i++) {
      guardExploration(st, "file_read", "");
      await submitReview(fullSubmit("big.ts"), "rs");
    }
    const results = readRunResults(meta.runId, d);
    expect(results).toHaveLength(1); // merged into one file review
    expect(results[0].file).toBe("big.ts");
    expect(results[0].findings.length).toBe(st.targets.length); // one per segment
  });

  it("idle watchdog past the cap saves a PARTIAL per-file review", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await startReview({ runId: meta.runId, files: ["a.ts"] }, d, "rs");
    for (let i = 0; i < MAX_RESUMES; i++) {
      expect((await onSessionIdle("rs"))?.kind).toBe("resume");
    }
    const fin = await onSessionIdle("rs");
    expect(fin?.kind).toBe("finalized");
    expect(fin?.text).toContain("partially reviewed");
    const results = readRunResults(meta.runId, d);
    expect(results[0].partial).toBe(true);
  });
});

describe("finalizeRun", () => {
  it("rejects an unknown run", async () => {
    expect(await finalizeRun("ghost", dir())).toContain("Unknown run");
  });

  it("aggregates a complete run into the standard report + run summary", async () => {
    const d = gitRepo();
    const meta = await createRun({ ...baseMeta(["a.ts", "b.ts"]), failOn: "major" }, d);
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);
    await writeFileReview(meta.runId, result("b.ts", { findings: [] }), "# b", d);

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("✅ Run complete — 2 file(s), 1 issue(s)");
    expect(msg).toContain("Verdict: FAIL"); // one major ≥ failOn major

    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md).toContain("## a.ts");
    expect(md).toContain("## b.ts");
    expect(md).toContain("## Run Summary");
    expect(md).toContain("Coverage: 2/2 file(s) reviewed — complete");
  });

  it("flags missing files as INCOMPLETE with a single-retry instruction", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts", "b.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts", { explorationCalls: 0, partial: true }), "# a", d);

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("⚠️ INCOMPLETE — 1/2");
    expect(msg).toContain("missing: b.ts");
    expect(msg).toContain("at most once");

    const path = /Partial report: (.+)$/m.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md).toContain("**INCOMPLETE**, missing: b.ts");
    expect(md).toContain("Partial reviews (subagent cut off early): a.ts");
    expect(md).toContain("Reviewed without exploration calls");
  });

  it("baseline is snapshotted at plan time — a finalize retry never marks this run's findings as pre-existing", async () => {
    const d = gitRepo();
    // A prior report exists with rule "old-rule" on a.ts.
    const { writeReport } = await import("../output");
    await writeReport(
      "fcq/report/f-review/review-prev.md",
      { "a.ts": [{ category: "correctness", severity: "major", file: "a.ts", rule: "old-rule", message: "m" }] },
      "prev",
      d,
      "ko"
    );

    const planMsg = await planReview({}, d);
    const runId = /Run created: (\S+)/.exec(planMsg)![1];
    expect(loadRun(runId, d)!.baseline!.length).toBeGreaterThan(0); // snapshot taken

    // a.ts re-finds old-rule AND finds new-rule; b.ts is still missing.
    await writeFileReview(
      runId,
      result("a.ts", {
        findings: [
          { category: "correctness", severity: "major", file: "a.ts", rule: "old-rule", message: "m" },
          { category: "correctness", severity: "major", file: "a.ts", rule: "new-rule", message: "n", suggestion: "s" },
        ],
      }),
      "# a",
      d
    );
    const fin1 = await finalizeRun(runId, d); // INCOMPLETE — writes a partial report
    expect(fin1).toContain("INCOMPLETE");

    await writeFileReview(runId, result("b.ts", { findings: [] }), "# b", d);
    const fin2 = await finalizeRun(runId, d); // retry: must not treat fin1's report as baseline
    const md = readFileSync(join(d, /Report: (.+)$/.exec(fin2)![1]), "utf8");
    const oldRow = md.split("\n").find((l) => l.includes("old-rule"))!;
    const newRow = md.split("\n").find((l) => l.includes("new-rule"))!;
    expect(oldRow).toContain("[기존]"); // genuinely pre-existing (from review-prev.md)
    expect(newRow).not.toContain("[기존]"); // found in THIS run — retry must not relabel it
  });

  it("ignores stray reviews for files outside the run's targets", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);
    await writeFileReview(meta.runId, result("evil.ts"), "# evil", d);

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("✅ Run complete — 1 file(s), 1 issue(s)");
    const md = readFileSync(join(d, /Report: (.+)$/.exec(msg)![1]), "utf8");
    expect(md).not.toContain("evil.ts");
  });
});
