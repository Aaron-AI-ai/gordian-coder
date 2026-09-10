/**
 * Judge-gate tests: context assembly, verdict recording (threshold-derived),
 * the bounded rework loop, feedback injection into re-review sessions, and
 * the plan/finalize integration.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeContext, judgeFeedbackFor, submitJudge } from "../judge";
import { artifactIdentity, currentPendingParts, loadJudgment, persistJudgmentSync, readRunJudgments } from "../judge-store";
import { DEFAULT_JUDGE_THRESHOLD, MAX_INVALID_JUDGE_SUBMISSIONS, MAX_JUDGE_ROUNDS, type FileJudgment, type JudgeAttempt, type JudgeSubmitPayload } from "../judge-store";
import { JUDGE_CONTEXT_MAX_BYTES, JUDGE_CRITERIA, buildJudgePrompt, buildPartPrompt, isContextOverflow, judgePartPlanFor } from "../judge-prompt";
import { describeTruncation } from "../judge-store";
import { planReview, finalizeRun } from "../run";
import { createRun, writeFileReview } from "../run-store";
import { loadRun, type RunMeta } from "../artifact";
import { readFileReviewResult, reviewSlug, runDir, type FileReviewResult } from "../artifact";
import { startReview } from "../start";
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

/** n건의 지적을 서로 멀리 떨어뜨려 윈도우 병합을 막는다. */
const manyFindings = (n: number): FileReviewResult => ({
  file: "big.ts",
  assessed: [...REQUIRED_CATEGORIES],
  findings: Array.from({ length: n }, (_, i) => ({
    category: "correctness" as const,
    severity: "major" as const,
    file: "big.ts",
    line: 1 + i * 120,
    rule: `r${i}`,
    message: "이슈 ".repeat(200),
    asIs: "코드 ".repeat(300),
    toBe: "고친 코드 ".repeat(300),
  })),
  explorationCalls: 2,
  partial: false,
});

/** 선언이 파일 전체에 흩어진 대형 whole-file 런. 앞부분만 보여주면 뒤쪽
 * 선언은 심사관 눈에 아예 없다. */
async function structuredRun() {
  const d = gitRepo();
  const body = (i: number) =>
    [
      `export function handler${i}(input: string): string {`,
      ...Array.from({ length: 28 }, (_, j) => `  // ${i}-${j} 아주 긴 설명 주석을 여러 번 반복한다 반복한다 반복한다`),
      `}`,
    ].join("\n");
  writeFileSync(
    join(d, "big.ts"),
    Array.from({ length: 50 }, (_, i) => body(i)).join("\n") + "\n"
  );
  const meta = await createRun(baseMeta({ targets: ["big.ts"], whole: true, range: null }), d);
  return { d, meta };
}

/** 3000줄짜리 파일 중 몇 줄만 바꾼 diff 모드 런. */
async function bigDiffRun() {
  const d = dir();
  const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
  sh(["git", "init", "-q"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  const lines = (mark: string) =>
    Array.from({ length: 3000 }, (_, i) =>
      i === 1500 ? `const v${i} = ${mark}; // 설명 주석` : `const v${i} = ${i}; // 설명 주석`
    ).join("\n") + "\n";
  writeFileSync(join(d, "big.ts"), lines("0"));
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "init"]);
  writeFileSync(join(d, "big.ts"), lines("999"));
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "change"]);
  const meta = await createRun(
    baseMeta({ targets: ["big.ts"], whole: false, range: "HEAD~1..HEAD" }),
    d
  );
  return { d, meta };
}

