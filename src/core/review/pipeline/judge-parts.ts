/**
 * 심사 작업을 예산에 맞는 part로 나누고, part별 제출을 하나의 판정으로 합성한다.
 *
 * 프롬프트 조립(judge-prompt.ts)이나 영속화(judge-store.ts)와 분리된 순수
 * 로직이다. 계획은 저장하지 않고 매번 재계산하므로, 같은 입력에 항상 같은
 * 계획이 나와야 한다 — 제출된 part가 담아야 할 인덱스 집합을 이 재계산으로
 * 검증하기 때문이다.
 */

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
