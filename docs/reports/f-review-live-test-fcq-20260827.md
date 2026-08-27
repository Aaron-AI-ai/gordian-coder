# f-review 실환경 테스트 — fcq 정적분석 연동 (2026-08-27)

- 대상: `/Users/koscom/workspace/fico/on-stk-ord` (working-tree, `on-stk-ord-online`)
- 플러그인: gordian-coder `feature/fcq-static-analysis` v0.2.0 (`22487c3` → 버그 수정 `ea83c7a`)
- 모델: `openrouter/qwen/qwen3.8-27b`, 프로젝트 설정 `judge: true, deepPasses: 2, maxToolCalls: 20`
- fcq: 0.2.4 (`~/.local/bin/fcq`)

## Case A — `--fcq` 정상 경로 (2파일, judge on)

```
opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- \
  "--fcq --files=…/upd/service/SONAU002Service.java,…/qry/controller/SONAQ002Controller.java"
```

14분(13:05→13:19). 결과:

| 단계 | 확인 |
|---|---|
| `--fcq` → `f_review_plan {fcq:true}` | ✅ 소형 모델이 인자 정확히 매핑 |
| fcq 실행 | 6.7s, 5 analyzer SUCCESS, 샤드 2개 (`runs/<id>/fcq/files/`) |
| 리뷰어 프롬프트 주입 | ✅ (Controller 리뷰 5건이 fcq 8건과 **0건 중복** — DI 규칙·Javadoc 경로 불일치·데드코드·테스트 부재만 보고) |
| judge | 93 / 92 PASS |
| finalize | ❌ **버그**: `2 unjudged review(s)` → INCOMPLETE |

### 버그 (수정됨, `ea83c7a`)

`finalizeRun`이 `findings[r.file] = r.findings`로 파싱된 리뷰 객체의 배열을 그대로 참조한 채
fcq finding을 `push`해서, judge 검증이 리뷰 artifact 해시를 계산하기 **전에** 객체가 변형됐다.
기록된 judgment 해시와 불일치 → 전부 unjudged → run INCOMPLETE. 배열 복사로 수정, 회귀 테스트 추가
(수정 전 fail 확인). 수정 빌드로 같은 run을 재finalize:
`✅ Run complete — 2 file(s), 42 issue(s) (incl. 29 from fcq)`.

리포트 확인: 파일별 표에 LLM finding + `fcq:<analyzer>/<ruleId>` 행 병합, `제안 상세`에 AS-IS 스니펫,
`## Static Analysis (fcq)` 요약(통과율·analyzer 상태·카테고리표·명령줄), HTML 동반 생성.
`[기존]` 마커는 당일 11:17의 이전 fcq 포함 리포트를 baseline으로 정상 동작.

## Case B — fcq 실패 경로 (`fcq` PATH 제거, `--failOn=major`, 1파일)

8분. 결과:

- plan: `fcq.status: failed`, reason `Executable not found in $PATH: "fcq"` (4ms), 리뷰어 팬아웃 정상 진행
- 리뷰어 프롬프트에 fcq 섹션 없음, LLM 리뷰 6건 완료·judge PASS
- finalize: `⚠️ Run terminated — INCOMPLETE … static analysis (fcq) did not complete … Verdict: FAIL — review quality INCOMPLETE (failOn: major; fail closed)`
- 리포트: `## Static Analysis (fcq)` → `Status: **FAILED** — cannot start fcq …`, `fcq:` 행 0건
- 오케스트레이터가 사용자에게 "fcq 설치하거나 `--fcq` 없이 재실행" 안내 — 설계대로 동작

## 관찰 / 개선 후보

1. ~~**fcq finding의 TO-BE가 비어 있음**~~ — **해결(같은 날)**: TO-BE에 룰 description을 넣고,
   같은 line + ruleId 언급 LLM finding을 fcq 행에 병합(`mergeFcqFindings`). Case A run 재finalize로
   플레이스홀더 0건·L89 무관 finding 비병합 확인. 실제 병합(리뷰어가 fcq CRITICAL을 후속 분석하는 경우)은
   Case A에 해당 위반이 없어 단위 테스트로만 검증 — CRITICAL fcq 위반이 있는 파일로 재확인 필요.
2. **minor 홍수** — Case A 42건 중 fcq 29건이 전부 MINOR(checkstyle). 리포트 요약이 스타일 위반에
   묻힌다. `fcqOptions.maxSeverity`로 상한 조정 가능하나, 리포트에서 fcq 행을 심각도별로 접는
   렌더링(예: MINOR 이하는 건수만)을 고려.
3. 소형 모델 한자 혼입("문서与实际") — 기존 `scriptMismatch` 30% 임계 미만이라 통과. fcq 무관.
4. Case 1의 미해결 항목(judge 18k 폴백, dirty-tree 기본 스코프, 고아 run)은 그대로.
