# f-review 설계 스펙

> OpenCode 플러그인으로 동작하는 코드 리뷰 기능. 이 문서를 보고 개발한다.

## 1. 개념

코드 리뷰 슬래시 명령으로 **git 커밋 / 대상 파일**을 입력하면, 해당 코드를 룰 기반으로 리뷰한다.

- **리뷰 주체**: LLM. 도구·훅은 컨텍스트 수집·룰 주입·커버리지 검증 등 **결정적인 부분만** 강제한다.
- **리뷰 기준**: `.aidlc-rule-details/` 의 룰(security-baseline, nfr-design, code-generation Critical Rules, build-and-test 등)을 체크리스트로 사용.
- **동작 형태**: 단발 시퀀스가 아니라 **에이전트 루프**. LLM이 분석 → 필요한 코드/정보를 추가 도구로 파악 → 다시 분석 → "done(submit)" 통과 시 종료.

---

## 2. OpenCode 플러그인 제약 / 사용 훅

| 능력 | OpenCode 실체 | 용도 |
|------|---------------|------|
| 커스텀 도구 | `tool: { [key]: ToolDefinition }` | 리뷰 도구 8종 등록 |
| 시스템 프롬프트 주입 | `experimental.chat.system.transform` | 템플릿·룰·루프규칙 주입 (실험 API → 어댑터에 격리) |
| 도구 호출 검증/가공 | `tool.execute.before` / `tool.execute.after` | 커버리지 검증, 루프 가드, 리포트 저장 |
| 사용자 입력 가로채기 | `chat.message` (읽기 전용) | 프롬프트 수정 **불가** → 주입은 반드시 system.transform |

> ⚠️ OpenCode에는 "skill" 프리미티브가 없다. 슬래시 진입점은 `.opencode/command/*.md` 네이티브 command 파일, 재사용 리뷰 페르소나는 `.opencode/agent/*.md` 로 매핑한다. (Claude Code 경로에서는 실제 Skill로 노출 가능.)

---

## 3. 입력 계약

```ts
const CommitSpec = z.union([
  z.string(),                                       // 단일 ref("HEAD","<sha>") 또는 범위("A..B")
  z.object({ from: z.string(), to: z.string().default("HEAD") }),
]);

const ReviewInputSchema = z.object({
  commit:  CommitSpec.optional(),
  files:   z.array(z.string()).optional(),
  whole:   z.boolean().optional(),           // diff 대신 파일 전체를 리뷰 대상으로
  exclude: z.array(z.string()).optional(),   // 추가 파라미터 (glob)
  output:  z.string().optional(),            // 산출물 경로 (파일 또는 디렉터리)
});
```

두 입력(commit/files)은 **각각 선택**, 합집합으로 대상 파일을 모은 뒤 exclude로 뺀다:

```
대상 = (commit diff 파일) ∪ (files)  −  exclude
```

`whole: true`이면 각 대상 파일의 리뷰 프롬프트에 diff 대신 **파일 전체 내용(라인번호 포함)**을 주입한다.
대상 파일 집합을 고르는 방식(commit/files)은 그대로이고, 리뷰 근거만 diff → 전체 파일로 바뀐다.

큰 파일(약 1000줄 초과)은 통째로 넣으면 품질이 떨어지므로 **겹치는 라인 세그먼트로 분할**해
각 세그먼트를 별도 리뷰 대상(`path#start-end`)으로 큐에 넣는다(세그먼트당 500줄, 60줄 겹침).
각 세그먼트에는 **그 구간이 참조하지만 선언은 구간 밖에 있는 같은 파일 내 심볼**(함수/클래스/const 등)의
선언부를 **전부**(개수 제한 없음, 과도한 경우 문자수 백스톱 24k에서만 절단) 함께 주입해,
연관 코드를 세그먼트와 같이 읽고 리뷰하도록 한다(결정론적, 정규식 기반).
findings는 세그먼트 단위로 수집하되 **리포트는 실제 파일 단위로 병합**한다. (`segment.ts`)

### 3.1 commit diff 범위 해석

```ts
function resolveDiffRange(commit, hasFiles) {
  if (!commit) return hasFiles ? null : "HEAD~1..HEAD"; // 아무것도 없으면 최근 commit
  if (typeof commit === "object") return `${commit.from}..${commit.to ?? "HEAD"}`;
  if (commit.includes("..")) return commit;                  // "A..B"
  return `${commit}~1..${commit}`;                           // 단일 커밋의 변경분
}
```

