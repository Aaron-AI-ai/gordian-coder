# f-judge / f-fixer part 분할 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 심사(f-judge)와 수정(f-fixer) 단계가 컨텍스트 예산을 넘길 때 증거를 잘라내거나 실패하는 대신, 작업을 여러 part로 나눠 part마다 새 서브에이전트로 순차 처리한다.

**Architecture:** part 계획은 디스크에 저장하지 않고 매번 결정론적으로 재계산한다(프롬프트를 실제로 조립해 크기를 재는 greedy 채우기). judge의 part 제출은 `FileJudgment.pendingParts`에 쌓였다가 전부 모이면 하나의 `JudgeAttempt`로 합성되어 기존 `attempts`에 들어간다 — 덕분에 기존 검증·rework 카운트·아티팩트 바인딩 로직을 수정하지 않는다. fixer는 점수 합성이 없어 part 컨텍스트와 제출 병합만 추가한다.

**Tech Stack:** TypeScript (strict), Bun, Zod, `bun test`

**Spec:** `docs/superpowers/specs/2026-09-09-judge-fixer-part-splitting-design.md`

## Global Constraints

- TypeScript strict mode. 공개 API는 추론 대신 명시적 타입.
- 외부 상태(디스크 아티팩트)는 Zod로 런타임 검증한다. 형태가 깨진 파일은 크래시가 아니라 "판정 없음"으로 degrade한다.
- 판정(pass/rework)은 점수와 threshold에서 도출한다. 모델이 보낸 값을 신뢰하지 않는다.
- TDD 필수. 테스트를 먼저 쓰고 실패를 확인한 뒤 구현한다.
- 분할 단위의 이름은 **`part`**. `batch`는 `RUN_BATCH_SIZE`(한 번에 스폰할 서브에이전트 수)로 이미 오케스트레이터 프롬프트에서 쓰이므로 재사용하지 않는다.
- 예산 상수는 기존 값을 그대로 쓴다: `JUDGE_CONTEXT_MAX_BYTES = 45_000`, `FIX_CONTEXT_MAX_BYTES = 45_000`, `FIX_MAX_ITEMS = 60`.
- 커밋 메시지에 `Co-Authored-By: Claude` 줄을 넣지 않는다.
- 각 태스크 끝에서 `bun test`와 `bun run typecheck`가 모두 통과해야 한다.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/core/review/pipeline/judge-parts.ts` | **신규.** judge part 계획 계산과 part 제출 합성. 순수 함수만 — 디스크 I/O 없음 | 생성 |
| `src/core/review/pipeline/judge-prompt.ts` | 프롬프트 조립. part 범위 프롬프트와 coverage part 프롬프트 추가 | 수정 |
| `src/core/review/pipeline/judge-store.ts` | 판정 레코드 스키마와 영속화. `pendingParts` 추가 | 수정 |
| `src/core/review/pipeline/judge.ts` | 툴 진입점. part 인자 처리, part 기록, 합성 트리거, 안내 메시지 | 수정 |
| `src/core/review/pipeline/fixer.ts` | fix part 계획, part 컨텍스트, 제출 병합 | 수정 |
| `src/core/review/pipeline/run.ts` | finalize 안내 문구, 팬아웃 지시문 | 수정 |
| `src/adapters/opencode/review/index.ts` | 툴 파라미터 `part` 추가 | 수정 |

`judge-parts.ts`를 새로 만드는 이유: `judge-prompt.ts`는 이미 355줄이고 프롬프트 조립이라는 하나의 책임을 갖고 있다. 계획 계산과 점수 합성은 프롬프트와 다른 관심사이며 LLM 호출과 무관한 순수 로직이라 단독 테스트가 쉽다. 이는 `src/core/review/review` 디렉터리의 기존 분류 기준(LLM과의 관계로 나눈다)과도 맞는다.

---

## Task 1: part 계획 계산기

judge part 계획을 계산하는 순수 함수. 아직 아무도 호출하지 않는다 — 다음 태스크들이 쓴다.

**Files:**
- Create: `src/core/review/pipeline/judge-parts.ts`
- Create: `src/core/review/pipeline/__tests__/judge-parts.test.ts`

**Interfaces:**
- Consumes: `Finding` (`../contract`)
- Produces:
  - `export interface JudgePartPlan { findingParts: number[][]; hasCoveragePart: boolean }`
  - `export function planJudgeParts(findingCount: number, measure: (indices: number[]) => number, budget: number): JudgePartPlan`

`measure`를 주입받는 이유: 실제 프롬프트 조립은 `judge-prompt.ts`가 하고 디스크를 읽지만, 계획 로직 자체는 "인덱스 집합 → 바이트 수" 함수만 있으면 된다. 테스트에서 가짜 `measure`를 넘겨 경계 조건을 정확히 만들 수 있다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/judge-parts.test.ts`:

```typescript
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
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge-parts.test.ts`
Expected: FAIL — `Cannot find module '../judge-parts'`

- [ ] **Step 3: 최소 구현을 작성한다**

`src/core/review/pipeline/judge-parts.ts`:

```typescript
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
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge-parts.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 타입 검사**

Run: `bun run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge-parts.ts src/core/review/pipeline/__tests__/judge-parts.test.ts
git commit -m "Add the judge part planner"
```

---

## Task 2: part 제출 합성

part별 제출을 하나의 `JudgeAttempt` 본문으로 합치는 순수 함수. Task 1과 같은 파일에 넣는다 — 계획과 합성은 같은 관심사(part 분할의 산술)이고 함께 바뀐다.

**Files:**
- Modify: `src/core/review/pipeline/judge-parts.ts`
- Modify: `src/core/review/pipeline/__tests__/judge-parts.test.ts`

**Interfaces:**
- Consumes: `planJudgeParts` (Task 1), `FindingJudgment` (`./judge-store`)
- Produces:
  - `export interface PartSubmission { part: number; score: number; feedback: string; coverageGaps: string[]; findingJudgments: FindingJudgment[] }`
  - `export interface SynthesisedJudgment { score: number; feedback: string; coverageGaps: string[]; findingJudgments: FindingJudgment[] }`
  - `export function synthesiseParts(plan: JudgePartPlan, submissions: PartSubmission[]): SynthesisedJudgment`

**가중치:** 지적 part 점수는 건수 가중평균으로 묶고 80%, coverage part 점수가 20%. coverage part만 있으면(지적 0건) 그 점수가 최종 점수다. 분할되지 않았으면(part 1개, coverage part 없음) 그 part 점수가 그대로 최종 점수다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/judge-parts.test.ts` 끝에 추가:

