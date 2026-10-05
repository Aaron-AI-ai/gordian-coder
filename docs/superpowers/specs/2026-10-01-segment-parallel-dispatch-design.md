# f-review 세그먼트 병렬 디스패치 (segment parallel dispatch)

2026-10-01

## 문제

whole-file 모드에서 `SEGMENT_THRESHOLD`(1000줄)를 넘는 파일은 500줄(겹침 60줄)
세그먼트로 쪼개진다. 지금은 그 쪼개기가 **리뷰어 join 시점**(`start.ts
startRunFileReview`)에 일어나고, 세그먼트 전부가 **그 한 서브에이전트의 큐**에
들어간다. 2500줄 파일 = 세그먼트 5개 × (탐색 + submit [+ deepPasses]) 를 한
LLM 대화가 직렬로 처리한다.

병렬 run의 배치는 "가장 느린 unit"에 묶이므로, 대형 파일 하나가 배치 전체를
붙잡는다. 세그먼트를 다른 서브에이전트에 나눠 주는 것은 지금 구조에서 불가능하다:
세션 종료 시 `writeRunReview`가 **파일당 아티팩트 1개**(`reviews/<slug(file)>.json`)를
쓰므로, 같은 파일의 두 세그먼트는 서로의 결과를 덮어쓴다.

세그먼트 id(`path#start-end`)는 이미 프롬프트 렌더(`prompt.ts`), fcq 필터
(`fcq.ts violationsForTarget`), 겹침 중복 제거(`contract.ts dedupeFindings`)가
모두 이해하는 1급 개념이다. 이 작업은 "디스패치 단위를 파일 → unit(파일 또는
세그먼트)으로 올리는" 것이지 새 개념을 도입하는 것이 아니다.

실측 근거(`docs/reports/f-review-live-test-case1-20260824.md`): 8파일 run이
34분, 배치 상한 5 하드코딩. 같은 리포트의 "judge 컨텍스트 상한 초과로 시도 0회
terminal" 문제도 대형 파일을 통째로 judge에 보낸 데서 나왔다.

## 목표

1. 1000줄 초과 파일의 세그먼트를 **각각 별도 f-reviewer 서브에이전트**로 동시 처리
2. 취합 결과는 **실파일 단위**로 정리 — 리포트 섹션, `finding.file`, fcq 병합,
   baseline 모두 실경로 기준
3. 같은 파일의 세그먼트끼리, 그리고 다른 파일과 **아티팩트 충돌·덮어쓰기 없음**
4. 배치 상한(`RUN_BATCH_SIZE` 5)을 설정값 `batchSize`로 — 슬롯 없이 unit만 늘면
   역효과이므로 같은 작업에 묶는다
5. 기존 파일 단위 run은 **동작·아티팩트 파일명까지 변화 없음**

## 비목표

- fcq / f-fixer 경로 변경 (파일 키, 리뷰와 독립 — 그대로)
- `--sequential` 레거시 단일 세션 모드 변경
- 시스템 프롬프트 캐시 무효화 제거, dirty-tree 기본 diff 등 다른 속도 항목 (별도 PR)
- 세그먼트 크기/겹침 폭 조정
- diff 모드에서의 분할 (diff 모드에는 세그먼트가 없다)

## 설계

### 1. 데이터 모델

**`run.json` (`RunMeta`, `artifact.ts`)**

| 필드 | 변경 | 의미 |
|---|---|---|
| `targets: string[]` | 유지 | 실파일 목록. fcq/fixer 파일 목록, `filesSnapshotIdentity`, 리포트 Review Context가 계속 이걸 본다 |
| `units?: string[]` | **추가** | 디스패치 단위. `whole`이면 `targets.flatMap(p => planSegments(cwd, ref, p))`, 아니면 `targets`와 동일. **plan 시점에 1회 계산해 저장** |
| `batchSize?: number` | **추가** | 이 run의 배치 상한 (아래 §6) |

읽기 헬퍼 `runUnits(meta): string[]` = `meta.units ?? meta.targets`. `units`가 없는
구 `run.json`은 파일 단위 run으로 읽힌다.

