# f-judge / f-fixer 컨텍스트 분할 (part splitting)

2026-09-09

## 문제

리뷰 대상 코드가 크고 fcq 위반이 많을 때, 심사(f-judge)와 수정(f-fixer)
단계가 컨텍스트 예산을 넘겨 실패한다. 두 단계의 실패 방식이 다르다.

### f-judge — fail-closed, 런 전체가 죽는다

`buildJudgePrompt`는 예산 초과 시 `JudgeContextOverflow`를 반환하고,
`judgeContext`가 이를 `judge-incomplete` terminal로 확정한다. 해당 파일은
다시 심사할 수 없고 `run.ts`의 finalize에서 런 전체가 INCOMPLETE로 닫힌다.

실측 근거 (`fcq/f-review/runs` 아티팩트 11건 + 대상 소스):

```
렌더 후 소스 크기        47.8 B/줄 (TypeScript), 48 B/줄 (한국어 주석 Java)
지적 1건당 JSON          중앙값 1,003 B, 최대 1,621 B
전체 파일 base 한도      24,000 B ÷ 48 = 약 500줄
윈도우 1개(±25줄=51줄)   약 2,437 B → 24,000 B 안에 약 9개
```

따라서:

- 500줄을 넘는 파일은 base(전체 코드)가 들어가지 못하고 항상 윈도우 모드가 된다
- 윈도우 모드에서 병합 후 윈도우가 10개를 넘으면 초과
- 지적 20건이면 지적 목록 JSON만 20,060 B로 `JUDGE_FINDINGS_MAX_BYTES`(20,000) 초과
- 섹션 예산 합(24,000 + 20,000 + 8,000)이 전체 예산 45,000을 넘으므로,
  각 섹션이 개별 통과해도 조립 단계에서 초과할 수 있다

구조적으로 고약한 점: 심사관이 REWORK을 주면 리뷰어가 더 많은 지적을 찾아오고,
그만큼 윈도우와 JSON이 늘어 다음 라운드에서 초과 확률이 올라간다. 품질을 높이는
메커니즘이 실패를 만든다.

또한 whole 모드에서 500줄 초과 파일의 리뷰가 **깨끗하면**(지적 0건) 앵커가 없어
`judge-prompt.ts:191`에서 무조건 초과 처리된다. 리뷰가 깨끗할수록 실패한다.

### f-fixer — fail-open, 조용히 일부만 처리된다

`fixContext`는 위반 목록(`head`)을 먼저 조립하고 **남은 것**을 소스 예산으로 쓴다
(`fixer.ts:163`). head 자체는 예산에 포함되지 않는다.

실측 근거 (`fcq/files` 샤드 11건):

```
위반 1건당 head 크기     700 B (SONAQ002Service.java 19건 = 13,296 B)
FIX_MAX_ITEMS = 60건     head만 42,000 B
남는 소스 예산           45,000 - 42,000 - tail ≈ 2,400 B
윈도우 1개(±40줄=81줄)   약 3,888 B  →  첫 윈도우부터 예산 초과
```

400줄 자바 파일 기준 동작:

| 위반 수 | 소스 몫 | 결과 |
|---|---|---|
| ~36건 | 19,200 B 이상 | 전체 파일 전달 |
| 37~57건 | 4~18 KB | 윈도우 모드, 뒤쪽 위반이 조용히 드롭 |
| 58건 이상 | 2 KB 미만 | 소스 0줄. "Only these line ranges are below: none" |

마지막 구간에서 fixer는 코드를 한 줄도 못 본 채 "보이지 않는 위반에는 fix를 넣지
말라"는 지시를 받고 빈 제출을 한다. `run.ts:490`의 `fixWarn`이 미수정 위반을
경고하고 재스폰을 지시하지만, head/예산 계산이 결정론적이라 재스폰해도 같은
결과가 나온다.

## 해결 방향

예산을 넘길 때 증거를 잘라내는 대신, **작업을 여러 part로 나눠 순차 처리**한다.
part마다 새 서브에이전트를 띄우므로 part 수만큼 예산을 곱해서 쓸 수 있다.

### 용어

