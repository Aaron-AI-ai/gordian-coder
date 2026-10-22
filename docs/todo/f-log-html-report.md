# TODO: f-log 리포트 HTML 출력

> 상태: **미착수 · 우선순위 높음** (2026-10-22 등록)

## 배경

- f-review는 markdown 리포트 옆에 같은 이름의 `.html`을 함께 쓴다 (`src/core/review/report/output.ts` `writeReport` → `html.ts` `renderHtmlReport`, 템플릿 `report.template.html`).
- f-log는 markdown(`log-<runId>.md`)만 쓴다 (`src/core/log/finalize.ts` `finalizeRun` → `writeFileSync(path, md)`). 브라우저로 열어 공유·열람할 수 있는 형태가 없다.

## 할 일

1. f-log finalize가 `.md`와 같은 위치·같은 이름으로 `.html`을 함께 쓴다 (`htmlReportPath` 재사용).
2. HTML 구성: 배지(신뢰도), 원인, 해결 방안(Fix — 코드 블록 유지), 근거 스택트레이스·코드 발췌, Gaps. markdown 리포트와 같은 섹션 순서.
3. 렌더러: f-review `renderHtmlReport`는 `Finding` 테이블 전용이라 그대로 쓸 수 없다. 공용으로 뺄 수 있는 것(`esc`, `fill`, 코드 펜스 처리, 테마/스타일, `localTimestamp`)은 `report/` 공용 모듈로 옮기고, f-log 전용 템플릿을 둔다. 공용화 범위는 `docs/todo/f-review-kb-retrieval.md` 3.8(모듈 승격) 방향과 맞춘다.
4. 채팅 요약(`Report:` 줄)에 HTML 경로도 표시할지 결정 (기본: md 경로 유지 + `HTML:` 한 줄 추가).
5. 설정: f-review와 동일하게 기본 생성. 끄는 옵션은 요청이 있을 때 추가.
6. 테스트: finalize 후 `.md`·`.html` 둘 다 존재, 재-finalize(캐시 응답) 시 다시 쓰지 않음, `--output` 파일 경로 충돌 리다이렉트(`log-<runId>.md`) 시 HTML도 같은 이름을 따름, HTML 이스케이프(로그 원문에 `<script>` 등).

## 주의

- 로그 원문·스택트레이스는 신뢰할 수 없는 입력이다. HTML에 넣을 때 반드시 이스케이프한다.
- f-review의 리포트 중복 문제(쓰기마다 폴더 백업)는 f-log에 없다 — f-log는 `runId` 기준 파일명이고 재-finalize는 저장된 응답만 돌려준다. HTML도 이 규칙을 그대로 따른다.

## 관련

- f-log 사용 문서: `docs/guides/f-log-usage.md`
- 실행 중지 조건 TODO: `docs/todo/run-stop-conditions.md`