/** 3000줄짜리 파일을 가진 whole-file 런. */
async function bigRun() {
  const d = gitRepo();
  writeFileSync(
    join(d, "big.ts"),
    Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // 설명 주석`).join("\n") + "\n"
  );
  const meta = await createRun(baseMeta({ targets: ["big.ts"], whole: true, range: null }), d);
  return { d, meta };
}

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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
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

  it("a raised judgeRounds is honoured by the re-review gate too (no deadlock)", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta({ judgeRounds: 4 }), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);

    // Three reworks — past MAX_JUDGE_ROUNDS, inside the run's cap of 4.
    for (let i = 1; i <= 3; i++) {
      const msg = await submitJudge(judgePayload(meta.runId, 10), d);
      expect(msg).toContain(`rework ${i}/4`);
      if (i < 3) await writeFileReview(meta.runId, reviewResult(), `# a revision ${i + 1}`, d);
    }
    // The judge told the orchestrator to re-spawn the reviewer; the gate must agree.
    const rejoin = await startReview({ runId: meta.runId, files: ["a.ts"] }, d, SESSION);
    expect(rejoin).not.toContain("rework cap");
    expect(getState(SESSION)).toBeDefined();
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
    // part를 싣지 않은 제출은 예산에서도 part 없는 하나의 버킷을 쓴다 — 기존
    // 판정 파일이 그렇듯이. 분할되지 않은 리뷰의 상한은 종전 그대로다.
    expect(judgment.invalidSubmissions.every((entry) => entry.part === undefined)).toBe(true);
    expect(await submitJudge(judgePayload(meta.runId, 100), d)).toContain("Judge INCOMPLETE");
  });

  it("잘린 화면으로 내린 판정은 무엇을 봤는지 함께 기록한다", async () => {
    // coverage-only 구제로 통과한 대형 클린 리뷰는, 심사관이 파일 전체를 본
    // 판정과 파일에서 구분되지 않았다. 리포트도 나중에 읽는 사람도 알 길이
    // 없다.
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, { ...manyFindings(0), findings: [] }, "md", d);
    const out = await submitJudge(
      { runId: meta.runId, file: "big.ts", part: 0, findingJudgments: [], coverageGaps: [], score: 90, feedback: "ok" },
      d
    );
    expect(out).toContain("Judge PASS");
    const attempt = loadJudgment(meta.runId, "big.ts", d).attempts[0]!;
    expect(attempt.verdict).toBe("pass");
    expect(attempt.truncated).toBeDefined();
    expect(attempt.truncated!.view).toBe("lines");
    expect(attempt.truncated!.total).toBe(3000);
    expect(attempt.truncated!.shown).toBeGreaterThan(0);
    expect(attempt.truncated!.shown).toBeLessThan(3000);
  });

  it("같은 part 재제출 안내는 기록 안내와 같은 번호 체계를 쓴다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(loadRun(meta.runId, d)!, review, judgment, d);
    const total = plan.findingParts.length + 1;
    const payload = {
      runId: meta.runId,
      file: "big.ts",
      part: 0,
      findingJudgments: plan.findingParts[0]!.map((index) => ({
        index, valid: true, evidenced: true, severityFit: true, actionable: true, note: "ok",
      })),
      coverageGaps: [],
      score: 80,
      feedback: "1. ok",
    };
    const first = await submitJudge(payload, d);
    expect(first).toContain(`part 1/${total} recorded`);
    const again = await submitJudge(payload, d);
    // 같은 제출을 0-기준으로 "part 0"이라 부르면 방금 본 "part 1/16"과 어긋난다.
    expect(again).toContain(`part 1/${total}`);
    expect(again).not.toContain("part 0 of");

    // judgeContext의 같은 안내는 다음 part의 인자를 바로 옆에 달고 다닌다.
    // 산문 서수(1-기준)와 인자(0-기준)가 한 문장에 서면 requested=0, next=1에서
    // 둘 다 "1"로 찍힌다 — 어느 쪽을 띄우라는 말인지 읽는 쪽이 고를 수 없다.
    // 그래서 이 문장에는 part 번호가 툴 인자 하나뿐이어야 한다.
    const ctx = judgeContext(meta.runId, "big.ts", d, 0);
    const mentions = [...ctx.matchAll(/\bpart[ =](\d+)/g)].map((m) => m[0]);
    expect(mentions).toEqual(["part=1"]);
    expect(ctx).toContain("was already submitted");
    // submitJudge 쪽은 옆에 인자가 없어 1-기준 산문 그대로가 맞다.
    expect(again).toContain(`part 1/${total} of big.ts was already submitted`);
  });

  it("part가 하나뿐인 coverage 프롬프트는 없는 다른 part를 말하지 않는다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, { ...manyFindings(0), findings: [] }, "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan) as string;
    expect(prompt).toContain("COVERAGE ONLY");
    expect(prompt).not.toContain("Other parts have already scored");
  });

  it("정수가 아닌 part는 코어에서 막힌다", async () => {
    // 오늘은 어댑터의 Zod 가드만 이걸 막는다. judgeContext는 export된 코어다.
    // 범위 안의 소수(분할된 리뷰의 1.5)여야 실제로 이 가드를 지난다.
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const plan = judgePartPlanFor(
      loadRun(meta.runId, d)!,
      readFileReviewResult(meta.runId, "big.ts", d)!,
      loadJudgment(meta.runId, "big.ts", d),
      d
    );
    expect(plan.findingParts.length + 1).toBeGreaterThan(2);
    expect(judgeContext(meta.runId, "big.ts", d, 1.5)).toContain("does not exist");
    // 범위 밖 part가 프롬프트 조립까지 흘러가면 overflow로 돌아와 리뷰를
    // 영구 종료시킨다. 거절은 거절로 끝나야 한다.
    expect(loadJudgment(meta.runId, "big.ts", d).terminal).toBeUndefined();
  });

  it("잘림 기록의 문구는 개요와 줄 수를 섞어 읽히지 않는다", async () => {
    // {view:"outline"}의 shown은 선언 개수, total은 줄 수다. "50/1500"으로
    // 찍으면 1500줄 중 50줄을 봤다는 뜻으로 읽힌다 — F4가 새로 넣은 바로 그
    // 화면에 대해 틀린 말이다.
    expect(describeTruncation({ view: "outline", shown: 50, total: 1500 })).toContain(
      "declaration"
    );
    expect(describeTruncation({ view: "outline", shown: 50, total: 1500 })).toContain("line");
    expect(describeTruncation({ view: "lines", shown: 269, total: 1500 })).toBe(
      "269 of 1500 line(s)"
    );
    expect(describeTruncation({ view: "diff", shown: 40, total: 90 })).toBe(
      "40 of 90 diff line(s)"
    );
  });

  it("전체를 본 판정에는 잘림 기록이 붙지 않는다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    await submitJudge(judgePayload(meta.runId, 90), d);
    expect(loadJudgment(meta.runId, "a.ts", d).attempts[0]!.truncated).toBeUndefined();
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
    // No truncated prefix: the windows below would re-render it line for line.
    expect(out).toContain("big.ts is 2400 lines — too large to show whole");
    expect(out).not.toContain("1|line1\n");
    expect(out).toContain("line2100"); // the finding's anchor is visible to the judge
  });

  it("salvages a truncated zero-finding review with a coverage-only part instead of terminalizing", async () => {
    // judgeContext now plans parts before falling back to the old terminal
    // path (Task 4's buildPartPrompt salvages exactly this case with a
    // coverage-only part over the lines it can show); the old expectation
    // that this always terminalizes predates that wiring.
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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
    expect(out).toContain("COVERAGE ONLY");
    expect(out).toContain("of 2400");
    expect(out).not.toContain("terminal Judge INCOMPLETE");

    const judgment = loadJudgment(meta.runId, "clean-big.ts", d);
    expect(judgment.attempts).toHaveLength(0);
    expect(judgment.terminal).toBeUndefined();

    // The salvage now completes end to end: this review's ONE part is the
    // coverage part, so submitting it records an ordinary attempt instead of
    // the terminal the unscoped overflow re-check used to write on first
    // submit. Serving a context nobody could ever answer was the dead end.
    // The no-PASS guarantee this test used to assert is not lost — it is
    // scoped to what it protects. It forbids passing a review whose FINDINGS
    // and evidence could not be shown to the judge; here there are no
    // findings, coverage is the only criterion in play, and the coverage
    // prompt states over which lines it was judged. A review WITH findings
    // never reaches this path (see buildPartPrompt), and the sibling
    // oversized-findings test below still asserts no PASS for that shape.
    const direct = await submitJudge(
      judgePayload(meta.runId, 100, { file: "clean-big.ts", findingJudgments: [] }),
      d
    );
    expect(direct).toContain("Judge PASS");
    const judged = loadJudgment(meta.runId, "clean-big.ts", d);
    expect(judged.terminal).toBeUndefined();
    expect(judged.attempts).toHaveLength(1);
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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
    expect(out).toContain("terminal Judge INCOMPLETE");
    expect(out).toContain("1 finding(s) have no line anchor");
    expect(out).not.toContain("Judge every finding by its index");

    const judgment = loadJudgment(meta.runId, "unanchored-big.ts", d);
    expect(judgment.attempts).toHaveLength(0);
    expect(judgment.terminal?.status).toBe("judge-incomplete");
  });

  it("splits oversized findings across parts instead of failing closed", async () => {
    // Each finding's own serialized JSON fits comfortably; only combining all
    // 8 into one call blew JUDGE_FINDINGS_MAX_BYTES. judgeContext now plans
    // parts first, so this is exactly the case part-splitting was built for.
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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toMatch(/part 1\/\d+/);
    expect(out).toMatch(/This file is judged in \d+ parts; submit with part=0\./);

    const judgment = loadJudgment(meta.runId, "a.ts", d);
    expect(judgment.terminal).toBeUndefined();

    // Every planned part must itself fit the budget — not just the first one.
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const total = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
    expect(total).toBeGreaterThan(1);
    for (let part = 0; part < total; part++) {
      const partOut = judgeContext(meta.runId, "a.ts", d, part);
      expect(partOut).not.toContain("does not exist");
      expect(partOut).not.toContain("Judge context INCOMPLETE");
    }

    // A direct, non-part-aware submitJudge call must still never manufacture a
    // PASS for this review — see the note in the coverage-part test above.
    const direct = await submitJudge(judgePayload(meta.runId, 100), d);
    expect(direct).not.toContain("✅ Judge PASS");
    expect(
      loadJudgment(meta.runId, "a.ts", d).attempts.some((a) => a.verdict === "pass")
    ).toBe(false);
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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
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

  /** 프롬프트에 실린 가중치 합. 0-100 칸에 80점짜리 배점표를 주면 심사관이
   * 스스로 그 총점에 맞춰 정규화하고, synthesiseParts가 그 위에 0.8을 또
   * 곱한다. */
  const weightSum = (prompt: string): number =>
    [...prompt.matchAll(/^\d\. [^(]+\((\d+)%\)/gm)].reduce((n, m) => n + Number(m[1]), 0);

  it("전체 배점표는 100%로 합산된다", () => {
    expect(weightSum(JUDGE_CRITERIA)).toBe(100);
  });

  it("지적 part의 배점표는 1-4번만 싣고 100%로 재정규화한다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    expect(plan.findingParts.length).toBeGreaterThan(1);
    const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan) as string;
    expect(weightSum(prompt)).toBe(100);
    expect(prompt).not.toContain("Coverage (");
    expect(prompt).toContain("Validity (50%)");
  });
});

