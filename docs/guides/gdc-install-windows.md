# gdc (gordian-coder) 설치 가이드 (Windows / 폐쇄망)

## 1. 설치

```powershell
tar -xzf gordian-coder-offline-0.2.2-<타임스탬프>.tar.gz
cd offline-package

powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> **설치와 사용 모두 PowerShell 사용을 권장합니다.** `install.ps1`을 직접 실행하세요.

### 진행 단계

```
1/3 Bun 설치        → %USERPROFILE%\.bun\bin\bun.exe   (약 108MB 압축 해제)
2/3 빌드 산출물 배치 → %USERPROFILE%\gordian-coder\dist\
3/3 글로벌 링크      → bun link (gdc, gordian-coder-cli)
```

**설치 후 새 터미널을 열어야** PATH가 적용됩니다.

버전을 확인해 **의도한 버전이 제대로 설치되었는지** 반드시 검증하세요.
번들 파일명의 버전(`gordian-coder-offline-0.2.2-...`)과 아래 출력이 일치해야 합니다.

```powershell
gdc --version        # 예: gdc v0.2.2
```

값이 다르거나 명령을 찾지 못하면 이전 설치본의 링크가 남아 있는 경우입니다.
`where.exe gdc`로 실제 실행되는 경로를 확인하세요.

### 옵션

| 환경변수 | 설명 |
|---|---|
| `SKIP_BUN=1` | Bun 설치 건너뜀 (이미 있을 때 — 1단계가 통째로 생략되어 훨씬 빠름) |
| `FORCE_BUN=1` | 기존 Bun을 확인 없이 번들 버전으로 덮어쓰기 |
| `FORCE=1` | 기존 설치 경로를 확인 없이 덮어쓰기 |
| `INSTALL_DIR` | 설치 경로 (기본 `%USERPROFILE%\gordian-coder`) |
| `BUN_DIR` | Bun 경로 (기본 `%USERPROFILE%\.bun`) |

> `FORCE`는 **Bun에 영향을 주지 않습니다.** 기존 Bun은 `FORCE_BUN` 없이 교체되지 않습니다.

**무인 설치**

```powershell
$env:SKIP_BUN="1"; $env:FORCE="1"
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

---

## 2. 설치되는 것

```
%USERPROFILE%\
├── gordian-coder\
│   ├── dist\                      빌드 산출물 (약 4MB, 90개 파일)
│   └── package.json
└── .bun\
    ├── bin\
    │   ├── bun.exe
    │   ├── gdc                    ← Cline 훅 어댑터 / opencode 연동 CLI
    │   └── gordian-coder-cli
    └── install\global\node_modules\gordian-coder → ①로 연결
```

`bun link`가 만든 링크라 **`gordian-coder\`를 지우면 `gdc`도 깨집니다.**

**환경변수** (사용자 범위): `Path`에 `%USERPROFILE%\.bun\bin` 추가, `BUN_INSTALL` 설정.

---

## 3. OpenCode 플러그인 연결

OpenCode를 설치했다면 이 명령으로 연결합니다.

```powershell
gdc --init-opencode --global
```

```
[gordian-coder:opencode] 설정 파일: C:\Users\<사용자>\.config\opencode\opencode.json
[gordian-coder:opencode] 경로 결정 근거: 전역 설정 (~/.config/opencode)
[gordian-coder:opencode] 등록할 플러그인: file:///C:/Users/<사용자>/gordian-coder/dist/adapters/opencode/index.js

  현재 plugin 설정:
    (없음)

  변경 후 plugin 설정:
   → file:///C:/Users/<사용자>/gordian-coder/dist/adapters/opencode/index.js

  이 내용으로 수정하시겠습니까? (y/N): y

  [OK] 수정 완료
  백업: opencode.json.bak-<타임스탬프>
```

`plugin` 배열만 추가되고 `provider`·`model` 등 나머지 설정은 그대로 유지됩니다.

### plugin 값 형식 — `file://` URL이어야 합니다

```json
"plugin": [
  "file:///C:/Users/21481/gordian-coder/dist/adapters/opencode/index.js"
]
```

### 옵션

```powershell
gdc --init-opencode --global --yes        # 확인 없이 (무인 설치)
gdc --init-opencode                       # 현재 디렉터리의 ./opencode.json (프로젝트별)
gdc --init-opencode --config <경로>       # 설정 파일 직접 지정
gdc --deinit-opencode --global            # 등록 해제
```

동작 특성:

- **재실행 안전** — 이미 등록돼 있으면 "변경할 내용이 없습니다"로 끝나고 파일을 건드리지 않습니다
- **경로 교체** — 예전 설치 경로가 남아 있으면 새 경로로 바꿉니다(중복 추가 아님)
- **수정 전 백업**을 항상 남깁니다
- **주석이 있는 JSON은 거부** — 주석을 날려먹지 않기 위해 일부러 쓰지 않습니다

---

## 4. 업데이트

**삭제 불필요.** 새 번들로 설치 스크립트를 다시 실행하면 됩니다.