| 입력 | diff 범위 |
|------|-----------|
| (없음, files도 없음) | `HEAD~1..HEAD` — **최근 commit** |
| `--commit=HEAD` | `HEAD~1..HEAD` |
| `--commit=<sha>` | `<sha>~1..<sha>` |
| `--commit=A..B` | `A..B` |
| `--from=A --to=B` | `A..B` |
| `--from=A` | `A..HEAD` |
| files만 | commit diff 없음, 파일집합만 |

> commit 기본값(HEAD)은 files가 **비었을 때만** 적용 → "파일만 리뷰" 의도에 최근 커밋이 섞이지 않음.

### 3.2 exclude (예외 경로)

- 출처: `.f-review.json` 의 `exclude` ∪ `--exclude` 파라미터 (**합집합**, 파라미터는 추가만)
- 매칭: `Bun.Glob` (의존성 추가 없음)

**기본 제외 (`isDefaultExcluded`) — 설정으로 끌 수 없음**

사용자 exclude보다 **먼저** 적용되며, `files`로 명시한 경로에도 예외 없이 적용된다:

| 규칙 | 예시 |
|---|---|
| 경로 세그먼트가 `.` 으로 시작 | `.gitignore`, `.github/workflows/ci.yml`, `.f-review.json`, `src/.hidden/x.ts` |
| 컴파일 산출물 | `build/Foo.class` |

즉 **`--files=.github/workflows/ci.yml` 은 조용히 무시된다** (경고 없음. 요청한 파일이 전부 여기 걸리면
`No files to review (empty target set after excludes)` 만 뜬다). 리뷰 체크리스트가 소스코드 기준
(correctness/security/performance/maintainability/tests/framework)이고, 닷 네임스페이스는 에디터 상태·VCS 메타데이터·빌드 캐시가
대부분이라 노이즈가 되기 때문이다.

> ⚠️ **CI 워크플로 리뷰는 이 설계가 의도적으로 포기한 영역이다.** 필요해지면 이 조건을 느슨하게 풀지 말고
> opt-in 스위치(예: `.f-review.json` 의 `includeDotPaths`)를 추가할 것 — 막고 있는 노이즈가 이 규칙의 존재 이유다.

```ts
const patterns = [...(readConfig()?.exclude ?? []), ...(input.exclude ?? [])];
const globs = patterns.map(p => new Bun.Glob(p));
const targets = collected.filter(f => !globs.some(g => g.match(f)));
```

### 3.3 output (산출물 위치)

report와 manifest는 서로 다른 트리에 저장한다.

- **report**: 우선순위 `--output` > `.f-review.json` 의 `output` > 기본 `fcq/report/f-review/`. 디렉터리 대상이면 파일명에 날짜가 붙는다(`review-<label>-<yyyymmdd>.md`).
- **manifest**: 고정 `fcq/f-review/manifest/review-<label>-targets.md`. 파일명에는 날짜를 넣지 않고, 본문에 생성 시각(UTC)을 기록한다.
- **백업**: report 기록 시 `f-review` report 폴더가 이미 있으면 `f-review.<yyyymmdd-hhmmss>`로 폴더째 백업한 뒤 새로 쓴다. (임의의 `--output` 디렉터리는 백업 대상이 아니다 — 폴더명이 `f-review`일 때만.)

```ts
function resolveOutputPath(opt, label /* commit short sha | timestamp */, cwd, date = new Date()) {
  const p = opt ?? readConfig()?.output ?? "fcq/report/f-review/";
  if (p.endsWith("/") || isDir(p)) return `${p}review-${label}-${ymd(date)}.md`;
  return p;
}
function resolveManifestPath(label) {
  return `fcq/f-review/manifest/review-${label}-targets.md`;
}
```

| 입력 | report 파일 |
|------|-----------|
| (없음) | `fcq/report/f-review/review-<sha|ts>-<yyyymmdd>.md` |
| `--output=reports/` | `reports/review-<sha|ts>-<yyyymmdd>.md` |
| `--output=reports/pr-42.md` | `reports/pr-42.md` |
| config `"output":"docs/rv/"` | `docs/rv/review-<sha|ts>-<yyyymmdd>.md` |

> 디렉터리는 없으면 자동 생성(`{recursive:true}`). label은 commit 있으면 short sha, 없으면 타임스탬프(덮어쓰기 방지).

---

## 4. 도구 (tool) 12종