describe("judge context overflow (fail-closed)", () => {
  /** Repo whose single file is far larger than any judge budget. */
  function hugeRepo(lines: number, width = 200): string {
    const d = dir();
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@t"]);
    sh(["git", "config", "user.name", "t"]);
    writeFileSync(join(d, "a.ts"), "x\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    writeFileSync(
      join(d, "a.ts"),
      Array.from({ length: lines }, (_, i) => `const v${i} = "${"y".repeat(width)}";`).join("\n") + "\n"
    );
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "grow"]);
    return d;
  }

  async function context(
    d: string,
    findings: FileReviewResult["findings"],
    over: Partial<RunMeta> = {}
  ): Promise<string> {
    const meta = await createRun(baseMeta({ whole: true, ...over }), d);
    await writeFileReview(
      meta.runId,
      { file: "a.ts", assessed: [...REQUIRED_CATEGORIES], findings, explorationCalls: 2, partial: false },
      "# r",
      d
    );
    return judgeContext(meta.runId, "a.ts", d);
  }

  const finding = (line?: number): FileReviewResult["findings"][number] => ({
    category: "correctness",
    severity: "major",
    file: "a.ts",
    ...(line === undefined ? {} : { line }),
    rule: "r",
    message: "m",
    toBe: "fix",
  });

  it("separates an unanchored finding into its own part instead of failing the whole review", async () => {
    // With two findings, planning now puts the anchored one in its own part
    // (which builds fine) and the unanchored one in another (which still
    // cannot be checked against a targeted window and fails closed on
    // request) — the file is no longer lost wholesale to one bad finding.
    const d = hugeRepo(4000);
    const meta = await createRun(baseMeta({ whole: true }), d);
    await writeFileReview(
      meta.runId,
      {
        file: "a.ts",
        assessed: [...REQUIRED_CATEGORIES],
        findings: [finding(1), finding()],
        explorationCalls: 2,
        partial: false,
      },
      "# r",
      d
    );

    const anchoredPart = judgeContext(meta.runId, "a.ts", d, 0);
    expect(anchoredPart).not.toContain("Judge context INCOMPLETE");
    expect(anchoredPart).toContain('"index": 0');

    const unanchoredPart = judgeContext(meta.runId, "a.ts", d, 1);
    expect(unanchoredPart).toContain("Judge context INCOMPLETE");
    expect(unanchoredPart).toContain("1 finding(s) have no line anchor");
    expect(unanchoredPart).toContain("Do NOT call f_review_judge");

    const judgment = loadJudgment(meta.runId, "a.ts", d);
    expect(judgment.terminal?.status).toBe("judge-incomplete");
  });

  it("salvages a zero-finding review of a truncated change with a coverage-only part", async () => {
    // With no findings there are no anchors to recover the hidden code from a
    // full 5-criteria prompt, but the coverage-only part is scoped to only the
    // lines it actually shows, so it can still judge coverage over those.
    const out = await context(hugeRepo(4000), []);
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toContain("COVERAGE ONLY");
  });

  it("splits findings across parts when they alone exceed the budget together", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...finding(i + 1),
      message: "m".repeat(400),
    }));
    const out = await context(hugeRepo(50), many);
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toMatch(/part 1\/\d+/);
  });

  it("refuses to judge when the finding windows still do not fit", async () => {
    // Anchors exist and windows are built, but base + windows still blow the
    // change budget — the last place a partial excerpt could have slipped by.
    const out = await context(hugeRepo(1, 40_000), [finding(1)]);
    expect(out).toContain("Judge context INCOMPLETE");
    expect(out).toContain("finding window(s) plus the base exceed");
  });

  it("leaves a salvaged zero-finding review unjudged (not terminal), and the run still fails closed", async () => {
    // This file is no longer terminal — the coverage-only part salvages it —
    // but nothing has submitted a verdict yet, so finalize must still fail
    // closed on it as unjudged rather than silently treating it as done.
    const d = hugeRepo(4000);
    const meta = await createRun(baseMeta({ whole: true }), d);
    await writeFileReview(
      meta.runId,
      { file: "a.ts", assessed: [...REQUIRED_CATEGORIES], findings: [], explorationCalls: 2, partial: false },
      "# r",
      d
    );
    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toContain("COVERAGE ONLY");
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    expect(judgment.terminal).toBeUndefined();

    const result = await finalizeRun(meta.runId, d);
    expect(result).toContain("INCOMPLETE");
  });

  it("refuses to judge a large deletion, whose source no longer exists", async () => {
    // The diff is big enough to need windows, but the file is gone at the
    // reviewed ref — there is nothing to build a window from.
    const d = dir();
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@t"]);
    sh(["git", "config", "user.name", "t"]);
    writeFileSync(
      join(d, "a.ts"),
      Array.from({ length: 400 }, (_, i) => `const v${i} = "${"y".repeat(200)}";`).join("\n") + "\n"
    );
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    rmSync(join(d, "a.ts"));
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "delete"]);

    const meta = await createRun(baseMeta({ whole: false }), d);
    await writeFileReview(
      meta.runId,
      { file: "a.ts", assessed: [...REQUIRED_CATEGORIES], findings: [finding(1)], explorationCalls: 2, partial: false },
      "# r",
      d
    );
    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain("Judge context INCOMPLETE");
    expect(out).toContain("source is unavailable");
  });

  it("judges normally when everything fits", async () => {
    const out = await context(gitRepo(), [finding(1)], { whole: false });
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toContain("### Criteria");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
  });
});

