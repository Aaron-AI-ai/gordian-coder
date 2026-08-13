/**
 * Judge-gate tests: context assembly, verdict recording (threshold-derived),
 * the bounded rework loop, feedback injection into re-review sessions, and
 * the plan/finalize integration.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_JUDGE_THRESHOLD,
  MAX_JUDGE_ROUNDS,
  JUDGE_CRITERIA,
  judgeContext,
  judgeFeedbackFor,
  loadJudgment,
  readRunJudgments,
  submitJudge,
  type JudgeSubmitPayload,
} from "../judge";
import { createRun, loadRun, planReview, finalizeRun, writeFileReview, type FileReviewResult, type RunMeta } from "../run";
import { startReview } from "../loop";
import { clearState, getState } from "../state";
import { REQUIRED_CATEGORIES } from "../contract";

const SESSION = "js";
const tmps: string[] = [];
afterEach(() => {
  clearState(SESSION);
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "f-judge-"));
  tmps.push(d);
  return d;
}

/** Two-commit git repo with a.ts changed in HEAD. */
function gitRepo(): string {
  const d = dir();
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

const baseMeta = (over: Partial<RunMeta> = {}): Omit<RunMeta, "runId" | "createdAt"> => ({
  targets: ["a.ts"],
  range: "HEAD~1..HEAD",
  whole: false,
  label: "L",
  language: "ko",
  judge: true,
  ...over,
});

const reviewResult = (file = "a.ts"): FileReviewResult => ({
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
});

const judgePayload = (
  runId: string,
  score: number,
  over: Partial<JudgeSubmitPayload> = {}
): JudgeSubmitPayload => ({
  runId,
  file: "a.ts",
  findingJudgments: [
    { index: 0, valid: true, evidenced: true, severityFit: true, actionable: true, note: "ok" },
  ],
  coverageGaps: [],
  score,
  feedback: "1. re-check line anchors",
  ...over,
});

describe("judgeContext", () => {
  it("rejects an unknown run", () => {
    expect(judgeContext("ghost", "a.ts", dir())).toContain("Unknown run");
  });

  it("rejects a file outside the run's targets", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    expect(judgeContext(meta.runId, "zz.ts", d)).toContain("not a target");
  });

  it("refuses to judge before the review is submitted", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("No submitted review");
  });

  it("returns criteria, the change, the findings, and the threshold", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain("judge round 1");
    expect(out).toContain(`Score threshold: ${DEFAULT_JUDGE_THRESHOLD}`);
    expect(out).toContain("Validity (40%)"); // criteria injected
    expect(out).toContain("-a1"); // diff hunk of the change
    expect(out).toContain('"rule": "r1"'); // submitted findings embedded
    expect(out).toContain("call f_review_judge");
  });

  it("shows file content instead of a diff for whole-file runs", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ whole: true }), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("a2");
  });
});