| 도구 | 시점 | 역할 |
|------|------|------|
| `f_review_plan` | 병렬 run 진입 1회 | 대상 수집 + run 생성(`fcq/f-review/runs/<runId>/run.json`) + fan-out 지시 반환 (오케스트레이터 전용) |
| `f_review_context` | 진입 1회 | 대상 파일 수집 + 룰 로드 + diff 스냅샷 + 세션 상태 초기화. `runId` 지정 시 run 합류: **정확히 1개 파일**만 리뷰 (설정은 run.json 공유) |
| `file_read` | 루프 중 | 파일 after-버전 읽기(라인범위·라인번호·500줄 cap·IS_TRUNCATED) |
| `file_read_diff` | 루프 중 | 다른 변경 파일의 diff 읽기(DiffMap 스냅샷, 다중경로) |
| `file_find` | 루프 중 | 파일명 부분일치 검색(basename, 100건 cap) |
| `code_search` | 루프 중 | git grep 검색(pathspec·정규식·100건 cap, 파일별 그룹핑) |
| `related_code` | 루프 중 | import·심볼 사용처·테스트·동시변경 이력을 점수화해 연관 코드 후보(+요청 시 미리보기) 제공 |
| `git_history` | 루프 중 | 최근 커밋 의도·동시변경 파일·선택적 과거 patch 제공 |
| `f_review_submit` | done 시도 | 구조화 결과 제출 → 검증 게이트. run 모드 완료 시 취합 리포트 대신 **개별 리뷰**(`runs/<runId>/reviews/<파일>.md`+`.json`)를 씀 |
| `f_review_judge_context` | judge 진입 | 고정된 변경 excerpt·제출 findings·판정 기준을 반환. 전체 판정 근거가 bounded context에 들어가지 않으면 artifact-bound `INCOMPLETE`로 종료 |
| `f_review_judge` | judge 제출 | 모든 finding index의 판정과 coverage를 검증하고 threshold로 PASS/REWORK를 결정. malformed/rework 반복은 유한 상한 뒤 `INCOMPLETE` |
| `f_review_finalize` | 병렬 run 종료 1회 | 커버리지 검증(기대 vs 작성) + 개별 json 취합 → 최종 리포트 + Run Summary(누락/부분/무탐색 감사) 작성 (오케스트레이터 전용) |

**병렬 run (Model A)** — `/f-review`는 기본적으로 오케스트레이터로 동작:
`f_review_plan` → 파일당 f-reviewer 서브에이전트 1개(배치 최대 `RUN_BATCH_SIZE`=5) → `f_review_finalize`.
공유 상태는 전부 **디스크**(run.json + reviews/)라 메모리 누적이 없다. 방어: run당 `MAX_RUN_TARGETS`=100 하드캡,
서브에이전트는 run 타깃 밖 파일·복수 파일 거부, 개별 리뷰는 덮어쓰기(재시도 idempotent), 누락 재스폰은 1회,
완료된 run 디렉토리는 최근 `RUNS_KEEP`=10개만 유지한다. 미완료 run은 최대 10개로 제한하고,
최근 artifact/judgment 활동 후 24시간 동안 보호하며 그보다 오래 멈춘 run만 abandoned로 정리한다. 동일 plan의 fingerprint는
프로세스 간 lock으로 원자적으로 claim하여 동시 재호출도 기존 미완료 run 하나만 재사용한다. plan은 diff ref를 commit SHA로 고정하고,
files-only 소스와 유효 룰의 hash를 저장하므로 작업 시작·종료 시점에 스냅샷이 달라지면 성공으로 finalize하지 않는다. 큰 파일 세그먼트는 **한 서브에이전트 안에서** 순차 처리 후
파일당 1개 리뷰로 병합. `--sequential` 또는 runId 없는 `f_review_context` = 기존 단일 세션 순차 모드(불변).

**정적분석 연동 (`fcq`)** — `--fcq` 또는 설정 `"fcq": true`이면 `f_review_plan`이 팬아웃 **전에**
[fico-code-q](../../../fico/fico-code-q) CLI를 run당 1회 실행한다(`fcq analyze <cwd> --paths=<타깃 목록> …`).
병렬이 아니라 선실행인 이유: fcq는 수 초, LLM 리뷰는 수 분이라 병렬화 이득이 없고, 결과를 리뷰어에게
**증거로 주입**할 수 있기 때문이다. `report.json`(대상 프로젝트 `fcq.yaml`의 `report.output`)을 파싱해
`runs/<runId>/fcq/files/<slug>.json`(파일별 위반)과 `summary.json`으로 샤딩하며, 원본은 복사하지 않는다.
- 리뷰어(`f_review_context`)는 자기 파일 샤드만 읽어 `<review_evidence>` 맨 앞에 "이미 발견됨 — 재보고 금지,
  단서로 활용" 섹션을 넣는다(세그먼트는 라인 창 안의 위반만). judge 컨텍스트에도 같은 블록이 들어가
  coverage gap 감점을 막는다.