```typescript
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
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge-parts.test.ts`
Expected: FAIL — `synthesiseParts is not a function`

- [ ] **Step 3: 최소 구현을 작성한다**

`src/core/review/pipeline/judge-parts.ts`의 **최상단 import 자리**에 다음을 추가한다:

```typescript
import type { FindingJudgment } from "./judge-store";
```

그리고 파일 끝에 다음을 추가한다:

```typescript

/** coverage part 점수가 최종 점수에서 차지하는 비중 (JUDGE_CRITERIA 5번 = 20%). */
const COVERAGE_WEIGHT = 0.2;

/** 합성된 feedback의 길이 상한. JudgeSubmitSchema의 capped(4000)과 같다. */
const FEEDBACK_MAX_CHARS = 4_000;

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
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge-parts.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: 타입 검사**

Run: `bun run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge-parts.ts src/core/review/pipeline/__tests__/judge-parts.test.ts
git commit -m "Synthesise part submissions into one judgment body"
```

---

## Task 3: pendingParts 저장 스키마

part 제출을 담을 자리를 `FileJudgment`에 추가한다. 아직 아무도 쓰지 않는다.

**Files:**
- Modify: `src/core/review/pipeline/judge-store.ts:102-109` (`FileJudgmentSchema`)
- Modify: `src/core/review/pipeline/__tests__/judge.test.ts`

**Interfaces:**
- Consumes: `FindingJudgmentSchema` (기존)
- Produces:
  - `export const JudgePartSubmissionSchema` / `export type JudgePartSubmission`
  - `FileJudgment.pendingParts: JudgePartSubmission[]`
  - `export function currentPendingParts(judgment: FileJudgment, review: PersistedFileReviewResult): JudgePartSubmission[]`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/judge.test.ts` 끝에 추가:

```typescript
describe("pendingParts", () => {
  it("pendingParts가 없는 기존 판정 파일도 그대로 읽힌다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
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
    const meta = await createRun(runMeta(), d);
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
```

`judge.test.ts` 상단 import에 `artifactIdentity`, `currentPendingParts`를 추가한다:

```typescript
import { artifactIdentity, currentPendingParts, loadJudgment, readRunJudgments } from "../judge-store";
```

(기존 `import { loadJudgment, readRunJudgments } from "../judge-store";` 줄을 위 줄로 교체한다.)

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts -t pendingParts`
Expected: FAIL — `currentPendingParts` export 없음

- [ ] **Step 3: 최소 구현을 작성한다**

`src/core/review/pipeline/judge-store.ts`의 `JudgeTerminalSchema` 정의 다음, `FileJudgmentSchema` 앞에 추가:

```typescript
/**
 * 한 part의 심사 제출. 모든 part가 모이면 하나의 JudgeAttempt로 합성되어
 * `attempts`로 옮겨가므로, 여기 남아있는 항목은 아직 미완인 심사를 뜻한다.
 *
 * attempt와 같은 방식으로 리뷰 아티팩트에 바인딩된다. 재리뷰로 새 revision이
 * 나오면 해시가 어긋나 자동으로 무효가 된다.
 */
export const JudgePartSubmissionSchema = z.object({
  reviewRevision: z.number().int().positive(),
  reviewArtifactHash: z.string(),
  /** 0..findingParts.length-1 은 지적 part, 그 다음 번호가 coverage part. */
  part: z.number().int().nonnegative(),
  score: z.number().min(0).max(100),
  feedback: z.string(),
  coverageGaps: z.array(z.string()),
  findingJudgments: z.array(FindingJudgmentSchema),
  at: z.string(),
});

export type JudgePartSubmission = z.infer<typeof JudgePartSubmissionSchema>;
```

`FileJudgmentSchema`를 다음으로 교체한다:

```typescript
export const FileJudgmentSchema = z.object({
  file: z.string(),
  attempts: z.array(JudgeAttemptSchema),
  invalidSubmissions: z.array(InvalidJudgeSubmissionSchema).default([]),
  /** 아직 전부 모이지 않은 part 제출. 합성되면 비워진다. */
  pendingParts: z.array(JudgePartSubmissionSchema).default([]),
  terminal: JudgeTerminalSchema.optional(),
});
```

`loadJudgment`의 마지막 return을 교체한다 (`judge-store.ts:306`):

```typescript
  return { file, attempts: [], invalidSubmissions: [], pendingParts: [] };
```

파일 끝에 추가:

```typescript
/** 현재 리뷰 아티팩트에 속한 part 제출만. 다른 revision에 남은 것은 버린다. */
export function currentPendingParts(
  judgment: FileJudgment,
  review: PersistedFileReviewResult
): JudgePartSubmission[] {
  const hash = artifactIdentity(review);
  return judgment.pendingParts.filter(
    (submission) =>
      submission.reviewRevision === review.revision && submission.reviewArtifactHash === hash
  );
}
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts`
Expected: PASS — 새 테스트 2개를 포함해 기존 judge 테스트가 모두 통과

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과. `pendingParts`에 `.default([])`가 있어 기존 판정 파일도 그대로 읽힌다.

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge-store.ts src/core/review/pipeline/__tests__/judge.test.ts
git commit -m "Hold part submissions until the judgment is complete"
```

---

## Task 4: part 범위 judge 프롬프트

지정된 지적 인덱스만 담은 프롬프트와, coverage 전용 프롬프트를 만든다.

**Files:**
- Modify: `src/core/review/pipeline/judge-prompt.ts`
- Modify: `src/core/review/pipeline/__tests__/judge.test.ts`

**Interfaces:**
- Consumes: `buildJudgePrompt` (기존), `planJudgeParts` (Task 1)
- Produces:
  - `export function judgePartPlanFor(meta: RunMeta, result: PersistedFileReviewResult, judgment: FileJudgment, cwd: string): JudgePartPlan`
  - `export function buildPartPrompt(meta, result, judgment, cwd, part: number, plan: JudgePartPlan): string | JudgeContextOverflow`