describe("submitJudge", () => {
  it("rejects an invalid payload", async () => {
    expect(await submitJudge({ nope: true }, dir())).toContain("Invalid judge submission");
  });

  it("rejects an unknown run and a non-target file", async () => {
    const d = gitRepo();
    expect(await submitJudge(judgePayload("ghost", 90), d)).toContain("Unknown run");
    const meta = await createRun(baseMeta(), d);
    expect(await submitJudge(judgePayload(meta.runId, 90, { file: "zz.ts" }), d)).toContain(
      "not a target"
    );
  });

  it("rejects judging a file with no submitted review", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    expect(await submitJudge(judgePayload(meta.runId, 90), d)).toContain("nothing to judge");
  });

  it("passes at/above the threshold and persists the attempt", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const msg = await submitJudge(judgePayload(meta.runId, DEFAULT_JUDGE_THRESHOLD), d);
    expect(msg).toContain("✅ Judge PASS");

    const j = loadJudgment(meta.runId, "a.ts", d);
    expect(j.attempts).toHaveLength(1);
    expect(j.attempts[0].verdict).toBe("pass");
    expect(j.attempts[0].score).toBe(DEFAULT_JUDGE_THRESHOLD);
  });

  it("derives the verdict from the threshold — never from the model", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ judgeThreshold: 90 }), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    // 80 would pass the default threshold, but the run demands 90.
    const msg = await submitJudge(judgePayload(meta.runId, 80), d);
    expect(msg).toContain("🔁 Judge REWORK");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts[0].verdict).toBe("rework");
  });

  it("rework message carries the exact re-spawn instruction", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const msg = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(msg).toContain(`runId=\"${meta.runId}\"`);
    expect(msg).toContain('files=["a.ts"]');
    expect(msg).toContain(`rework 1/${MAX_JUDGE_ROUNDS}`);
    expect(msg).toContain("f-judge subagent");
  });

  it("caps rework: after MAX_JUDGE_ROUNDS the review is accepted as-is", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    for (let i = 1; i <= MAX_JUDGE_ROUNDS; i++) {
      const msg = await submitJudge(judgePayload(meta.runId, 10), d);
      expect(msg).toContain(`rework ${i}/${MAX_JUDGE_ROUNDS}`);
    }
    const capped = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(capped).toContain("Accept the latest review as-is");
    expect(capped).toContain("do NOT re-spawn");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(MAX_JUDGE_ROUNDS + 1);
  });

  it("HARD-enforces the cap: past it no context, verdict, or re-review is served", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    // burn the cap: MAX_JUDGE_ROUNDS rework instructions + the cap message
    for (let i = 0; i <= MAX_JUDGE_ROUNDS; i++) await submitJudge(judgePayload(meta.runId, 10), d);

    // an orchestrator that lost the cap message and tries again is refused everywhere:
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("rework cap");
    const refused = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(refused).toContain("verdict NOT recorded");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(MAX_JUDGE_ROUNDS + 1); // unchanged
    const rejoin = await startReview({ runId: meta.runId, files: ["a.ts"] }, d, SESSION);
    expect(rejoin).toContain("rework cap");
    expect(getState(SESSION)).toBeUndefined(); // no re-review session was seeded
  });

  it("truncates runaway judge feedback instead of persisting a blob", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    await submitJudge(judgePayload(meta.runId, 10, { feedback: "loop ".repeat(10_000) }), d);
    expect(loadJudgment(meta.runId, "a.ts", d).attempts[0].feedback.length).toBe(4000);
  });
});

describe("judge excerpt covers finding lines past the cap", () => {
  it("appends per-finding windows for a whole-file run larger than the excerpt cap", async () => {
    const d = gitRepo();
    // 2400-line file: the base excerpt stops at 2000 lines
    const big = Array.from({ length: 2400 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(d, "big.ts"), `${big}\n`);
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "big"], { cwd: d });

    const meta = await createRun(baseMeta({ targets: ["big.ts"], whole: true, range: null }), d);
    const result = reviewResult("big.ts");
    result.findings[0].line = 2100; // past the 2000-line excerpt cap
    await writeFileReview(meta.runId, result, "# big", d);

    const out = judgeContext(meta.runId, "big.ts", d);
    expect(out).toContain("truncated at 2000 lines");
    expect(out).toContain("finding lines the capped excerpt above does not show");
    expect(out).toContain("line2100"); // the finding's anchor is visible to the judge
  });
});

describe("judge feedback injection", () => {
  it("is empty without a judgment or after a pass", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    expect(judgeFeedbackFor(meta.runId, "a.ts", d)).toBe("");
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    await submitJudge(judgePayload(meta.runId, 100), d);
    expect(judgeFeedbackFor(meta.runId, "a.ts", d)).toBe("");
  });

  it("renders the latest rework feedback with coverage gaps", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    await submitJudge(judgePayload(meta.runId, 10, { coverageGaps: ["error path L10-20"] }), d);

    const fb = judgeFeedbackFor(meta.runId, "a.ts", d);
    expect(fb).toContain("scored 10");
    expect(fb).toContain("1. re-check line anchors");
    expect(fb).toContain("error path L10-20");
  });

  it("reaches a re-spawned reviewer session via requirementBackground", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    await submitJudge(judgePayload(meta.runId, 10), d);

    await startReview({ runId: meta.runId, files: ["a.ts"] }, d, SESSION);
    expect(getState(SESSION)!.requirementBackground).toContain("Judge feedback");
    expect(getState(SESSION)!.requirementBackground).toContain("1. re-check line anchors");
  });

  it("does not leak feedback into a fresh (non-rework) run session", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await startReview({ runId: meta.runId, files: ["a.ts"] }, d, SESSION);
    expect(getState(SESSION)!.requirementBackground).toBe("");
  });
});