- `f_review_finalize`는 샤드를 `Finding`(rule `fcq:<analyzer>/<ruleId>`, severity INFO→nit…CRITICAL/BLOCKER→blocker,
  category bugs→correctness·sql/security→security·architecture/framework-*→framework·기타→maintainability)으로
  변환해 같은 파일 표에 병합하고, `## Static Analysis (fcq)` 요약 섹션을 Review Context 앞에 붙인다.
  fcq finding도 `failOn` verdict에 포함된다. fcq는 수정안이 없으므로 suggestion은 위반 스니펫(AS-IS) +
  룰 description(TO-BE)이다. **같은 line에 앵커되고 message/rule에 그 ruleId를 언급한** LLM finding은
  리뷰어의 후속 분석으로 보고 fcq 행에 병합한다(`mergeFcqFindings`): rule은 fcq 것, severity는 둘 중
  높은 쪽, message에 `리뷰어: …` 추가, suggestion은 LLM의 AS-IS/TO-BE로 교체. line만 같은 finding은
  별개 행으로 남긴다(무관한 논리 결함이 LineLength 행에 섞이는 것 방지).
- **실패 시**(바이너리 없음·종료코드 2·타임아웃·report.json 없음·`report:` 미설정): LLM 리뷰는 그대로 진행하되
  run.json에 `fcq.status: failed`를 기록하고, `failOn`이 있으면 finalize가 fail-closed(`INCOMPLETE`)한다.
- 옵션은 `.f-review.json` `fcqOptions` `{ bin, analyzers, module, config, maxSeverity, noBuild, buildTimeout, timeout }`.
  run 모드 전용(`--sequential`/MCP 경로는 무시). fcq에 `--report-dir`가 생기면 `locateReport`만 교체하면 된다.

**자동 주입 evidence 정책** — `{{review_evidence}}`의 **크로스파일 연관은 프리뷰를 넣지 않고 경로 목록만** 준다.
앞부분 프리뷰는 대개 그 파일의 import/헤더라 리뷰 대상이 실제 호출하는 함수를 놓치기 때문. 대신
"이 프로젝트 파일들에서 네가 쓰는 심볼은 `code_search(<symbol>)`/`file_read`로 정의부를 확인하라"는 recipe를
붙여, 모델이 **리뷰 중인 세그먼트/diff가 실제 참조하는 심볼**을 grep으로 집어오게 한다(세그먼트 맞춤이 자동으로 성립).
같은 파일 내부 연관 선언은 `segment.ts`가 세그먼트 단위로 직접 주입한다. (프리뷰 자체는 on-demand `related_code`에는 남아 있음.)

import resolver가 저장소 파일로 연결하지 못한 specifier는 **미해결(unresolved)** 로만 표시한다. TS/JS path alias·barrel index,
Python package, Java source-root/static import처럼 저장소 내부인데 휴리스틱이 놓치는 경우가 있으므로 이를 곧바로
"외부 의존성"이라고 단정하거나 `NEVER search`를 지시하지 않는다. 확실한 내부 후보는 resolver가 evidence에 연결하고,
남은 항목은 짧은 targeted lookup만 허용한 뒤 일반 탐색 예산으로 수렴시킨다.

**공통 `FileReader(cwd + ref)`** 추상화로 3모드를 한 곳에서 처리:
- `ref === null` → **workspace** 모드 (working tree / untracked)
- `ref`가 git ref → **ref** 모드 (해당 commit/range 끝 시점 파일을 `git show`/`ls-tree`/`git grep <ref>`로 읽음)
- 비-git 디렉터리 → fs walk / `git grep --no-index` 폴백

`ref` = `afterRef(diffRange)` ("A..B" → "B", 단일 ref → 그대로, null → workspace).

`mode: reference` 프로젝트 룰은 working-tree 스냅샷에서 제공하되 일반 `file_read`와 동일한 line slicing,
라인 번호, 500줄/16KB cap을 적용한다. reference라는 이유로 원문 전체를 컨텍스트에 주입하지 않는다.

---

## 5. 동작 원리 — 에이전트 루프

### 5.1 반복의 엔진

우리가 `while`을 짜지 않는다. LLM 에이전트는 원래 루프다:

```
[LLM 응답] → 도구 호출 → OpenCode가 실행 → 결과를 LLM에 돌려줌 → [LLM 응답] ↺
            └ 도구 안 부르고 글로 답 → 끝
```

**도구를 부르는 한 자동으로 계속 돈다.** 반복을 "시키는" 레버는 **도구가 LLM에게 돌려주는 결과 텍스트**다.

- 결과 = "아직 부족. 보안 누락. 계속하라" → LLM이 또 도구 호출 (한 바퀴 더)
- 결과 = "통과. 완료" → LLM이 더 부를 게 없어 마무리 (멈춤)

### 5.2 종료(DONE) 정의