describe("pendingParts", () => {
  it("pendingParts가 없는 기존 판정 파일도 그대로 읽힌다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    mkdirSync(join(runDir(meta.runId, d), "judgments"), { recursive: true });
    writeFileSync(
      join(runDir(meta.runId, d), "judgments", `${reviewSlug("a.ts")}.json`),
      JSON.stringify({ file: "a.ts", attempts: [], invalidSubmissions: [] })
    );
    expect(loadJudgment(meta.runId, "a.ts", d).pendingParts).toEqual([]);
  });

  it("현재 아티팩트에 속한 part만 돌려준다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    judgment.pendingParts = [
      {
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        part: 0,
        score: 80,
        feedback: "f",
        coverageGaps: [],
        findingJudgments: [],
        at: new Date().toISOString(),
      },
      {
        reviewRevision: review.revision,
        reviewArtifactHash: "다른-아티팩트-해시",
        part: 1,
        score: 80,
        feedback: "f",
        coverageGaps: [],
        findingJudgments: [],
        at: new Date().toISOString(),
      },
    ];
    expect(currentPendingParts(judgment, review).map((p) => p.part)).toEqual([0]);
  });
});

describe("judge part 프롬프트", () => {
  it("지적이 많으면 여러 part로 나뉜다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const plan = judgePartPlanFor(loadRun(meta.runId, d)!, review, loadJudgment(meta.runId, "big.ts", d), d);
    expect(plan.findingParts.length).toBeGreaterThan(1);
    expect(plan.hasCoveragePart).toBe(true);
    // 모든 인덱스가 정확히 한 번씩 나타난다
    expect(plan.findingParts.flat().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i)
    );
  });

  it("각 part 프롬프트가 예산 안에 들어간다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    for (let part = 0; part < plan.findingParts.length; part++) {
      const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, part, plan);
      expect(typeof prompt).toBe("string");
      expect(Buffer.byteLength(prompt as string, "utf8")).toBeLessThanOrEqual(
        JUDGE_CONTEXT_MAX_BYTES
      );
    }
  });

  it("part 프롬프트는 그 part의 지적만 담고 번호를 밝힌다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan) as string;
    expect(prompt).toContain(`part 1/${plan.findingParts.length + 1}`);
    // part 0에 없는 지적의 rule은 프롬프트에 없어야 한다
    const absent = plan.findingParts[1]![0]!;
    expect(prompt).not.toContain(`"rule": "r${absent}"`);

    // 두 번째 part는 원본 리뷰의 인덱스를 그대로 싣는다. 부분집합을 그냥
    // 직렬화하면 0부터 다시 세어 심사관이 엉뚱한 지적에 판정을 붙인다.
    const second = buildPartPrompt(runMetaLoaded, review, judgment, d, 1, plan) as string;
    expect(absent).toBeGreaterThan(0);
    expect(second).toContain(`"index": ${absent}`);
    expect(second).toContain(`"rule": "r${absent}"`);
    expect(second).not.toContain(`"index": 0`);
  });

  it("coverage part는 지적 요약만 담고 채점 기준 5번을 지시한다", async () => {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(
      runMetaLoaded, review, judgment, d, plan.findingParts.length, plan
    ) as string;
    expect(prompt).toContain("Coverage");
    expect(prompt).toContain("r0");            // 지적 요약에는 모든 rule이 있다
    expect(prompt).not.toContain("고친 코드"); // 수정안 본문은 없다
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
  });

  it("planner가 재는 프롬프트는 실제 unsplit 프롬프트보다 항상 크다", async () => {
    // judgePartPlanFor는 widest scope로 재고, 그 값이 예산 안이면 part 하나로
    // 계획한다. 그런데 실제로 조립되는 것은 scope 없는 프롬프트다. 이 부등식이
    // 뒤집히면 "한 part로 계획했는데 조립에서 overflow" — 파일이 통째로
    // terminal INCOMPLETE가 된다. 상수 여유(~111B)라 입력으로는 깎이지 않지만
    // 문구를 고치면 조용히 음수가 될 수 있다.
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    const all = review.findings.map((_, index) => index);
    const unscoped = buildJudgePrompt(runMetaLoaded, review, judgment, d) as string;
    const widest = buildJudgePrompt(runMetaLoaded, review, judgment, d, all, {
      number: review.findings.length,
      total: review.findings.length + 1,
    }) as string;
    expect(Buffer.byteLength(unscoped, "utf8")).toBeLessThan(
      Buffer.byteLength(widest, "utf8")
    );
  });

  it("part 하나로 끝나면 기존 프롬프트와 동일하다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    expect(plan.findingParts).toEqual([[0]]);
    expect(plan.hasCoveragePart).toBe(false);
    expect(buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan)).toBe(
      buildJudgePrompt(runMetaLoaded, review, judgment, d) as string
    );
  });

  /** 프롬프트가 실제로 보여준 마지막 줄. 헤더의 주장과 대조한다. */
  const shownTo = (prompt: string): number => Number(/LINE_RANGE: 1-(\d+)/.exec(prompt)![1]);

  it("coverage part 헤더는 실제로 보여준 줄 범위만 주장한다", async () => {
    // 바이트 예산을 문자수 상한으로 넘기면 개요는 1000줄에서 끊기는데 헤더는
    // 3000줄을 다 보여준 척한다. 그러면 심사관은 본 적 없는 2300줄을 놓고
    // "다 살펴봤나"를 답해야 하고, 없는 coverage gap을 지어낸다.
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(
      runMetaLoaded, review, judgment, d, plan.findingParts.length, plan
    ) as string;

    const shown = shownTo(prompt);
    expect(shown).toBeLessThan(3000); // 3000줄은 예산에 들어가지 않는다
    expect(prompt).toContain(`lines 1-${shown} of 3000`);
    expect(prompt).toContain(`Lines ${shown + 1}-3000 were NOT shown`);
    expect(prompt).not.toContain("(3000 lines)"); // 전체를 본 척하지 않는다
    expect(prompt).not.toContain("… (truncated)"); // 문자수 절단 흔적이 없다
    // 헤더가 밝힌 범위가 본문과 정확히 일치한다
    expect(prompt).toContain(`\n${shown}|const v${shown - 1} =`);
    expect(prompt).not.toContain(`\n${shown + 1}|const v${shown} =`);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
  });

  it("통째로 못 보여주는 파일은 앞부분 원문이 아니라 선언 개요를 받는다", async () => {
    // 명세 §2가 요구하는 입력은 "파일 구조와 전체 지적 요약"이다. 앞에서부터
    // 예산만큼 잘라 붙이면 기준 5번(배점의 20%)을 파일 앞 3분의 1만 보고
    // 채점하게 되고, 뒤쪽 선언은 전부 "안 살펴본 영역"으로 신고된다.
    const { d, meta } = await structuredRun();
    await writeFileReview(meta.runId, { ...manyFindings(0), findings: [] }, "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(
      runMetaLoaded, review, judgment, d, plan.findingParts.length, plan
    ) as string;
    expect(typeof prompt).toBe("string");
    // 마지막 선언까지 전부 보인다 — 앞부분 절단이면 없다.
    expect(prompt).toContain("handler0");
    expect(prompt).toContain("handler49");
    // 본문은 싣지 않는다.
    expect(prompt).not.toContain("아주 긴 설명 주석");
    // 앞부분만 보여준 척하는 안내가 아니다.
    expect(prompt).not.toContain("were NOT shown to you");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
  });

  it("선언을 못 찾는 파일은 지금까지의 앞부분 개요로 물러선다", async () => {
    // fileDeclarations는 TS/JS/Python만 안다. Java 소스는 선언이 0건이라
    // 개요를 만들 수 없고, 그때는 바이트 상한 원문 개요가 그대로 남아야 한다.
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, { ...manyFindings(0), findings: [] }, "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(
      runMetaLoaded, review, judgment, d, plan.findingParts.length, plan
    ) as string;
    expect(prompt).toContain("were NOT shown to you");
    expect(prompt).toContain("of 3000");
  });

  it("diff 모드에서는 coverage part도 diff만 보여준다", async () => {
    // changeExcerpt는 meta.range && !meta.whole에서 diff로 갈라지는데
    // coveragePrompt는 무조건 파일 전체를 읽었다. 그러면 "이 변경의 중요한
    // 부분을 다 살펴봤나"를 애초에 리뷰 범위가 아니었던 코드를 놓고 묻게 되고,
    // 심사관은 없는 간극을 지어낸다 — 합성 점수가 threshold-1로 눌리고
    // 파일은 rework 상한을 타고 terminal INCOMPLETE로 간다.
    const { d, meta } = await bigDiffRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    expect(plan.hasCoveragePart).toBe(true);
    const prompt = buildPartPrompt(
      runMetaLoaded, review, judgment, d, plan.findingParts.length, plan
    ) as string;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("COVERAGE ONLY");
    // 바뀐 줄은 보여준다.
    expect(prompt).toContain("const v1500 = 999;");
    // 손대지 않은 줄은 보여주지 않는다 — 리뷰 범위가 아니다.
    expect(prompt).not.toContain("const v10 = 10;");
    expect(prompt).not.toContain("of 3000");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_BYTES);
  });

  it("지적 없는 대형 파일도 coverage part로 심사된다", async () => {
    // 지적이 0건이면 changeExcerpt에 앵커가 없어 기존 프롬프트는 무조건
    // overflow로 닫힌다. 그 파일을 통째로 잃는 대신 coverage만 심사한다.
    const { d, meta } = await bigRun();
    await writeFileReview(
      meta.runId,
      { ...manyFindings(0), findings: [] },
      "md",
      d
    );
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const judgment = loadJudgment(meta.runId, "big.ts", d);
    expect(isContextOverflow(buildJudgePrompt(runMetaLoaded, review, judgment, d))).toBe(true);

    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    expect(plan.findingParts).toEqual([]);
    const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan);
    expect(typeof prompt).toBe("string");
    expect(prompt as string).toContain("COVERAGE ONLY");
    expect(prompt as string).toContain(`lines 1-${shownTo(prompt as string)} of 3000`);
    expect(Buffer.byteLength(prompt as string, "utf8")).toBeLessThanOrEqual(
      JUDGE_CONTEXT_MAX_BYTES
    );
  });

  it("지적 없는 작은 파일은 기존 5개 기준 프롬프트를 그대로 받는다", async () => {
    // coverage 예외는 base가 들어가지 않는 대형 파일에만 걸린다. 통째로
    // 보이는 파일은 심사관이 다섯 기준을 모두 채점하던 동작을 유지한다.
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, { ...reviewResult(), findings: [] }, "md", d);
    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const prompt = buildPartPrompt(runMetaLoaded, review, judgment, d, 0, plan) as string;
    expect(prompt).not.toContain("COVERAGE ONLY");
    expect(prompt).toContain("Validity (40%)");
    expect(prompt).toBe(buildJudgePrompt(runMetaLoaded, review, judgment, d) as string);
  });
});