describe("plan/finalize integration", () => {
  it("planReview omits judge steps by default", async () => {
    const msg = await planReview({}, gitRepo());
    expect(msg).not.toContain("JUDGE GATE");
  });

  it("planReview arg judge:true adds the judge gate and records it in the meta", async () => {
    const d = gitRepo();
    const msg = await planReview({ judge: true }, d);
    expect(msg).toContain("judge gate on");
    expect(msg).toContain("JUDGE GATE");
    expect(msg).toContain("f_review_judge_context");
    const runId = /Run created: (\S+) /.exec(msg)![1];
    expect(loadRun(runId, d)!.judge).toBe(true);
  });

  it("planReview picks up judge/judgeThreshold from .f-review.json", async () => {
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), '{"judge": true, "judgeThreshold": 85}');
    const msg = await planReview({}, d);
    const runId = /Run created: (\S+) /.exec(msg)![1];
    const meta = loadRun(runId, d)!;
    expect(meta.judge).toBe(true);
    expect(meta.judgeThreshold).toBe(85);
  });

  it("finalizeRun reports judge outcomes: passed, capped-below-threshold, unjudged", async () => {
    const d = gitRepo();
    writeFileSync(join(d, "b.ts"), "b\n");
    writeFileSync(join(d, "c.ts"), "c\n");
    const meta = await createRun(baseMeta({ targets: ["a.ts", "b.ts", "c.ts"] }), d);
    await writeFileReview(meta.runId, reviewResult("a.ts"), "# a", d);
    await writeFileReview(meta.runId, reviewResult("b.ts"), "# b", d);
    await writeFileReview(meta.runId, reviewResult("c.ts"), "# c", d);
    await submitJudge(judgePayload(meta.runId, 95), d); // a.ts pass
    await submitJudge(judgePayload(meta.runId, 10, { file: "b.ts" }), d); // b.ts rework (never fixed)
    // c.ts reviewed but never judged

    const msg = await finalizeRun(meta.runId, d);
    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md).toContain(`Judge: 1/3 file(s) passed (threshold ${DEFAULT_JUDGE_THRESHOLD})`);
    expect(md).toContain("Below judge threshold (accepted as-is): b.ts (score 10)");
    expect(md).toContain("Reviewed but never judged: c.ts");
  });

  it("readRunJudgments returns every file's judgment", async () => {
    const d = gitRepo();
    writeFileSync(join(d, "b.ts"), "b\n");
    const meta = await createRun(baseMeta({ targets: ["a.ts", "b.ts"] }), d);
    await writeFileReview(meta.runId, reviewResult("a.ts"), "# a", d);
    await writeFileReview(meta.runId, reviewResult("b.ts"), "# b", d);
    await submitJudge(judgePayload(meta.runId, 95), d);
    await submitJudge(judgePayload(meta.runId, 20, { file: "b.ts" }), d);
    expect(readRunJudgments(meta.runId, d).map((j) => j.file).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("corrupt on-disk state", () => {
  it("treats an unreadable judgment file as never-judged", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const jdir = join(d, "fcq/f-review/runs", meta.runId, "judgments");
    mkdirSync(jdir, { recursive: true });
    writeFileSync(join(jdir, "a.ts.json"), "{not json");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toEqual([]);
  });

  it("treats a shape-corrupt judgment (valid JSON, wrong fields) as never-judged", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const jdir = join(d, "fcq/f-review/runs", meta.runId, "judgments");
    mkdirSync(jdir, { recursive: true });
    // an attempt missing coverageGaps/feedback would crash judgeFeedbackFor at .at(-1)
    writeFileSync(
      join(jdir, "a.ts.json"),
      JSON.stringify({ file: "a.ts", attempts: [{ score: 10, verdict: "rework" }] })
    );
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toEqual([]);
    expect(judgeFeedbackFor(meta.runId, "a.ts", d)).toBe(""); // no crash, no feedback
    expect(readRunJudgments(meta.runId, d)).toEqual([]); // finalize input also clean
  });

  it("treats an unreadable review json as not-yet-submitted", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const rdir = join(d, "fcq/f-review/runs", meta.runId, "reviews");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "a.ts.json"), "{not json");
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("No submitted review");
  });
});

describe("criteria constant", () => {
  it("keeps the offline-reusable rubric aligned with the scoring axes", () => {
    for (const axis of ["Validity", "Evidence", "Severity calibration", "Actionability", "Coverage"]) {
      expect(JUDGE_CRITERIA).toContain(axis);
    }
  });
});
