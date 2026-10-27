# TODO: KB 검색 하이브리드(bm25 + Chroma 임베딩) 검토

> 상태: **미착수 · 검토** (2026-10-27 등록)

## 현황

- `kb_search`의 순위 방식은 두 가지이며 `kbSearch`로 고른다: `keyword`(기본), `bm25` (`src/core/kb/framework-kb.ts`). 둘 다 어휘 일치만 본다.
- 어휘 검색은 정답 페이지가 질의 단어를 거의 쓰지 않으면 실패한다. 예: `Scheduled` → RequestScopeUtils, OracleAq 변환기 5종 구분 (`docs/reports/f-review-kb-search-bm25-20261021.md`).
  - 이 실패는 의미 기반 검색이 보완할 수 있는 영역이다.
- 기존 계획인 `docs/todo/f-review-kb-retrieval.md` 3.4 2단계("임베딩 검색기 선택 기능")를 구체화하는 항목이다.

## 구상

- bm25 후보와 Chroma 벡터 검색 후보를 각각 상위 N개 뽑는다.
- 두 목록을 **RRF(Reciprocal Rank Fusion)** 또는 정규화 점수 가중합으로 합친다.
  - RRF는 점수 척도를 맞출 필요가 없어서 1순위 후보다.
- 설정 예시는 다음과 같다. 기본값은 지금 동작 그대로 둔다.
  ```json
  { "review": { "kbSearch": "hybrid", "embedding": { "provider": "local", "model": "...", "chroma": "..." } } }
  ```
- 색인
  - 단위: KB 페이지별, 또는 큰 페이지는 섹션 단위로 쪼갠다.
  - 저장: Chroma 컬렉션.
  - 갱신: KB 파일 해시가 바뀐 페이지만 재색인한다.
- 실패 시: 임베딩이나 Chroma를 쓸 수 없으면 경고 1회를 내고 bm25로 동작한다. 리뷰는 멈추지 않는다.
- prefetch에 하이브리드를 적용할지는 별도로 정한다. 현재 prefetch 채택 임계값은 keyword 점수 기준이다.

## 검토할 것

1. **필요성 측정**
   - 기존 81개 질의 세트를 쓰고, 의미형 질의를 추가한다(한글 설명문, "읽기 전용 서비스에서 쓰기" 같은 질의).
   - 비교 대상: keyword, bm25, 임베딩 단독, 하이브리드.
   - 지표: hit@2, MRR.
2. **Chroma 운용 방식**
   - 임베디드(로컬 파일) 또는 서버 모드.
   - JS 클라이언트는 서버 모드가 전제인지 확인한다. 임베디드가 안 되면 별도 프로세스를 관리해야 한다.
   - 대안: 페이지 약 400개 규모라면 벡터를 JSON이나 SQLite에 저장하고 코사인 계산을 직접 해도 충분한지 비교한다(의존성 0).
3. **임베딩 모델**
   - 사내망 정책상 외부 API 허용 여부를 확인한다.
   - 로컬 모델이면 아래를 확인한다:
     - 한국어 지원(다국어 모델)
     - 모델 크기
     - CPU 추론 속도
     - ONNX/WASM 실행 가능 여부
4. **배포 제약**
   - 오프라인 설치 패키지(`scripts/offline/prepare.sh`)의 조건: Bun 단일 번들, 5개 플랫폼, 망 분리 환경.
   - 모델 파일과 Chroma를 패키지에 포함할지, 별도 설치로 둘지 정한다.
   - 플러그인 4종(OpenCode, Claude Code, Cline, Pi)에서 모두 동작하는지 확인한다.
5. **채택 기준**
   - 하이브리드가 bm25보다 hit@2에서 유의미하게 개선되어야 한다.
   - 검색 1회 지연이 리뷰 시간에 비해 무시할 수준이어야 한다.
   - 임베딩이나 Chroma가 없는 환경에서도 지금과 같이 동작해야 한다.

## 관련

- `docs/todo/f-review-kb-retrieval.md` 3.4: 유사도 검색 단계 계획.
- `docs/todo/kb-bm25-korean-morphology.md`: bm25 한국어 형태소 분석. 하이브리드의 어휘 쪽 품질에 영향을 준다.
- `docs/reports/f-review-kb-search-bm25-20261021.md`: 측정 방법과 기준 수치.
