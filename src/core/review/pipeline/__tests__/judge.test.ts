/**
 * Judge-gate tests: context assembly, verdict recording (threshold-derived),
 * the bounded rework loop, feedback injection into re-review sessions, and
 * the plan/finalize integration.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeContext, judgeFeedbackFor, loadJudgment, readRunJudgments, submitJudge } from "../judge";
import { DEFAULT_JUDGE_THRESHOLD, MAX_INVALID_JUDGE_SUBMISSIONS, MAX_JUDGE_ROUNDS, type FileJudgment, type JudgeAttempt, type JudgeSubmitPayload } from "../judge-store";
import { JUDGE_CONTEXT_MAX_CHARS, JUDGE_CRITERIA } from "../judge-prompt";
import { planReview, finalizeRun } from "../run";
import { createRun, loadRun, readFileReviewResult, reviewSlug, runDir, writeFileReview, type FileReviewResult, type RunMeta } from "../run-store";
import { startReview } from "../loop";
import { clearState, getState } from "../state";
import { REQUIRED_CATEGORIES } from "../../contract";

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

  it("injects the authoritative rules the reviewer was held to", async () => {
    // Without them the judge scores against general best practice and rejects
    // correct rule-based findings as style preferences, sinking every file
    // below the threshold no matter how many rework rounds run.
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ frameworkGuide: "fw.md" }));
    writeFileSync(join(d, "fw.md"), "- Field injection with @Autowired is REQUIRED here.\n");
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain("Field injection with @Autowired is REQUIRED here.");
    expect(out).toContain("REQUIRED to follow these");
    expect(out).toContain("not up for debate");
  });

  it("truncates oversized rules instead of failing the judge context", async () => {
    // Rules are advisory context: a review judged against partial rules still
    // beats one judged against none, so this must never become an overflow.
    const d = gitRepo();
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ frameworkGuide: "fw.md" }));
    writeFileSync(join(d, "fw.md"), "x".repeat(30_000));
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain("(rules truncated)");
    expect(out).toContain("Validity (40%)"); // still a real context, not an overflow notice
    expect(out.length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_CHARS);
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

  it("caps rework across rewritten review revisions and terminates judge-incomplete", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    for (let i = 1; i <= MAX_JUDGE_ROUNDS; i++) {
      const msg = await submitJudge(judgePayload(meta.runId, 10), d);
      expect(msg).toContain(`rework ${i}/${MAX_JUDGE_ROUNDS}`);
      await writeFileReview(meta.runId, reviewResult(), `# a revision ${i + 1}`, d);
    }
    const capped = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(capped).toContain("Judge INCOMPLETE");
    expect(capped).toContain("do NOT re-spawn");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(MAX_JUDGE_ROUNDS + 1);
    expect(loadJudgment(meta.runId, "a.ts", d).terminal?.status).toBe("judge-incomplete");
  });

  it("meta judgeRounds overrides the rework cap (1 = judge twice, re-review once)", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ judgeRounds: 1 }), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    // Judge call 1: below threshold → the single allowed rework.
    const first = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(first).toContain("rework 1/1");
    await writeFileReview(meta.runId, reviewResult(), "# a revision 2", d);

    // Judge call 2: still below threshold → terminal, no further re-review.
    const second = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(second).toContain("Judge INCOMPLETE");
    expect(loadJudgment(meta.runId, "a.ts", d).terminal?.status).toBe("judge-incomplete");
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("Judge INCOMPLETE");
  });

  it("HARD-enforces the cap: past it no context, verdict, or re-review is served", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    // burn the cap across real rewritten artifacts
    for (let i = 0; i <= MAX_JUDGE_ROUNDS; i++) {
      await submitJudge(judgePayload(meta.runId, 10), d);
      if (i < MAX_JUDGE_ROUNDS) {
        await writeFileReview(meta.runId, reviewResult(), `# a revision ${i + 2}`, d);
      }
    }

    // an orchestrator that lost the cap message and tries again is refused everywhere:
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("Judge INCOMPLETE");
    const refused = await submitJudge(judgePayload(meta.runId, 10), d);
    expect(refused).toContain("no new attempt was added");
    expect(refused).toContain("Judge INCOMPLETE");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(MAX_JUDGE_ROUNDS + 1); // unchanged
    const rejoin = await startReview({ runId: meta.runId, files: ["a.ts"] }, d, SESSION);
    expect(rejoin).toContain("terminal review artifact");
    expect(getState(SESSION)).toBeUndefined(); // no re-review session was seeded
  });

  it("requires exactly one judgment for every finding index, unordered", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const review = reviewResult();
    review.findings.push({
      category: "security",
      severity: "minor",
      file: "a.ts",
      line: 1,
      rule: "r2",
      message: "second issue",
    });
    await writeFileReview(meta.runId, review, "# a", d);

    for (const indices of [[0], [0, 0], [0, 2]]) {
      const findingJudgments = indices.map((index) => ({
        index,
        valid: true,
        evidenced: true,
        severityFit: true,
        actionable: true,
        note: "ok",
      }));
      const msg = await submitJudge(judgePayload(meta.runId, 100, { findingJudgments }), d);
      expect(msg).toContain("must contain every index");
      expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(0);
      // Keep each assertion below the malformed terminal bound.
      await writeFileReview(meta.runId, review, "# rewritten", d);
    }

    const ok = await submitJudge(
      judgePayload(meta.runId, 100, {
        findingJudgments: [
          { index: 1, valid: true, evidenced: true, severityFit: true, actionable: true, note: "b" },
          { index: 0, valid: true, evidenced: true, severityFit: true, actionable: true, note: "a" },
        ],
      }),
      d
    );
    expect(ok).toContain("Judge PASS");
  });

  it("allows an empty findingJudgments array only for a zero-finding review", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, { ...reviewResult(), findings: [] }, "# clean", d);
    expect(
      await submitJudge(judgePayload(meta.runId, 100, { findingJudgments: [] }), d)
    ).toContain("Judge PASS");
  });

  it("validates every index without truncating a review above sixty findings", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const review = reviewResult();
    review.findings = Array.from({ length: 61 }, (_, index) => ({
      category: "correctness" as const,
      severity: "minor" as const,
      file: "a.ts",
      line: 1,
      rule: `r${index}`,
      message: `issue ${index}`,
    }));
    await writeFileReview(meta.runId, review, "# many", d);
    const findingJudgments = review.findings.map((_, index) => ({
      index,
      valid: true,
      evidenced: true,
      severityFit: true,
      actionable: true,
      note: "ok",
    }));

    expect(
      await submitJudge(judgePayload(meta.runId, 100, { findingJudgments }), d)
    ).toContain("Judge PASS");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts[0].findingJudgments).toHaveLength(61);
  });

  it("rejects a PASS score that contradicts failed finding checks or coverage gaps", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ judgeThreshold: 50 }), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    const contradictory = judgePayload(meta.runId, 100, {
      findingJudgments: [
        {
          index: 0,
          valid: false,
          evidenced: false,
          severityFit: false,
          actionable: false,
          note: "not supported",
        },
      ],
      coverageGaps: ["entire error path"],
    });
    expect(await submitJudge(contradictory, d)).toContain("cannot pass");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(0);
  });

  it("rejects a below-threshold score without concrete rework feedback", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    const msg = await submitJudge(judgePayload(meta.runId, 10, { feedback: "   " }), d);
    expect(msg).toContain("requires concrete non-empty rework feedback");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(0);
  });

  it("is idempotent for an unchanged review revision, even when the payload changes", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    expect(await submitJudge(judgePayload(meta.runId, 10), d)).toContain("Judge REWORK");
    const duplicate = await submitJudge(judgePayload(meta.runId, 100), d);
    expect(duplicate).toContain("already recorded");
    expect(duplicate).toContain("Judge REWORK");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(1);

    await writeFileReview(meta.runId, reviewResult(), "# rewritten", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(2);
  });

  it("serializes concurrent submissions for the same review artifact", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    // The first call owns the artifact gate. All competing PASS submissions
    // must observe its persisted REWORK instead of racing the same empty file.
    const first = submitJudge(judgePayload(meta.runId, 10), d);
    const competing = Array.from({ length: 20 }, () =>
      submitJudge(judgePayload(meta.runId, 100), d)
    );
    const messages = await Promise.all([first, ...competing]);

    expect(messages.every((message) => message.includes("Judge REWORK"))).toBe(true);
    expect(messages.filter((message) => message.includes("already recorded"))).toHaveLength(20);
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    expect(judgment.attempts).toHaveLength(1);
    expect(judgment.attempts[0]?.verdict).toBe("rework");

    // The settled gate was released, so a rewritten artifact can be judged.
    await writeFileReview(meta.runId, reviewResult(), "# rewritten", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");
  });

  it("does not reuse a stale verdict when a corrupt artifact is rewritten at revision 1", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# first", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");

    writeFileSync(join(runDir(meta.runId, d), "reviews", `${reviewSlug("a.ts")}.json`), "{}");
    await writeFileReview(meta.runId, { ...reviewResult(), findings: [] }, "# rewritten", d);
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("judge round 2");
    expect(await finalizeRun(meta.runId, d)).toContain("unjudged review");
  });

  it("advances revision past judgment history after an identical corrupt artifact rewrite", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    const review = reviewResult();
    await writeFileReview(meta.runId, review, "# first", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");

    writeFileSync(join(runDir(meta.runId, d), "reviews", `${reviewSlug("a.ts")}.json`), "{}");
    await writeFileReview(meta.runId, review, "# identical rewrite", d);
    expect(readFileReviewResult(meta.runId, "a.ts", d)?.revision).toBe(2);
    expect(judgeContext(meta.runId, "a.ts", d)).toContain("judge round 2");
    expect(await finalizeRun(meta.runId, d)).toContain("unjudged review");
  });

  it("bounds malformed submissions and terminates fail-closed without recording PASS", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    const malformed = judgePayload(meta.runId, 100, { findingJudgments: [] });
    for (let i = 1; i < MAX_INVALID_JUDGE_SUBMISSIONS; i++) {
      const msg = await submitJudge(malformed, d);
      expect(msg).toContain(`Retry ${i}/${MAX_INVALID_JUDGE_SUBMISSIONS}`);
    }
    const terminal = await submitJudge(malformed, d);
    expect(terminal).toContain("Judge INCOMPLETE");
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    expect(judgment.attempts).toHaveLength(0);
    expect(judgment.terminal?.status).toBe("judge-incomplete");
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge INCOMPLETE");
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

  it("terminalizes a truncated zero-finding review instead of allowing a prefix-only PASS", async () => {
    const d = gitRepo();
    const big = Array.from({ length: 2400 }, (_, index) => `clean-line-${index + 1}`).join("\n");
    writeFileSync(join(d, "clean-big.ts"), `${big}\n`);
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "large clean file"], { cwd: d });

    const meta = await createRun(
      baseMeta({ targets: ["clean-big.ts"], whole: true, range: null }),
      d
    );
    await writeFileReview(
      meta.runId,
      { ...reviewResult("clean-big.ts"), findings: [] },
      "# clean-big",
      d
    );

    const out = judgeContext(meta.runId, "clean-big.ts", d);
    expect(out.length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_CHARS);
    expect(out).toContain("terminal Judge INCOMPLETE");
    expect(out).toContain("zero-finding review has no anchors");
    expect(out).not.toContain("Judge every finding by its index");

    const judgment = loadJudgment(meta.runId, "clean-big.ts", d);
    expect(judgment.attempts).toHaveLength(0);
    expect(judgment.terminal?.status).toBe("judge-incomplete");
    expect(judgment.terminal?.reviewArtifactHash).toBeDefined();
    expect(judgeContext(meta.runId, "clean-big.ts", d)).toContain("This revision is terminal");

    const direct = await submitJudge(
      judgePayload(meta.runId, 100, { file: "clean-big.ts", findingJudgments: [] }),
      d
    );
    expect(direct).toContain("Judge INCOMPLETE");
    expect(loadJudgment(meta.runId, "clean-big.ts", d).attempts).toHaveLength(0);
  });

  it("terminalizes a truncated review when any finding lacks a line anchor", async () => {
    const d = gitRepo();
    const big = Array.from({ length: 2400 }, (_, index) => `line-${index + 1}`).join("\n");
    writeFileSync(join(d, "unanchored-big.ts"), `${big}\n`);
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "large unanchored file"], { cwd: d });

    const meta = await createRun(
      baseMeta({ targets: ["unanchored-big.ts"], whole: true, range: null }),
      d
    );
    const result = reviewResult("unanchored-big.ts");
    delete result.findings[0].line;
    await writeFileReview(meta.runId, result, "# unanchored-big", d);

    const out = judgeContext(meta.runId, "unanchored-big.ts", d);
    expect(out.length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_CHARS);
    expect(out).toContain("terminal Judge INCOMPLETE");
    expect(out).toContain("1 finding(s) have no line anchor");
    expect(out).not.toContain("Judge every finding by its index");

    const judgment = loadJudgment(meta.runId, "unanchored-big.ts", d);
    expect(judgment.attempts).toHaveLength(0);
    expect(judgment.terminal?.status).toBe("judge-incomplete");
  });

  it("fails closed when serialized findings cannot fit the total context budget", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ whole: true, range: null }), d);
    const result = reviewResult();
    result.findings = Array.from({ length: 8 }, (_, index) => ({
      category: "correctness" as const,
      severity: "major" as const,
      file: "a.ts",
      line: 1,
      rule: `rule-${index}`,
      message: `failure-${index} ${"m".repeat(2000)}`,
      suggestion: `fix-${index} ${"s".repeat(4000)}`,
    }));
    await writeFileReview(meta.runId, result, "# oversized findings", d);

    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out.length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_CHARS);
    expect(out).toContain("Judge context INCOMPLETE");
    expect(out).toContain("serialized finding(s)");
    expect(out).toContain("Do NOT call f_review_judge");
    expect(out).not.toContain("Judge every finding by its index");

    // Directly bypassing judgeContext must still never manufacture a PASS.
    const terminal = await submitJudge(judgePayload(meta.runId, 100), d);
    expect(terminal).toContain("Judge INCOMPLETE");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(0);
    expect(loadJudgment(meta.runId, "a.ts", d).terminal?.reason).toContain(
      "bounded judge context unavailable"
    );
  });

  it("bounds very wide source lines and refuses to omit an anchored evidence window", async () => {
    const d = gitRepo();
    const wide = Array.from(
      { length: 2200 },
      (_, index) => `line${index + 1}-${"x".repeat(1000)}`
    ).join("\n");
    writeFileSync(join(d, "wide.ts"), `${wide}\n`);
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "wide"], { cwd: d });

    const meta = await createRun(
      baseMeta({ targets: ["wide.ts"], whole: true, range: null }),
      d
    );
    const result = reviewResult("wide.ts");
    result.findings[0].line = 2100;
    await writeFileReview(meta.runId, result, "# wide", d);

    const out = judgeContext(meta.runId, "wide.ts", d);
    expect(out.length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_CHARS);
    expect(out).toContain("Judge context INCOMPLETE");
    expect(out).toContain("merged finding window(s)");
    expect(out).toContain("Do NOT call f_review_judge");
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

  it("planReview picks up judge/judgeThreshold/judgeRounds from .f-review.json", async () => {
    const d = gitRepo();
    writeFileSync(
      join(d, ".f-review.json"),
      '{"judge": true, "judgeThreshold": 85, "judgeRounds": 1}'
    );
    const msg = await planReview({}, d);
    const runId = /Run created: (\S+) /.exec(msg)![1];
    const meta = loadRun(runId, d)!;
    expect(meta.judge).toBe(true);
    expect(meta.judgeThreshold).toBe(85);
    expect(meta.judgeRounds).toBe(1);
  });

  it("finalizeRun folds judge outcomes into the response, keeping the report findings-only", async () => {
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
    expect(msg).toContain("Run terminated — INCOMPLETE");
    expect(msg).toContain("below judge threshold");
    expect(msg).toContain("unjudged review(s)");
    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md).not.toContain("## Run Summary"); // judge detail stays out of the report
  });

  it("invalidates a cached PASS when its persisted judgment becomes semantically invalid", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");
    expect(await finalizeRun(meta.runId, d)).toContain("✅ Run complete");

    const judgmentPath = join(
      runDir(meta.runId, d),
      "judgments",
      `${reviewSlug("a.ts")}.json`
    );
    const judgment = JSON.parse(readFileSync(judgmentPath, "utf8")) as FileJudgment;
    // Shape remains valid, but the current review's only finding is no longer
    // judged. Semantic load validation must drop this attempt and invalidate
    // the finalize cache instead of replaying its earlier PASS response.
    judgment.attempts[0]!.findingJudgments = [];
    writeFileSync(judgmentPath, JSON.stringify(judgment, null, 2));

    const stale = await finalizeRun(meta.runId, d);
    expect(stale).toContain("Run terminated — INCOMPLETE");
    expect(stale).toContain("unjudged review");
    expect(stale).not.toContain("✅ Run complete");
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

  it("fails closed for shape-valid attempts that violate current review semantics", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge PASS");

    const path = join(
      runDir(meta.runId, d),
      "judgments",
      `${reviewSlug("a.ts")}.json`
    );
    const valid = JSON.parse(readFileSync(path, "utf8")) as FileJudgment;
    const corruptions: Array<[string, (attempt: JudgeAttempt) => void]> = [
      ["missing finding indices", (attempt) => { attempt.findingJudgments = []; }],
      ["out-of-range score", (attempt) => { attempt.score = 101; }],
      ["verdict/threshold mismatch", (attempt) => {
        attempt.score = 10;
        attempt.verdict = "pass";
      }],
      ["contradictory PASS finding", (attempt) => {
        attempt.findingJudgments[0]!.valid = false;
      }],
      ["PASS with a coverage gap", (attempt) => {
        attempt.coverageGaps = ["unexamined branch"];
      }],
    ];

    for (const [label, corrupt] of corruptions) {
      const persisted = structuredClone(valid);
      corrupt(persisted.attempts[0]!);
      writeFileSync(path, JSON.stringify(persisted, null, 2));

      expect(loadJudgment(meta.runId, "a.ts", d).attempts, label).toHaveLength(0);
      const runJudgment = readRunJudgments(meta.runId, d).find((entry) => entry.file === "a.ts");
      expect(runJudgment?.attempts, label).toHaveLength(0);
      expect(judgeContext(meta.runId, "a.ts", d), label).toContain("judge round 1");
    }

    expect(await finalizeRun(meta.runId, d)).toContain("unjudged review");
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
