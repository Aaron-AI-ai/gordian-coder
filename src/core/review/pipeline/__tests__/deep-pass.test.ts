import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DEEP_PASSES, resolveDeepPasses } from "../../config";
import { startReview, submitReview, guardExploration } from "../loop";
import { MAX_ITER } from "../../tools/read";
import { getState, clearState } from "../state";
import { REQUIRED_CATEGORIES } from "../../contract";
import { planReview, finalizeRun } from "../run";
import { createRun, loadRun, readRunResults } from "../run-store";

const tmps: string[] = [];
afterEach(() => {
  clearState("dp");
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "f-deep-"));
  tmps.push(d);
  const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
  sh(["git", "init", "-q"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  writeFileSync(join(d, "a.ts"), "a1\n");
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "init"]);
  writeFileSync(join(d, "a.ts"), "a2\n");
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "change"]);
  return d;
}

const submitOf = (rule: string) => ({
  assessed: [...REQUIRED_CATEGORIES],
  findings: [
    {
      category: "correctness",
      severity: "major",
      file: "a.ts",
      line: 1,
      rule,
      message: "m",
      suggestion: "s",
    },
  ],
});

describe("resolveDeepPasses", () => {
  it("defaults to 1 and clamps to [1, MAX_DEEP_PASSES]", () => {
    const d = mkdtempSync(join(tmpdir(), "f-deep-cfg-"));
    tmps.push(d);
    expect(resolveDeepPasses(undefined, d)).toBe(1);
    expect(resolveDeepPasses(3, d)).toBe(3);
    expect(resolveDeepPasses(0, d)).toBe(1);
    expect(resolveDeepPasses(-2, d)).toBe(1);
    expect(resolveDeepPasses(99, d)).toBe(MAX_DEEP_PASSES);
    expect(resolveDeepPasses(2.9, d)).toBe(2);
    expect(resolveDeepPasses(NaN, d)).toBe(1);
  });

  it("reads the config file; an explicit arg wins over it", () => {
    const d = mkdtempSync(join(tmpdir(), "f-deep-cfg-"));
    tmps.push(d);
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ deepPasses: 4 }));
    expect(resolveDeepPasses(undefined, d)).toBe(4);
    expect(resolveDeepPasses(2, d)).toBe(2); // arg wins
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ deepPasses: "lots" }));
    expect(resolveDeepPasses(undefined, d)).toBe(1); // non-numeric config → default
  });
});

describe("sequential deep-pass rounds", () => {
  it("bounces clean submissions back for N-1 rounds, then accepts the LAST set", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 3 }, d, "dp");
    const st = getState("dp")!;
    expect(st.deepPasses).toBe(3);
    guardExploration(st, "file_read", ""); // keep the final check clean

    const r2 = await submitReview(submitOf("round1-rule"), "dp");
    expect(r2).toContain("Deep review round 2/3");
    expect(r2).toContain("REFUTE"); // round 2 = adversarial pass
    expect(r2).toContain("round1-rule"); // echoes previous findings
    expect(getState("dp")!.currentIndex).toBe(0); // cursor did not advance

    const r3 = await submitReview(submitOf("round2-rule"), "dp");
    expect(r3).toContain("Deep review round 3/3");
    expect(r3).toContain("Calibrate"); // final round = calibrate & polish
    expect(getState("dp")!.currentIndex).toBe(0);

    const done = await submitReview(submitOf("final-rule"), "dp");
    expect(done).toContain("✅ Review complete");
    const report = readFileSync(join(d, /Report: (.+)$/.exec(done)![1]), "utf8");
    expect(report).toContain("final-rule"); // last submission wins…
    expect(report).not.toContain("round1-rule"); // …and replaces earlier rounds
  });

  it("gives each round a fresh exploration budget so the round instruction is followable", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 3 }, d, "dp");
    const st = getState("dp")!;

    // The duplicate-call ledger fills up in round 1 …
    guardExploration(st, "file_read", "o", { file_path: "a.ts" });
    guardExploration(st, "file_read", "o", { file_path: "a.ts" });
    expect(guardExploration(st, "file_read", "o", { file_path: "a.ts" })).toContain(
      "Duplicate call"
    );

    // Round 1 burns the whole budget.
    for (let i = 0; i <= MAX_ITER; i++) guardExploration(st, "file_read", "");
    expect(guardExploration(st, "file_read", "out")).toContain("Exploration limit reached");

    // Round 2 orders a re-read ("REFUTE … re-read the code"), so it must not
    // open with the limit warning that tells the model to submit instead.
    const r2 = await submitReview(submitOf("r1"), "dp");
    expect(r2).toContain("Deep review round 2/3");
    expect(st.iterations).toBe(0);
    expect(guardExploration(st, "file_read", "out")).not.toContain("Exploration limit reached");
    // … and is cleared per round, so the ordered re-read is answered normally.
    expect(guardExploration(st, "file_read", "o", { file_path: "a.ts" })).toBe("o");

    // Per-file call log stays cumulative — it audits the file, not the round.
    expect(st.callLog["a.ts"].file_read).toBeGreaterThan(MAX_ITER);
  });

  it("reads deepPasses from .f-review.json when no arg is given", async () => {
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ deepPasses: 2 }));
    await startReview({ files: ["a.ts"] }, d, "dp");
    expect(getState("dp")!.deepPasses).toBe(2);

    const st = getState("dp")!;
    guardExploration(st, "file_read", "");
    const r2 = await submitReview(submitOf("r1"), "dp");
    expect(r2).toContain("Deep review round 2/2");
    expect(r2).toContain("Calibrate"); // with 2 total, round 2 is already the last
    const done = await submitReview(submitOf("r2"), "dp");
    expect(done).toContain("✅ Review complete");
  });

  it("a coverage-failing submission does NOT consume a round", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 2 }, d, "dp");
    const st = getState("dp")!;
    guardExploration(st, "file_read", "");
    const gated = await submitReview({ assessed: ["security"], findings: [] }, "dp");
    expect(gated).toContain("Incomplete");
    expect(st.deepPassDone["a.ts"] ?? 0).toBe(0); // round counter untouched

    const r2 = await submitReview(submitOf("r1"), "dp");
    expect(r2).toContain("round 2/2");
  });

  it("an identical resubmission still consumes rounds and gets one final check", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"], deepPasses: 3 }, d, "dp");
    // no exploration + major w/o suggestion → the final check has notes
    const same = {
      assessed: [...REQUIRED_CATEGORIES],
      findings: [
        { category: "correctness", severity: "major", file: "a.ts", line: 1, rule: "r", message: "m" },
      ],
    };
    expect(await submitReview(same, "dp")).toContain("Deep review round 2/3");
    // honest convergence: nothing to change → round 3 still runs (--deep=3 means 3)
    expect(await submitReview(same, "dp")).toContain("Deep review round 3/3");
    // after the last round the final check still gets its bounce …
    expect(await submitReview(same, "dp")).toContain("Final check");
    // … and only repeating the payload the final check bounced is accepted
    expect(await submitReview(same, "dp")).toContain("✅ Review complete");
  });

  it("deepPasses=1 (default) keeps the single-pass behavior", async () => {
    const d = gitRepo();
    await startReview({ files: ["a.ts"] }, d, "dp");
    const st = getState("dp")!;
    guardExploration(st, "file_read", "");
    const done = await submitReview(submitOf("only"), "dp");
    expect(done).toContain("✅ Review complete"); // no bounce
  });
});