`buildJudgePrompt`는 시그니처를 바꾸지 않는다. 대신 인덱스 부분집합을 받는 내부 오버로드를 추가한다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/judge.test.ts` 끝에 추가:

```typescript
describe("judge part 프롬프트", () => {
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

  /** 3000줄짜리 파일을 가진 whole-file 런. */
  async function bigRun() {
    const d = gitRepo();
    writeFileSync(
      join(d, "big.ts"),
      Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // 설명 주석`).join("\n") + "\n"
    );
    const meta = await createRun(runMeta({ targets: ["big.ts"], whole: true, range: null }), d);
    return { d, meta };
  }

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

  it("part 하나로 끝나면 기존 프롬프트와 동일하다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
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
});
```

`judge.test.ts` 상단 import에 다음을 추가한다:

```typescript
import { JUDGE_CONTEXT_MAX_BYTES, JUDGE_CRITERIA, buildJudgePrompt, buildPartPrompt, judgePartPlanFor } from "../judge-prompt";
```

(기존 `import { JUDGE_CONTEXT_MAX_BYTES, JUDGE_CRITERIA } from "../judge-prompt";` 줄을 위 줄로 교체한다.)

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts -t "judge part 프롬프트"`
Expected: FAIL — `judgePartPlanFor` export 없음

- [ ] **Step 3: 최소 구현을 작성한다**

`judge-prompt.ts`의 `buildJudgePrompt`를 인덱스 부분집합을 받도록 확장한다. 기존 시그니처는 그대로 두고 네 번째 인자 뒤에 선택 인자를 붙인다:

```typescript
export function buildJudgePrompt(
  meta: RunMeta,
  result: PersistedFileReviewResult,
  judgment: FileJudgment,
  cwd: string,
  indices?: number[],
  partLabel?: string
): string | JudgeContextOverflow {
  const scoped = indices ? indices.map((i) => result.findings[i]!) : result.findings;
  const findingsJson = JSON.stringify(scoped, null, 2);
  if (byteLen(findingsJson) > JUDGE_FINDINGS_MAX_BYTES) {
    return contextOverflow(
      `${scoped.length} serialized finding(s) exceed ${JUDGE_FINDINGS_MAX_BYTES} bytes`
    );
  }

  const excerpt = changeExcerpt(meta, result.file, cwd, scoped);
  if (isContextOverflow(excerpt)) return excerpt;
  // ...이하 기존 본문과 동일하되, 아래 두 곳만 바꾼다
```

기존 본문에서 `result.findings`를 쓰던 곳(`changeExcerpt` 호출과 `findingsJson`)은 위에서 `scoped`로 바뀌었다. 프롬프트 첫 줄과 제출 지시문을 part 인지형으로 바꾼다:

```typescript
    `You are judging the review of ${result.file} (run ${meta.runId}, judge round ${round})` +
      (partLabel ? ` — ${partLabel}.` : `.`),
```

그리고 제출 지시문의 마지막 줄을 다음으로 교체한다:

```typescript
    partLabel
      ? `Judge every finding by its index AS NUMBERED ABOVE, then call f_review_judge with`
      : `Judge every finding by its index, list coverage gaps, then call f_review_judge`,
```

**중요:** part 프롬프트의 지적 인덱스는 **원본 리뷰의 인덱스**를 유지해야 한다. 부분집합을 그대로 `JSON.stringify`하면 배열 위치가 0부터 다시 시작해 심사관이 잘못된 인덱스를 보낸다. `scoped` 계산을 다음으로 바꾼다:

```typescript
  const scopedEntries = (indices ?? result.findings.map((_, i) => i)).map((i) => ({
    index: i,
    ...result.findings[i]!,
  }));
  const scoped = scopedEntries.map(({ index: _drop, ...finding }) => finding);
  const findingsJson = JSON.stringify(scopedEntries, null, 2);
```

`changeExcerpt`에는 `scoped`(index 필드 없는 원본 형태)를 넘기고, 프롬프트에 실리는 JSON은 `scopedEntries`(각 항목에 `index` 명시)를 쓴다.

파일 끝에 part 계획과 part 프롬프트를 추가한다:

```typescript
import { planJudgeParts, type JudgePartPlan } from "./judge-parts";

/** 지적 요약 한 줄의 최대 길이. coverage part는 줄번호와 rule만 필요하다. */
const COVERAGE_SUMMARY_MAX_CHARS = 120;

/**
 * 이 리뷰의 part 계획. 프롬프트를 실제로 조립해 크기를 재므로 결정론적이며,
 * 제출 검증 때 그대로 다시 계산해 인덱스 집합을 대조한다.
 */
export function judgePartPlanFor(
  meta: RunMeta,
  result: PersistedFileReviewResult,
  judgment: FileJudgment,
  cwd: string
): JudgePartPlan {
  const measure = (indices: number[]): number => {
    const prompt = buildJudgePrompt(meta, result, judgment, cwd, indices, "part x/y");
    // 조립 자체가 실패하면 예산을 넘긴 것으로 보고 계획이 더 쪼개게 한다.
    return isContextOverflow(prompt) ? Number.MAX_SAFE_INTEGER : byteLen(prompt);
  };
  return planJudgeParts(result.findings.length, measure, JUDGE_CONTEXT_MAX_BYTES);
}

/** 한 part의 프롬프트. `part === plan.findingParts.length` 이면 coverage 전용. */
export function buildPartPrompt(
  meta: RunMeta,
  result: PersistedFileReviewResult,
  judgment: FileJudgment,
  cwd: string,
  part: number,
  plan: JudgePartPlan
): string | JudgeContextOverflow {
  const total = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
  if (part < 0 || part >= total) {
    return contextOverflow(`part ${part} does not exist (this review has ${total} part(s))`);
  }
  // 분할되지 않은 리뷰는 지금까지와 완전히 같은 프롬프트를 받는다.
  if (total === 1) return buildJudgePrompt(meta, result, judgment, cwd);
  if (part < plan.findingParts.length) {
    return buildJudgePrompt(
      meta,
      result,
      judgment,
      cwd,
      plan.findingParts[part],
      `part ${part + 1}/${total} — judge ONLY the findings listed below, by the index each carries. ` +
        `Criteria 1-4 only; another part scores coverage, so do NOT report coverage gaps here`
    );
  }
  return coveragePrompt(meta, result, cwd, part, total);
}

/**
 * coverage 전용 part: 파일 구조와 전체 지적 요약만 보여주고 기준 5번을 묻는다.
 * 지적 본문(message/asIs/toBe)은 싣지 않는다 — 여기서 판단할 것은 개별 지적의
 * 타당성이 아니라 리뷰가 훑지 않은 영역이다.
 */
function coveragePrompt(
  meta: RunMeta,
  result: PersistedFileReviewResult,
  cwd: string,
  part: number,
  total: number
): string | JudgeContextOverflow {
  const ref = afterRef(meta.range);
  const content = readFileAt(cwd, ref, result.file);
  if (content === null) {
    return contextOverflow(`source unavailable for the coverage part of ${result.file}`);
  }
  const totalLines = content.replace(/\n$/, "").split("\n").length;
  const summary = result.findings.length
    ? result.findings.map(
        (finding, index) =>
          `  ${index}. L${finding.line ?? "?"} [${finding.severity}] ${finding.rule}`.slice(
            0,
            COVERAGE_SUMMARY_MAX_CHARS
          )
      )
    : ["  (지적 없음 — 리뷰는 이 파일에서 아무 문제도 보고하지 않았다)"];

  const outline = renderFileContent(
    result.file,
    content,
    1,
    totalLines,
    JUDGE_FILE_MAX_LINES,
    JUDGE_CHANGE_MAX_BYTES
  );
  const threshold = meta.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  const prompt = [
    `You are judging the review of ${result.file} (run ${meta.runId}) — part ${part + 1}/${total}: COVERAGE ONLY.`,
    `Score threshold: ${threshold}.`,
    ``,
    `Other parts have already scored the individual findings. Your ONLY job is`,
    `criterion 5:`,
    `Coverage — was every significant part of this change actually examined?`,
    ``,
    `Score 0-100 for coverage alone, and list every unexamined significant area`,
    `in coverageGaps. Do NOT re-judge the findings themselves.`,
    ``,
    authoritativeRules(result.file, cwd),
    `### The file under review (${totalLines} lines)`,
    outline,
    ``,
    `### What the review reported (index, line, severity, rule)`,
    ...summary,
    ``,
    `Call f_review_judge with runId="${meta.runId}", file="${result.file}", part=${part},`,
    `findingJudgments=[] (this part judges no findings), your coverageGaps, your`,
    `coverage score, and feedback naming what a next reviewer must examine.`,
  ].join("\n");
  return byteLen(prompt) <= JUDGE_CONTEXT_MAX_BYTES
    ? prompt
    : contextOverflow(`the assembled coverage prompt is ${byteLen(prompt)} bytes`);
}
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts`
Expected: PASS — 새 테스트 5개 포함, 기존 judge 테스트 전부 통과

`"part 하나로 끝나면 기존 프롬프트와 동일하다"`가 실패하면 `buildJudgePrompt`의 `indices` 기본 경로가 `scopedEntries` 도입으로 달라진 것이다. 기존 프롬프트도 이제 각 지적에 `index` 필드를 갖게 되므로, 기존 스냅샷성 테스트(`"returns criteria, the change, the findings, and the threshold"`)가 함께 깨질 수 있다. 그 경우 기존 테스트의 기대값에 `index` 필드를 반영해 고친다 — 심사관에게 인덱스를 명시하는 것은 의도된 개선이다.

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge-prompt.ts src/core/review/pipeline/__tests__/judge.test.ts
git commit -m "Build judge prompts scoped to one part"
```