unit을 저장하는 이유(파생 대신): 모든 참여자(리뷰어 join, judge, finalize)가 **같은
정본**을 본다는 보장을 데이터로 닫는다. 파생 방식은 "소스가 안 바뀌었다"는
가드(`sourceStale`)에 간접 의존하고, 가드가 빠지는 경로가 하나라도 생기면 join과
finalize가 다른 목록을 보는 사고가 조용히 난다. 저장하면 감사 흔적도 남고
join/finalize마다 git 줄 수를 세지 않는다.

**리뷰 아티팩트 (`FileReviewResult`, `artifact.ts`)**

| 필드 | 변경 | 의미 |
|---|---|---|
| `file: string` | 유지 | **실경로**. `finding.file === result.file` 불변식(`superRefine`) 그대로 |
| `target?: string` | **추가** | unit id. 없으면 `file`로 간주 (구 아티팩트 호환) |

- 아티팩트 파일명 = `reviewSlug(target)`. `reviewSlug`는 가독 접두 + 전체 문자열
  해시이므로 `a.java#1-500`과 `a.java#441-940`은 서로 다른 파일명이고, `#`은
  `_`로 치환된다.
- `readFileReviewResult(runId, target, cwd)`: 경로를 `reviewSlug(target)`로 찾고,
  `parsed.data.target ?? parsed.data.file === target` 검증.
- `readRunResults`의 파일명 검증 `f === reviewSlug(parsed.data.file)` →
  `reviewSlug(parsed.data.target ?? parsed.data.file)`.
- `target === file`(파일 단위 unit)이면 slug가 지금과 동일하므로 **기존 run의
  아티팩트 파일명은 바뀌지 않는다**.

**judgment 레코드 (`judge-store.ts`)**: 스키마 변경 없음. `file` 필드에 unit id가
들어간다(의미가 "unit"). 파일명 = `reviewSlug(unit)`, 기존 검증 코드가 그대로
맞는다.

**설정 (`config.ts ReviewConfigSchema`)**: `batchSize?: number`. `resolveBatchSize(cwd)`
= config 값을 `[1, 20]`으로 clamp, 없으면 `RUN_BATCH_SIZE`(5).

### 2. plan (`run.ts planReview`)

- `targets` 수집 → `MAX_RUN_TARGETS`(100) 검사는 **파일 수 기준 유지**. unit 수에는
  별도 상한을 두지 않는다 (파일 100개 × 분할 몇 개면 수백 unit — 디스크 아티팩트라
  메모리 문제 없음).
- `units` 계산: `planned.whole ? targets.flatMap(p => planSegments(cwd, afterRef(range), p)) : targets`.
- **unit 정렬 (whole-file 모드만): 라인 수 내림차순.** diff 모드는 비용이 diff 크기에
  비례하므로 정렬하지 않고 `targets` 순서를 그대로 쓴다. whole 모드에서는 배치가
  가장 느린 unit에 묶이므로 비슷한 크기끼리
  같은 배치에 들어가게 한다. 1차 키 = unit의 줄 수(세그먼트는 `end - start + 1`,
  파일은 `fileLineCount`) 내림차순, 동률은 `(path, start)` 오름차순. 한 파일의
  마지막 세그먼트는 짧을 수 있어(2500줄 → 마지막 300줄) 같은 파일의 다른
  세그먼트보다 뒤로 밀린다 — 의도된 동작. `targets` 자체의 순서는 건드리지 않는다.
  plan 출력(§6)은 이 `units` 순서 그대로 나열한다 — 나열 순서가 곧 spawn 순서.
- `batchSize: resolveBatchSize(cwd)` 저장.
- `planFingerprint`에 `units`와 `batchSize`를 넣지 **않는다** — 둘 다 `targets` +
  설정에서 결정적으로 파생되므로 동일 plan 중복 방지 의미가 변하지 않는다.

### 3. 리뷰어 join (`start.ts startRunFileReview`)

- `files=["<unit>"]` 하나로 join. 검증: `runUnits(meta).includes(unit)`.
- **bare 경로가 들어왔고 그 파일이 분할된 경우**(`unit`이 `targets`에는 있고
  `units`에는 없음): 거부 메시지가 아니라 안내를 반환한다.
  ```
  ❌ a.java is reviewed in 6 units in run <runId>. Call f_review_context with
  exactly ONE of these ids in `files`: a.java#1-500, a.java#441-940, …
  ```
  소형 모델이 plan 출력의 `#start-end`를 떼먹는 경우의 복구 경로다. 세션 상태는
  만들지 않는다.
