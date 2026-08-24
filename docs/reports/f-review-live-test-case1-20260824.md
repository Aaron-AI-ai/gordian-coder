# f-review 실환경 테스트 — Case 1: working-tree 병렬 리뷰 (judge 게이트 포함)

- 일시: 2026-08-24 10:06~10:41 KST (약 34분)
- 대상: `/Users/koscom/workspace/fico/on-stk-ord` (리뷰 범위: `on-stk-ord-online` 하위만)
- 실행: `opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--exclude=on-stk-ord-bsm/**,build.gradle,fcq/**"`
- 플러그인: gordian-coder `develop@5e27938` (always-fresh run·findings-only 리포트 반영 빌드)
- 프로젝트 설정(`fcq/config/.f-review.json`): `judge: true`, `deepPasses: 2`, `maxToolCalls: 20`, `judgeRounds: 2`, framework KB 4개 매핑(`.fico/kb/`)
- 규모: 세션 19개(오케스트레이터 1 + 리뷰어 9 + judge 9), 어시스턴트 메시지 119건, 총 2.53M 토큰, $1.70

## 결과 요약

8/8 파일 리뷰 제출·집계 완료, 발견 41건(major 9 / minor 26 / nit 6). 최종 verdict는
**INCOMPLETE (fail-closed)** — SONAQ002Service의 judge가 컨텍스트 상한(18,000자)으로
채점을 포기했기 때문. 무한 반복·메모리 누수·프로세스 잔류 없음.

| 파일 | 1차 judge | 재작업 |
|---|---|---|
| SONAQ002Controller | 96 pass | — |
| SONAQ001Service | 95 pass | — |
| SONAQ003Service | 90 pass | — |
| application.yml | 90 pass | — |
| fico-log-template.json | 90 pass | — |
| SONAU002Service | 85 pass | — |
| SONAU006Service | 65 **rework** | 재리뷰 후 90 pass (1회 수렴) |
| SONAQ002Service | **judge-incomplete** (attempts 0) | 채점 없이 종결, 리뷰(7건)는 리포트에 포함 |

## 정상 동작 확인 항목

- **run 위생**: 시작 시 `pruneRuns`가 8/19의 방치 run 7개 중 6개 삭제(terminal 1개 보존). TTL(24h) 프루닝 정상.
- **팬아웃 규율**: 배치 상한 5 준수(5개 → 완료 대기 → 3개), 파일당 서브에이전트 1개, run join(`f_review_context` + runId + 단일 파일) 정확.
- **evidence 주입**: 리뷰어·judge 프롬프트에 임포트 소스(PBOnlineException, PBCommonUtils 등)와 framework KB 페이지가 주입됨. "재조회 금지" 지시도 judge 프롬프트에 전달됨.
- **judge rework 루프**: 65점 → 구체적 피드백과 함께 재리뷰 1회 → 90점 수렴. `judgeRounds=2` 상한 내 종결.
- **fail-closed**: judge 1건이 미채점이자 run 전체가 INCOMPLETE로 종결(finalize 요약 152자: "8/8 review artifact(s) present; 1 judge-incomplete"). 리포트에는 PASS 표기 없음.
- **리포트 산출물**: findings-only 본문 + `## Review Context` 부록(모드/범위/룰 소스/파일 목록), AS-IS/TO-BE 제안 82블록, HTML 리포트 동반 생성, 기존 `f-review/` 폴더는 `f-review.<stamp>`로 아카이브. 파일명 초 단위 스탬프(`review-c9a2a26-010803-20260824-014020.md`) 적용 — 당일 커밋의 always-fresh 변경이 실환경에서 그대로 동작.
- **안정성**: opencode RSS 275~595MB 등락(34분, 15초 간격 138샘플), 단조 증가 없음. 동일 툴 무한 재호출 패턴 없음. 프로세스 exit 0.

## 개선 필요 사항 (우선순위순)

### 1. judge 컨텍스트 18k 상한 초과 시 전면 포기 → 폴백 필요 (impact: 높음)

`bounded judge context unavailable: 4 merged finding window(s) plus the base exceed 18000
characters` 사유로 SONAQ002Service judge가 **시도 0회로 terminal 종결**됐고, 이 1건 때문에
run 전체가 INCOMPLETE가 됐다. finding이 많은 파일일수록(= 채점이 가장 필요한 리뷰일수록)
채점에서 빠지는 역설. 개선안: 윈도우 축소(라인 수 절반) 재시도 → finding을 배치로 나눠
복수 judge 세션 채점 → 그래도 불가하면 지금처럼 terminal. 최소한 폴백 1단계는 필요.