`f_review_submit` 호출 **+** 커버리지 검증 통과. submit이 모델의 "done 선언"이고, 게이트가 통과시켜야만 실제 종료된다. 미달이면 같은 도구 응답이 루프를 계속 돌린다.

### 5.3 무한루프 가드

탐색 도구(file_read·code_search·file_find·file_read_diff·related_code·git_history) 호출이 `MAX_ITER` 초과 → 결과를 **보류**하고 "지금 정보로 submit 하라"만 반환 → 강제 수렴.
동일 인자 반복 호출은 `MAX_DUP_CALLS`회까지만 응답한다.
예산(iterations·중복 호출 장부)은 타깃 전진 시점, **딥패스 라운드 전환 시점**, 그리고 **최종 점검(final check) 바운스 시점**에 리셋된다(§12 참조) — 바운스 지시문이 재검증(재읽기)을 요구하기 때문이다.

**세션 레벨 동일-호출 가드 (어댑터, repeat-guard)**: OpenCode의 `tool.execute.before/after` 훅에서 모든 도구의 동일 호출(도구+정규화한 인자) 연속 반복을 감시한다. `REPEAT_LIMIT`(3) 연속이면 **명시적으로 조회성인 도구에 한해서만** 출력을 보류하고 "다른 행동을 하라" notice로 교체한다. `bash`와 알 수 없는 플러그인 도구는 상태를 바꿀 수 있으므로 조회성 목록에 넣지 않는다. `f_review_submit`/`f_review_judge`/plan/context/finalize처럼 상태를 바꾸는 도구도 실행 후 결과를 절대 가리지 않는다. 상태는 이미 전진했는데 다음 파일·리포트 경로 응답만 숨기면 동일 payload가 새 상태에 재적용될 수 있기 때문이다. 코어의 bounded terminal/idempotency와 OpenCode agent `steps` 상한이 이 경로의 최종 안전핀이다.

연속 동일 호출뿐 아니라 최근 네 호출의 `A-B-A-B` 패턴도 감지한다. 특히 `code_search("X")`와 `file_find("X")`는 검색어를 정규화한 동일 lookup intent로 묶어, 도구 이름을 번갈아 반복 가드를 우회하지 못하게 한다. 감지 즉시 탐색을 봉인하고 `f_review_submit`만 생산적인 출구로 남긴다.

**세션 전체 하드 예산 (`maxToolCalls`)**: OpenCode reviewer의 context·탐색·submit을 모두 합친 호출 상한이며 기본 10, 최소 3이다. `maxIter`와 달리 파일 전진·딥패스·최종 점검·idle 재개에서 절대 리셋되지 않는다. 마지막 두 호출은 submit/수정 submit용으로 예약한다. 상한 번째 호출이 submit이 아니면 실행 전에 차단하고 세션을 abort하며, 상한 번째 submit 뒤에도 리뷰가 활성 상태면 `INCOMPLETE`로 부분 종료한다. 예산 소진 세션은 idle watchdog이 재개하지 않는다.

`HARD_LIMIT`(6) 도달 시 **격상**: 활성 리뷰 세션이면 탐색을 영구 봉인해 어떤 탐색 도구를 불러도 강제 수렴 메시지가 나가고, 유일한 생산적 출구는 `f_review_submit`이 된다. 이 봉인은 라운드 전환에서도 리셋되지 않아 퇴화 모델에 새 루프 활주로를 주지 않는다.

**네이티브 탐색 도구도 같은 예산을 쓴다**: 리뷰 활성 세션에서 네이티브 `glob`/`grep`/`read`/`list`/`lsp`/웹 검색 도구 호출은 after-hook에서 `guardExploration`을 통과한다 — `MAX_ITER` 예산 소모 + 동일 인자 반복(`MAX_DUP_CALLS`, **비연속 반복 포함**) 차단. `bash`는 상태 변경 가능성이 있어 사후 출력을 가리거나 조회 예산으로 오분류하지 않는다(번들 reviewer/judge에서는 기본 거부). 출력 문자열은 검사하지 않으므로 miss-streak은 f-review 탐색 도구 전용으로 유지된다.

**강제 전진은 성공이 아니다**: schema-invalid/coverage-missing 제출이 상한을 넘으면 findings를 가능한 만큼 salvage하고 다음 대상으로 전진해 세션은 반드시 끝낸다. 단, 이 terminal escape는 품질 상태를 `INCOMPLETE`로 남긴다. 최종 응답과 영속 리포트는 `Review complete`/`PASS`를 출력하지 않으며, `failOn` CI 게이트는 fail-closed 한다. 강제 전진 artifact는 존재하므로 missing 재실행 목록에는 넣지 않는다.