---

## Task 5: part 인지형 judgeContext

`judgeContext`가 part 인자를 받고, 다음에 처리할 part를 안내한다.

**Files:**
- Modify: `src/core/review/pipeline/judge.ts:75-122` (`judgeContext`)
- Modify: `src/core/review/pipeline/__tests__/judge.test.ts`

**Interfaces:**
- Consumes: `judgePartPlanFor`, `buildPartPrompt` (Task 4), `currentPendingParts` (Task 3)
- Produces: `export function judgeContext(runId: string, file: string, cwd: string, part?: number): string`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`judge.test.ts` 끝에 추가:

```typescript
describe("judgeContext의 part 처리", () => {
  it("분할되지 않은 리뷰는 part 인자 없이 지금처럼 동작한다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const out = judgeContext(meta.runId, "a.ts", d);
    expect(out).toContain(JUDGE_CRITERIA.split("\n")[0]!);
    expect(out).not.toContain("part 1/");
  });

  it("존재하지 않는 part 번호를 거부한다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    expect(judgeContext(meta.runId, "a.ts", d, 5)).toContain("does not exist");
  });

  it("이미 제출된 part를 다시 요청하면 다음 part를 알려준다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
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
    ];
    persistJudgmentSync(meta.runId, "a.ts", d, judgment);
    const out = judgeContext(meta.runId, "a.ts", d, 0);
    expect(out).toContain("already submitted");
  });
});
```

