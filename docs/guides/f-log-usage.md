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
  "review": { "frameworkKb": { "kr.co.openlabs.fico.framework.*": ".fico/kb/fico_framework/fico-fwk-core/" }, "language": "ko", "maxToolCalls": 20 },
  "log": {
    "output": ".fico/report/f-log/",
    "runsDir": ".fico/f-log/runs/",
    "rulesDir": "log/rules",
    "judgeThreshold": 70,
    "judgeRounds": 2,
    "contextMaxChars": 40000,
    "judge": true
  }
}
```

`log` 섹션이 없으면 위 값이 기본이다. `frameworkKb`·`language`·`maxToolCalls`·`maxIter`는 `review`의 값을 그대로 쓴다.

## 산출물

```
.fico/report/f-log/log-<runId>.md      리포트 (덮어쓰지 않음)
.fico/f-log/runs/<runId>/               input.log · plan.json · context-<n>.md · submission-<n>.json · judgments.json · finalize.json
```

리포트 순서: 요약 → 스택 원문 → 진입점→원인 경로 → 원인 상세와 근거(실제 코드 인용) → 해결 방안(변경 파일별 수정 후 코드·설정 조각 포함) → 검토한 대안 → **못 본 것** → 심사 이력 → 실행 정보. 배지: `PASS` / `TERMINAL`(임계값 미달, 최고점 채택) / `FORCED` / `PARTIAL` / `JUDGE SKIPPED`.

## 룰 파일 — `log/rules/*.md`

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
