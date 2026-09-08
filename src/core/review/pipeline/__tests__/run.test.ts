import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeRun, planReview } from "../run";
import { MAX_RUN_TARGETS, MAX_UNFINISHED_RUNS, UNFINISHED_RUN_TTL_MS, RUN_BATCH_SIZE, createRun, pruneRuns, readRunResults, reviewCriteriaIdentity, runCoverage, writeFileReview } from "../run-store";
import { loadRun, type RunMeta } from "../artifact";
import { RUNS_DIR, reviewSlug, runDir, type FileReviewResult } from "../artifact";
import { submitReview, guardExploration, onSessionIdle, MAX_RESUMES } from "../loop";
import { startReview } from "../start";
import { getState, clearState } from "../state";
import { REQUIRED_CATEGORIES } from "../../contract";

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

  it("claims unique run ids for concurrent creators", async () => {
    const d = dir();
    const runs = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createRun({ ...baseMeta(["a.ts"]), planGuidance: `parallel-${index}` }, d)
      )
    );
    expect(new Set(runs.map((run) => run.runId)).size).toBe(runs.length);
    for (const run of runs) {
      expect(loadRun(run.runId, d)?.planGuidance).toBe(run.planGuidance);
    }
  });

  it("loadRun rejects unknown and path-escaping runIds", () => {
    const d = dir();
    expect(loadRun("nope", d)).toBeNull();
    expect(loadRun("../../etc", d)).toBeNull();
    expect(loadRun("a/b", d)).toBeNull();
  });

  it("reviewSlug is filesystem-safe and distinct per path", () => {
    expect(reviewSlug("src/core/a.ts")).toStartWith("src__core__a.ts--");
    expect(reviewSlug("src\\win.ts")).toStartWith("src__win.ts--");
    expect(reviewSlug("weird name?.ts")).toStartWith("weird_name_.ts--");
    expect(reviewSlug("a/b.ts")).not.toBe(reviewSlug("a__b.ts"));
  });

  it("writeFileReview + readRunResults round-trip; overwrite is idempotent", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["src/a.ts"]), d);
    await writeFileReview(meta.runId, result("src/a.ts"), "# md v1", d);
    await writeFileReview(meta.runId, result("src/a.ts", { explorationCalls: 9 }), "# md v2", d);
    const results = readRunResults(meta.runId, d);
    expect(results).toHaveLength(1); // overwritten, not duplicated
    expect(results[0].explorationCalls).toBe(9);
    expect(results[0].revision).toBe(2);
    expect(results[0].coverageComplete).toBe(true);
    const md = readFileSync(
      join(runDir(meta.runId, d), "reviews", `${reviewSlug("src/a.ts")}.md`),
      "utf8"
    );
    expect(md).toBe("# md v2");
  });

  it("readRunResults skips corrupt json instead of throwing", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# md", d);
    writeFileSync(join(runDir(meta.runId, d), "reviews", "broken.json"), "{not json");
    expect(readRunResults(meta.runId, d)).toHaveLength(1);
  });

  it("readRunResults rejects valid JSON with a corrupt shape or wrong artifact filename", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    const reviews = join(runDir(meta.runId, d), "reviews");
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, "a.ts.json"), "{}");
    writeFileSync(join(reviews, "renamed.json"), JSON.stringify(result("a.ts")));
    expect(readRunResults(meta.runId, d)).toEqual([]);
    expect(runCoverage(meta, readRunResults(meta.runId, d)).missing).toEqual(["a.ts"]);
  });

  it("rejects a finding whose embedded file does not match its review artifact", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    const bad = result("a.ts");
    bad.findings[0].file = "other.ts";
    expect(writeFileReview(meta.runId, bad, "# bad", d)).rejects.toThrow("does not match");
    expect(readRunResults(meta.runId, d)).toEqual([]);
  });

  it("runCoverage reports reviewed vs missing", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts", "b.ts", "c.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# md", d);
    const cov = runCoverage(meta, readRunResults(meta.runId, d));
    expect(cov.reviewed).toEqual(["a.ts"]);
    expect(cov.missing).toEqual(["b.ts", "c.ts"]);
  });

  it("pruneRuns keeps unfinished runs and only the newest N terminal runs", async () => {
    const d = dir();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await createRun(
        { ...baseMeta(["a.ts"]), label: `r${i}`, output: join(d, `report-${i}.md`) },
        d
      );
      ids.push(m.runId);
      await writeFileReview(m.runId, result("a.ts"), "# a", d);
      await finalizeRun(m.runId, d);
      // Distinct mtimes so newest-first ordering is deterministic.
      const when = new Date(Date.now() - (4 - i) * 60_000);
      utimesSync(runDir(m.runId, d), when, when);
    }
    const unfinished = await createRun(
      { ...baseMeta(["a.ts"]), label: "unfinished", output: join(d, "unfinished.md") },
      d
    );
    await finalizeRun(unfinished.runId, d);
    const cachePath = join(runDir(unfinished.runId, d), "finalize.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    writeFileSync(cachePath, JSON.stringify({ ...cache, terminal: true }));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(runDir(unfinished.runId, d), old, old);

    const removed = pruneRuns(d, 2);
    expect(removed.sort()).toEqual([ids[0], ids[1]].sort());
    expect(existsSync(runDir(ids[3], d))).toBe(true);
    expect(existsSync(runDir(unfinished.runId, d))).toBe(true);
  });

  it("prunes abandoned unfinished runs after the TTL", async () => {
    const d = dir();
    const stale = await createRun(baseMeta(["a.ts"]), d);
    const old = new Date(Date.now() - UNFINISHED_RUN_TTL_MS - 1000);
    writeFileSync(
      join(runDir(stale.runId, d), "run.json"),
      JSON.stringify({
        ...stale,
        createdAt: old.toISOString(),
      })
    );
    utimesSync(join(runDir(stale.runId, d), "run.json"), old, old);
    utimesSync(runDir(stale.runId, d), old, old);
    expect(pruneRuns(d)).toContain(stale.runId);
    expect(existsSync(runDir(stale.runId, d))).toBe(false);
  });

  it("keeps an old unfinished run when a review artifact was written recently", async () => {
    const d = dir();
    const stale = await createRun(baseMeta(["a.ts"]), d);
    const old = new Date(Date.now() - UNFINISHED_RUN_TTL_MS - 1000);
    writeFileSync(
      join(runDir(stale.runId, d), "run.json"),
      JSON.stringify({ ...stale, createdAt: old.toISOString() })
    );
    utimesSync(join(runDir(stale.runId, d), "run.json"), old, old);
    utimesSync(runDir(stale.runId, d), old, old);

    await writeFileReview(stale.runId, result("a.ts"), "# recent work", d);
    expect(pruneRuns(d)).not.toContain(stale.runId);
    expect(existsSync(runDir(stale.runId, d))).toBe(true);
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

  it("reports the effective settings and the config file they came from", async () => {
    const d = gitRepo();
    mkdirSync(join(d, ".fico", "config"), { recursive: true });
    writeFileSync(
      join(d, ".fico", "config", "fico_ai.json"),
      JSON.stringify({ review: { judge: true, deepPasses: 3 } })
    );
    const msg = await planReview({}, d);
    expect(msg).toContain("deepPasses=3");
    expect(msg).toContain("judge=on");
    expect(msg).toContain("fcq=off");
    expect(msg).toContain("config: .fico/config/fico_ai.json");
  });

  it("says so when no project config was found", async () => {
    const msg = await planReview({}, gitRepo());
    expect(msg).toContain("no project config found");
  });

  it("creates a fresh run for a repeated identical plan (no resume)", async () => {
    const d = gitRepo();
    const first = await planReview({}, d);
    const firstId = /Run created: (\S+)/.exec(first)![1];
    const second = await planReview({}, d);
    expect(second).toContain("Run created:");
    const secondId = /Run created: (\S+)/.exec(second)![1];
    expect(secondId).not.toBe(firstId);
    expect(readdirSync(join(d, RUNS_DIR)).filter((name) => name !== ".claims")).toHaveLength(2);
  });

  it("concurrent identical plans never create two runs in the same instant", async () => {
    const d = gitRepo();
    const modulePath = join(import.meta.dir, "..", "run.ts");
    const script =
      `import { planReview } from ${JSON.stringify(modulePath)};` +
      `process.stdout.write(await planReview({}, ${JSON.stringify(d)}));`;
    const workers = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, "-e", script], { cwd: d, stdout: "pipe", stderr: "pipe" })
    );
    const messages = await Promise.all(
      workers.map(async (worker) => {
        const output = await new Response(worker.stdout).text();
        expect(await worker.exited).toBe(0);
        return output;
      })
    );
    // Overlapping planners are refused by the claim; non-overlapping ones each
    // create their own run (always-fresh). Nobody resumes, nothing else leaks.
    const created = messages.filter((message) => message.startsWith("Run created:"));
    const refused = messages.filter((message) =>
      message.includes("still being created by another process")
    );
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length + refused.length).toBe(messages.length);
    expect(readdirSync(join(d, RUNS_DIR)).filter((name) => name !== ".claims")).toHaveLength(
      created.length
    );
  });

  it("creates a new run when HEAD moves even if the changed file list is identical", async () => {
    const d = gitRepo();
    const first = await planReview({}, d);
    const firstId = /Run created: (\S+)/.exec(first)![1];
    const firstRange = loadRun(firstId, d)!.range;

    writeFileSync(join(d, "a.ts"), "a3\n");
    writeFileSync(join(d, "b.ts"), "b3\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "next"], { cwd: d });

    const second = await planReview({}, d);
    expect(second).toContain("Run created:");
    expect(second).not.toContain("Duplicate f_review_plan ignored");
    const secondId = /Run created: (\S+)/.exec(second)![1];
    expect(secondId).not.toBe(firstId);
    expect(loadRun(secondId, d)!.range).not.toBe(firstRange);
  });

  it("creates a new run when effective project review rules change", async () => {
    const d = gitRepo();
    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(join(d, "review", "rules", "local.md"), "# Local\n\nfirst rule\n");
    const first = await planReview({}, d);

    writeFileSync(join(d, "review", "rules", "local.md"), "# Local\n\nsecond rule\n");
    const second = await planReview({}, d);
    expect(second).toContain("Run created:");
    expect(second).not.toContain("Duplicate f_review_plan ignored");
    expect(/Run created: (\S+)/.exec(second)![1]).not.toBe(/Run created: (\S+)/.exec(first)![1]);
  });

  it("bounds distinct unfinished plans without deleting an active run", async () => {
    const d = gitRepo();
    const ids: string[] = [];
    for (let i = 0; i < MAX_UNFINISHED_RUNS; i++) {
      const meta = await createRun(
        { ...baseMeta(["a.ts", "b.ts"]), planGuidance: `variant-${i}` },
        d
      );
      ids.push(meta.runId);
    }
    const refused = await planReview({ planGuidance: "one-too-many" }, d);
    expect(refused).toContain("Refusing to create another run");
    expect(readdirSync(join(d, RUNS_DIR)).filter((name) => name !== ".claims")).toHaveLength(
      MAX_UNFINISHED_RUNS
    );
    expect(existsSync(runDir(ids[0], d))).toBe(true);
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

  it("tells the orchestrator to wait for the fix pass before finalizing", async () => {
    // Without this the orchestrator finalizes when judging is done, and a fix
    // still in flight misses the report entirely.
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ fcq: false }));
    const plain = await planReview({ commit: "HEAD" }, d);
    expect(plain).not.toContain("every fix subagent has returned");
    expect(plain).not.toContain("FIX PASS");
  });

  it("refuses runs above MAX_RUN_TARGETS", async () => {
    const d = dir();
    const files = Array.from({ length: MAX_RUN_TARGETS + 1 }, (_, i) => `f${i}.ts`);
    for (const f of files) writeFileSync(join(d, f), "x\n"); // targets must exist to be planned
    const msg = await planReview({ files }, d);
    expect(msg).toContain("exceed the per-run cap");
    expect(existsSync(join(d, RUNS_DIR))).toBe(false); // nothing created
  });

  it("returns the empty-target message without creating a run", async () => {
    const d = gitRepo();
    mkdirSync(join(d, ".hidden"), { recursive: true });
    writeFileSync(join(d, ".hidden/x.ts"), "x\n");
    // The file exists and resolves; the dot-path rule is what empties the set.
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

  it("rejects joining a run after its effective review rules changed", async () => {
    const d = gitRepo();
    const msg = await planReview({ files: ["a.ts"] }, d);
    const runId = /Run created: (\S+)/.exec(msg)![1];
    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(join(d, "review", "rules", "new.md"), "# Newly authoritative rule\n");

    const stale = await startReview({ runId, files: ["a.ts"] }, d, "rs");
    expect(stale).toContain("effective review rules changed");
    expect(getState("rs")).toBeUndefined();
  });

  it("rejects joining a files-only run after its source snapshot changed", async () => {
    const d = gitRepo();
    const msg = await planReview({ files: ["a.ts"] }, d);
    const runId = /Run created: (\S+)/.exec(msg)![1];
    writeFileSync(join(d, "a.ts"), "changed after planning\n");

    const stale = await startReview({ runId, files: ["a.ts"] }, d, "rs");
    expect(stale).toContain("files-only source snapshot changed");
    expect(getState("rs")).toBeUndefined();
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
    const md = readFileSync(
      join(runDir(meta.runId, d), "reviews", `${reviewSlug("a.ts")}.md`),
      "utf8"
    );
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

  it("aggregates a complete run into the standard findings-only report", async () => {
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
    // Operational run info lives in the tool response only — the report stays
    // findings-only.
    expect(md).not.toContain("## Run Summary");
    // Input parameters + criteria sources ARE recorded, as the Review Context.
    expect(md).toContain("## Review Context");
    expect(md).toContain("- Mode: commit diff (");
    expect(md).toContain("- Rubric: ");
    expect(md).toContain("### Files");
    expect(md).toContain("- a.ts");
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
    expect(md).toContain("## a.ts");
    expect(md).not.toContain("## Run Summary"); // incompleteness is reported in msg only
  });

  it("keeps bounded-recovery and partial artifacts terminal but quality-incomplete", async () => {
    const d = gitRepo();
    const meta = await createRun({ ...baseMeta(["a.ts", "b.ts"]), failOn: "major" }, d);
    await writeFileReview(
      meta.runId,
      result("a.ts", {
        findings: [],
        forced: "forced after repeated invalid submissions",
        coverageComplete: false,
      }),
      "# a",
      d
    );
    await writeFileReview(
      meta.runId,
      result("b.ts", { findings: [], partial: true, coverageComplete: false }),
      "# b",
      d
    );

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("Run terminated — INCOMPLETE");
    expect(msg).toContain("Verdict: FAIL");
    expect(msg).not.toContain("missing:");
    expect(msg).not.toContain("Re-spawn");
    expect(msg).not.toContain("Verdict: PASS");
    expect(msg).not.toContain("✅ Run complete");
    expect(msg).toContain("force-advanced by bounded recovery");

    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md).not.toContain("## Run Summary"); // quality verdict is in msg only
    expect(md).not.toContain("Verdict: PASS"); // failOn suppressed for incomplete runs
  });

  it("baseline is snapshotted at plan time — a finalize retry never marks this run's findings as pre-existing", async () => {
    const d = gitRepo();
    // A prior report exists with rule "old-rule" on a.ts.
    const { writeReport } = await import("../../report/output");
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

  it("returns a cached finalize response without rewriting/archiving the report", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);

    const first = await finalizeRun(meta.runId, d);
    const reportPath = join(d, /Report: (.+)$/.exec(first)![1]);
    const firstMtime = statSync(reportPath).mtimeMs;
    const second = await finalizeRun(meta.runId, d);
    expect(second).toBe(first);
    expect(statSync(reportPath).mtimeMs).toBe(firstMtime);
  });

  it("reuses the finalize cache when output is an absolute path", async () => {
    const d = gitRepo();
    const reportPath = join(d, "absolute-report.md");
    const meta = await createRun({ ...baseMeta(["a.ts"]), output: reportPath }, d);
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);

    const first = await finalizeRun(meta.runId, d);
    const firstMtime = statSync(reportPath).mtimeMs;
    const second = await finalizeRun(meta.runId, d);
    expect(second).toBe(first);
    expect(statSync(reportPath).mtimeMs).toBe(firstMtime);
  });

  it("invalidates the finalize cache when an output-affecting run option changes", async () => {
    const d = gitRepo();
    const reportPath = join(d, "gate.md");
    const meta = await createRun(
      { ...baseMeta(["a.ts"]), failOn: "major", output: reportPath },
      d
    );
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);
    expect(await finalizeRun(meta.runId, d)).toContain("Verdict: FAIL");

    writeFileSync(
      join(runDir(meta.runId, d), "run.json"),
      JSON.stringify({ ...meta, failOn: "blocker" })
    );
    expect(await finalizeRun(meta.runId, d)).toContain("Verdict: PASS");
  });

  it("invalidates a cached complete result when effective review rules change", async () => {
    const d = gitRepo();
    const reportPath = join(d, "criteria.md");
    const meta = await createRun(
      {
        ...baseMeta(["a.ts"]),
        output: reportPath,
        criteriaIdentity: reviewCriteriaIdentity(d),
      },
      d
    );
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);
    expect(await finalizeRun(meta.runId, d)).toContain("✅ Run complete");

    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(join(d, "review", "rules", "new.md"), "# New rule\n");
    const stale = await finalizeRun(meta.runId, d);
    expect(stale).toContain("INCOMPLETE");
    expect(stale).toContain("effective review rules changed after planning");
    expect(stale).not.toContain("✅ Run complete");
  });

  it("invalidates a cached complete files-only run when its source changes", async () => {
    const d = gitRepo();
    const plan = await planReview({ files: ["a.ts"] }, d);
    const runId = /Run created: (\S+)/.exec(plan)![1];
    await writeFileReview(runId, result("a.ts", { findings: [] }), "# clean", d);
    expect(await finalizeRun(runId, d)).toContain("✅ Run complete");

    writeFileSync(join(d, "a.ts"), "changed after review\n");
    const stale = await finalizeRun(runId, d);
    expect(stale).toContain("INCOMPLETE");
    expect(stale).toContain("review source files changed after planning");
    expect(stale).not.toContain("✅ Run complete");
  });
});
