# TODO: 실행 폴더의 단위별 리뷰 markdown 정리

> 상태: **미착수 · 우선순위 낮음** (2026-10-23 등록)

## 현황

- `writeFileReview` (`src/core/review/pipeline/run-store.ts`)는 단위마다 `fcq/f-review/runs/<runId>/reviews/<단위>.json`과 `<단위>.md`를 함께 쓴다.
- 최종 리포트(`finalizeRun`, `pipeline/run.ts`)와 judge·커버리지 판정은 `.json`만 읽는다. `.md`를 읽는 코드는 없다 — 쓰기 전용 산출물이다.
- 규모: 2026-10-22 on-stk-ord-online 실행(56파일)에서 59개.

## 할 일

1. `.md`의 실제 용도 확인: 사람이 단위별 결과를 열어 보는지, `writeFileReview`가 반환하는 `.md` 경로를 리뷰어 응답/로그에 노출하는지 (`loop.ts:445`).
2. 선택지:
   - 그대로 둔다 (디버깅용으로 의미가 있으면).
   - 설정으로 끄게 한다 (기본 생성 유지).
   - 생성을 없애고, 필요하면 `.json`에서 렌더링한다.
3. 바꿀 경우: `writeFileReview` 반환값을 쓰는 곳 정리, 테스트(`run.test.ts`의 `writeFileReview` 호출) 수정, `docs/guides/f-review-usage.md` 5.2 중간 산출물 설명 수정.

## 관련

- 리포트 중복 수정: 커밋 `6aec30d` (실행당 리포트 1개)
