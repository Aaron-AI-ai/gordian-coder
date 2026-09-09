/**
 * judge part 계획: 예산 안에 들어가는 인덱스 묶음을 결정론적으로 계산한다.
 */

import { describe, expect, it } from "bun:test";
import { planJudgeParts } from "../judge-parts";

/** 지적 1건당 고정 비용 + 고정 오버헤드를 갖는 가짜 측정기. */
const measurer = (perFinding: number, overhead = 0) =>
  (indices: number[]): number => overhead + indices.length * perFinding;

describe("planJudgeParts", () => {
  it("전부 예산에 들어가면 part 하나만 만들고 coverage part를 붙이지 않는다", () => {
    const plan = planJudgeParts(5, measurer(1_000), 45_000);
    expect(plan.findingParts).toEqual([[0, 1, 2, 3, 4]]);
    expect(plan.hasCoveragePart).toBe(false);
  });

  it("예산을 넘기면 넘기 직전에 part를 닫는다", () => {
    // 건당 10,000B, 예산 45,000B → part당 4건
    const plan = planJudgeParts(10, measurer(10_000), 45_000);
    expect(plan.findingParts).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
  });

  it("분할이 일어나면 coverage part를 붙인다", () => {
    const plan = planJudgeParts(10, measurer(10_000), 45_000);
    expect(plan.hasCoveragePart).toBe(true);
  });

  it("고정 오버헤드를 예산에서 뺀다", () => {
    // 오버헤드 20,000B + 건당 10,000B, 예산 45,000B → part당 2건
    const plan = planJudgeParts(4, measurer(10_000, 20_000), 45_000);
    expect(plan.findingParts).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("혼자서도 예산을 넘기는 지적은 그 건만 담은 part로 만든다", () => {
    // 건당 50,000B — 어떤 조합도 45,000B 안에 못 들어간다
    const plan = planJudgeParts(3, measurer(50_000), 45_000);
    expect(plan.findingParts).toEqual([[0], [1], [2]]);
  });

  it("결정론적이다 — 같은 입력에 같은 계획", () => {
    const a = planJudgeParts(10, measurer(10_000), 45_000);
    const b = planJudgeParts(10, measurer(10_000), 45_000);
    expect(a).toEqual(b);
  });

  it("지적이 0건이면 지적 part 없이 coverage part만 남긴다", () => {
    const plan = planJudgeParts(0, measurer(1_000), 45_000);
    expect(plan.findingParts).toEqual([]);
    expect(plan.hasCoveragePart).toBe(true);
  });
});

import { synthesiseParts, type PartSubmission } from "../judge-parts";
import type { FindingJudgment } from "../judge-store";

const fj = (index: number): FindingJudgment => ({
  index,
  valid: true,
  evidenced: true,
  severityFit: true,
  actionable: true,
  note: "ok",
});

const submission = (
  part: number,
  score: number,
  indices: number[],
  over: Partial<PartSubmission> = {}
): PartSubmission => ({
  part,
  score,
  feedback: `part ${part} 피드백`,
  coverageGaps: [],
  findingJudgments: indices.map(fj),
  ...over,
});

describe("synthesiseParts", () => {
  it("분할되지 않으면 그 part의 값을 그대로 쓴다", () => {
    const plan = { findingParts: [[0, 1]], hasCoveragePart: false };
    const out = synthesiseParts(plan, [
      submission(0, 82, [0, 1], { coverageGaps: ["에러 경로 미점검"] }),
    ]);
    expect(out.score).toBe(82);
    expect(out.coverageGaps).toEqual(["에러 경로 미점검"]);
    expect(out.findingJudgments.map((j) => j.index)).toEqual([0, 1]);
  });

  it("지적 part를 건수로 가중평균하고 coverage에 20%를 준다", () => {
    const plan = {
      findingParts: [
        [0, 1, 2, 3, 4, 5, 6, 7],
        [8, 9, 10, 11, 12, 13, 14, 15],
        [16, 17, 18, 19],
      ],
      hasCoveragePart: true,
    };
    const out = synthesiseParts(plan, [
      submission(0, 85, [0, 1, 2, 3, 4, 5, 6, 7]),
      submission(1, 60, [8, 9, 10, 11, 12, 13, 14, 15]),
      submission(2, 90, [16, 17, 18, 19]),
      submission(3, 50, [], { coverageGaps: ["트랜잭션 경계 미점검"] }),
    ]);
    // 지적 = (8*85 + 8*60 + 4*90) / 20 = 1520 / 20 = 76
    // 최종 = 76 * 0.8 + 50 * 0.2 = 70.8
    expect(out.score).toBeCloseTo(70.8, 5);
  });

  it("모든 part의 findingJudgments를 인덱스 순으로 합친다", () => {
    const plan = { findingParts: [[0, 1], [2, 3]], hasCoveragePart: true };
    const out = synthesiseParts(plan, [
      submission(1, 70, [2, 3]),
      submission(0, 70, [0, 1]),
      submission(2, 70, []),
    ]);
    expect(out.findingJudgments.map((j) => j.index)).toEqual([0, 1, 2, 3]);
  });

  it("coverageGaps는 coverage part의 것만 쓴다", () => {
    const plan = { findingParts: [[0], [1]], hasCoveragePart: true };
    const out = synthesiseParts(plan, [
      submission(0, 70, [0], { coverageGaps: ["무시되어야 함"] }),
      submission(1, 70, [1], { coverageGaps: ["이것도 무시"] }),
      submission(2, 70, [], { coverageGaps: ["진짜 간극"] }),
    ]);
    expect(out.coverageGaps).toEqual(["진짜 간극"]);
  });

  it("지적이 0건이면 coverage part 점수가 최종 점수다", () => {
    const plan = { findingParts: [], hasCoveragePart: true };
    const out = synthesiseParts(plan, [
      submission(0, 88, [], { coverageGaps: [] }),
    ]);
    expect(out.score).toBe(88);
    expect(out.findingJudgments).toEqual([]);
  });

  it("part 번호를 붙여 피드백을 이어붙이고 4000자에서 자른다", () => {
    const plan = { findingParts: [[0], [1]], hasCoveragePart: true };
    const out = synthesiseParts(plan, [
      submission(0, 70, [0], { feedback: "가".repeat(3000) }),
      submission(1, 70, [1], { feedback: "나".repeat(3000) }),
      submission(2, 70, [], { feedback: "다".repeat(3000) }),
    ]);
    expect(out.feedback.length).toBe(4000);
    expect(out.feedback.startsWith("[part 1]")).toBe(true);
  });
});