### 2. plan 기본 스코프가 dirty working tree와 어긋남 (impact: 높음, 소형 모델에서 증폭)

`--exclude`만 주고 실행하자 기본 대상이 **마지막 커밋 diff**(fcq.yaml 1개)로 잡혀 exclude 후
빈 집합("No files to review")이 됐다. 소형 모델 오케스트레이터는 이에 대응해 ① 빈 인자 `{}`로
재호출(의도와 무관한 run 생성), ② bash로 git 탐색, ③ 세 번째 호출에서야 files 8개를 명시했다.
개선안 중 택1:
- working tree가 dirty면 기본 스코프를 working-tree diff로 (또는 설정 플래그)
- "No files to review" 메시지에 복구 힌트 추가: "워킹트리에 수정 파일 N개 있음 —
  working tree를 리뷰하려면 `files=[…]` 또는 `commit=HEAD` 지정" (도구 메시지가 곧
  소형 모델의 가드레일이라는 점에서 비용 대비 효과 가장 큼)

### 3. 디스패치 0건 고아 run 누적 (impact: 중간)

위 ②의 빈 인자 호출이 만든 run(`c9a2a26-010732`, 타깃 = 사용자가 제외한 fcq.yaml)이
디스패치 없이 방치됐다. always-fresh 정책(5e27938) 이후 이런 고아 run이
`MAX_UNFINISHED_RUNS`(10)에 그대로 누적된다 — 오늘 같은 반복 테스트를 하루에 10회 하면
plan이 거부되기 시작한다. 개선안: 리뷰 artifact가 0건인 run은 TTL을 짧게(예: 1h) 적용하거나,
새 plan 성공 시 같은 라벨의 미디스패치 run을 정리.

### 4. 오케스트레이터가 finalize 후 리포트 전문(42KB)을 다시 읽음 (impact: 중간, 비용)

`f_review_finalize`는 152자 요약을 반환했지만, 오케스트레이터가 `read`로 리포트 1,018줄
전문을 컨텍스트에 넣은 뒤 요약을 릴레이했다. 결과 릴레이 자체는 정확했으나 소형 모델
기준 토큰 낭비가 크고 max-output 퇴행 리스크 지점이다. 개선안: `/f-review` 명령 템플릿
5단계에 "리포트 파일을 다시 읽지 말 것 — finalize가 반환한 요약만 릴레이" 한 줄 추가.

### 5. 팬아웃/인자 전달의 프롬프트 의존 재확인 (impact: 구조적, 기존 보류 설계와 연결)

exclude 인자 유실 재시도(관찰 #2의 ①)는 메모리에 보류해 둔 팬아웃 강제화 설계(A′,
`tool.execute.before` 인터셉터)가 다루는 문제의 실측 사례다. 이번 run에서는 배치·단일 파일
규율이 지켜졌지만, 그것도 전부 프롬프트 순응에 기대고 있다. 소형 모델 운영을 계속할
거라면 A′ 구현 우선순위를 올릴 근거가 하나 늘었다.

### 6. 사소/외부

- 빈 인자 tool 호출이 CLI에 `f_review_plan Unknown`으로 표시됨 — OpenCode 렌더링 한계(외부).
- files 모드 run의 Review Context에 `Excludes: none`으로 기록됨 — 사용자가 CLI에 준 exclude
  의도가 최종 run 메타에 남지 않는다. 추적성 관점에서 plan 인자 원문을 run.json에 보존하는
  것 고려(사소).

## 다음 테스트 케이스 후보

1. **커밋 범위 리뷰**: `A..B` 범위 지정 — diff 모드·범위 해석·evidence(git_history) 검증
2. **judge-incomplete 재현·경계**: finding 많은 대형 파일 1개 집중(18k 상한 동작과 세그먼트 분할 상호작용)
3. **동시 실행 경합**: 같은 plan을 2개 프로세스에서 동시 실행 — fingerprint claim("still being created by another process") 검증
4. **--sequential 레거시 모드**: 단일 세션 순차 경로 회귀 확인
5. **대형 모델 대조**: 동일 케이스를 claude-sonnet으로 실행해 소형 모델 의존 이슈(#2·#4·#5) 분리