```powershell
tar -xzf gordian-coder-offline-0.2.2-<새 타임스탬프>.tar.gz
cd offline-package

$env:SKIP_BUN="1"      # Bun 이미 있음 → 108MB 압축 해제 생략
$env:FORCE="1"
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

몇 초면 끝납니다. 하는 일:

- 기존 `dist`를 **삭제한 뒤** 새 `dist` 복사 (옛 파일 잔류 방지)
- `bun link` 재등록

```powershell
gdc --version        # 새 버전인지 확인 — 번들 파일명의 버전과 일치해야 합니다
```

**`gdc --init-opencode`는 다시 안 해도 됩니다** — 설치 경로가 같으면 `opencode.json`의
플러그인 경로가 그대로 유효합니다. `INSTALL_DIR`을 바꿔 설치했다면 한 번 실행하세요
(옛 항목을 새 경로로 교체합니다).

---

## 5. 삭제

번들의 `uninstall.ps1`은 **gdc와 OpenCode를 함께** 정리합니다.

```powershell
cd offline-package
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

**완전 초기화**:

```powershell
$env:ALL=1; $env:WITH_DATA=1; $env:WITH_BUN=1
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

| 대상 | `ALL=1` 기본 |
|---|---|
| `gordian-coder\` + bun link (`gdc` 등 3개) | 삭제 |
| `.opencode\`, `.config\opencode\`, `.cache\opencode\` | 삭제 |
| `.local\share\opencode\` | **유지** → `WITH_DATA=1` |
| `.bun\` | **유지** → `WITH_BUN=1` |
| PATH · `OPENCODE_*` · `BUN_INSTALL` | 삭제 |
| `.bashrc` 블록 | 삭제 (백업 생성) |

**스크립트가 지우지 않는 것** — 프로젝트별 잔여물은 각 프로젝트에서:

```powershell
cd <프로젝트>
gdc --deinit-opencode      # 프로젝트 opencode.json의 plugin 항목
gdc --deinit               # .clinerules\hooks
```

gdc를 이미 지웠다면 수동으로 `<프로젝트>\opencode.json`의 plugin 항목과
`<프로젝트>\.clinerules\hooks\`를 삭제하세요.

### 확인 — 반드시 새 터미널에서

```powershell
where.exe gdc                                    # 아무것도 안 나와야 정상
Test-Path "$env:USERPROFILE\gordian-coder"
reg query HKCU\Environment | findstr /i bun
```

---

## 6. KB 동기화 (`gdc kb-sync`)

git wiki(`<저장소>.wiki.git`)의 `.md` 문서를 프로젝트 안의 KB 디렉터리로 내려받습니다.
f-review의 `framework_kb` 규칙이 이 디렉터리를 참조하므로, **리뷰 전에 한 번 받아두면 됩니다.**

- 저장 위치: `.fico\kb\<이름>\` (기본값)
- 방식: **미러** — 받을 때마다 대상 디렉터리를 지우고 다시 채웁니다. 그 안에 직접 만든 파일은 사라집니다
- 실행 위치: **프로젝트 루트** (설정 파일을 현재 디렉터리 기준으로 찾습니다)

### 6.1 사전 설정 ① — wiki 주소 등록

`.fico\config\fico_ai.json` 의 `wikiKb`에 등록합니다. (`review` 섹션 밖, 최상위)

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

### 6.2 사전 설정 ② — git 토큰

폐쇄망 GitLab이 로그인 없이 읽기를 허용하지 않으면 **PAT(Personal Access Token)** 가 필요합니다.

1. GitLab → 우측 상단 프로필 → **Edit profile** → **Access Tokens**
2. 권한(scope)은 **`read_repository` 하나면 충분**합니다. 만료일을 지정하세요
3. 생성된 토큰 문자열을 **환경변수에 저장** — 이름은 `tokenEnv`에 적은 값과 같아야 합니다

```powershell
# 현재 터미널에서만 (테스트용)
$env:FICO_WIKI_TOKEN = "glpat-xxxxxxxxxxxxxxxxxxxx"

# 사용자 계정에 영구 저장 → 새 터미널부터 적용
setx FICO_WIKI_TOKEN "glpat-xxxxxxxxxxxxxxxxxxxx"
```

> `setx`는 **현재 창에는 적용되지 않습니다.** 저장 후 새 PowerShell을 여세요.
> 토큰은 설정 파일·리포트·로그 어디에도 기록되지 않습니다(원격 주소는 `***`로 가려서 출력).

**토큰을 안 쓰는 경우**: `tokenEnv`를 비워두거나 변수를 설정하지 않으면, git이 이미 가진
자격증명(Windows 자격 증명 관리자, SSH 키, `~/.netrc`)을 그대로 사용합니다. 사내에서 이미
`git clone`이 되는 환경이면 토큰 설정 없이도 동작합니다.

### 6.3 사용

```powershell
cd C:\workspace\내프로젝트

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

### 6.4 정상 동작 확인

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

```powershell
Get-ChildItem -Recurse -Filter *.md .fico\kb\fico_framework | Measure-Object
```

---

## 부록: 명령 요약

```powershell
gdc --version                     버전
gdc --help                        도움말
gdc --init                        Cline 훅 설치 (.clinerules\hooks)
gdc --deinit                      Cline 훅 제거
gdc --init-opencode --global      OpenCode 플러그인 등록
gdc --deinit-opencode --global    OpenCode 플러그인 해제
gdc kb-sync                       git wiki → KB 동기화
```

| 대상 | 경로 |
|---|---|
| 본체 | `%USERPROFILE%\gordian-coder\dist\` |
| 실행 명령 | `%USERPROFILE%\.bun\bin\{gdc, gordian-coder-cli}` |
| 글로벌 링크 | `%USERPROFILE%\.bun\install\global\node_modules\gordian-coder` |
