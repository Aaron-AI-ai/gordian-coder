# f-log — 에러 로그 분석

Spring Boot(fico 프레임워크) 서비스의 Java 스택트레이스 한 건을 받아 **원인 코드 위치 · 원인 · 해결 방안 · 못 본 것**을 리포트로 낸다. 저장소 코드 + 사내 프레임워크 KB + 룰 파일만 근거로 삼는다(웹 검색 없음).

## 사용

OpenCode에서 대상 프로젝트를 연 뒤:

```
/f-log <스택트레이스 붙여넣기>
/f-log --file=logs/app.log
/f-log --judge --output=.fico/report/f-log/ <스택트레이스>
```

핸들러 로그 줄(`고정길이 전문 CommonException: errorCode=1001`, `PB CommonException: URI=…, code=…`)을 스택과 **함께** 붙여넣으면 에러코드·URI로도 용의 파일을 찾는다. 스택이 없는 warn 줄만 있어도 된다.

## 설정 — `.fico/config/fico_ai.json`

```json
{
  "rulesDir": ".fico/rules",
  "frameworkKb": { "kr.co.openlabs.fico.framework.*": ".fico/kb/fico_framework/fico-fwk-core/" },
  "review": { "language": "ko", "maxToolCalls": 20 },
  "log": {
    "output": ".fico/report/f-log/",
    "runsDir": ".fico/f-log/runs/",
    "judgeThreshold": 70,
    "judgeRounds": 2,
    "contextMaxChars": 40000,
    "judge": false
  }
}
```

`log` 섹션이 없으면 위 값이 기본이다. `judge`는 f-review와 같이 기본 꺼짐이며, `--judge`로 실행마다 켜거나 `log.judge`(또는 `review.judge`)를 `true`로 두면 켜진다. `frameworkKb`·`language`·`maxToolCalls`·`maxIter`는 `review`의 값을 그대로 쓴다.

`rulesDir`(이 프로젝트가 따라야 할 규칙, 기본 `.fico/rules`)도 f-review와 공유하는 최상위 키다. `log.rulesDir`을 두면 f-log에서는 그 값이 우선하고, 아무것도 설정하지 않으면 `.fico/rules`와 예전 기본 위치 `log/rules`를 둘 다 읽는다.

`frameworkKb`는 f-review·f-log가 공유하므로 위처럼 최상단에 두는 것을 권장한다. 기존처럼 `review.frameworkKb`에 둬도 동작하며, 둘 다 있으면 `review` 쪽이 우선한다.

## 산출물

```
.fico/report/f-log/report-<runId>/log.md      리포트 (실행마다 디렉터리 하나, 덮어쓰지 않음)
.fico/report/f-log/report-<runId>/log.html    같은 내용의 HTML 화면 (브라우저로 열기)
.fico/f-log/runs/<runId>/               input.log · plan.json · context-<n>.md · submission-<n>.json · judgments.json · finalize.json
```

리포트 순서: 요약 → 스택 원문 → 진입점→원인 경로 → 원인 상세와 근거(실제 코드 인용) → 해결 방안(변경 파일별 수정 후 코드·설정 조각 포함) → 검토한 대안 → **못 본 것** → 심사 이력 → 실행 정보. 배지: `PASS` / `TERMINAL`(임계값 미달, 최고점 채택) / `FORCED` / `PARTIAL` / `JUDGE SKIPPED`.

HTML 리포트는 맨 위 **분석 대상**(로그 파일, 발생 시각, URI·서비스 ID·에러 코드, 추적 ID·사용자, 호스트·스레드, 로그 메시지, 예외 — 로그에 있는 항목만)과 판정 배너(배지·신뢰도·원인 한 줄) 아래에 **1. 로그 분석**(진입점→원인 경로, 로그 관측, 스택 원문) → **2. 원인**(메커니즘, 근거 코드 — 원인 줄 강조, **근거 자료** — 참고한 프레임워크 KB(수정 코드에 쓰인 문서 표시)·적용한 분석 룰·분석 중 읽은 파일) → **3. 해결 방안**(변경마다 `복사` 버튼, `해결 방안 전체 복사`는 markdown으로 복사) 순서로 보여주고, 검토한 대안·못 본 것·심사 이력·실행 정보는 접어 둔다. 채팅 요약에 `HTML:` 줄로 경로가 나온다.

## 룰 파일 — `.fico/rules/*.md`

f-review 룰과 같은 형식이며 게이트만 예외 타입이다:

```markdown
---
exceptions: "org.springframework.dao.*", "*SQLException"
globs: "**/mapper/**/*.xml"        # 선택: 용의 파일 중 하나라도 맞을 때 (AND)
mode: reference                    # 선택: 본문 대신 목록만 주고 f_log_read로 읽게
---
#### 의심할 것 / 어느 툴로 확인할 것
```

번들 룰 13개(`fico_error_code`, `fico_exception_flow`, `fico_transaction`, `fico_datasource`, `fico_mybatis`, `fico_fixed_message`, `fico_request_scope`, `fico_outbound`, `fico_redis`, `fico_batch`, `fico_daemon`, `fico_wiring`, `npe`)가 항상 먼저 로드되고, 프로젝트 룰이 뒤에 붙는다.

## 평가 테스트베드

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