`judge.test.ts` import에 `persistJudgmentSync`를 추가한다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts -t "judgeContext의 part"`
Expected: FAIL — `judgeContext`가 네 번째 인자를 받지 않음

- [ ] **Step 3: 최소 구현을 작성한다**

`judge.ts`의 `judgeContext`에서 프롬프트를 만드는 부분(`const prompt = buildJudgePrompt(...)` 부터 함수 끝까지)을 다음으로 교체한다:

```typescript
  const plan = judgePartPlanFor(meta, result, judgment, cwd);
  const total = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
  const requested = part ?? 0;
  if (requested < 0 || requested >= total) {
    return `❌ part ${requested} does not exist for ${file} — this review has ${total} part(s) (0..${total - 1}).`;
  }

  const submitted = currentPendingParts(judgment, result).map((p) => p.part);
  if (submitted.includes(requested)) {
    const next = Array.from({ length: total }, (_, i) => i).find((i) => !submitted.includes(i));
    return next === undefined
      ? `ℹ️ Every part of ${file} was already submitted; the verdict is being assembled. Do NOT judge it again.`
      : `ℹ️ part ${requested} of ${file} was already submitted. Spawn a NEW f-judge for part ${next}: call f_review_judge_context with runId="${runId}", file="${file}", part=${next}.`;
  }

  const prompt = buildPartPrompt(meta, result, judgment, cwd, requested, plan);
  if (!isContextOverflow(prompt)) {
    return total === 1
      ? prompt
      : `${prompt}\n\nThis file is judged in ${total} parts; submit with part=${requested}.`;
  }

  // Context creation itself is the terminal decision: asking a small judge to
  // retry cannot make an oversized immutable artifact smaller. Persist it now
  // so repeated context calls, direct submit attempts, and finalize all agree.
  const terminal = contextOverflowTerminal(result, prompt.reason);
  persistJudgmentSync(runId, file, cwd, { ...judgment, terminal });
  return overflowContext(file, result.revision, terminal.reason);
}
```

함수 시그니처를 바꾼다:

```typescript
export function judgeContext(runId: string, file: string, cwd: string, part?: number): string {
```

import에 다음을 추가한다:

```typescript
import { buildJudgePrompt, buildPartPrompt, contextOverflowTerminal, isContextOverflow, judgePartPlanFor, overflowContext } from "./judge-prompt";
```

`currentPendingParts`를 `./judge-store` import에 추가한다.

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts`
Expected: PASS

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge.ts src/core/review/pipeline/__tests__/judge.test.ts
git commit -m "Serve one judge part at a time"
```

---

## Task 6: part 제출과 합성

`submitJudge`가 part 제출을 받아 쌓고, 전부 모이면 합성해 기존 attempt 경로에 태운다.

**Files:**
- Modify: `src/core/review/pipeline/judge-store.ts` (`JudgeSubmitSchema`에 `part` 추가)
- Modify: `src/core/review/pipeline/judge.ts` (`submitJudgeSerialized`)
- Modify: `src/core/review/pipeline/__tests__/judge.test.ts`

**Interfaces:**
- Consumes: `synthesiseParts` (Task 2), `judgePartPlanFor` (Task 4), `currentPendingParts` (Task 3)
- Produces: `JudgeSubmitPayload.part?: number`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`judge.test.ts` 끝에 추가:

```typescript
describe("part 제출", () => {
  /** 30건짜리 리뷰를 만들고 part 계획을 돌려준다. */
  async function splitRun() {
    const d = gitRepo();
    writeFileSync(
      join(d, "big.ts"),
      Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // 설명 주석`).join("\n") + "\n"
    );
    const meta = await createRun(runMeta({ targets: ["big.ts"], whole: true, range: null }), d);
    const findings = Array.from({ length: 30 }, (_, i) => ({
      category: "correctness" as const,
      severity: "major" as const,
      file: "big.ts",
      line: 1 + i * 120,
      rule: `r${i}`,
      message: "이슈 ".repeat(200),
      asIs: "코드 ".repeat(300),
      toBe: "고친 코드 ".repeat(300),
    }));
    await writeFileReview(
      meta.runId,
      { file: "big.ts", assessed: [...REQUIRED_CATEGORIES], findings, explorationCalls: 2, partial: false },
      "md",
      d
    );
    const review = readFileReviewResult(meta.runId, "big.ts", d)!;
    const plan = judgePartPlanFor(loadRun(meta.runId, d)!, review, loadJudgment(meta.runId, "big.ts", d), d);
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

  it("분할되지 않은 리뷰는 part 없이 지금처럼 제출된다", async () => {
    const d = gitRepo();
    const meta = await createRun(runMeta(), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const out = await submitJudge(judgePayload(meta.runId, 90), d);
    expect(out).toContain("Judge PASS");
    expect(loadJudgment(meta.runId, "a.ts", d).attempts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts -t "part 제출"`
Expected: FAIL — `part` 필드가 스키마에 없어 무시되고, 첫 제출이 곧바로 attempt가 된다

- [ ] **Step 3: 최소 구현을 작성한다**

`judge-store.ts`의 `JudgeSubmitSchema`에 `part`를 추가한다:

```typescript
export const JudgeSubmitSchema = z.object({
  runId: z.string(),
  file: z.string(),
  /** 분할 심사에서 이 제출이 담당한 part. 분할되지 않은 리뷰는 생략한다. */
  part: z.number().int().nonnegative().optional(),
  findingJudgments: z.array(FindingJudgmentSchema),
  coverageGaps: z.array(capped(500)).transform((a) => a.slice(0, 20)),
  score: z.number().min(0).max(100),
  feedback: capped(4000),
});
```

`judge.ts`의 `submitJudgeSerialized`에서, 기존 검증 블록(`const invalidIndices = ...` 부터 `attempt` 생성 직전까지)을 다음으로 교체한다:

```typescript
  const plan = judgePartPlanFor(meta, review, judgment, cwd);
  const totalParts = plan.findingParts.length + (plan.hasCoveragePart ? 1 : 0);
  const part = parsed.data.part ?? 0;

  if (totalParts > 1) {
    if (part < 0 || part >= totalParts) {
      return recordInvalidSubmission(
        runId, file, review, payload,
        `part ${part} does not exist (this review has ${totalParts} parts)`, cwd
      );
    }
    // 그 part가 담아야 할 인덱스 집합과 정확히 일치해야 한다. 계획은
    // 결정론적이므로 저장하지 않고 여기서 다시 계산해 대조한다.
    const expected = part < plan.findingParts.length ? plan.findingParts[part]! : [];
    const received = parsed.data.findingJudgments.map((j) => j.index);
    const same =
      received.length === expected.length &&
      new Set(received).size === expected.length &&
      expected.every((index) => received.includes(index));
    if (!same) {
      return recordInvalidSubmission(
        runId, file, review, payload,
        `part ${part} must judge exactly indices [${expected.join(", ")}] (received [${received.join(", ")}])`,
        cwd
      );
    }
    if (currentPendingParts(judgment, review).some((p) => p.part === part)) {
      return `ℹ️ part ${part} of ${file} was already submitted; no new record was made.`;
    }

    judgment.pendingParts = [
      ...currentPendingParts(judgment, review),
      {
        reviewRevision: review.revision,
        reviewArtifactHash: artifactIdentity(review),
        part,
        score: parsed.data.score,
        feedback: parsed.data.feedback,
        coverageGaps: parsed.data.coverageGaps,
        findingJudgments: parsed.data.findingJudgments,
        at: new Date().toISOString(),
      },
    ];

    const submitted = judgment.pendingParts.map((p) => p.part);
    const next = Array.from({ length: totalParts }, (_, i) => i).find(
      (i) => !submitted.includes(i)
    );
    if (next !== undefined) {
      await persistJudgment(runId, file, cwd, judgment);
      return [
        `📝 part ${part + 1}/${totalParts} recorded for ${file} (score ${parsed.data.score}).`,
        `Spawn a NEW f-judge subagent (fresh session) with this prompt:`,
        `  "Call f_review_judge_context with runId=\"${runId}\", file=\"${file}\", part=${next}, evaluate that part, then call f_review_judge with part=${next}."`,
      ].join("\n");
    }
    // 전 part가 모였다 — 하나의 판정으로 합성해 기존 경로에 태운다.
    const merged = synthesiseParts(plan, judgment.pendingParts);
    judgment.pendingParts = [];
    parsed.data.score = merged.score;
    parsed.data.feedback = merged.feedback;
    parsed.data.coverageGaps = merged.coverageGaps;
    parsed.data.findingJudgments = merged.findingJudgments;
  }

  const invalidIndices = indexValidationError(review.findings, parsed.data.findingJudgments);
  if (invalidIndices) {
    return recordInvalidSubmission(runId, file, review, payload, invalidIndices, cwd);
  }
  const inconsistent = consistencyValidationError(parsed.data, review.findings, threshold);
  if (inconsistent) {
    return recordInvalidSubmission(runId, file, review, payload, inconsistent, cwd);
  }
```

import에 `synthesiseParts`(`./judge-parts`)와 `currentPendingParts`(`./judge-store`)를 추가한다.

**주의:** 기존 코드에서 `buildJudgePrompt` 오버플로 재검사가 이 블록보다 앞에 있다. 그 호출을 `buildPartPrompt(meta, review, judgment, cwd, part, plan)`로 바꿔야 part별 예산으로 검사한다. 다만 `plan`이 그 시점 이후에 계산되므로, `plan`/`totalParts`/`part` 계산을 오버플로 재검사보다 **앞으로** 옮긴다.

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts`
Expected: PASS — 새 테스트 6개 포함, 기존 judge 테스트 전부 통과

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/judge-store.ts src/core/review/pipeline/judge.ts src/core/review/pipeline/__tests__/judge.test.ts
git commit -m "Record judge parts and synthesise the verdict when complete"
```

---

## Task 7: fixer part 컨텍스트와 제출 병합

fixer는 점수 합성이 없어 단순하다. 다만 **제출 병합이 part 분할의 전제 조건**이므로 먼저 바꾼다.

**Files:**
- Modify: `src/core/review/pipeline/fixer.ts` (`fixContext`, `submitFix`)
- Modify: `src/core/review/pipeline/__tests__/fixer.test.ts`

**Interfaces:**
- Consumes: `planJudgeParts` (Task 1 — 같은 greedy 로직을 재사용한다)
- Produces:
  - `export function fixPartPlan(runId: string, file: string, cwd: string): number[][]`
  - `export function fixContext(runId: string, file: string, cwd: string, part?: number): string`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/fixer.test.ts` 끝에 추가:

```typescript
describe("fixer part 분할", () => {
  /** n건의 위반과 1400줄 소스를 가진 런. */
  async function bigFixRun(n: number) {
    const d = repo();
    writeFileSync(
      join(d, "src/Big.java"),
      Array.from({ length: 1400 }, (_, i) => `  int f${i}() { return ${i}; } // 설명 주석`).join("\n") + "\n"
    );
    const meta = await createRun(
      {
        targets: ["src/Big.java"],
        range: null,
        whole: true,
        label: "L",
        language: "ko",
        fcqFix: true,
        fcq: { status: "ok", durationMs: 1, partial: false },
      } as never,
      d
    );
    const rows: FcqFileViolation[] = Array.from({ length: n }, (_, i) => ({
      ...VIOLATION,
      ruleId: `Rule${i}`,
      line: 1 + i * 20,
      description: "설명 ".repeat(40),
      message: "메시지 ".repeat(40),
      snippet: ["코드 한 줄 ".repeat(10), "코드 두 줄 ".repeat(10)],
    }));
    mkdirSync(join(runDir(meta.runId, d), "fcq", "files"), { recursive: true });
    writeFcqShard(runDir(meta.runId, d), "src/Big.java", rows);
    return { d, runId: meta.runId };
  }

  it("위반이 60건이어도 소스를 한 줄도 못 보는 일이 없다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    for (let part = 0; part < plan.length; part++) {
      const ctx = fixContext(runId, "src/Big.java", d, part);
      expect(ctx).not.toContain("ranges below: none");
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(FIX_CONTEXT_MAX_BYTES);
    }
  });

  it("모든 위반이 정확히 한 part에 배정된다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    expect(plan.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("위반이 적으면 part 하나로 끝나고 기존 컨텍스트와 같다", async () => {
    const { d, runId } = await bigFixRun(3);
    expect(fixPartPlan(runId, "src/Big.java", d)).toHaveLength(1);
    expect(fixContext(runId, "src/Big.java", d)).toBe(fixContext(runId, "src/Big.java", d, 0));
  });

  it("두 번째 part 제출이 첫 part의 fix를 지우지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    await submitFix(
      { runId, file: "src/Big.java", fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "b" }] },
      d
    );
    await submitFix(
      { runId, file: "src/Big.java", fixes: [{ line: 21, ruleId: "Rule1", asIs: "c", toBe: "d" }] },
      d
    );
    const fixes = loadFixes(runId, "src/Big.java", d).fixes;
    expect(fixes.map((f) => f.ruleId).sort()).toEqual(["Rule0", "Rule1"]);
  });

  it("같은 앵커를 다시 제출하면 덮어쓴다", async () => {
    const { d, runId } = await bigFixRun(60);
    await submitFix(
      { runId, file: "src/Big.java", fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "처음" }] },
      d
    );
    await submitFix(
      { runId, file: "src/Big.java", fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "나중" }] },
      d
    );
    const fixes = loadFixes(runId, "src/Big.java", d).fixes;
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.toBe).toBe("나중");
  });
});
```

`fixer.test.ts` import에 `fixPartPlan`을 추가한다.

샤드 쓰기는 이 파일의 기존 `run()` 헬퍼(`fixer.test.ts:45-67`)가 하는 것과 같은
방식이다 — `fcqShardPath`는 이미 `fcq.ts:168`에서 export되어 있다. 위 테스트의
`writeFcqShard`는 다음으로 정의한다:

```typescript
import { fcqShardPath } from "../../evidence/fcq";