OpenCode/MCP 도구 계약에서 `f_review_context`가 발급하는 `submitToken`은 필수이며 현재 타깃·라운드에만 유효하다. 이전 응답을 그대로 재생한 stale submit은
상태를 전진시키지 않으며, 올바른 토큰 제출 또는 bounded terminal 경로로만 수렴한다. Judge도 모든 finding index를
`0..N-1` 정확히 한 번씩 판정해야 하고, 저장된 리뷰·판정 JSON을 Zod와 교차 필드 규칙으로 다시 검증한다. 고정된
judge 컨텍스트 안에 변경 전체와 필요한 finding evidence를 담을 수 없으면 부분 문맥으로 PASS하지 않고 terminal `INCOMPLETE`로 fail-close 한다.

**OpenCode 에이전트 권한**: f-reviewer/f-judge는 agent `permission`의 `"*": "deny"`에서 시작해 필요한 f-review 도구만 명시적으로 허용한다. 새 built-in, 플러그인, MCP 도구가 설치되어도 reviewer의 ref/탐색 예산이나 judge의 고정 컨텍스트를 우회할 수 없어야 한다.

---

## 6. 프롬프트 주입 + 파일 단위 템플릿

주입은 `experimental.chat.system.transform` 에서 **시스템 프롬프트**에 한다(세션이 `active`일 때만). 템플릿은 **파일 단위**(current_file)라 루프도 파일 하나씩 진행한다.

### 6.1 템플릿 — `core/review/template.ts`

```
You are a code reviewer. Review the change in <current_file_diff> against the checklist.

// The following is the list of other files changed in this update.
<other_changed_files>
{{change_files}}
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

<current_file_diff>
{{diff}}
</current_file_diff>

Current time in the real world: {{current_system_date_time}}

<user_task>
### Requirement Background (Optional)
{{requirement_background}}

### Review Checklist
{{system_rule}}

### Review Plan (Optional)
{{plan_guidance}}

Now please review the code changes in <current_file_diff>.
When you need more context, use file_read / code_search / file_find / file_read_diff / related_code / git_history.
When done with THIS file, call f_review_submit.
</user_task>
```

### 6.2 변수 → 출처 매핑

| 변수 | 출처 | 비고 |
|------|------|------|
| `{{change_files}}` | state.targets 중 **현재 파일 제외** 목록 | 다른 변경파일 컨텍스트 |
| `{{current_file_path}}` | `state.targets[currentIndex]` | 루프 포인터 |
| `{{diff}}` | context.ts — 그 파일의 git diff hunk | |
| `{{review_evidence}}` | evidence.ts — 연관 코드 **경로 목록 + grep recipe**·최근 Git 이력 | 파일별 lazy 생성·캐시 (프리뷰 X, 아래 참고) |
| `{{current_system_date_time}}` | 시스템 시계(ISO) | |
| `{{requirement_background}}` | slash 인자/param (선택) | 없으면 블록 생략 |
| `{{system_rule}}` | rubric.ts — `.aidlc-rule-details` 체크리스트 | |
| `{{plan_guidance}}` | param/config (선택) | 없으면 블록 생략 |

### 6.3 치환 (템플릿 엔진 없음)

```ts
function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}
// 선택 블록: requirement_background·plan_guidance가 비면 해당 ### 섹션 줄 제거
```

---

## 7. 전체 워크플로우

```
/f-review <commit> --files=… --exclude=… --output=…
  ▼  [진입점: .opencode/command/f-review.md, $ARGUMENTS]
① f_review_context → targets[] 정렬·룰·배경·plan 수집, state 시드(currentIndex=0)
  ▼
② system.transform → render(template, 현재파일 변수) 주입        ← 변수 치환 주입
  ┌──── 현재 파일 LOOP (네이티브 에이전트 루프) ─────────────
  │  LLM 분석
  │   ├─ 정보 필요 → ③ file_read·code_search·file_find·file_read_diff·related_code·git_history → 다시 분석 ↺
  │   └─ 이 파일 끝 → ④ f_review_submit(findings)
  │        ▼ hook: tool.execute.after (검증)
  │        ├─ 이 파일 룰 미커버 → "누락:{X} 계속" ───────────┘ (현재 파일 유지·반복)
  │        └─ 통과 → findings 저장, currentIndex++
  └──────────┬──────────────────────────────────────────────
             ├─ 다음 파일 있음 → ②로 (다음 파일 변수 재주입) ↺
             └─ 더 없음 → finalize:
                   renderReport(findings) → Bun.write(resolveOutputPath) → 저장 경로 회신
  ⛔ 가드: fetch 반복 > MAX_ITER → "마무리·submit 하라" 주입
```

