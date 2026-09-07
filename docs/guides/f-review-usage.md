# f-review 사용 가이드 (OpenCode)

gordian-coder를 OpenCode 플러그인으로 붙이면 `/f-review` 명령이 생깁니다.
커밋이나 파일 묶음을 **파일 단위로 병렬 리뷰**하고, 마크다운·HTML 리포트를 남깁니다.

---

## 1. 개요

```
사용자 ──/f-review──▶ 오케스트레이터(메인 세션)
                        │
                        │ ① f_review_plan        대상 수집 · fcq 1회 실행 · 지시 반환
                        │
                        ├─▶ f-reviewer × N       파일 1개씩 병렬 리뷰 (최대 5개 동시)
                        ├─▶ f-judge    × N       (선택) 리뷰 품질 채점 → 미달 시 재리뷰
                        ├─▶ f-fixer    × N       (선택) fcq 위반의 수정 코드 작성
                        │
                        │ ② f_review_finalize    집계 · 리포트 생성 · 판정
                        ▼
                  fcq/report/f-review/review-<runId>-<시각>.md (+ .html)
```

**오케스트레이터는 코드를 직접 읽지 않습니다.** 계획하고, 서브에이전트를 띄우고, 마무리만 합니다.

### 세 가지 서브에이전트

| 에이전트 | 역할 | 도구 |
|---|---|---|
| **f-reviewer** | 파일 하나를 규칙 체크리스트로 리뷰 | `f_review_context`, 탐색 6종, `f_review_submit` |
| **f-judge** | 제출된 리뷰를 적대적으로 채점(0-100) | `f_review_judge_context`, `f_review_judge` |
| **f-fixer** | fcq 위반의 수정 코드(TO-BE) 작성 | `f_review_fix_context`, `f_review_fix_submit` |

각 에이전트는 `"*": "deny"` 기본에 필요한 도구만 열려 있습니다. bash·write·edit 같은
OpenCode 내장 도구는 전부 차단되어 있어 **리뷰 중 코드가 수정되지 않습니다.**

---

## 2. 기본 사용법

OpenCode TUI에서:

```
/f-review HEAD
```

인자는 자유 형식이고, 오케스트레이터가 파싱해 `f_review_plan`에 넘깁니다.

### 대상 지정

| 입력 | 의미 |
|---|---|
| `/f-review HEAD` | 마지막 커밋의 변경분 |
| `/f-review abc1234` | 특정 커밋 |
| `/f-review main..feature` | 두 지점 사이의 변경분 |
| `/f-review --from=main --to=HEAD` | 위와 동일 (명시형) |
| `/f-review --files=src/A.java,src/B.java` | 파일 지정 — 커밋이 없으면 **자동으로 파일 전체** 리뷰 |
| `/f-review HEAD --whole` | 변경된 파일을 diff가 아닌 **전체 내용**으로 리뷰 |
| `/f-review HEAD --files=src/A.java` | 커밋 변경분 + 지정 파일, **diff 기준** |

### 자주 쓰는 옵션

| 옵션 | 설명 |
|---|---|
| `--output=경로` | 리포트 경로 (파일 또는 디렉터리) |
| `--deep=N` | 파일당 리뷰 라운드 1~5 (기본 1) |
| `--judge` | 판정 게이트 켜기 |
| `--fcq` | 정적 분석(fcq) 실행 후 결과를 증거로 주입 |

**예시**

```
/f-review HEAD --output=reports/charge.md          리포트를 지정한 파일로
/f-review HEAD --output=reports/                   리포트를 지정한 디렉터리에
/f-review HEAD --deep=2                            파일당 2라운드 리뷰
/f-review HEAD --judge                             판정 게이트 켜기
/f-review HEAD --fcq                               정적 분석 결과를 증거로 주입

/f-review main..feature --fcq --judge              브랜치 변경분 · 정적 분석 · 판정
/f-review --files=src/payment/Charge.java --deep=2 파일 전체를 2라운드로
/f-review HEAD --fcq --judge --deep=2 --output=reports/charge.md
```