function writeFcqShard(runRoot: string, file: string, rows: FcqFileViolation[]): void {
  mkdirSync(join(runRoot, "fcq", "files"), { recursive: true });
  writeFileSync(fcqShardPath(runRoot, file), JSON.stringify(rows));
}
```

`createRun`에 넘기는 `as never` 캐스팅은 이 테스트 파일의 기존 관행을 따른 것이다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/fixer.test.ts -t "fixer part"`
Expected: FAIL — `fixPartPlan` export 없음, 그리고 병합 테스트는 덮어쓰기 때문에 실패

- [ ] **Step 3: 최소 구현을 작성한다**

`fixer.ts`의 `fixContext`를 part 인지형으로 바꾼다. 현재 `const shown = rows.slice(0, FIX_MAX_ITEMS);` 줄을 다음으로 교체한다:

```typescript
  const capped = rows.slice(0, FIX_MAX_ITEMS);
  const plan = planFixParts(cwd, file, capped);
  const requested = part ?? 0;
  if (requested < 0 || requested >= plan.length) {
    return `❌ part ${requested} does not exist for ${file} — this fix pass has ${plan.length} part(s) (0..${plan.length - 1}).`;
  }
  const shown = plan[requested]!.map((index) => capped[index]!);
```

시그니처를 바꾼다:

```typescript
export function fixContext(runId: string, file: string, cwd: string, part?: number): string {
```

그리고 `head` 첫 문장을 part 인지형으로 바꾼다:

```typescript
    `${rows.length} static-analysis violation(s)` +
      (plan.length > 1
        ? `, part ${requested + 1}/${plan.length} — the ${shown.length} listed below are yours; other parts own the rest.`
        : rows.length > shown.length
          ? `, first ${shown.length} shown.`
          : "."),
```

`fixSource` 호출 뒤 반환 직전에, part가 여럿일 때 다음 part 안내를 붙인다:

```typescript
  const body = [...head, ...fixSource(cwd, file, shown, budget), ...tail].join("\n");
  return plan.length > 1
    ? `${body}\n\nThis file is fixed in ${plan.length} parts. After you submit, the orchestrator spawns a NEW f-fixer for the next part.`
    : body;
```

파일에 계획 함수를 추가한다:

```typescript
import { planJudgeParts } from "./judge-parts";

/**
 * 위반을 예산에 맞는 part로 나눈다. judge와 같은 greedy 채우기를 쓰되,
 * 측정 대상은 "위반 목록(head) + 그 위반들을 덮는 소스 윈도우"다.
 *
 * head를 예산 밖에 두던 기존 구조가 여기서 해소된다: 위반이 많으면 목록이
 * 예산을 다 먹고 소스 몫이 0이 되어, fixer가 코드를 한 줄도 못 본 채 빈 제출을
 * 하게 되어 있었다.
 */
function planFixParts(cwd: string, file: string, rows: FcqFileViolation[]): number[][] {
  const total = fileLineCount(cwd, null, file) ?? 0;
  const measure = (indices: number[]): number => {
    const picked = indices.map((index) => rows[index]!);
    const headBytes = byteLen(violationLines(picked).join("\n"));
    const sourceBytes = fixWindows(
      picked.map((v) => v.line ?? 0).filter((l) => l > 0),
      total
    ).reduce(
      (sum, [start, end]) => sum + byteLen(fileRead(cwd, null, file, start, end, end - start + 1)),
      0
    );
    return headBytes + sourceBytes;
  };
  // 헤더/지시문/tail이 차지하는 몫을 남긴다.
  const plan = planJudgeParts(rows.length, measure, FIX_CONTEXT_MAX_BYTES - 3_000);
  return plan.findingParts.length ? plan.findingParts : [[]];
}

/** 위반 한 건의 목록 표시. fixContext의 head와 planFixParts가 공유한다. */
function violationLines(rows: FcqFileViolation[]): string[] {
  return rows.map(
    (v) =>
      `- L${v.line ?? 0} [${v.severity}] ${v.analyzer}/${v.ruleId} — ${v.description}` +
      (v.message ? ` (${v.message})` : "") +
      (v.snippet?.length ? `\n  code:\n${v.snippet.map((l) => `    ${l}`).join("\n")}` : "")
  );
}

/** 이 파일의 fix part 계획. 오케스트레이터 안내와 테스트가 쓴다. */
export function fixPartPlan(runId: string, file: string, cwd: string): number[][] {
  const rows = readFcqFile(runDir(runId, cwd), file).slice(0, FIX_MAX_ITEMS);
  return planFixParts(cwd, file, rows);
}
```

`fixContext`의 `head` 안에서 위반을 렌더링하던 `...shown.map((v) => ...)` 부분을 `...violationLines(shown)`로 교체해 중복을 없앤다.

`submitFix`를 병합으로 바꾼다. `fixes`를 그대로 쓰던 부분을 다음으로 교체한다:

```typescript
  // part 분할에서 두 번째 제출이 첫 제출을 지우면 안 된다. 같은 앵커
  // (line + ruleId)는 나중 것으로 덮고, 새 앵커는 추가한다.
  const existing = loadFixes(runId, file, cwd).fixes;
  const merged = new Map(existing.map((f) => [fixKey(f.line, f.ruleId), f]));
  for (const fix of fixes) merged.set(fixKey(fix.line, fix.ruleId), fix);
  const nextFixes = [...merged.values()];
```

이후 영속화에서 `fixes` 대신 `nextFixes`를 쓴다.

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/fixer.test.ts`
Expected: PASS — 새 테스트 5개 포함, 기존 fixer 테스트 전부 통과

기존 테스트 중 "제출이 멱등이다"류가 덮어쓰기를 기대하고 있다면, 같은 앵커는 여전히 덮어써지므로 통과해야 한다. 서로 다른 앵커의 전체 교체를 기대하는 테스트가 있다면 병합이 의도된 변경이므로 그 테스트를 병합 기대로 고친다.

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/core/review/pipeline/fixer.ts src/core/review/pipeline/__tests__/fixer.test.ts src/core/review/evidence/fcq.ts
git commit -m "Split the fix pass into parts and merge their submissions"
```

---

## Task 8: 툴 파라미터와 오케스트레이터 지시문

플러그인 툴이 `part`를 받게 하고, 오케스트레이터가 part 흐름을 알도록 안내 문구를 고친다.

**Files:**
- Modify: `src/adapters/opencode/review/index.ts:169-181` (`f_review_judge_context`), `:182+` (`f_review_judge`), `:213-223` (`f_review_fix_context`)
- Modify: `src/core/review/pipeline/run.ts:245-266` (팬아웃 지시문), `:433` (finalize 문구)
- Modify: `src/core/review/pipeline/__tests__/run.test.ts`