핵심: **submit 통과 = 다음 파일로 포인터 이동**. system.transform은 항상 **현재 파일**의 변수를 치환해 주입. 모든 파일 소진 = 전체 done → 리포트 저장.

---

## 8. 검증 강제화 (2겹)

1. **프롬프트 주입**(system.transform) = LLM에게 말로 시킴 → 부드러운 유도
2. **검증 게이트**(submit 결과) = 무시하면 결과로 막음 → 강한 강제

```ts
// adapters/opencode/review/index.ts (스케치)
"tool.execute.after": async (input, output) => {
  const st = stateFor(input.sessionID);

  if (input.tool === "f_review_fetch") {
    st.iterations++;
    if (st.iterations > MAX_ITER)
      output.output += "\n\n⚠️ 탐색 한도 도달 — 지금 정보로 f_review_submit 하라.";
    return;
  }
  if (input.tool !== "f_review_submit") return;

  const missing = st.categories.filter(c => !covered(parsed, c));
  if (missing.length) {                          // DONE 거부 → 루프 지속
    output.output = `❌ 미완료 — 누락 카테고리: ${missing.join(", ")}. 계속 분석 후 재제출.`;
    return;
  }
  st.findings[st.targets[st.currentIndex]] = parsed.findings;
  st.currentIndex++;                             // 다음 파일
  if (st.currentIndex < st.targets.length) {
    output.output = `✅ 파일 통과. 다음 파일 review 진행.`;
  } else {                                       // 전체 done → 저장
    st.active = false;
    const path = resolveOutputPath(st.output, st.label);
    await writeReport(path, st.findings);
    output.output = `✅ 리뷰 완료 → ${path}`;
  }
};
```

### submit 스키마 (커버리지 강제의 핵심)

```ts
const REQUIRED_CATEGORIES = ["correctness","security","performance","maintainability","tests"] as const;

const FindingSchema = z.object({
  category: z.enum(REQUIRED_CATEGORIES),
  severity: z.enum(["blocker","major","minor","nit"]),
  file: z.string(), line: z.number().optional(),
  rule: z.string(),       // 어떤 룰 위반인지
  message: z.string(),
});
const SubmitSchema = z.object({ findings: z.array(FindingSchema) });
```

스키마가 입력 형식을, 훅이 카테고리 커버리지를 강제한다.

---

## 9. 세션 상태 — `core/review/state.ts`

```ts
type ReviewState = {
  active: boolean;
  targets: string[];                    // 대상 파일 (정렬)
  currentIndex: number;                 // 파일 루프 포인터
  categories: Category[];               // 커버 대상 룰
  requirementBackground: string;        // {{requirement_background}}
  planGuidance: string;                 // {{plan_guidance}}
  systemRule: string;                   // {{system_rule}} (rubric 렌더 결과)
  findings: Record<string, Finding[]>;  // 파일별 누적
  output: string | undefined;           // 산출물 경로 옵션
  label: string;                        // short sha | timestamp
  iterations: number;                   // 가드
};
// adapter가 sessionID → ReviewState 로 in-memory Map 보관
```

---

## 10. 파일 레이아웃

```
src/core/review/                ← 플랫폼 독립 (Cline/MCP 재사용 가능)
  rubric.ts      # .aidlc-rule-details 룰 → 카테고리 체크리스트 로드
  context.ts     # git diff + 파일 수집, exclude 적용
  contract.ts    # REQUIRED_CATEGORIES + submit zod 스키마
  template.ts    # 리뷰 프롬프트 템플릿 + render()
  reader.ts      # FileReader(3모드) + file_read·file_read_diff·file_find·code_search
  evidence.ts    # 연관 파일 점수화(경로 목록+grep recipe, 프리뷰 X) + Git 이력/동시변경 증거
  segment.ts     # whole 모드 큰 파일 세그먼트 분할 + 같은 파일 내 연관 선언 주입
  state.ts       # 세션별 리뷰 상태
  output.ts      # 출력 경로 해석 + 리포트 렌더·저장
  run.ts         # 병렬 run store: run.json·개별 리뷰(md+json)·커버리지·plan/finalize
  fcq.ts         # fcq 정적분석: plan 시 실행·report.json 샤딩·evidence 렌더·finding 변환
src/adapters/opencode/review/
  index.ts       # tool 10개 + system.transform + config/검증/가드 hook wiring
  prompts.ts     # 번들 내장 /f-review command + f-reviewer agent 정의
                 # (config 훅으로 주입; 동명의 .opencode md 파일이 있으면 그쪽 우선)
```

