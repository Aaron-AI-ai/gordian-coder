import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DEEP_PASSES, resolveDeepPasses } from "../context";
import { startReview, submitReview, guardExploration } from "../loop";
import { getState, clearState } from "../state";
import { REQUIRED_CATEGORIES } from "../contract";
import { createRun, planReview, loadRun, readRunResults } from "../run";

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
});