**Interfaces:**
- Consumes: `judgeContext(runId, file, cwd, part?)` (Task 5), `fixContext(runId, file, cwd, part?)` (Task 7)
- Produces: 툴 스키마의 `part` 파라미터

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/core/review/pipeline/__tests__/run.test.ts` 끝에 추가:

```typescript
describe("part 안내 문구", () => {
  it("판정 게이트 지시문이 part 흐름을 설명한다", async () => {
    const d = gitRepo();
    const out = await planReview({ commit: "HEAD", judge: true }, d);
    expect(out).toContain("part");
    expect(out).toContain("f_review_judge_context");
  });

  it("미제출 part가 남으면 finalize가 그 사실을 밝힌다", async () => {
    // judge.test.ts의 "part가 남은 채로는 finalize가 미판정으로 처리한다"와
    // 짝을 이룬다. 여기서는 문구만 확인한다.
    const d = gitRepo();
    const meta = await createRun(runMeta({ judge: true }), d);
    await writeFileReview(meta.runId, reviewResult(), "md", d);
    const out = await finalizeRun(meta.runId, d);
    expect(out).toContain("unjudged");
  });
});
```

`run.test.ts`에 없는 헬퍼(`gitRepo`, `runMeta`, `reviewResult`)는 그 파일의 기존 헬퍼를 쓰거나, `judge.test.ts`와 같은 형태로 파일 상단에 만든다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts -t "part 안내"`
Expected: FAIL — 팬아웃 지시문에 "part"라는 말이 없음

- [ ] **Step 3: 최소 구현을 작성한다**

`src/adapters/opencode/review/index.ts`의 `f_review_judge_context`:

```typescript
  const f_review_judge_context = tool({
    description:
      "Judge-agent entry point (run mode): returns the change under review, the submitted findings, and the scoring criteria for one file of a run. A large review is judged in several parts — the result says how many and which part to submit. Call before f_review_judge.",
    args: {
      runId: z.string().min(1).describe("The runId of the reviewed run"),
      file: z.string().min(1).describe("The reviewed file to judge"),
      part: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Which part of a split judgment to fetch (default 0). Only pass what a previous tool result told you to."
        ),
    },
    async execute(args) {
      return judgeContext(args.runId, args.file, cwd, args.part);
    },
  });
```

`f_review_judge`의 `args`에 추가한다:

```typescript
      part: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("The part number f_review_judge_context gave you. Omit when it gave none."),
```

`f_review_fix_context`:

```typescript
      part: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Which part of a split fix pass to fetch (default 0). Only pass what a previous tool result told you to."
        ),
```

```typescript
    async execute(args) {
      return fixContext(args.runId, args.file, cwd, args.part);
    },
```

`run.ts`의 `judgeSteps` 두 번째 항목을 다음으로 교체한다:

```typescript
        `Follow the message f_review_judge returns EXACTLY: it either accepts the file, tells you to spawn a NEW f-judge for the next part of the same review, or tells you to re-spawn the f-reviewer for that file (judge feedback is injected automatically) and judge again. A large review is judged in several parts — each part needs its OWN fresh f-judge subagent, one after another. The rework cap is enforced by the tool — never re-spawn beyond what it instructs.`,
```

`fixSteps`의 프롬프트 줄을 교체한다:

```typescript
          `   Prompt: "Call f_review_fix_context with runId=\"${meta.runId}\" and file=\"<file>\", write the corrected code for every violation, then call f_review_fix_submit."`,
          `   A file with many violations is fixed in parts: if the context says so, spawn a NEW f-fixer for each remaining part after the previous one submits.`,
```

`run.ts:433`의 미판정 사유 문구를 교체한다:

```typescript
  if (judgeUnjudged.length) {
    qualityReasons.push(
      `${judgeUnjudged.length} unjudged review(s) (a partially submitted split judgment counts here — spawn f-judge for the remaining part(s))`
    );
  }
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts`
Expected: PASS

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `bun test && bun run typecheck`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/adapters/opencode/review/index.ts src/core/review/pipeline/run.ts src/core/review/pipeline/__tests__/run.test.ts
git commit -m "Teach the tools and the orchestrator about parts"
```

---

## Task 9: 빌드와 실환경 확인

**Files:**
- 없음 (검증만)

**Interfaces:**
- Consumes: Task 1-8 전부

- [ ] **Step 1: 전체 테스트**

Run: `bun test`
Expected: 전부 통과. 실패한 테스트가 있으면 여기서 멈추고 원인을 고친다.

- [ ] **Step 2: 타입 검사**

Run: `bun run typecheck`
Expected: 에러 없음

- [ ] **Step 3: 배포 빌드**

Run: `bun run build`
Expected: 5개 어댑터가 모두 컴파일된다

- [ ] **Step 4: 컴파일된 번들에 반영되었는지 확인**

Run: `grep -c "pendingParts" dist/adapters/opencode/index.js`
Expected: 1 이상

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "Build the part-splitting judge and fixer into the distribution"
```

- [ ] **Step 6: 사용자에게 실환경 검증을 요청한다**

OpenCode 프로세스를 재시작한 뒤, 지적이 많이 나오는 큰 파일에 f-review를 돌려
다음을 확인해 달라고 요청한다:

- 판정이 여러 part로 나뉘고 각 part마다 새 f-judge가 스폰되는지
- 최종 점수가 가중평균 산식과 맞는지
- 예전에 `judge-incomplete`로 죽던 파일이 이제 판정을 받는지
- fcq 위반이 많은 파일에서 fixer가 모든 위반에 fix를 내는지

---

## 자체 검토 결과

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| 1. part 계획 (greedy, 결정론) | Task 1, Task 4 (`judgePartPlanFor`) |
| 2. coverage 전용 part | Task 1 (`hasCoveragePart`), Task 4 (`coveragePrompt`) |
| 3. 저장 구조 (`pendingParts`) | Task 3, Task 6 |
| 4. 점수 합성 | Task 2, Task 6 |
| 5. 툴 계약 | Task 5, Task 6, Task 8 |
| 6. finalize 게이트 | Task 6 (테스트), Task 8 (문구) |
| 7. f-fixer | Task 7 |
| 테스트 목록 | Task 1-7에 분산 |

**알려진 위험**

- Task 4에서 `buildJudgePrompt`에 `index` 필드를 추가하면 기존 프롬프트 내용을 문자열로 검사하는 테스트가 깨질 수 있다. Task 4 Step 4에 대응 방법을 적어두었다.
- Task 6에서 `parsed.data`를 변형(mutate)한다. Zod 파싱 결과는 평범한 객체이므로 동작하지만, 리뷰어가 불변성을 선호하면 새 객체를 만들어 넘기도록 바꾼다.
- `planFixParts`의 `FIX_CONTEXT_MAX_BYTES - 3_000` 여유분은 head/tail 지시문 크기를 어림한 값이다. Task 7의 "60건에서도 소스를 본다" 테스트가 이 값을 지킨다.
