/**
 * 심사 작업을 예산에 맞는 part로 나누고, part별 제출을 하나의 판정으로 합성한다.
 *
 * 프롬프트 조립(judge-prompt.ts)이나 영속화(judge-store.ts)와 분리된 순수
 * 로직이다. 계획은 저장하지 않고 매번 재계산하므로, 같은 입력에 항상 같은
 * 계획이 나와야 한다 — 제출된 part가 담아야 할 인덱스 집합을 이 재계산으로
 * 검증하기 때문이다.
 */

import type { FindingJudgment } from "./judge-store";

export interface JudgePartPlan {
  /** 지적 인덱스 묶음. 분할되지 않으면 길이 1, 지적이 0건이면 빈 배열. */
  findingParts: number[][];
  /** 마지막에 coverage 전용 part가 붙는지. */
  hasCoveragePart: boolean;
}

/**
 * 지적을 순서대로 담으며 `measure`로 조립 크기를 재고, `budget`을 넘기 직전에
 * part를 닫는다. 고정 건수 상수를 두지 않는 이유는 비용이 지적마다 다르기
 * 때문이다 — 한곳에 뭉친 지적은 소스 윈도우가 병합되어 훨씬 싸다.
 *
 * coverage part는 분할이 실제로 일어났을 때만 붙는다. part 하나로 끝나면 그
 * 심사관이 파일 전체를 본 것이므로 5개 기준을 모두 채점하면 되고, part 개념이
 * 드러나지 않는다(기존 동작과 동일).
 */
export function planJudgeParts(
  findingCount: number,
  measure: (indices: number[]) => number,
  budget: number
): JudgePartPlan {
  if (findingCount <= 0) return { findingParts: [], hasCoveragePart: true };

  const findingParts: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < findingCount; index++) {
    const candidate = [...current, index];
    if (current.length > 0 && measure(candidate) > budget) {
      findingParts.push(current);
      current = [index];
    } else {
      current = candidate;
    }
  }
  // 혼자서도 예산을 넘기는 지적은 더 쪼갤 단위가 없으므로 그대로 담는다.
  if (current.length) findingParts.push(current);

  return { findingParts, hasCoveragePart: findingParts.length > 1 };
}

/** coverage part 점수가 최종 점수에서 차지하는 비중 (JUDGE_CRITERIA 5번 = 20%). */
const COVERAGE_WEIGHT = 0.2;

/** 합성된 feedback의 길이 상한. JudgeSubmitSchema의 capped(4000)과 같다. */
export const FEEDBACK_MAX_CHARS = 4_000;

export interface PartSubmission {
  /** 0..findingParts.length-1 은 지적 part, 그 다음 번호가 coverage part. */
  part: number;
  score: number;
  feedback: string;
  coverageGaps: string[];
  findingJudgments: FindingJudgment[];
}

export interface SynthesisedJudgment {
  score: number;
  feedback: string;
  coverageGaps: string[];
  findingJudgments: FindingJudgment[];
}

/**
 * part별 제출을 하나의 판정 본문으로 합친다. 결과는 전체 findingJudgments를
 * 담으므로 기존 indexValidationError / consistencyValidationError를 그대로
 * 통과한다 — 그래서 이 설계가 기존 검증 로직을 건드리지 않는다.
 *
 * 호출 전에 모든 part가 제출되었는지 확인해야 한다. 누락된 part가 있으면
 * 그 part의 지적은 판정 없이 빠진다.
 */
export function synthesiseParts(
  plan: JudgePartPlan,
  submissions: PartSubmission[]
): SynthesisedJudgment {
  const byPart = [...submissions].sort((a, b) => a.part - b.part);
  const findingSubmissions = byPart.filter((s) => s.part < plan.findingParts.length);
  const coverage = plan.hasCoveragePart
    ? byPart.find((s) => s.part === plan.findingParts.length)
    : undefined;

  const judged = findingSubmissions.reduce((n, s) => n + s.findingJudgments.length, 0);
  const findingScore = judged
    ? findingSubmissions.reduce((sum, s) => sum + s.score * s.findingJudgments.length, 0) / judged
    : 0;

  // 분할되지 않았으면 그 part가 5개 기준을 모두 채점했다. 가중치를 적용하면
  // coverage를 두 번 세는 셈이 되므로 점수를 그대로 쓴다.
  let score: number;
  if (!coverage) score = findingScore;
  else if (!judged) score = coverage.score;
  else score = findingScore * (1 - COVERAGE_WEIGHT) + coverage.score * COVERAGE_WEIGHT;

  const feedback = byPart
    .map((s) => `[part ${s.part + 1}] ${s.feedback}`)
    .join("\n\n")
    .slice(0, FEEDBACK_MAX_CHARS);

  return {
    score,
    feedback,
    // 부분만 본 part의 간극 신고는 신뢰할 수 없다. 분할되지 않았을 때만 그
    // part의 것을 쓰고, 분할되었으면 coverage part의 것만 쓴다.
    coverageGaps: coverage ? coverage.coverageGaps : (byPart[0]?.coverageGaps ?? []),
    findingJudgments: findingSubmissions
      .flatMap((s) => s.findingJudgments)
      .sort((a, b) => a.index - b.index),
  };
}