- `state.targets = [unit]`. 이 세션의 큐는 항상 길이 1. **`planSegments` 호출
  제거**(plan이 이미 했다).
- "이미 아티팩트 있음 / rework / terminal / cap" 검사는 로직 그대로, 키만 unit.
- `fcqViolations`는 파일 전체를 넣는다(지금과 동일). 프롬프트의 `violationsForTarget`이
  세그먼트 창으로 걸러 주고, `finalCheckNotes`의 "fcq 반복 제출" 검사도 지금과 같은
  입력을 본다.
- 응답 문구: `Run <id>: reviewing a.java#441-940 (lines 441-940 of a.java) …`.
- 프롬프트 렌더(`prompt.ts reviewPromptFor`)는 세그먼트 id를 이미 처리한다. **무변경**.

### 4. 아티팩트 쓰기 (`loop.ts writeRunReview`, `run-store.ts writeFileReview`)

- `result.target = st.targets[0]`, `result.file = targetPath(target)`.
- 세그먼트 간 병합 코드(`Object.values(st.findings).flat()` → `dedupeFindings`)는
  큐 길이 1이라 no-op이지만 **삭제하지 않는다** — 비용 0, 방어적 유지.
- `writeFileReview`: revision 계산의 previous 조회를 target 키로. judgment
  revision 조회(`readRunJudgments(...).filter(j => j.file === …)`)는 unit 키로.
- 반환 경로·메시지의 파일명은 unit id.

### 5. 취합 (`run.ts finalizeRun`)

```
units       = runUnits(meta)
results     = readRunResults(runId)  (target 기준으로 읽힘)
coverage    = units  vs  { r.target ?? r.file }       → missing은 unit id
byFile      = group(results, r => r.file)
              각 그룹을 targetRange(target).start 오름차순(파일 unit은 0) 정렬
findings[f] = dedupeFindings(concat(byFile[f].map(r => r.findings)))   ← 기존 함수
fcq 병합    = 그 다음, 파일 단위 (mergeFcqFindings)                     ← 기존 순서 유지
```

- `dedupeFindings`는 바로 이 용도(겹침 구간·`inFileRelated`로 인한 세그먼트 간
  중복)로 만들어진 함수다. 입력(여러 세그먼트의 finding 묶음)과 함수가 지금의
  `writeRunReview` 경로와 동일하다. 정렬은 동점 병합의 결정성을 위한 것이다
  (`mergeDuplicate`는 fix 가중치·메시지 길이 동점이면 먼저 본 쪽이 이긴다).
- **dedupe → fcq 병합 순서는 반드시 유지.** 겹침 구간에서 두 세그먼트가 같은 fcq
  행을 후속 보고해도 dedupe가 먼저 1건으로 접은 뒤 `mergeFcqFindings`가 1:1로
  매칭한다. 순서가 뒤집히면 한 fcq 행이 두 리뷰어 finding과 각각 짝지어지거나
  하나가 남는다.
- **파일 품질 플래그 fold** (새 코드):

  | 파일 속성 | fold |
  |---|---|
  | `partial` | any |
  | `coverageComplete` | all |
  | `forced` | 비어 있지 않은 것 `";"` join |
  | `assessed` | 합집합 |
  | `explorationCalls` | 합 |

- `qualityReasons`에 나열되는 이름(`partials`, `forced`, `coverageIncomplete`,
  `judgeBelowThreshold`, `judgeUnjudged`, `judgeIncomplete`, `judgeTruncated`)은
  **unit id** — 어느 조각이 문제인지 그대로 보이게 하고, 재spawn 지시가 그 unit을
  가리키게 한다.
- judge 검사 루프(`reviewed.filter(...)`)는 unit 단위로 돈다. `resultByFile`은
  `resultByUnit`으로.
- 응답 문구: 분할이 하나라도 있으면 `N unit(s) across M file(s)`, 없으면 지금과
  동일한 `M file(s)`.
- 리포트 `Review Context` 부록: 파일 목록은 그대로, 분할 파일 뒤에 `(5 segments)`.
- `finalizeFingerprint`의 `results` 항목은 `{ target, hash }`로 — 같은 파일의
  세그먼트 둘이 같은 키로 뭉개지지 않게.

### 6. plan 출력·오케스트레이터 지시문 (`run.ts renderPlanInstructions`, `prompts.ts`)

