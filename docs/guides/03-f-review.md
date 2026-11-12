# f-review 사용 가이드 (OpenCode)

gordian-coder를 OpenCode 플러그인으로 붙이면 `/f-review` 명령이 생깁니다.
커밋이나 파일 묶음을 **파일 단위로 병렬 리뷰**하고, 마크다운·HTML 리포트를 남깁니다.

> 이 문서의 명령과 경로는 모두 **Windows Git Bash** 기준입니다 (`C:\workspace` → `/c/workspace`).

| 장 | 이럴 때 보세요 |
|---|---|
| [1. 개요](#1-개요) | 동작 구조와 서브에이전트 |
| [2. 기본 사용법](#2-기본-사용법) | 처음 리뷰를 돌려볼 때. 실행 위치, 대상 지정, 자주 쓰는 옵션 |
| [3. 설정](#3-설정) | 동시 실행 수·모델·출력 경로를 바꾸거나 프로젝트 전용 규칙(`rulesDir`)을 추가할 때 |
| [4. KB 동기화](#4-kb-동기화-gdc-kb-sync) | 사내 프레임워크 KB(wiki)를 받아야 할 때, `gdc kb-sync`가 실패할 때 |
| [5. 리포트와 산출물](#5-리포트와-산출물) | 리포트 위치, 리뷰가 멈췄거나 결과가 이상할 때 중간 산출물 확인 |
| [6. 일괄 실행 명령 모음](#6-일괄-실행-명령-모음-복사용-한-줄) | 프로젝트 전체·모듈 단위로 한꺼번에 돌릴 때 (복사해서 쓰는 명령) |

---

## 1. 개요

```
사용자 ──/f-review──▶ 오케스트레이터(메인 세션)
                        │
                        │ ① f_review_plan        대상 수집 · fcq 1회 실행 · 지시 반환
                        │
                        ├─▶ f-reviewer × N       unit 1개씩 병렬 리뷰 (동시 수 = batchSize, 기본 5)
                        │                        1000줄 초과 whole-file 대상은 500줄 세그먼트 unit으로
                        │                        나뉘어 각각 병렬, 리포트에서 파일 1섹션으로 합쳐짐
                        ├─▶ f-judge    × N       (선택) 리뷰 품질 채점 → 미달 시 재리뷰
                        ├─▶ f-fixer    × N       (선택) fcq 위반의 수정 코드 작성
                        │
                        │ ② f_review_finalize    집계 · 리포트 생성 · 판정
                        ▼
                  .fico/report/f-review/report-<날짜>-<runId>/review.md (+ .html)
```

**오케스트레이터는 코드를 직접 읽지 않습니다.** 계획하고, 서브에이전트를 띄우고, 마무리만 합니다.

### 세 가지 서브에이전트

| 에이전트           | 역할                      | 도구                                            |
| -------------- | ----------------------- | --------------------------------------------- |
| **f-reviewer** | 파일 하나를 규칙 체크리스트로 리뷰     | `f_review_context`, 탐색 6종, `f_review_submit`  |
| **f-judge**    | 제출된 리뷰를 적대적으로 채점(0-100) | `f_review_judge_context`, `f_review_judge`    |
| **f-fixer**    | fcq 위반의 수정 코드(TO-BE) 작성 | `f_review_fix_context`, `f_review_fix_submit` |

각 에이전트는 `"*": "deny"` 기본에 필요한 도구만 열려 있습니다. bash·write·edit 같은
OpenCode 내장 도구는 전부 차단되어 있어 **리뷰 중 코드가 수정되지 않습니다.**

---

## 2. 기본 사용법

### OpenCode 실행 위치 — 반드시 루트 프로젝트에서

f-review는 **OpenCode를 실행한 디렉토리를 프로젝트 루트로 봅니다.** 설정(`.fico/config/fico_ai.json`),
KB(`.fico/kb/`), `--files` 경로, 리포트 위치가 모두 이 디렉토리 기준입니다.
루트 아래에 서브 프로젝트가 있는 Gradle 멀티 프로젝트라면 **`settings.gradle`이 있는 루트에서 실행하세요.**

```
pb-online/                    ← 여기서 opencode 실행
├── settings.gradle
├── build.gradle
├── .fico/config/fico_ai.json
├── pb-online-common/         (서브 프로젝트)
│   └── src/main/java/...
└── pb-online-stk/            (서브 프로젝트)
    └── src/main/java/...
```

```bash
cd /c/workspace/pb-online
opencode
```

서브 프로젝트만 리뷰할 때도 루트에서 실행하고, 경로로 범위를 좁힙니다.

```
/f-review --files=pb-online-stk
/f-review --files=pb-online-stk/src/main/java,pb-online-common/src/main/java
```

> 서브 프로젝트 디렉토리(`pb-online-stk/`)에서 실행하면 루트의 `.fico` 설정과 KB를 찾지 못해
> **설정이 적용되지 않은 채** 리뷰되고, 리포트도 서브 프로젝트 안에 생깁니다.

### 리뷰 대상 지정

OpenCode TUI에서 **리뷰할 파일을 지정**합니다.

```
/f-review --files=src/A.java,src/B.java
```

- 여러 개는 쉼표로 구분합니다 (공백 없이)
- 경로는 **프로젝트 루트 기준 상대 경로**입니다
- 항목마다 **디렉터리**, **`.`(프로젝트 전체)**, **글롭**도 됩니다 — 추적+미추적 파일을 포함하고
  `.gitignore`는 존중합니다. `*`는 한 단계, `**`는 하위 전체.

```
/f-review --files=src/main/java/kr/co/koscom/pb/on/stk/ord/online
/f-review --files=**/src/main/**/*.java --exclude=**/evosuite-cp/**
/f-review --files=. --exclude=**/test/**
```

한 run에 최대 100파일이라, 넘치면 plan이 거부하고 범위를 좁히라고 안내합니다.
- 커밋 범위를 주지 않았으므로 **파일 전체**가 리뷰 대상이 됩니다 (diff가 아님)

### 자주 쓰는 옵션

| 옵션            | 설명                         |
| ------------- | -------------------------- |
| `--output=경로` | 리포트 경로 (파일 또는 디렉터리)        |
| `--deep=N`    | 파일당 리뷰 라운드 1~5 (기본 1)      |
| `--judge`     | 판정 게이트 켜기                  |
| `--fcq`       | 정적 분석(fcq) 실행 후 결과를 증거로 주입 |

**예시**

```
/f-review --files=src/payment/Charge.java --output=reports/charge.md
/f-review --files=src/payment/Charge.java --output=reports/
/f-review --files=src/payment/Charge.java --deep=2
/f-review --files=src/payment/Charge.java --judge
/f-review --files=src/payment/Charge.java --fcq

/f-review --files=src/A.java,src/B.java --fcq --judge --deep=2 --output=reports/charge.md
```

> 이 옵션들은 **설정 파일에 미리 넣어두면 매번 입력하지 않아도 됩니다.**
> `--output` → `output`, `--deep=N` → `deepPasses`, `--judge` → `judge`,
> `--fcq` → `fcq` 로 대응됩니다. 명령에 준 값이 설정보다 우선합니다.
> 작성 방법은 [3. 설정](#3-설정)을 참고하세요.

### 리뷰 관점 6가지

리뷰어는 파일마다 이 여섯 범주를 **빠짐없이** 평가하고, 깨끗해도 평가했다고 보고합니다.

`correctness` · `security` · `performance` · `maintainability` · `tests` · `framework`

각 지적은 `severity`(blocker/major/minor/nit), `rule`, `message`와 함께
**`asIs`(현재 코드)** / **`toBe`(수정 코드)** 를 코드로만 담습니다.

---

## 3. 설정

`.fico/config/fico_ai.json`과 프로젝트 규칙(`rulesDir`)을 설정하는 방법입니다.

### 위치

**`.fico/config/fico_ai.json`** 을 사용합니다. 프로젝트 루트 기준 상대 경로입니다.

```
/c/workspace/내프로젝트/.fico/config/fico_ai.json
```

f-review 설정은 **`review` 키 아래**에 넣습니다. `review` 섹션의 값이 최상위
동명 키보다 우선합니다. 여러 도구가 함께 쓰는 값(`rulesDir`, `frameworkKb`, `wikiKb`)은 최상위에 둡니다.

```json
{
  "wikiKb": {
    "fico_framework": {
      "url": "https://gitlab-ce.koscom.co.kr/fico_ai/fico-wiki.wiki.git",
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
  "rulesDir": ".fico/rules",
  "review": {
    "language": "ko",
    "frameworkKb": {
      "kr.co.openlabs.fico.framework.extension.*": ".fico/kb/fico_framework/fico-fwk-extension/",
      "kr.co.openlabs.fico.framework.*": ".fico/kb/fico_framework/fico-fwk-core/",
      "kr.co.koscom.pb.framework.site.ext.*": ".fico/kb/fico_framework/framework-site-ext/",
      "kr.co.openlabs.fico.common.*": ".fico/kb/fico_framework/fico-common-model/"
    },
    "deepPasses": 2,
    "maxToolCalls": 20,
    "judgeRounds": 2,
    "judge": true,
    "fcq": true,
    "fcqFix": true
  },
  "wikiKb": {
    "fico_framework": {
      "url": "https://gitlab-ce.koscom.co.kr/fico_ai/fico-wiki.wiki.git",
      "tokenEnv": "FICO_WIKI_TOKEN"
    }
  }
}
```

> **주석을 넣지 마세요.** JSON 표준이 아니고, `gdc --init-opencode`가 파싱 실패로 거부합니다.
> 값 타입이 틀리면 그 키만 조용히 무시되고(미설정 취급) 나머지는 정상 동작합니다.

### 전체 키

| 키              | 타입       | 기본값                    | 설명                                                  |
| -------------- | -------- | ---------------------- | --------------------------------------------------- |
| `language`     | string   | `"ko"`                 | 리포트·지적 언어. `ko` / `en` / `ja`                       |
| `failOn`       | string   | 없음                     | CI 게이트 기준. `blocker` | `major` | `minor` | `nit`    |
| `output`       | string   | `.fico/report/f-review/` | 리포트 경로. `/`로 끝나거나 기존 디렉터리면 그 아래 실행별 `report-*/` 생성|
| `exclude`      | string[] | 없음                     | 제외 글롭. **리뷰 대상에서만** 빠지고, 탐색 도구는 저장소 전체를 검색합니다       |
| `deepPasses`   | number   | `1` (1~5)              | 파일당 리뷰 라운드. 2 이상이면 반박·심화·보정 패스 추가                   |
| `maxToolCalls` | number   | `10` (최소 3)            | 리뷰어 세션당 총 도구 호출 수. 파일이나 라운드가 바뀌어도 리셋되지 않음           |
| `batchSize`    | number   | `5` (1~20)             | 동시에 띄우는 서브에이전트 수. 세그먼트 unit이 많을수록 올릴 가치가 있음(프로바이더 한도 내) |
| `judge`        | boolean  | `false`                | 판정 게이트 상시 활성화                                       |
| `judgeRounds`  | number   | `2` (0~5)              | 파일당 최대 재작업 횟수. 0이면 채점만 하고 재리뷰 없음                    |
| `fcq`          | boolean  | `false`                | 정적 분석 실행                                            |
| `fcqFix`       | boolean  | `false`                | f-fixer 패스 추가 (MINOR 포함 전 위반에 TO-BE 작성)             |
| `rulesDir`     | string   | `.fico/rules`          | **최상위 키.** 이 프로젝트가 따라야 할 규칙 디렉터리 (f-review·f-log 공용). 아래 참고 |
| `frameworkKb`  | object   | 없음                     | import 접두사 → KB 디렉터리 맵. `framework_kb` 규칙의 기본 표를 대체 |
| `kbSearch`     | string   | `"keyword"`            | `kb_search` 도구의 순위 방식. `keyword`(부분 문자열 일치) / `bm25`(단어 단위 + 희귀도 가중). 사전 검색은 항상 `keyword` |
| `wikiKb`       | object   | 없음                     | git wiki → KB 미러링 (`gdc kb-sync`)                   |

### 프로젝트 규칙 (`rulesDir`)

**이 프로젝트가 따라야 할 규칙**을 `.md` 파일로 `.fico/rules/`에 넣어 두면 f-review와 f-log가 함께 참고합니다.
기본 내장 규칙(Java, Mapper XML 등)에 **추가로** 적용됩니다.

```
내프로젝트/
└── .fico/rules/
    ├── naming.md          # 예: 명명 규칙
    ├── transaction.md     # 예: 트랜잭션 처리 규칙
    └── mapper/
        └── sql.md         # 하위 폴더도 모두 읽음
```

```markdown
---
globs: "*.java"
---

### 트랜잭션 규칙
- Service 의 쓰기 메서드에는 @Transactional 을 붙인다
- Controller 에서 트랜잭션을 시작하지 않는다
```

- 다른 위치를 쓰려면 `fico_ai.json` **최상위**에 `"rulesDir": "<경로>"`를 둡니다(`review` 밖). 경로는 **프로젝트 루트 기준**입니다
- 하위 호환: 예전처럼 `review.rulesDir`(또는 `log.rulesDir`)에 두면 그 도구에서는 그 값이 우선합니다.
  아무것도 설정하지 않으면 `.fico/rules`와 예전 기본 위치 `review/rules`를 **둘 다** 읽습니다(f-log는 `log/rules`)
- 하위 폴더까지 **모든 `.md`** 를 읽습니다
- 맨 위 `globs`(선택)로 적용 대상을 좁힙니다. 예: `"*.java"`, `"**/*Mapper.xml"`. 없으면 모든 파일에 적용
- 내용이 길면 `mode: reference`를 추가하세요. 프롬프트에 본문을 넣는 대신 목록만 주고, 리뷰어가 필요할 때 읽습니다
- 한 파일에 적용되는 규칙 본문은 **합계 20,000자**까지만 들어갑니다. 넘으면 뒤가 잘리니 `globs`로 나누세요
- 같은 디렉터리를 f-log도 읽습니다. f-log용 조건(`exceptions:`, `handler:`)만 있고 `globs`가 없는 규칙은 특정 에러에 대한 내용이라 f-review에서는 건너뜁니다

---

## 4. KB 동기화 (`gdc kb-sync`)

git wiki(`<저장소>.wiki.git`)의 `.md` 문서를 프로젝트 안의 KB 디렉터리로 내려받습니다.
f-review의 `framework_kb` 규칙이 이 디렉터리를 참조하므로, **리뷰 전에 한 번 받아두면 됩니다.**

- 저장 위치: `.fico/kb/<이름>/` (기본값)
- 방식: **미러** — 받을 때마다 대상 디렉터리를 지우고 다시 채웁니다. 그 안에 직접 만든 파일은 사라집니다
- 실행 위치: **프로젝트 루트** (설정 파일을 현재 디렉터리 기준으로 찾습니다)

### 사전 설정 ① — wiki 주소 등록

`.fico/config/fico_ai.json` 의 `wikiKb`에 등록합니다. (`review` 섹션 밖, 최상위)

```json
{
  "wikiKb": {
    "fico_framework": {
      "url": "https://gitlab-ce.koscom.co.kr/fico_ai/fico-wiki.wiki.git",
      "tokenEnv": "FICO_WIKI_TOKEN"
    }
  }
}
```

| 키 | 필수 | 설명 |
|---|---|---|
| `url` | ✔ | wiki의 **git 주소**. 웹 주소 뒤에 `.wiki.git`이 붙습니다 (브라우저 주소 `.../fico-wiki/-/wikis/home` → `.../fico-wiki.wiki.git`) |
| `tokenEnv` | | 토큰을 담은 **환경변수 이름**. 토큰 값 자체를 적지 마세요 |

### 사전 설정 ② — git 토큰

폐쇄망 GitLab이 로그인 없이 읽기를 허용하지 않으면 **PAT(Personal Access Token)** 가 필요합니다.

1. GitLab → 우측 상단 프로필 → **Edit profile** → **Access Tokens**
2. 권한(scope)은 **`read_repository` 하나면 충분**합니다. 만료일을 지정하세요
3. 생성된 토큰 문자열을 **환경변수에 저장** — 이름은 `tokenEnv`에 적은 값과 같아야 합니다

```bash
# 현재 터미널에서만 (테스트용)
export FICO_WIKI_TOKEN="glpat-xxxxxxxxxxxxxxxxxxxx"

# 영구 저장 → ~/.bashrc 에 추가하고 바로 적용
echo 'export FICO_WIKI_TOKEN="glpat-xxxxxxxxxxxxxxxxxxxx"' >> ~/.bashrc
source ~/.bashrc
```

> `~/.bashrc`는 Git Bash에서만 읽힙니다. OpenCode도 **Git Bash에서 실행해야** 이 토큰을 씁니다.
> 토큰은 설정 파일·리포트·로그 어디에도 기록되지 않습니다(원격 주소는 `***`로 가려서 출력).

**토큰을 안 쓰는 경우**: `tokenEnv`를 비워두거나 변수를 설정하지 않으면, git이 이미 가진
자격증명(Windows 자격 증명 관리자, SSH 키, `~/.netrc`)을 그대로 사용합니다. 사내에서 이미
`git clone`이 되는 환경이면 토큰 설정 없이도 동작합니다.

### 사용

```bash
cd /c/workspace/내프로젝트

gdc kb-sync --check          # 최신 여부만 확인 (다운로드 없음, 몇 초)
gdc kb-sync                  # 동기화
```

| 옵션 | 설명 |
|---|---|
| `--check` | 원격 커밋과 로컬 기록만 비교. 오래됐거나 미동기화면 **종료 코드 1** |
| `--name <이름>` | `wikiKb`의 특정 항목만 대상 |
| `--dry-run` | 받아서 개수만 보고, 파일은 쓰지 않음 |
| `--force` | 최신이어도 다시 내려받기 |

옵션 없이 실행하면 **원격 커밋이 그대로일 때 다운로드를 건너뜁니다.** 매일 돌려도 부담 없습니다.

### 정상 동작 확인

**① 명령 출력**

```
gdc kb-sync

  ✔ fico_framework → .fico/kb/fico_framework (128 md @a1b2c3d4)
  + .ignore에 `!.fico` 추가 — 이게 없으면 ripgrep 기반 검색(opencode glob 등)이 .fico를 건너뜁니다
```

두 번째 실행부터는 이렇게 나오면 정상입니다.

```
  = fico_framework 이미 최신 @a1b2c3d4 — 건너뜀
```

**② 받은 문서 확인** — `.md` 파일이 실제로 있어야 합니다.

```bash
find .fico/kb/fico_framework -name '*.md' | wc -l
```

---

## 5. 리포트와 산출물

### 산출물 위치

```
.fico/report/f-review/report-<날짜>-<runId>/review.md      ← 리포트 (실행마다 디렉터리 하나)
.fico/report/f-review/report-<날짜>-<runId>/review.html    ← 같은 내용 HTML
```

`runId`는 `<짧은 SHA>-<시각>` 형태입니다. 실행 하나에 디렉터리 하나 — 같은 실행을 다시
finalize하면 같은 디렉터리의 파일을 갱신합니다. `output`이 파일 경로면 그 파일을 덮어씁니다.
runId·`Generated:` 시각은 **PC의 시간대** 기준이며, 본문에는 오프셋과 지역명이 함께
적힙니다(예: `2026-10-13 13:40:37 +09:00 (Asia/Seoul)`).

리포트는 지적의 **출처**를 구분합니다 — `AI`(리뷰어), `fcq`(정적 분석), `fcq+AI`(fcq 위반을
리뷰어가 같은 줄에서 후속 보고해 한 행으로 병합). 마크다운 표의 마지막 열이 출처이고, HTML은
지적마다 배지가 붙고 툴바의 출처 필터(전체/AI/fcq)로 걸러볼 수 있으며, 파일 블록 안에서
AI 리뷰 → 구분선 → 정적 분석 순으로 묶입니다. `fcq+AI` 행은 두 필터 모두에 나타납니다.

> 리포트 폴더의 다른 파일은 옮기거나 지우지 않습니다. 실행마다 `report-*/` 디렉터리가 쌓이므로,
> 최신 결과는 디렉터리 이름(날짜)이나 수정 시각으로 찾습니다. 예전 버전의 리포트는 `fcq/report/f-review/`에 남아 있습니다. (이전 버전은 쓸 때마다 폴더째
> `f-review.<타임스탬프>`로 옮겼고, 그 때문에 리포트가 여러 폴더로 갈라졌습니다.)

### 중간 산출물

리뷰가 도는 동안 모든 상태가 디스크에 남습니다. 문제 추적의 출발점입니다.

```
.fico/f-review/runs/<runId>/
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
한 번에 최대 100개 파일, 동시 서브에이전트 수는 `batchSize`(기본 5). 1000줄 초과
whole-file 대상은 세그먼트 unit(`path#start-end`)으로 쪼개져 각각 디스패치되고,
리포트에서는 파일 1개 섹션으로 합쳐진다(겹침 구간 중복 제거 포함).

---

## 6. 일괄 실행 명령 모음 (복사용 한 줄)

프로젝트 루트(예: `/Users/koscom/workspace/fico/on-stk-ord`)에서 실행합니다. 모델은 필요에 맞게 바꾸세요.
한 run에 최대 100파일. 파일만 넘기면 whole-file 모드로 돌고, 1000줄 초과 파일은 500줄 unit으로 쪼개져 병렬 리뷰됩니다.

### OpenCode TUI에서 (디렉터리·글롭 직접 지정 — 셸 전개 불필요)

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

### 모듈 단위 (권장)

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

### main Java 전체 (모듈 합산, 100파일 이하일 때)

> 2026-10-13 기준 on-stk-ord는 미추적 포함 **99파일**이라 상한(100) 직전입니다. 파일이 하나라도
> 늘면 plan이 거부하므로 그때는 아래 청크 루프를 쓰세요. 개수 확인:
> `git ls-files -co --exclude-standard '*/src/main/**/*.java' | grep -vc evosuite-cp`

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard '*/src/main/**/*.java' | grep -v evosuite-cp | paste -sd, -) --exclude=**/evosuite-cp/**"
```

### 100파일 초과 — 60개씩 청크로 순차 실행 (Java + 매퍼 XML 포함, on-stk-ord 기준 153파일 → 3청크)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && git ls-files -co --exclude-standard '*.java' '*/src/main/**/*.xml' | grep -v evosuite-cp | split -l 60 - /tmp/freview-chunk- && for c in /tmp/freview-chunk-*; do opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(paste -sd, - < "$c")"; done; rm -f /tmp/freview-chunk-*
```

### 최근 변경분만 (diff 모드, 가장 가벼움)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--from=v1.0.0"
```

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "HEAD~5..HEAD"
```

### 단일 파일 (세그먼트 분할 확인용 — 1,507줄 픽스처)

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=on-stk-ord-online/src/main/java/kr/co/koscom/pb/on/stk/ord/online/qry/service/SONAQ009Service.java"
```

### 백그라운드로 돌리고 로그로 지켜보기

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && nohup opencode run --command f-review -m openrouter/qwen/qwen3.8-27b -- "--files=$(git ls-files -co --exclude-standard 'on-stk-ord-online/src/main/**/*.java' | paste -sd, -)" > /tmp/freview-$(date +%H%M%S).log 2>&1 & echo "log: $(ls -t /tmp/freview-*.log | head -1)"
```

```bash
tail -f $(ls -t /tmp/freview-*.log | head -1) | grep --line-buffered -E "Agent|judged|REWORK|PASS|finalize|Report|complete|INCOMPLETE|rror"
```

### 결과 확인

```bash
cd /Users/koscom/workspace/fico/on-stk-ord && ls -td .fico/report/f-review/report-*/review.md | head -1 | xargs -I{} sh -c 'echo {}; grep -E "^\*\*|^## |Verdict" {} | head -20'
```

---

#### 전체 스윕 전에 설정을 가볍게 (`.fico/config/fico_ai.json` → `review`)

| 키 | 현장값 | 스윕 권장 | 이유 |
|---|---|---|---|
| `batchSize` | 5 | 8~10 | 동시 unit 수. 레이트리밋이 받아주는 선에서 |
| `deepPasses` | 2 | 1 | 라운드당 리뷰어 턴 전체가 한 번 더 돈다 (`--deep=1`로 CLI 지정도 가능) |
| `judge` | true | false | unit당 judge 세션 + 미달 시 전체 재리뷰. CLI로는 끌 수 없음 |
| `fcqFix` | true | false | 위반 많은 파일마다 f-fixer 세션 추가 |

현장 설정 그대로면 unit당 20~30분 × (unit 수 ÷ batchSize) 배치. 가볍게 바꾸면 67 unit 기준 1시간 안팎.

#### 주의

- 긴 `--files` 인자는 오케스트레이터 모델이 `f_review_plan` 인자로 **다시 타이핑**합니다. plan 출력의 `N file(s)`가 넘긴 개수와 같은지 확인하세요. 모듈 단위로 나누면 누락 위험이 줄어듭니다.
- `-co --exclude-standard`는 미추적 파일도 포함합니다. 추적 파일만 원하면 두 옵션을 빼세요.
- 같은 모델로 run을 동시에 둘 띄우면 레이트리밋을 나눠 써서 둘 다 느려집니다. 하나씩.