describe("run-mode deep passes", () => {
  it("planReview stores the rounds in run.json and announces them", async () => {
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ deepPasses: 2 }));
    const msg = await planReview({}, d);
    expect(msg).toContain("2 review rounds/target");
    const runId = /Run created: (\S+)/.exec(msg)![1];
    expect(loadRun(runId, d)!.deepPasses).toBe(2);
  });

  it("subagents inherit the run's rounds and iterate before saving the review", async () => {
    const d = gitRepo();
    const meta = await createRun(
      {
        targets: ["a.ts"],
        range: "HEAD~1..HEAD",
        whole: false,
        label: "L",
        language: "ko",
        deepPasses: 2,
      },
      d
    );
    const msg = await startReview({ runId: meta.runId, files: ["a.ts"] }, d, "dp");
    expect(msg).toContain("2 review rounds");
    const st = getState("dp")!;
    expect(st.deepPasses).toBe(2);
    guardExploration(st, "file_read", "");

    const r2 = await submitReview(submitOf("draft"), "dp");
    expect(r2).toContain("Deep review round 2/2");
    expect(readRunResults(meta.runId, d)).toHaveLength(0); // nothing saved mid-rounds

    const done = await submitReview(submitOf("polished"), "dp");
    expect(done).toContain("task is COMPLETE");
    const results = readRunResults(meta.runId, d);
    expect(results).toHaveLength(1);
    expect(results[0].findings[0].rule).toBe("polished"); // final round's set persisted
  });

  it("persists a force-advance marker instead of a clean run result", async () => {
    const d = gitRepo();
    const meta = await createRun(
      { targets: ["a.ts"], range: "HEAD~1..HEAD", whole: false, label: "L", language: "ko" },
      d
    );
    await startReview({ runId: meta.runId, files: ["a.ts"] }, d, "dp");
    for (let i = 1; i <= 5; i++) await submitReview({ garbage: true }, "dp");
    const done = await submitReview({ garbage: true }, "dp");
    expect(done).toContain("force-advanced");
    expect(done).toContain("incomplete review saved");
    const [result] = readRunResults(meta.runId, d);
    expect(result.forced).toContain("forced after repeated invalid submissions");
    expect(result.findings).toEqual([]);
    // finalize surfaces the forced file instead of announcing a clean run
    const fin = await finalizeRun(meta.runId, d);
    expect(fin).toContain("Run terminated — INCOMPLETE");
    expect(fin).toContain("force-advanced");
    expect(fin).toContain("a.ts");
  });
});