> 이 옵션들은 **설정 파일에 미리 넣어두면 매번 입력하지 않아도 됩니다.**
> `--output` → `output`, `--deep=N` → `deepPasses`, `--judge` → `judge`,
> `--fcq` → `fcq` 로 대응됩니다. 명령에 준 값이 설정보다 우선합니다.
> 작성 방법은 [3. 설정 파일](#3-설정-파일)을 참고하세요.

### 리뷰 관점 6가지

리뷰어는 파일마다 이 여섯 범주를 **빠짐없이** 평가하고, 깨끗해도 평가했다고 보고합니다.

`correctness` · `security` · `performance` · `maintainability` · `tests` · `framework`

각 지적은 `severity`(blocker/major/minor/nit), `rule`, `message`와 함께
**`asIs`(현재 코드)** / **`toBe`(수정 코드)** 를 코드로만 담습니다.

---

## 3. 설정 파일

### 위치

**`.fico/config/fico_ai.json`** 을 사용합니다. 프로젝트 루트 기준 상대 경로입니다.

```
C:\workspace\내프로젝트\.fico\config\fico_ai.json
```

f-review 설정은 **`review` 키 아래**에 넣습니다. `review` 섹션의 값이 최상위
동명 키보다 우선합니다.

```json
{
  "wikiKb": {
    "fico_framework": {
      "url": "https://gitlab.사내/group/framework.wiki.git",
      "tokenEnv": "FICO_WIKI_TOKEN"
    }
  },
  "review": {
    "language": "ko",
    "failOn": "major"
  }
}
```

실전 예시:

```json
{
  "wikiKb": {
    "fico_framework": {
      "url": "https://gitlab.사내/group/framework.wiki.git",
      "tokenEnv": "FICO_WIKI_TOKEN"
    }
  },
  "review": {
    "language": "ko",
    "failOn": "major",
    "output": "fcq/report/f-review/",
    "exclude": [
      "**/*.yml", "**/*.yaml",
      "**/*.gradle", "**/*.gradle.kts", "**/gradle/**",
      "**/target/**", "**/build/**", "**/generated/**"
    ],
    "deepPasses": 2,
    "maxToolCalls": 12,
    "judge": true,
    "judgeRounds": 2,
    "fcq": true,
    "fcqFix": true,
    "rulesDir": "review/rules"
  }
}
```

> **주석을 넣지 마세요.** JSON 표준이 아니고, `gdc --init-opencode`가 파싱 실패로 거부합니다.
> 값 타입이 틀리면 그 키만 조용히 무시되고(미설정 취급) 나머지는 정상 동작합니다.

### 전체 키

| 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `language` | string | `"ko"` | 리포트·지적 언어. `ko` / `en` / `ja` |
| `failOn` | string | 없음 | CI 게이트 기준. `blocker` \| `major` \| `minor` \| `nit` |
| `output` | string | `fcq/report/f-review/` | 리포트 경로. `/`로 끝나거나 기존 디렉터리면 디렉터리 모드 |
| `exclude` | string[] | 없음 | 제외 글롭. **리뷰 대상에서만** 빠지고, 탐색 도구는 저장소 전체를 검색합니다 |
| `deepPasses` | number | `1` (1~5) | 파일당 리뷰 라운드. 2 이상이면 반박·심화·보정 패스 추가 |
| `maxToolCalls` | number | `10` (최소 3) | 리뷰어 세션당 총 도구 호출 수. 파일이나 라운드가 바뀌어도 리셋되지 않음 |
| `judge` | boolean | `false` | 판정 게이트 상시 활성화 |
| `judgeRounds` | number | `2` (0~5) | 파일당 최대 재작업 횟수. 0이면 채점만 하고 재리뷰 없음 |
| `fcq` | boolean | `false` | 정적 분석 실행 |
| `fcqFix` | boolean | `false` | f-fixer 패스 추가 (MINOR 포함 전 위반에 TO-BE 작성) |
| `rulesDir` | string | `review/rules` | 프로젝트 규칙 디렉터리 |
| `wikiKb` | object | 없음 | git wiki → KB 미러링 (`gdc kb-sync`) |

---

## 4. 리포트가 만들어지는 과정

### 4.1 산출물 위치

```
fcq/report/f-review/review-<runId>-<yyyymmdd-hhmmss>.md      ← 리포트
fcq/report/f-review/review-<runId>-<yyyymmdd-hhmmss>.html    ← 같은 내용 HTML
```

`runId`는 `<짧은 SHA>-<시각>` 형태입니다. `output`이 파일 경로면 그 파일을 덮어씁니다.

> 리포트 디렉터리 이름이 정확히 `f-review`이면, 새로 쓰기 전에 기존 폴더를
> `f-review.<타임스탬프>`로 보관합니다. 그 폴더에는 항상 최신 리포트만 남습니다.

### 4.2 중간 산출물

리뷰가 도는 동안 모든 상태가 디스크에 남습니다. 문제 추적의 출발점입니다.

```
fcq/f-review/runs/<runId>/
├── run.json                  실행 메타 (대상, 범위, 옵션, baseline, fcq 상태)
├── reviews/<파일>.json       파일별 리뷰 결과 (findings, assessed, 커버리지)
├── reviews/<파일>.md         사람이 읽는 파일별 리뷰
├── fcq/raw/report.json       fcq 원본 리포트
├── fcq/files/<파일>.json     파일별 위반 샤드 ← f-fixer가 읽는 것
├── fcq/summary.json          fcq 요약
├── fixes/<파일>.json         f-fixer가 제출한 수정 코드
├── judgments/<파일>.json     f-judge 채점 이력
└── finalize.json             집계 캐시
```

보관 정책: 완료된 실행 디렉터리 10개 유지, 24시간 이상 방치된 미완 실행은 정리,
한 번에 최대 100개 파일, 동시 서브에이전트 5개.

---

## 부록: 도구 목록

**리뷰 흐름** (오케스트레이터/서브에이전트가 호출, 사용자가 직접 부르지 않음)

| 도구 | 호출 주체 | 역할 |
|---|---|---|
| `f_review_plan` | 오케스트레이터 | 대상 수집, 실행 생성, fcq 1회, 지시 반환 |
| `f_review_context` | f-reviewer | 리뷰 시작 — 대상·규칙·diff 스냅샷 수령 |
| `f_review_submit` | f-reviewer | 리뷰 제출 (토큰 검사, 커버리지 게이트) |
| `f_review_judge_context` | f-judge | 채점 대상 리뷰와 기준 수령 |
| `f_review_judge` | f-judge | 점수·피드백 제출 |
| `f_review_fix_context` | f-fixer | 소스 + 해당 파일 위반 목록 수령 |
| `f_review_fix_submit` | f-fixer | 수정 코드 제출 |
| `f_review_finalize` | 오케스트레이터 | 집계·리포트·판정 |

**탐색 도구** (f-reviewer 전용, `maxToolCalls` 예산 소모)

| 도구 | 역할 |
|---|---|
| `file_read` | 리뷰 대상 파일 읽기 (줄 번호, 500줄 단위) |
| `file_read_diff` | 다른 변경 파일의 diff |
| `file_find` | 파일명 조각으로 파일 찾기 |
| `code_search` | git grep (최대 100건) |
| `related_code` | 의존성·사용처·테스트·동시 변경 파일 추천 |
| `git_history` | 최근 커밋 이력과 의도 |