분할 단위를 **part**라 부른다. `batch`는 `RUN_BATCH_SIZE`("한 번에 스폰할
서브에이전트 수")로 이미 오케스트레이터 프롬프트에서 쓰이고 있어, 같은 프롬프트
안에서 뜻이 충돌한다.

## 설계

### 1. part 계획 — 결정론적 greedy 채우기

```
judgePartPlan(meta, review, cwd) → number[][]   // finding 인덱스 배열의 배열
```

지적을 줄번호 순으로 담으며 `buildJudgePrompt`를 실제로 조립해 크기를 재고,
`JUDGE_CONTEXT_MAX_BYTES`를 넘기 직전에 part를 닫는다. 고정 건수 상수를 두지
않는다 — 지적이 한곳에 뭉쳐 윈도우가 병합되면 20건도 한 part에 들어가고,
흩어져 있으면 6~8건으로 쪼개진다.

**결정론이 필수 요건이다.** 같은 리뷰 아티팩트에 대해 항상 같은 계획이 나와야,
제출 시 "이 part가 담아야 할 인덱스 집합"을 재계산으로 검증할 수 있다. 계획을
디스크에 저장하지 않고 매번 재계산하는 이유이기도 하다.

part가 1개로 나오면 현재 동작과 동일하다. 기존 흐름이 하위호환으로 유지된다.

지적 1건이 혼자서도 예산을 넘기는 경우(스키마상 최대 10,000자)에는 그 건만 담은
part를 만들고 진행한다. 더 쪼갤 단위가 없다.

### 2. coverage 전용 part

**분할이 실제로 일어났을 때만** coverage part를 붙인다. 계획이 지적 part 하나로
끝나면 그 심사관이 파일 전체를 본 것이므로, 지금처럼 5개 기준을 모두 채점하고
part 개념은 드러나지 않는다.

지적 part가 2개 이상이면 각 part는 `JUDGE_CRITERIA` 1~4번(validity, evidence,
severity, actionability = 80%)만 채점한다. 부분만 본 심사관은 "리뷰가 파일
전체에서 놓친 영역"을 판단할 수 없기 때문이다.

이때 마지막 part(인덱스 N)가 coverage 전용이 된다. 입력은 파일 구조와 전체 지적
요약(줄번호 + rule만, 건당 약 60 B — 50건이어도 3,000 B)이고, 출력은
`coverageGaps`와 coverage 점수다.

지적이 0건인 리뷰는 예외다. 500줄을 넘는 파일이면 base가 들어가지 않고 앵커도
없어 현재는 무조건 실패하는데, 이 경우 coverage part 하나만으로 심사한다.

### 3. 저장 구조

`JudgeAttempt` 스키마는 바꾸지 않는다. 대신 임시 보관함을 추가한다.

```
FileJudgment {
  attempts: JudgeAttempt[]              // 기존 그대로. 합성된 최종 판정만
  pendingParts: JudgePartSubmission[]   // 신규
  invalidSubmissions, terminal          // 기존 그대로
}

JudgePartSubmission {
  reviewRevision, reviewArtifactHash    // 아티팩트 바인딩 (기존 규약과 동일)
  part: number                          // 0..N-1 지적 part, N = coverage
  score, feedback, coverageGaps, findingJudgments
  at
}
```

part 제출은 `pendingParts`에 쌓인다. 0..N이 모두 모이면 하나의 `JudgeAttempt`로
합성해 기존 `attempts`에 push하고 `pendingParts`를 비운다.

합성된 attempt는 전체 findingJudgments를 담으므로
`indexValidationError`(전체 인덱스를 정확히 1회) ·
`persistedAttemptValidationError` · `reworkCount` · `attemptMatchesReview` 가
그대로 통과한다. 기존 검증 로직을 수정할 필요가 없다.

재리뷰로 새 revision이 나오면 `pendingParts`의 `reviewArtifactHash`가 달라지므로
`loadJudgment`에서 걸러진다.

### 4. 점수 합성

분할되지 않은 경우(지적 part 1개)에는 합성이 없다. 그 part의 점수가 곧 최종
점수이며 지금과 동일하다.

분할된 경우:

```
지적 점수 = Σ(part 점수 × part 지적 건수) / 전체 지적 건수
최종 점수 = 지적 점수 × 0.8 + coverage part 점수 × 0.2
판정      = 최종 점수 >= threshold ? pass : rework
```

지적 0건이라 coverage part만 있는 경우에는 그 점수를 그대로 최종 점수로 쓴다.

판정은 지금과 같이 점수에서 도출하며 모델이 정하지 않는다.

`feedback`은 part별 피드백을 part 번호와 함께 이어붙이고 기존 4,000자 cap을
적용한다. `coverageGaps`는 coverage part의 것을 쓴다.

### 5. 툴 계약

```
f_review_judge_context(runId, file, part?)     // 생략 시 0
  → "part k/N" 표시와 함께 해당 part의 프롬프트
  → 이미 제출된 part면 다음 part 번호를 안내
  → 마지막 part는 coverage 전용 지시문

f_review_judge(runId, file, part, findingJudgments, coverageGaps, score, feedback)
  → 미완: "part k 기록됨. 다음 part k+1을 새 f-judge 서브에이전트로 스폰하라"
  → 완료: 합성 후 기존 PASS / REWORK 메시지
```

part 제출 시 인덱스 검증은 계획을 재계산해 해당 part의 인덱스 집합과 정확히
일치하는지 확인한다. `consistencyValidationError`는 part 단위로 적용하되,
`coverageGaps` 비어있음 규칙은 coverage part에만 적용한다.

무효 제출 상한(`MAX_INVALID_JUDGE_SUBMISSIONS`)은 지금처럼 파일 단위로 둔다.
part 단위 상한이 필요해지면 그때 나눈다.

### 6. finalize 게이트

part가 일부만 제출된 파일은 합성된 attempt가 없으므로 `run.ts:419`의 기존
`judgeUnjudged` 경로에 그대로 걸려 `qualityIncomplete`가 된다. 새 게이트는
필요 없다.

다만 안내 문구는 보강한다. 지금은 "unjudged review(s)"라고만 나와서
오케스트레이터가 리뷰부터 다시 돌려야 하는지 남은 part만 처리하면 되는지 알 수
없다. 미제출 part 번호를 문구에 넣는다.

### 7. f-fixer

점수 합성이 없어 훨씬 단순하다.

```
fixPartPlan(runId, file, cwd) → FcqFileViolation[][]
f_review_fix_context(runId, file, part?)
```

part의 head와 그 part의 위반을 덮는 소스 윈도우를 함께 조립해
`FIX_CONTEXT_MAX_BYTES` 안에 들어가도록 채운다. head를 예산에서 빼지 않던
`fixer.ts:163`의 구조가 여기서 해소된다.

**`submitFix`를 덮어쓰기에서 병합으로 바꾸는 것이 전제 조건이다.** 현재는
"Overwrites — a retry is idempotent" 주석대로 파일 단위로 덮어쓰므로 part 2가
part 1의 결과를 지운다. fix 항목은 이미 `line + ruleId` 앵커로 위반에 매칭되므로
같은 앵커 기준 upsert로 병합한다.

`FIX_MAX_ITEMS`(60) 상한은 정책으로 유지한다. 60건을 넘으면 리뷰 대상이 아니라
lint 실패라는 판단이 담겨 있고, 이 설계가 바꾸려는 것은 그 판단이 아니라
60건 이하에서 소스가 잘려나가던 동작이다.

## 테스트

- `judgePartPlan` 결정론: 같은 아티팩트 → 같은 계획
- part가 1개일 때 기존 동작과 동일 (회귀)
- part별 인덱스 검증: 부분집합만 허용, 누락 · 중복 · 타 part 인덱스 거부
- 분할되지 않은 계획에는 coverage part가 붙지 않고 5개 기준이 모두 채점되는지
- 점수 합성 산식, 그리고 합성 attempt가 기존 전체 검증을 통과하는지
- 지적 0건 · 500줄 초과 리뷰가 coverage part만으로 판정되는지 (기존에는 무조건 실패)
- part 일부만 제출된 상태에서 finalize → INCOMPLETE
- 재리뷰 시 `pendingParts`가 아티팩트 해시 불일치로 무효화되는지
- fixer: part 병합이 이전 part의 fix를 보존하는지
- fixer: 위반 60건에서 소스가 0줄이 되지 않는지 (현재 동작에 대한 회귀 테스트)

## 변경 파일

| 파일 | 변경 |
|---|---|
| `judge-prompt.ts` | `judgePartPlan`, part 범위 프롬프트, coverage part 프롬프트 |
| `judge-store.ts` | `JudgePartSubmission` 스키마, `pendingParts`, 무효화 필터 |
| `judge.ts` | part 인자 처리, part 제출 기록, 합성, 안내 메시지 |
| `fixer.ts` | `fixPartPlan`, part 컨텍스트, `submitFix` 병합 |
| `run.ts` | 미제출 part를 알리는 finalize 문구, 팬아웃 지시문 |
| `adapters/opencode/review/index.ts` | 툴 파라미터 `part` 추가 |

## 범위 밖

- 지적 part의 병렬 실행. 순차로 두어 제출 순서를 결정적으로 유지한다
- `JUDGE_WINDOW` 축소 사다리. part 분할이 같은 문제를 덮으므로 두 장치를 겹치지
  않는다. part 하나가 지적 1건만 담고도 넘칠 때 다시 검토한다
- `asIs` / `toBe` 본문 압축. 채점 기준 4번(actionability)을 훼손하므로, part
  분할로 해결되지 않는 사례가 실제로 관측되면 그때 재검토한다