`units` 순서(§2의 정렬) 그대로 한 줄에 하나씩 나열한다. 세그먼트 unit은 어느
파일의 몇 번째 조각인지 주석을 단다. 나열 순서 = spawn 순서:

```
Run created: <id> — 3 file(s) → 8 unit(s), mode: explicit files · whole-file.
Units (spawn in this order; a large file is split into segment units — ONE f-reviewer per unit):
  - b.java
  - a.java#1-500        (segment 1/6 of a.java, 2500 lines)
  - a.java#441-940      (segment 2/6 of a.java)
  - a.java#881-1380     (segment 3/6 of a.java)
  - a.java#1321-1820    (segment 4/6 of a.java)
  - a.java#1761-2260    (segment 5/6 of a.java)
  - c.java
  - a.java#2201-2500    (segment 6/6 of a.java)
```

(위 예에서 b.java 700줄, c.java 400줄, 마지막 세그먼트 300줄.)

- spawn 프롬프트: `"Call f_review_context with runId=\"<id>\" and files=[\"<unit id exactly as listed above, including any #start-end suffix>\"], …"`.
- 배치 문구: `Spawn at most ${meta.batchSize} subagents at a time; …`.
- 명령 템플릿(`prompts.ts REVIEW_COMMAND_TEMPLATE`)의 하드코딩 `At most 5 subagents
  in flight` → `At most the number of subagents the plan states in flight` — 숫자
  출처를 plan 하나로.
- judge 지시문의 `file="<file>"` → `file="<unit id>"`, "after EACH f-reviewer" 는
  unit 기준.
- missing 재시도 지시(`Re-spawn ONE f-reviewer subagent per missing file`) → `per
  missing unit`.
- fix pass 목록은 **파일 단위 그대로**(`targets` 기반) — fixer는 리뷰와 독립.

### 7. judge (`judge.ts`, `judge-store.ts`, `judge-prompt.ts`)

- 도구 인자 이름 `file`은 유지하되 **unit id를 받는다**
  (`f_review_judge_context(runId, file="a.java#441-940")`). 저장소 키·검증·rework
  카운트·피드백 조회 전부 이 값 기준. 코드 내부의 매개변수명은 `target`으로 바꿔
  의미를 드러낸다(외부 스키마 불변).
- 소스를 읽는 지점(`changeExcerpt`, 선언 수집)만 `targetPath(target)`로 실경로 변환.
- `changeExcerpt`에 세그먼트 분기: `targetRange(target)`가 있으면 base를 그 범위의
  `renderFileContent(file, content, start, end, …)`로 만든다. 500줄 세그먼트는
  대개 `JUDGE_CHANGE_MAX_BYTES`(24,000 B ≈ 500줄) 안에 들어 base 전체가 보이고,
  넘치면 기존 윈도우/part 메커니즘이 그대로 받는다. finding의 `line`은 실제 줄
  번호이므로 `visibleTo`/윈도우 계산은 범위 오프셋만 반영하면 된다.
- 겹침 구간의 finding은 양쪽 unit에서 보이므로 각자 채점된다. finalize dedupe가
  접는다.
- `meta.targets.includes(file)` 검증(`judge.ts` 2곳, `fixer.ts`는 제외)은 `runUnits(meta)`.
- `judgeFeedbackFor`, `reviewReworkStatus`, `reworkCount`, `currentReviewTerminal`:
  시그니처의 `file` → unit. `start.ts`가 넘기는 값도 unit.
- 재리뷰 지시는 그 unit만 재spawn. rework cap은 unit별.

### 8. 영향 없는 것 (명시)

- `prompt.ts`, `segment.ts`, `template.ts`, `dossier.ts` — 세그먼트 렌더는 이미 됨
- `fcq.ts` — 파일 키(`reviewSlug(file)` 샤드), `violationsForTarget` 이미 세그먼트 인식
- `fixer.ts` — 파일 키, `meta.targets` 기준 유지
- `--sequential` (`startReviewUnlocked`) — 자체적으로 `planSegments`를 돌려 한 세션
  큐에 넣는 지금 동작 유지
- 리포트 렌더(`output.ts renderReport`) — 실경로 키로 받음
- baseline(`baselineKey(file, rule)`) — 실경로

## 호환성

- `units` 없는 `run.json`: `runUnits`가 `targets`를 돌려주므로 파일 단위 run으로
  동작. 진행 중인 run이 플러그인 업데이트를 넘겨도 깨지지 않는다.
