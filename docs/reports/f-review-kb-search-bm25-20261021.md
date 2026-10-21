# f-review `kb_search` 순위 방식 비교: keyword vs bm25 (2026-10-21)

## 결론

- `kb_search` 순위 방식은 `.fico/config/fico_ai.json`의 `kbSearch`로 고른다: `"keyword"`(기본) / `"bm25"`. 설정이 없거나 다른 값이면 **keyword**로 동작한다.
- 리뷰 전 사전 검색(prefetch)은 설정과 무관하게 항상 keyword다 (채택 임계값이 키워드 점수 기준).
- 검색만 따로 측정하면 **bm25(필드별 BM25)가 근소하게 우세**하다. 실제 f-review 결과에서는 차이가 측정되지 않았다. 기본값은 keyword로 유지하고, bm25는 선택 옵션으로 둔다.

```json
{ "review": { "kbSearch": "bm25" } }
```

## 구현

`src/core/review/evidence/framework-kb.ts`

| 항목 | 내용 |
|---|---|
| 토큰 | 식별자 전체 + camelCase 조각(약어 접두 포함: `PBTransactionAspect` → pb, transaction, aspect), 한글은 2글자 조각 추가 |
| 점수 | 필드별 Okapi BM25(k1=1.2, b=0.75)에 가중치를 곱해 합산: 파일명 5, 제목·fqcn 4, 태그 3, 설명 2, 본문 1 |
| 캐시 | KB 페이지를 파일 mtime 기준으로 한 번만 읽어 재사용 (이전에는 검색·단서마다 전 페이지 재읽기) |
| 사전 검색 | 파일당 KB 목록을 한 번만 만들고, 단서는 최대 40개만 검색 |

필드별로 포화시키지 않고 빈도를 하나로 합친 초기 구현(v1/v2)은, 페이지 이름 일치가 본문 빈도에 묻혀 흔한 단어를 여러 개 맞힌 긴 페이지에 밀렸다(예: `Q-type service transaction write read-only` → 1위 `FixedDataConverter.md`). 필드별 포화(v3)로 고쳤다.

## 측정

대상: `test-projects/on-test-lab/on-test-lab-online`, KB 약 395페이지, 모델 `openrouter/qwen/qwen3.8-27b`.
정답: f-review 케이스 YAML의 `kb_ref`(단일 페이지). `kb_search`는 상위 2개만 본문을 주므로 **hit@2**가 핵심 지표다.

### 오프라인 (같은 질의를 모든 방식에, 결정적)

질의 81개: 실제 `kb_search` 기록 14 + A/B 실행 중 질의 19 + 케이스 소스 식별자 48(정답 클래스 이름 자체는 제외).

| 방식 | hit@1 | hit@2 | hit@5 | MRR |
|---|---|---|---|---|
| keyword | 15 | 26 | 40 | 0.297 |
| bm25 v1/v2 (빈도 합산) | 20 | 26 | 40 | 0.330 |
| **bm25 v3 (필드별, 채택)** | 17 | **29** | **42** | 0.323 |

- bm25가 강한 경우: 질의 단어가 무관한 페이지 이름의 부분 문자열일 때 (`format` ⊂ `FormatterUtils`).
- keyword가 강한 경우: 질의 식별자가 페이지 이름의 접두일 때 (`KafkaConsumer` ⊂ `KafkaConsumerService`).
- 둘 다 실패: 정답 페이지가 질의 단어를 거의 쓰지 않을 때 (`Scheduled` → RequestScopeUtils, OracleAq 변환기 5종 구분). 순위 방식이 아니라 KB 문서 쪽 문제 — `docs/todo/f-review-kb-retrieval.md` 3.3(검색 힌트 필드).

### 실제 f-review (whole 모드)

- 10케이스(37, 39, 43, 44, 47, 48, 66, 93, 95, 96): keyword 6/10, bm25 v3 9/10. 다만 8케이스는 정답 페이지가 리뷰 전에 이미 주입되므로 검색 방식과 무관하다.
- 정답이 주입되지 않는 3케이스(05, 47, 95)를 방식별 3회 반복: keyword 8/9, bm25 v3 6/9. **FAIL 5건 모두 채점 기준 문제**였다. 18회 전부 정답 근거를 지적했다.
  - case-95: 지적은 같으나 분류 `framework` → YAML은 `correctness`만 허용
  - case-47: 프레임워크 위반을 15·17줄에 지적 → 앵커 22줄 ±3 밖
- 실행 중 실제 `kb_search` 호출의 정답 hit@2: keyword 8/11, bm25 v3 8/12.

## 함께 확인된 문제 (별도 처리)

- 평가 YAML: case-95에 `framework` 분류 허용, case-47에 15~19줄 앵커 추가 필요.
- 평가 스크립트가 같은 리포트 경로를 모드마다 덮어써서, 끝난 run이 `runIsTerminal`에서 다시 미완료가 되고 10개 상한에 걸려 실행이 거부됐다 (모델이 다른 run을 임의로 finalize함). 리포트 백업 시 run 종료 판정이 풀리는 문제와 같은 원인이다.