describe("judgeContext의 part 처리", () => {
  it("분할되지 않은 리뷰는 part 인자 없이 지금처럼 동작한다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain(JUDGE_CRITERIA.split("\n")[0]!);
    expect(out).not.toContain("part 1/");
  });

  it("존재하지 않는 part 번호를 거부한다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    expect(judgeContext(meta.runId, "a.ts", d, 5)).toContain("does not exist");
  });

  it("part가 하나뿐인(분할 안 된) 리뷰는 그 part가 제출되면 전부 제출됐다고 안내한다", async () => {
    // total === 1 here, so this exercises the "every part already submitted"
    // branch — not the "here is the next part" branch (see the test below for
    // that, which needs a genuinely split review to reach it).
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "# a", d);
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    judgment.pendingParts = [
      {
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        part: 0,
        score: 80,
        feedback: "f",
        coverageGaps: [],
        findingJudgments: [],
        at: new Date().toISOString(),
      },
    ];
    persistJudgmentSync(meta.runId, "a.ts", d, judgment);
    const out = judgeContext(meta.runId, "a.ts", d, 0);
    expect(out).toContain("already submitted");
    expect(out).toContain("Every part");
  });

  it("분할된 리뷰에서 이미 제출된 part를 다시 요청하면 다음 part 번호를 알려준다", async () => {
    // Genuinely split (total > 1), reusing the 8-oversized-findings fixture.
    // Only part 0 is pending, so judgeContext must name part 1 as the next
    // one to spawn a fresh judge for — the branch the total===1 test above
    // cannot reach.
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

    const runMetaLoaded = loadRun(meta.runId, d)!;
    const review = readFileReviewResult(meta.runId, "a.ts", d)!;
    const judgment = loadJudgment(meta.runId, "a.ts", d);
    const plan = judgePartPlanFor(runMetaLoaded, review, judgment, d);
    const total = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
    expect(total).toBeGreaterThan(1);

    judgment.pendingParts = [
      {
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        part: 0,
        score: 80,
        feedback: "f",
        coverageGaps: [],
        findingJudgments: [],
        at: new Date().toISOString(),
      },
    ];
    persistJudgmentSync(meta.runId, "a.ts", d, judgment);

    const out = judgeContext(meta.runId, "a.ts", d, 0);
    expect(out).toContain("already submitted");
    // 이 두 줄이 나란히 서 있던 것이 바로 그 충돌이었다: "part 1"은 인덱스 0,
    // "part=1"은 인덱스 1. 이 문장에 남는 part 번호는 인자 하나뿐이다.
    expect([...out.matchAll(/\bpart[ =](\d+)/g)].map((m) => m[0])).toEqual(["part=1"]);
    expect(out).not.toContain("Every part");
  });
});

