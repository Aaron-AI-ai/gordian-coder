# f-log 사용 가이드 (OpenCode)

fico-ai를 OpenCode 플러그인으로 붙이면 `/f-log` 명령이 생깁니다.
Spring Boot(fico 프레임워크) 서비스의 **Java 스택트레이스 한 건**을 받아 **원인 코드 위치 · 원인 · 해결 방안**을 분석하고, 마크다운·HTML 리포트를 남깁니다.
저장소 코드 + 사내 프레임워크 KB + 룰 파일만 근거로 삼습니다(웹 검색 없음).

> 이 문서의 명령과 경로는 모두 **Windows Git Bash** 기준입니다 (`C:\workspace` → `/c/workspace`).

| 장 | 이럴 때 보세요 |
|---|---|
| [1. 개요](#1-개요) | 동작 구조와 서브에이전트 |
| [2. 기본 사용법](#2-기본-사용법) | 처음 분석을 돌려볼 때. 실행 위치, 입력 방법, 자주 쓰는 옵션 |
| [3. 설정](#3-설정) | 출력 경로·언어·판정을 바꾸거나 에러별 룰 파일을 추가할 때 |
| [4. KB 동기화](#4-kb-동기화-gdc-kb-sync) | 사내 프레임워크 KB(wiki)를 받아야 할 때 |
| [5. 리포트와 산출물](#5-리포트와-산출물) | 리포트 위치·읽는 법, 분석이 멈췄거나 결과가 이상할 때 중간 산출물 확인 |
| [6. 평가 테스트베드](#6-평가-테스트베드) | (개발자용) 정답 케이스로 f-log 품질을 채점할 때 |

---

## 1. 개요

```
사용자 ──/f-log──▶ 오케스트레이터(메인 세션)
                     │
                     │ ① f_log_plan        로그 파싱 · 용의 파일 선정 · 룰/KB 매칭 · 지시 반환
                     │
                     ├─▶ f-log-analyst × 1   원인 가설 → 코드 탐색 → f_log_submit
                     ├─▶ f-log-judge   × 1   (선택) 원인이 모든 관측을 설명하는지 채점 → 미달 시 재분석
                     │
                     │ ② f_log_finalize    리포트 생성 · 판정
                     ▼
               .fico/report/f-log/report-<runId>/log.md (+ .html)
```

**오케스트레이터는 코드를 직접 읽지 않습니다.** 계획하고, 서브에이전트를 띄우고, 마무리만 합니다.
f-review와 달리 **로그 한 건 = 분석가 한 명**이라 병렬 분할은 없습니다.

### 두 가지 서브에이전트

| 에이전트 | 역할 | 도구 |
|---|---|---|
| **f-log-analyst** | 로그의 모든 관측을 설명하는 원인 하나를 찾고 해결 방안 작성 | `f_log_context`, 탐색 7종(`f_log_read`·`find`·`search`·`related`·`history`·`callers`·`blame`), `f_log_submit` |
| **f-log-judge** | 제출된 원인이 관측을 설명하는지·대안을 배제했는지·증상 완화가 아닌지 채점(0-100) | `f_log_judge_context`, `f_log_judge` |

bash·write·edit 같은 OpenCode 내장 도구는 차단되어 있어 **분석 중 코드가 수정되지 않습니다.**
수정 코드는 리포트에 *제안*으로만 담깁니다.

---

## 2. 기본 사용법

### OpenCode 실행 위치 — 반드시 루트 프로젝트에서

f-log도 f-review와 같이 **OpenCode를 실행한 디렉토리를 프로젝트 루트로 봅니다.**
설정(`.fico/config/fico_ai.json`), KB(`.fico/kb/`), 룰(`.fico/rules/`), 리포트 위치가 모두 이 디렉토리 기준이므로
Gradle 멀티 프로젝트라면 **`settings.gradle`이 있는 루트에서 실행하세요.**

```bash
cd /c/workspace/pb-online
opencode
```

### 입력 방법

```
/f-log <스택트레이스 붙여넣기>
/f-log --file=logs/app.log
```

- 붙여넣을 때는 **로그 첫 줄(예외 헤더 또는 로그4j 접두부)부터** 통째로 넣어야 발생 시각·URI·스레드 같은 정보가 리포트에 나옵니다
- `--file`은 프로젝트 루트 기준 상대 경로이며, 파일은 플러그인이 직접 읽습니다
- 핸들러 로그 줄(`고정길이 전문 CommonException: errorCode=1001`, `PB CommonException: URI=…, code=…`)을 스택과 **함께** 붙여넣으면 에러코드·URI로도 용의 파일을 찾습니다. 스택이 없는 warn 줄만 있어도 됩니다
- 스택에서 예외를 찾지 못하면 분석을 시작하지 않고 이유를 알려 줍니다

### 자주 쓰는 옵션

| 옵션 | 설명 |
|---|---|
| `--file=경로` | 로그 파일에서 읽기 (붙여넣기 대신) |
| `--output=경로` | 리포트 경로 (파일 또는 디렉터리) |
| `--judge` / `--no-judge` | 이번 실행만 판정 게이트 켜기 / 끄기 |

**예시**

```
/f-log --file=logs/app.log
/f-log --file=logs/app.log --output=reports/
/f-log --judge <스택트레이스>
```

> 이 옵션들은 **설정 파일에 미리 넣어두면 매번 입력하지 않아도 됩니다.**
> `--output` → `log.output`, `--judge` → `log.judge` 로 대응됩니다. 명령에 준 값이 설정보다 우선합니다.
> 작성 방법은 [3. 설정](#3-설정)을 참고하세요.

### 분석 결과를 보는 관점

분석가는 아래를 **빠짐없이** 적어 제출합니다(자세한 항목은 [5. 리포트와 산출물](#5-리포트와-산출물)).

`원인(한 문장)` · `원인 메커니즘` · `근거 코드(실제로 읽은 파일)` · `로그 관측별 설명 여부` · `검토한 대안` · `해결 방안(변경 파일별 수정 코드)`

---

## 3. 설정

`.fico/config/fico_ai.json`과 룰 파일(`rulesDir`)을 설정하는 방법입니다.

### 위치

**`.fico/config/fico_ai.json`** 을 사용합니다. 프로젝트 루트 기준 상대 경로입니다.

f-log 설정은 **`log` 키 아래**에 넣습니다. 여러 도구가 함께 쓰는 값(`rulesDir`, `frameworkKb`, `wikiKb`)은 최상위에 두고,
`language`·`maxToolCalls`·`maxIter`·`judgeThreshold`·`judgeRounds`는 `review`의 값을 그대로 씁니다(`log`에 두면 f-log에서만 우선).

```json
{
  "rulesDir": ".fico/rules",
  "frameworkKb": { "kr.co.openlabs.fico.framework.*": ".fico/kb/fico_framework/fico-fwk-core/" },
  "review": { "language": "ko", "maxToolCalls": 20 },
  "log": {
    "judge": true
  }
}
```

> **주석을 넣지 마세요.** JSON 표준이 아니고 파싱 실패로 거부됩니다.
> 값 타입이 틀리면 그 키만 조용히 무시되고(미설정 취급) 나머지는 정상 동작합니다.

### 전체 키 (`log` 섹션)

| 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `output` | string | `.fico/report/f-log/` | 리포트 경로. `/`로 끝나거나 기존 디렉터리면 그 아래 실행별 `report-*/` 생성 |
| `runsDir` | string | `.fico/f-log/runs/` | 중간 산출물 위치 |
| `judge` | boolean | `false` | 판정 게이트 상시 활성화. 없으면 `review.judge`를 따름. 심사가 에이전트를 하나 더 쓰므로 f-review처럼 기본 꺼짐 |
| `judgeThreshold` | number | `70` | 판정 통과 점수 (없으면 `review.judgeThreshold`) |
| `judgeRounds` | number | `2` | 미달 시 최대 재분석 횟수 (없으면 `review.judgeRounds`) |
| `contextMaxChars` | number | `40000` | 분석가에게 주는 초기 컨텍스트(용의 코드·룰·KB) 크기 상한 |
| `language` | string | `"ko"` | 리포트 언어 (없으면 `review.language`) |
| `rulesDir` | string | 최상위 `rulesDir` | 이 키를 두면 f-log에서는 이 값이 우선 |

최상위·`review` 공용 키: `rulesDir`(기본 `.fico/rules`), `frameworkKb`(import 접두사 → KB 디렉터리), `wikiKb`, `maxToolCalls`(분석가 세션당 도구 호출 수), `maxIter`.
`frameworkKb`는 f-review·f-log가 공유하므로 최상단에 두는 것을 권장합니다. 기존처럼 `review.frameworkKb`에 둬도 동작하며, 둘 다 있으면 `review` 쪽이 우선합니다.

### 룰 파일 (`rulesDir`)

**이 프로젝트가 따라야 할 규칙**을 `.md` 파일로 `.fico/rules/`에 넣어 두면 f-review와 f-log가 함께 참고합니다. 기본 위치와 작성법은 [f-review 가이드 3장](03-f-review.md#프로젝트-규칙-rulesdir)과 같습니다.
아무것도 설정하지 않으면 `.fico/rules`와 예전 기본 위치 `log/rules`를 둘 다 읽습니다.

f-log 룰은 **에러 종류**로 적용 여부를 정하는 게이트(`exceptions`)가 추가로 있습니다:

```markdown
---
exceptions: "org.springframework.dao.*", "*SQLException"
globs: "**/mapper/**/*.xml"        # 선택: 용의 파일 중 하나라도 맞을 때 (AND)
mode: reference                    # 선택: 본문 대신 목록만 주고 f_log_read로 읽게
---
#### 의심할 것 / 어느 툴로 확인할 것
```

- `exceptions`: 로그의 예외 체인에 맞는 타입이 있을 때만 적용(와일드카드 `*`)
- `globs`: 용의 파일 중 하나라도 맞을 때만 적용. `exceptions`와 함께 쓰면 둘 다 만족해야 함(AND)
- `mode: reference`: 본문 대신 목록만 주고 분석가가 필요할 때 `f_log_read`로 읽음
- `exceptions:`만 있고 `globs`가 없는 룰은 특정 에러용이라 f-review에서는 건너뜁니다

번들 룰 13개(`fico_error_code`, `fico_exception_flow`, `fico_transaction`, `fico_datasource`, `fico_mybatis`, `fico_fixed_message`, `fico_request_scope`, `fico_outbound`, `fico_redis`, `fico_batch`, `fico_daemon`, `fico_wiring`, `npe`)가 항상 먼저 로드되고, 프로젝트 룰이 뒤에 붙습니다.

---

## 4. KB 동기화 (`gdc kb-sync`)

f-log는 용의 파일의 import와 로그 키워드로 **프레임워크 KB 페이지를 미리 주입**하고, 수정 코드가 쓰는 프레임워크 클래스를 KB와 대조합니다.
KB가 없으면 이 근거가 빠지므로 **분석 전에 한 번 받아두세요.** f-review와 같은 KB(`frameworkKb`)를 공유하며,
`wikiKb` 등록·토큰 설정·`gdc kb-sync` 실행법은 [f-review 가이드 4장](03-f-review.md#4-kb-동기화-gdc-kb-sync)을 따릅니다.

---

## 5. 리포트와 산출물

### 산출물 위치

```
.fico/report/f-log/report-<runId>/log.md      리포트 (실행마다 디렉터리 하나, 덮어쓰지 않음)
.fico/report/f-log/report-<runId>/log.html    같은 내용의 HTML 화면 (브라우저로 열기)
```

채팅 요약에 배지·원인·해결·`HTML:` 경로가 나옵니다. `--output`이 파일 경로면 그 파일을 덮어씁니다.

배지: `PASS` / `TERMINAL`(임계값 미달, 최고점 채택) / `FORCED`(제출 검사를 5회 넘게 못 통과해 마지막 제출 채택) / `PARTIAL` / `JUDGE SKIPPED`.

### 리포트 구성

마크다운 순서: 분석 대상 → 요약(원인 한 문장) → 스택 원문 → 진입점→원인 경로 → 원인 상세와 근거(실제 코드 인용) → 해결 방안(변경 파일별 수정 후 코드·설정 조각 포함) → 실행 정보.

- 원인 요약은 **한 문장(150자 이내)** 이어야 하며, 넘으면 제출이 반려되고 설명은 원인 상세로 옮기게 됩니다
- 검토한 대안·누락 점검(못 본 것)·심사 점수는 리포트에 쓰지 않고 중간 산출물에만 남습니다. 누락 개수는 채팅 요약의 `Gaps:` 줄에 나옵니다

HTML 리포트는 맨 위 **분석 대상**(로그 파일, 발생 시각, URI·서비스 ID·에러 코드, 추적 ID·사용자, 호스트·스레드, 로그 메시지, 예외 — 로그에 있는 항목만)과 판정 배너(배지·원인 위치·원인 한 줄) 아래에 다음 순서로 보여줍니다.

1. **로그 분석** — 진입점→원인 경로, 로그 관측, 스택 원문
2. **원인** — 메커니즘, 근거 코드(원인 줄 강조), **근거 자료**(참고한 프레임워크 KB — 수정 코드에 쓰인 문서 표시 · 적용한 분석 룰 · 분석 중 읽은 파일)
3. **해결 방안** — 변경마다 `복사` 버튼, `해결 방안 전체 복사`는 markdown으로 복사

실행 정보는 접어 둡니다.

### 제출 검사

분석가의 제출은 아래 검사를 거치며, 걸리면 **각 1회 반려**되어 다시 확인합니다.

- 수정 코드가 바꾼 상수가 프레임워크 메서드 인자로 쓰이면, 그 호출과 KB 페이지를 보여 주고 허용 값인지 확인 (예: `StringUtils.masking`의 마스킹 유형)
- 수정한 설정 키가 KB의 `@ConfigurationProperties(prefix)` 밖이면 실제로 바인딩되는 키를 안내
- 리포트 문장에 섞인 한자 차단, `catch` 폴백을 `throw`로 바꾸는 의도 변경 차단
- 수정 코드가 쓰는 프레임워크 클래스의 KB 페이지를 아직 안 봤다면 보여 주고 대조

### 중간 산출물

분석이 도는 동안 모든 상태가 디스크에 남습니다. 문제 추적의 출발점입니다.

```
.fico/f-log/runs/<runId>/
├── input.log             입력 로그 원문
├── plan.json             파싱 결과·용의 파일·적용 룰·KB 매칭
├── context-<n>.md        분석가에게 준 컨텍스트
├── submission-<n>.json   분석가의 제출 (대안·누락 점검 포함)
├── judgments.json        f-log-judge 채점 이력
└── finalize.json         집계 캐시
```

제출이 계속 검사를 통과하지 못하면 5회째에 마지막 유효 제출을 채택(`FORCED`)합니다.

---

## 6. 평가 테스트베드

`scripts/flog-eval.ts`는 대상 프로젝트의 `f-log-cases/<id>.yaml`(정답)마다 f-log를 실행해 리포트를 자동 채점한다.
채점용 리포트는 실제 리포트(`.fico/report/`)와 섞이지 않게 `.fico/eval/f-log/<id>.md`에 쓴다.
기본 대상(`scripts/run-flog-eval.sh`)은 Gradle 루트 `test-projects/on-test-lab/`이며, 정답의 파일 경로는 그 루트 기준(`on-test-lab-online/src/...`)이다.

**프로젝트 규칙 반영 검증**: `on-test-lab/.fico/rules/`의 규칙이 실제로 쓰이는지 보는 케이스가 따로 있다.

| 케이스 | 도구 | 규칙 | 통과 조건 |
|---|---|---|---|
| `f-log-cases/case-102-project-rule-null-result` | f-log | `otl-null-result.md` ([OTL-R01]) | 실행 정보 '적용 룰'에 `otl-null-result`, 수정 코드에 규칙의 코드 `"1404"` |
| `f-review-cases/rule-01` | f-review | `otl-null-result.md` ([OTL-R01]) | NPE 지적의 TO-BE에 `1404` |
| `f-review-cases/rule-02` | f-review | `otl-coding-style.md` ([OTL-S01]) | `System.out.println` 줄 지적 메시지에 `OTL-S01` |

```bash
./scripts/run-flog-eval.sh --case case-102-project-rule-null-result
./scripts/run-freview-eval.sh --mode whole --case 'rule-*'
```

```bash
bun scripts/flog-eval.ts /path/to/target [--model provider/model] [--case <selector>] [--no-run]
```

`--case`는 콤마로 구분한 케이스 ID 목록이며, 각 항목에 `*` 와일드카드를 쓸 수 있다(정확한 ID와 섞어도 된다):

```bash
--case case-01-npe                              # 한 케이스만
--case case-04-fixed-string-length-overflow,case-10-fixed-nested-vo-block-count  # 여러 개 지정
--case 'case-0*'                                 # 접두어로 구간 지정(04~09)
--case 'case-01-npe,case-2*'                     # 정확한 ID + glob 혼용
```

정답 YAML 필드: `log`(로그 경로), `exception`(체인 중 하나의 FQCN), `cause_files`(하나 이상 등장), `cause_symbol`(메서드/SQL id), `fix_keywords_any`(해결 방안 절에 하나 이상), `fix_code_any`(선택, 수정 코드 블록에 하나 이상), `fix_forbid_any`(선택, 수정 코드 블록에 하나도 없어야 함 — 프레임워크가 대체하는 plain-Java 방식), `rule`(선택, 실행 정보의 적용 룰). 코드 조각은 공백·대소문자를 무시하고, `re:`로 시작하면 공백을 뺀 코드에 거는 정규식, `raw:`로 시작하면 원문 그대로(줄·들여쓰기 유지, 멀티라인)에 거는 정규식이다 — yml 중첩처럼 들여쓰기가 의미일 때 쓴다. 첫 대상 프로젝트는 `on-test-lab-online`이며 `gradle test`가 케이스 로그를 다시 만든다. 설계: `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`.

1차 실행 결과와 발견한 개선점은 `docs/reports/f-log-eval-testbed-run1-20260917.md` 참조.

빌드부터 채점까지는 `./scripts/run-flog-eval.sh`(옵션은 그대로 flog-eval.ts에 전달, 대상/모델은 `FLOG_TARGET`/`FLOG_MODEL` 환경변수로 override), 채점기 자체의 단위 테스트는 `./scripts/test-flog-eval.sh`로 돌린다.
