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
