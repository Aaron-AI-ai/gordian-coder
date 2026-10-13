# f-review 일괄 실행 명령 모음 (복사용 한 줄)

프로젝트 루트(예: `/Users/koscom/workspace/fico/on-stk-ord`)에서 실행합니다. 모델은 필요에 맞게 바꾸세요.
한 run에 최대 100파일. 파일만 넘기면 whole-file 모드로 돌고, 1000줄 초과 파일은 500줄 unit으로 쪼개져 병렬 리뷰됩니다.

## OpenCode TUI에서 (디렉터리·글롭 직접 지정 — 셸 전개 불필요)

`--files` 항목에 디렉터리, `.`, 글롭을 그대로 쓸 수 있습니다 (추적+미추적, `.gitignore` 존중).

```
/f-review --files=on-stk-ord-online/src/main
```

```
/f-review --files=**/src/main/**/*.java --exclude=**/evosuite-cp/**
```

```
/f-review --files=. --exclude=**/test/**,**/evosuite-cp/**
```

터미널에서도 같은 형태가 가장 짧고, 오케스트레이터가 긴 경로 목록을 다시 타이핑할 일이 없어 안전합니다:

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=on-stk-ord-online/src/main"
```

아래의 `$(git ls-files …)` 변형은 글롭 지원 이전 방식이며, 100파일 초과 시 청크 루프에는 여전히 필요합니다.

## 모듈 단위 (권장)

> on-stk-ord 2026-10-13 기준: online 55 · bsm 9 · daemon 9 파일 (미추적 포함). online 인자 길이 약 5.4KB.

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard 'on-stk-ord-online/src/main/**/*.java' | paste -sd, -)"
```

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard 'on-stk-ord-bsm/src/main/**/*.java' | paste -sd, -)"
```

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard 'on-stk-ord-daemon/src/main/**/*.java' | paste -sd, -)"
```

## main Java 전체 (모듈 합산, 100파일 이하일 때)

> 2026-10-13 기준 on-stk-ord는 미추적 포함 **99파일**이라 상한(100) 직전입니다. 파일이 하나라도
> 늘면 plan이 거부하므로 그때는 아래 청크 루프를 쓰세요. 개수 확인:
> `git ls-files -co --exclude-standard '*/src/main/**/*.java' | grep -vc evosuite-cp`

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard '*/src/main/**/*.java' | grep -v evosuite-cp | paste -sd, -) --exclude=**/evosuite-cp/**"
```

## 100파일 초과 — 60개씩 청크로 순차 실행 (Java + 매퍼 XML 포함, on-stk-ord 기준 153파일 → 3청크)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && git ls-files -co --exclude-standard '*.java' '*/src/main/**/*.xml' | grep -v evosuite-cp | split -l 60 - /tmp/freview-chunk- && for c in /tmp/freview-chunk-*; do opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(paste -sd, - < "$c")"; done; rm -f /tmp/freview-chunk-*
```

## 최근 변경분만 (diff 모드, 가장 가벼움)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--from=v1.0.0"
```

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "HEAD~5..HEAD"
```

## 단일 파일 (세그먼트 분할 확인용 — 1,507줄 픽스처)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=on-stk-ord-online/src/main/java/kr/co/koscom/pb/on/stk/ord/online/qry/service/SONAQ009Service.java"
```

## 백그라운드로 돌리고 로그로 지켜보기

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && nohup opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard 'on-stk-ord-online/src/main/**/*.java' | paste -sd, -)" > /tmp/freview-$(date +%H%M%S).log 2>&1 & echo "log: $(ls -t /tmp/freview-*.log | head -1)"
```

```bash
tail -f $(ls -t /tmp/freview-*.log | head -1) | grep --line-buffered -E "Agent|judged|REWORK|PASS|finalize|Report|complete|INCOMPLETE|rror"
```

## 결과 확인

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && ls -t fcq/report/f-review/*.md | head -1 | xargs -I{} sh -c 'echo {}; grep -E "^\*\*|^## |Verdict" {} | head -20'
```

---

### 전체 스윕 전에 설정을 가볍게 (`.fico/config/fico_ai.json` → `review`)

| 키 | 현장값 | 스윕 권장 | 이유 |
|---|---|---|---|
| `batchSize` | 5 | 8~10 | 동시 unit 수. 레이트리밋이 받아주는 선에서 |
| `deepPasses` | 2 | 1 | 라운드당 리뷰어 턴 전체가 한 번 더 돈다 (`--deep=1`로 CLI 지정도 가능) |
| `judge` | true | false | unit당 judge 세션 + 미달 시 전체 재리뷰. CLI로는 끌 수 없음 |
| `fcqFix` | true | false | 위반 많은 파일마다 f-fixer 세션 추가 |

현장 설정 그대로면 unit당 20~30분 × (unit 수 ÷ batchSize) 배치. 가볍게 바꾸면 67 unit 기준 1시간 안팎.

### 주의

- 긴 `--files` 인자는 오케스트레이터 모델이 `f_review_plan` 인자로 **다시 타이핑**합니다. plan 출력의 `N file(s)`가 넘긴 개수와 같은지 확인하세요. 모듈 단위로 나누면 누락 위험이 줄어듭니다.
- `-co --exclude-standard`는 미추적 파일도 포함합니다. 추적 파일만 원하면 두 옵션을 빼세요.
- 같은 모델로 run을 동시에 둘 띄우면 레이트리밋을 나눠 써서 둘 다 느려집니다. 하나씩.