설정 파일: 프로젝트 루트 `.f-review.json`, 없으면 `fcq/config/.f-review.json`
(`{ exclude, output, language, frameworkGuide, failOn, debug, deepPasses, maxIter, maxToolCalls, rulesDir, judge, judgeThreshold, fcq, fcqOptions }`).
Zod로 검증하며 타입이 틀린 필드는 unset으로 강등된다(파일 전체를 버리지 않음); 루트 파일이 파싱 불가면 fcq 폴백을 시도한다.

**딥패스 반복 리뷰 (`deepPasses`)** — 타깃(파일/세그먼트)당 리뷰 라운드 수. 파라미터 `deepPasses` > 설정 `deepPasses` > 기본 1,
항상 [1, 5]로 clamp. 1이면 기존 단일 패스. N>1이면 submit 게이트가 앞의 N-1회 제출을 수락하지 않고
**직전 findings를 echo + 라운드별 지시**와 함께 되돌린다 (재제출이 이전 제출을 대체):
- 2라운드: 각 finding **반박 시도**(오탐 제거) + 카테고리별 누락 탐색 + 라인 앵커 검증
- 중간 라운드: 엣지 케이스·에러 경로·경계값·동시성 심층 + 안 읽은 호출자/피호출자 추적
- 마지막 라운드: severity 보정 + blocker/major에 구체 suggestion + 중복 병합 (2라운드제면 반박+보정 병합)
run 모드에서는 plan 시점 값이 run.json에 저장돼 모든 서브에이전트가 동일 라운드 수로 리뷰한다.
중간 라운드 findings는 저장되지 않고 마지막 라운드 제출만 개별 리뷰/리포트에 반영된다.

**탐색 예산 (`maxIter`)** — 라운드당 탐색 도구 호출 상한. 설정 `maxIter` > 기본 `MAX_ITER`(20), 최소 1로 clamp.
리뷰 시작 시 상태에 고정되므로 세션 도중 설정 변경은 다음 리뷰부터 반영된다. 소형 모델은 낮게(예: 10) 잡아
배회 대신 조기 수렴을 유도할 수 있다.

`MAX_ITER` 탐색 예산은 **라운드 단위**로 리셋된다(딥패스 라운드와 최종 점검 바운스 모두). 2라운드 이후의 지시문이
"코드를 다시 읽고 반박하라"이므로, 소진된 예산을 이월하면 그 지시에 "탐색 한도 도달 — 지금 submit 하라"로
응답하게 되기 때문이다. 상한은 여전히 유한하다: 파일당 최대 `(MAX_DEEP_PASSES + MAX_FINAL_RECHECKS) × MAX_ITER`.

**세션 호출 예산 (`maxToolCalls`)** — reviewer 세션 전체 도구 호출 상한. 기본 10, 최소 3으로 clamp하며 `f_review_context`도 1회로 계산한다. 예: `{ "deepPasses": 1, "maxIter": 7, "maxToolCalls": 10 }`은 context 1회, 탐색 최대 7회, submit/복구 2회를 배정한다. OpenCode agent의 `steps=10`은 보조 상한이고, 실제 호출 강제는 before-hook 카운터와 세션 abort가 담당한다.

**동일 페이로드 재제출(repeat)**: 딥패스 라운드는 라운드마다 지시가 다르므로 byte-identical 재제출도
라운드를 정상 소진한다(성실한 수렴 ≠ 루프). 최종 점검만 repeat 감지를 무장한다 — 최종 점검이 바운스한
페이로드가 그대로 재제출되면(같은 지적에 같은 응답) 재바운스가 무의미하므로 수락한다.
즉 최종 점검은 항상 최소 1회 실행된다.

---

## 11. 구현 단계 (제안)

1. **Phase 1 — core**: `rubric.ts`, `context.ts`(commit/files/exclude 해석), `contract.ts`, `template.ts`, `output.ts`. 플랫폼 독립, 단위 테스트 가능. 가장 가치 높고 독립적.
2. **Phase 2 — 루프/상태**: `state.ts`, `reader.ts`.
3. **Phase 3 — opencode 어댑터**: `adapters/opencode/review/index.ts` (도구 3개 + 훅 2개 wiring) + `.opencode/command` / `agent`.

---

## 12. 보류한 단순화 (필요 시 추가)

- 하이브리드(정적분석 1차 필터): LLM-only로 시작, 노이즈 많으면 추가.
- exclude 덮어쓰기 모드(`--exclude-only`): 합집합으로 충분.
- `to:"WORKTREE"`(uncommitted 포함): 필요 시 특수값 추가.
- 파일별 병렬 리뷰: 순차로 시작, 느리면 병렬화.
- 다중 출력 포맷(json/html): md 단일로 시작, 필요 시 `--format`.
- fetch 응답 길이 cap: MAX_ITER로 1차 방어, 컨텍스트 폭증 시 추가.
