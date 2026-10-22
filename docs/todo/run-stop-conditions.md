# TODO: 실행 중지 조건 명세 (f-review / f-log 공통)

> 상태: **보류** (2026-10-21 기준). 현재 구현을 유지하고, 아래 항목은 추후 구체화한다.
> 근거: 평가 케이스 case-01~100 실행 중 겪은 멈춤·연결 단절·실행 슬롯 정체 사례.

## 1. 현재 구현 (코드에 있는 중지 조건)

| 영역 | 조건 | 위치 |
|---|---|---|
| 도구 호출 | 세션당 총 호출 수(`maxToolCalls`), 라운드당 탐색 수(`maxIter`), 같은 호출 반복(`MAX_DUP_CALLS`=2), 연속 miss(`MAX_MISS_STREAK`=4) | `src/core/guard.ts` |
| 제출 | 제출 거부 누적 시 마지막 유효 payload 강제 수락(`MAX_FAILED_SUBMITS`=5) | `src/core/review/pipeline/loop.ts` |
| 재개 | 리뷰어가 멈추면 감시자가 다시 구동(`MAX_RESUMES`=3), 이후 부분 리포트로 종료 | `loop.ts` (`onSessionIdle`) |
| 판정 | judge 재작업 횟수(`judgeRounds`), 잘못된 judge 제출 한도(`MAX_INVALID_JUDGE_SUBMISSIONS`=3) | `pipeline/judge-store.ts` |
| 실행 정리 | 미완료 실행 최대 10개(`MAX_UNFINISHED_RUNS`), 24시간 후 방치 처리(`UNFINISHED_RUN_TTL_MS`), 보관 10개(`RUNS_KEEP`) | `pipeline/run-store.ts` |

## 2. 관찰된 빈틈

### 2.1 시간 기준 중지가 없다
- 사례: `case-15`가 리뷰어 단계에서 11분 넘게 응답을 기다림. 도구 호출 수가 늘지 않아 가드가 작동하지 않았다.
- 평가 스크립트(`scripts/freview-eval.ts`)에도 실행별 타임아웃이 없어, 한 케이스가 멈추면 뒤의 모든 케이스가 지연된다.
- 필요: 파일당 / 실행 전체 벽시계 한도.

### 2.2 네트워크 단절 처리가 일관되지 않다
- 증상: `SSE read timed out`, `Cannot connect to API: Unable to connect`. 하위 에이전트가 실패하면 재개를 시도하다 `opencode exited 1`로 끝나고, 나머지 대상이 연달아 즉시 실패한다 (case-36~40이 "리포트 없음").
- 불명확한 점: 재시도·백오프 후 중단할지, 즉시 중단하고 "미실행"으로 표기할지.

### 2.3 중지 사유가 결과에 구조적으로 남지 않는다
- 어떤 한도로 멈췄는지(도구 예산, 재개 한도, 시간, 네트워크, 사용자 중단)가 리포트·`run.json`에 일관된 형태로 없다.
- 평가에서 "실패(FAIL)"와 "미실행"을 로그를 읽어야 구분할 수 있었다.

### 2.4 한도 간 우선순위·상호작용이 문서화되어 있지 않다
- 어느 한도가 먼저 걸릴 때 부분 결과를 어떻게 남기는지, 한도에 걸린 파일을 재시도할 때 무엇을 이어받는지가 코드에 흩어져 있다.

### 2.5 사용자 중단과 정리
- 중간에 끊긴 미완료 실행이 다음 실행의 슬롯을 차지한다 (`A run cap blocked planning; finalizing an unfinished run to free a slot` 경고가 실제로 발생). 안전하게 정리할 시점·조건이 불명확하다.

### 2.6 비용·토큰 한도가 없다
- 호출 횟수만 제한하고 토큰/비용 기준은 없다.

## 3. 명세로 정리할 항목

1. **중지 사유 정의**: `budget`(도구 예산) / `resume_cap`(재개 한도) / `timeout`(시간 초과) / `network`(연결 단절) / `user_abort`(사용자 중단) / `invalid_submit`(제출 거부 한도) 와 각각의 결과 상태(부분 완료, 미실행, 실패).
2. **시간 한도 설정**: 파일당 / 실행당 한도를 `fico_ai.json`의 `review` / 로그 설정에 어떻게 노출할지, 기본값.
3. **결과 표기**: 리포트와 `run.json`에 중지 사유를 구조화해 남기기. 평가 스크립트가 FAIL과 "미실행"을 구분하도록 연결.
4. **네트워크 정책**: 재시도 횟수·백오프, 연속 실패 시 남은 대상을 건너뛰는 규칙.
5. **정리 규칙**: 미완료 실행의 정리 시점과 슬롯 해제 조건. 다른 세션이 쓰는 실행을 건드리지 않는 보호.
6. **한도 간 우선순위**: 한 번에 여러 한도가 걸릴 때의 판정 순서와 부분 결과 보존 규칙.
7. **(선택) 비용·토큰 한도**.

## 4. 우선순위

1. 시간 한도 (2.1) — 평가에서 가장 큰 지연 원인.
2. 네트워크 단절 처리 + 중지 사유 표기 (2.2, 2.3) — 결과 신뢰성에 직결.
3. 정리·우선순위 명세 (2.4, 2.5).
4. 비용·토큰 한도 (2.6)는 필요 시.

## 5. 관련

- KB 검색 개선 TODO: `docs/todo/f-review-kb-retrieval.md`
- 가드: `src/core/guard.ts`, 루프: `src/core/review/pipeline/loop.ts`, 실행 저장소: `src/core/review/pipeline/run-store.ts`
- 평가 실행: `scripts/run-freview-eval.sh`, `scripts/freview-eval.ts`