- `target` 없는 아티팩트: `target = file`로 읽힌다.
- 파일 단위 unit의 아티팩트 파일명은 `reviewSlug(file)` 그대로 — 기존 run 디렉터리
  의 coverage·finalize 캐시(`finalize.json` fingerprint)가 그대로 맞는다.
  단 `finalizeFingerprint`의 results 키가 `file` → `target`으로 바뀌므로 **진행 중
  run의 finalize 캐시는 1회 무효화**된다(재finalize하면 같은 리포트를 다시 쓴다).
  허용.

## 테스트 계획 (TDD — 실패 확인 후 구현)

| # | 대상 | 검증 |
|---|---|---|
| 1 | plan | whole 모드: `units`가 세그먼트로 전개, `targets`는 파일 그대로, 라인 수 내림차순 정렬 / diff 모드: `units === targets` / `batchSize` config 반영·clamp·기본 5 |
| 2 | plan 출력 | 분할 파일이 묶여 나열되고 spawn 지시가 unit id를 가리킴, 배치 숫자가 `batchSize` |
| 3 | join | unit id로 join 성공(`state.targets.length === 1`), bare 경로는 unit 목록 안내 반환 + 상태 미생성, 다른 run의 unit·존재하지 않는 unit 거부 |
| 4 | 아티팩트 | 같은 파일 두 unit이 다른 파일명에 써지고 서로 안 덮어씀; `target` 없는 구 아티팩트는 `target=file`로 읽힘; 파일 unit의 slug는 기존과 동일 |
| 5 | finalize 취합 | unit 2개(겹침 구간 중복 finding 포함) → 리포트 파일 1섹션, 중복 1건으로 접힘, 겹침 구간 fcq 행이 1:1로 1건만 병합 |
| 6 | finalize 품질 | unit 1개 누락 → `missing`에 그 id; unit 1개 partial → 파일 partial, qualityReasons에 unit id; assessed 합집합 |
| 7 | judge | unit 단위 context가 그 범위만 렌더하고 `line`이 실제 줄 번호; 판정·rework·cap이 unit별로 격리되어 같은 파일의 다른 unit에 영향 없음 |
| 8 | 회귀 | 기존 `__tests__` 전부 녹색(현재 897 pass). 파일 단위 run의 아티팩트 파일명·finalize 응답 문구 불변 |

## 리스크와 완화

| 리스크 | 완화 |
|---|---|
| 소형 모델이 `#start-end`를 떼먹고 bare 경로로 join | §3의 안내 메시지가 정확한 id 목록을 돌려줌 (도구 메시지가 소형 모델의 가드레일) |
| 세션 간 컨텍스트 단절 — 앞 세그먼트를 본 상태로 뒤를 리뷰하던 효과 상실 | 이미 있는 60줄 겹침 + `inFileRelated`(창 밖 선언 주입). 실환경 1회 대조 테스트로 품질 확인 |
| unit 증가로 배치 수 증가 | `batchSize` 설정화를 같은 작업에 포함. 라인 수 내림차순 정렬 |
| 토큰 비용 증가 (세그먼트마다 evidence·룰을 새 세션에 다시 보냄) | 허용된 트레이드오프. 별도 PR의 캐시 무효화 제거와 상쇄 |
| 아티팩트 파일명 검증을 target으로 안 바꾸면 세그먼트 아티팩트가 전부 무시되어 coverage 0 | 테스트 #4·#6이 고정 |

## 작업 환경

워크트리 `.claude/worktrees/segment-parallel-dispatch`, 브랜치
`worktree-segment-parallel-dispatch` (develop d6f88ee 기반). 스펙·계획·구현 커밋 모두
이 브랜치.

구현 완료: 2026-10-05, 브랜치 worktree-segment-parallel-dispatch. 계획:
`docs/superpowers/plans/2026-10-05-segment-parallel-dispatch.md`.

## 참고

- `docs/reports/f-review-live-test-case1-20260824.md` — 34분 실측, judge 상한 문제
- `docs/superpowers/specs/2026-09-09-judge-fixer-part-splitting-design.md` — judge
  part 분할(이 작업이 기대는 기존 윈도우/part 메커니즘)
- `src/core/review/contract.ts` 88-172행 — `dedupeFindings` 설계 의도