describe("part 제출", () => {
  /** 30건짜리 리뷰를 제출하고 그 part 계획을 돌려준다. */
  async function splitRun() {
    const { d, meta } = await bigRun();
    await writeFileReview(meta.runId, manyFindings(30), "md", d);
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const plan = judgePartPlanFor(
      loadRun(meta.runId, d)!,
      review,
      loadJudgment(meta.runId, "big.ts", d),
      d
    );
    return { d, runId: meta.runId, plan };
  }

  const partPayload = (runId: string, part: number, indices: number[], score: number) => ({
    runId,
    file: "big.ts",
    part,
    findingJudgments: indices.map((index) => ({
      index, valid: true, evidenced: true, severityFit: true, actionable: true, note: "ok",
    })),
    coverageGaps: [],
    score,
    feedback: "1. 줄 앵커 재확인",
  });

  it("중간 part는 다음 part를 지시하고 attempt를 만들지 않는다", async () => {
    const { d, runId, plan } = await splitRun();
    const out = await submitJudge(partPayload(runId, 0, plan.findingParts[0]!, 90), d);
    expect(out).toContain("part 1");
    expect(loadJudgment(runId, "big.ts", d).attempts).toHaveLength(0);
    expect(loadJudgment(runId, "big.ts", d).pendingParts).toHaveLength(1);
  });

  it("그 part에 속하지 않은 인덱스를 거부한다", async () => {
    const { d, runId, plan } = await splitRun();
    const wrong = plan.findingParts[1]!;
    const out = await submitJudge(partPayload(runId, 0, wrong, 90), d);
    expect(out).toContain("Invalid judge submission");
    expect(loadJudgment(runId, "big.ts", d).pendingParts).toHaveLength(0);
  });

  it("존재하지 않는 part 번호를 거부한다", async () => {
    const { d, runId, plan } = await splitRun();
    const total = plan.findingParts.length + 1;
    const out = await submitJudge(partPayload(runId, total, [], 90), d);
    expect(out).toContain("Invalid judge submission");
    expect(loadJudgment(runId, "big.ts", d).terminal).toBeUndefined();
  });

  it("같은 part를 두 번 제출해도 한 번만 쌓인다", async () => {
    const { d, runId, plan } = await splitRun();
    await submitJudge(partPayload(runId, 0, plan.findingParts[0]!, 90), d);
    const again = await submitJudge(partPayload(runId, 0, plan.findingParts[0]!, 20), d);
    expect(again).toContain("already submitted");
    const pending = loadJudgment(runId, "big.ts", d).pendingParts;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.score).toBe(90);
  });

  it("모든 part가 모이면 하나의 attempt로 합성한다", async () => {
    const { d, runId, plan } = await splitRun();
    for (let p = 0; p < plan.findingParts.length; p++) {
      await submitJudge(partPayload(runId, p, plan.findingParts[p]!, 90), d);
    }
    const last = await submitJudge(partPayload(runId, plan.findingParts.length, [], 90), d);
    expect(last).toContain("Judge PASS");
    const judgment = loadJudgment(runId, "big.ts", d);
    expect(judgment.attempts).toHaveLength(1);
    expect(judgment.pendingParts).toHaveLength(0);
    expect(judgment.attempts[0]!.findingJudgments).toHaveLength(30);
    expect(judgment.attempts[0]!.verdict).toBe("pass");
  });

  it("합성 점수가 가중평균 산식을 따른다", async () => {
    const { d, runId, plan } = await splitRun();
    for (let p = 0; p < plan.findingParts.length; p++) {
      await submitJudge(partPayload(runId, p, plan.findingParts[p]!, 100), d);
    }
    await submitJudge(partPayload(runId, plan.findingParts.length, [], 0), d);
    // 지적 100점 * 0.8 + coverage 0점 * 0.2 = 80
    expect(loadJudgment(runId, "big.ts", d).attempts[0]!.score).toBeCloseTo(80, 5);
  });

  it("part가 남은 채로는 finalize가 미판정으로 처리한다", async () => {
    const { d, runId, plan } = await splitRun();
    await submitJudge(partPayload(runId, 0, plan.findingParts[0]!, 90), d);
    const out = await finalizeRun(runId, d);
    expect(out).toContain("INCOMPLETE");
  });

  it("제출한 part 번호가 실제로 읽힌다", async () => {
    // JudgeSubmitSchema는 non-strict라 `part`를 선언하지 않으면 조용히 떼어낸다.
    // 떨어져 나가면 이 제출은 part 0으로 보이고, part 1의 인덱스 집합은 part 0의
    // 것과 달라 거절된다 — 그래서 이 테스트는 필드가 읽힐 때에만 통과한다.
    const { d, runId, plan } = await splitRun();
    const out = await submitJudge(partPayload(runId, 1, plan.findingParts[1]!, 90), d);
    expect(out).toContain("part 2/");
    expect(loadJudgment(runId, "big.ts", d).pendingParts.map((p) => p.part)).toEqual([1]);
  });

  it("part 자체가 앞뒤가 안 맞으면 제출 시점에 거절한다", async () => {
    // 합성까지 미루면 전 part의 작업이 함께 버려진다. part 단위로 걸러야 싸게 복구된다.
    const { d, runId, plan } = await splitRun();
    const payload = partPayload(runId, 0, plan.findingParts[0]!, 90);
    payload.findingJudgments = payload.findingJudgments.map((j) => ({ ...j, valid: false }));
    const out = await submitJudge(payload, d);
    expect(out).toContain("Invalid judge submission");
    expect(out).toContain("part 0");
    expect(loadJudgment(runId, "big.ts", d).pendingParts).toHaveLength(0);
  });

  it("지적 part의 coverageGaps는 비어있음 규칙을 받지 않는다", async () => {
    // 부분만 본 심사관의 간극 신고는 합성에서 버려진다. 규칙을 그대로 걸면
    // 버려질 값 때문에 정상 제출이 거절된다 — coverage part에만 적용한다.
    const { d, runId, plan } = await splitRun();
    const out = await submitJudge(
      { ...partPayload(runId, 0, plan.findingParts[0]!, 90), coverageGaps: ["부분만 본 신고"] },
      d
    );
    expect(out).toContain("part 1/");
    expect(loadJudgment(runId, "big.ts", d).pendingParts).toHaveLength(1);
  });

  it("coverage part는 간극을 신고하면서 통과 점수를 줄 수 없다", async () => {
    const { d, runId, plan } = await splitRun();
    const out = await submitJudge(
      { ...partPayload(runId, plan.findingParts.length, [], 90), coverageGaps: ["에러 경로"] },
      d
    );
    expect(out).toContain("Invalid judge submission");
    expect(out).toContain("coverageGaps");
    expect(loadJudgment(runId, "big.ts", d).pendingParts).toHaveLength(0);
  });

  it("coverage 간극이 신고되면 합성 점수를 임계값 아래로 낮춰 REWORK로 남긴다", async () => {
    // coverage part가 0점을 줘도 0.8*90 = 72로 임계값을 넘는다. 어느 심사관도
    // 단독으로 만들 수 없는 조합이고, 거절하면 16개 part가 전부 버려진다.
    const { d, runId, plan } = await splitRun();
    for (let p = 0; p < plan.findingParts.length; p++) {
      await submitJudge(partPayload(runId, p, plan.findingParts[p]!, 90), d);
    }
    const out = await submitJudge(
      { ...partPayload(runId, plan.findingParts.length, [], 0), coverageGaps: ["에러 경로 L100-200"] },
      d
    );
    expect(out).toContain("Judge REWORK");

    const judgment = loadJudgment(runId, "big.ts", d);
    expect(judgment.pendingParts).toHaveLength(0);
    expect(judgment.attempts).toHaveLength(1);
    expect(judgment.attempts[0]!.verdict).toBe("rework");
    expect(judgment.attempts[0]!.score).toBe(DEFAULT_JUDGE_THRESHOLD - 1);
    expect(judgment.attempts[0]!.findingJudgments).toHaveLength(30);
    // 낮춘 사실과 이유가 feedback에 남는다 — 아니면 보고서의 점수를 아무도 유도할 수 없다.
    expect(judgment.attempts[0]!.feedback).toContain("Score reduced from 72");
    expect(judgment.attempts[0]!.feedback).toContain("coverageGaps");
    // 기록된 attempt는 다시 읽어도 validatePersistedAttempts를 통과한다.
    expect(loadJudgment(runId, "big.ts", d).attempts).toHaveLength(1);
  });

  it("일부 판정이 거짓인데 합성 점수가 통과선을 넘으면 낮춰서 REWORK로 남긴다", async () => {
    const { d, runId, plan } = await splitRun();
    for (let p = 0; p < plan.findingParts.length; p++) {
      const payload = partPayload(runId, p, plan.findingParts[p]!, p === 0 ? 30 : 100);
      if (p === 0) {
        payload.findingJudgments = payload.findingJudgments.map((j) => ({ ...j, valid: false }));
      }
      await submitJudge(payload, d);
    }
    const out = await submitJudge(partPayload(runId, plan.findingParts.length, [], 100), d);
    expect(out).toContain("Judge REWORK");

    const attempt = loadJudgment(runId, "big.ts", d).attempts[0]!;
    expect(attempt.verdict).toBe("rework");
    expect(attempt.score).toBe(DEFAULT_JUDGE_THRESHOLD - 1);
    expect(attempt.feedback).toContain("Score reduced from");
    expect(attempt.feedback).toContain("finding judgment");
    expect(loadJudgment(runId, "big.ts", d).attempts).toHaveLength(1);
  });

  /** 그 part의 인덱스는 맞지만 자기 자신과 앞뒤가 안 맞는 제출. */
  const inconsistentPart = (runId: string, part: number, indices: number[]) => {
    const payload = partPayload(runId, part, indices, 90);
    payload.findingJudgments = payload.findingJudgments.map((j) => ({ ...j, valid: false }));
    return payload;
  };

  it("같은 part의 무효 제출이 상한에 닿으면 종료한다", async () => {
    const { d, runId, plan } = await splitRun();
    const bad = inconsistentPart(runId, 0, plan.findingParts[0]!);
    for (let i = 1; i < MAX_INVALID_JUDGE_SUBMISSIONS; i++) {
      expect(await submitJudge(bad, d)).toContain(`Retry ${i}/${MAX_INVALID_JUDGE_SUBMISSIONS}`);
    }
    expect(await submitJudge(bad, d)).toContain("Judge INCOMPLETE");
    expect(loadJudgment(runId, "big.ts", d).terminal?.status).toBe("judge-incomplete");
  });

  it("서로 다른 part의 무효 제출은 한 예산을 나눠 쓰지 않는다", async () => {
    // part마다 새 f-judge가 뜬다. 심사관 셋이 각자 한 번씩 틀린 것과, 한 심사관이
    // 세 번 틀린 것은 다르다 — 전자로 파일이 종료되면 분할된 리뷰만 불리해진다.
    const { d, runId, plan } = await splitRun();
    expect(plan.findingParts.length).toBeGreaterThanOrEqual(MAX_INVALID_JUDGE_SUBMISSIONS);
    for (let p = 0; p < MAX_INVALID_JUDGE_SUBMISSIONS; p++) {
      const out = await submitJudge(inconsistentPart(runId, p, plan.findingParts[p]!), d);
      expect(out).toContain(`Retry 1/${MAX_INVALID_JUDGE_SUBMISSIONS}`);
      expect(out).toContain(`part ${p}`);
    }
    expect(loadJudgment(runId, "big.ts", d).terminal).toBeUndefined();

    // 그리고 그 리뷰는 여전히 끝까지 갈 수 있다.
    for (let p = 0; p < plan.findingParts.length; p++) {
      await submitJudge(partPayload(runId, p, plan.findingParts[p]!, 90), d);
    }
    const out = await submitJudge(partPayload(runId, plan.findingParts.length, [], 90), d);
    expect(out).toContain("Judge PASS");
    expect(loadJudgment(runId, "big.ts", d).attempts).toHaveLength(1);
  });

  it("분할되지 않은 리뷰는 part 없이 지금처럼 제출된다", async () => {
    const d = gitRepo();
    const meta = await createRun(baseMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const out = await submitJudge(judgePayload(meta.runId, 90), d);
    expect(out).toContain("Judge PASS");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(1);
    expect(loadJudgment(meta.runId, "a.ts", d).pendingParts).toHaveLength(0);
  });
});
