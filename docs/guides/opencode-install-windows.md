# OpenCode 설치 가이드 (Windows / 폐쇄망)

## 1. 설치

```powershell
tar -xzf opencode-1.18.27-offline-<타임스탬프>.tar.gz
cd 1.18.27

powershell -ExecutionPolicy Bypass -File .\install-opencode.ps1
```

### 진행 화면

**apiKey만 입력하고 나머지는 전부 엔터**를 치면 됩니다.

- **apiKey**는 **AX 추진실에 요청하여 발급**받으세요.
- **모델 관련 정보**(`provider id`, `name`, `baseURL`, `model id`, `context`, `output`)는
  기본값이 예시일 뿐이므로, **AX 추진실에서 서비스 중인 모델 정보로 변경하여** 사용하세요.
  기본값 그대로 두면 예시 엔드포인트를 가리켜 실제 호출이 되지 않습니다.

```
1/4 설치할 플랫폼 선택
  감지된 플랫폼: windows-x64
   *  1) windows-x64    opencode-windows-x64-1.18.27.tgz
  설치할 번호 [1]:                                        ⏎

2/4 바이너리 설치        → %USERPROFILE%\.opencode\bin\opencode.exe
3/4 PATH 등록            → 사용자 PATH + 오프라인 환경변수 + .bashrc

4/4 opencode.json 구성
  provider id [internal]:                                 ⏎
  name        [Koscom LLM]:                               ⏎
  npm         [@ai-sdk/openai-compatible]:                ⏎
  baseURL     [http://ollama.ai.koscom.co.kr/v1]:         ⏎
  apiKey      (필수): sk-AX추진실로부터받은KEY       ← 이것만 입력
  model id    [Qwen-Coder]:                               ⏎
  model name  [Qwen-Coder]:                               ⏎
  context     [131072]:                                   ⏎
  output      [40960]:                                    ⏎
```

**설치 후 새 터미널을 열어야** PATH와 환경변수가 적용됩니다.

버전을 확인해 **의도한 버전이 제대로 설치되었는지** 반드시 검증하세요.
번들 파일명의 버전(`opencode-1.18.27-offline-...`)과 아래 출력이 일치해야 합니다.

```powershell
opencode --version        # 예: 1.18.27
```

값이 다르거나 명령을 찾지 못하면 이전 설치본이 PATH에 남아 있는 경우입니다.
`where.exe opencode`로 실제 실행되는 경로를 확인하세요.

---

## 2. 설치되는 것

### 파일

```
%USERPROFILE%\
├── .opencode\
│   ├── bin\opencode.exe          실행 파일 (약 171MB)
│   └── .npmrc                    npm 재시도 차단 ★
├── .config\opencode\
│   ├── opencode.json             provider·모델 설정
│   ├── env                       apiKey 실제 값
│   └── .npmrc                    npm 재시도 차단 ★
└── .local\share\opencode\        opencode가 첫 실행 때 자동 생성
    ├── auth.json                 opencode auth login 사용 시
    ├── opencode.db               세션·메시지 (SQLite)
    └── log\  repos\  snapshot\
```

> **설정 파일 위치는 전 플랫폼 공통으로 `~/.config/opencode/opencode.json`** 입니다.
> Windows에서도 `%APPDATA%`가 아니라 홈 아래 `.config`입니다.

### `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "internal": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Koscom LLM",
      "options": {
        "baseURL": "http://ollama.ai.koscom.co.kr/v1",
        "apiKey": "{env:OPENCODE_INTERNAL_API_KEY}"
      },
      "models": {
        "Qwen-Coder": {
          "name": "Qwen-Coder",
          "limit": { "context": 131072, "output": 40960 }
        }
      }
    }
  },
  "model": "internal/Qwen-Coder",
  "autoupdate": false,
  "plugin": []
}
```

apiKey는 평문으로 두지 않고 `{env:...}` 참조만 저장합니다. 실제 값은 사용자 환경변수와
`~\.config\opencode\env`에 들어갑니다.

`plugin` 배열은 비어 있습니다 — [gdc 설치 가이드](./gdc-install-windows.md)의
`gdc --init-opencode --global`이 채웁니다.

### 환경변수 (사용자 범위, HKCU)

| 변수 | 값 | 목적 |
|---|---|---|
| `Path` | `...\.opencode\bin` 추가 | 실행 |
| `OPENCODE_DISABLE_MODELS_FETCH` | `1` | 모델 카탈로그 조회 차단 (~20초) |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `1` | 언어 서버 다운로드 차단 |
| `OPENCODE_DISABLE_AUTOUPDATE` | `1` | 버전 확인 차단 |
| `OPENCODE_DISABLE_SHARE` | `1` | 세션 공유 업로드 차단 |
| `OPENCODE_CONFIG` | 설정 파일 절대경로 | 셸 간 설정 통일 |
| `OPENCODE_INTERNAL_API_KEY` | apiKey | 인증 |

---

## 3. 업데이트

같은 절차를 새 번들로 다시 실행하면 됩니다. **삭제 불필요.**

```powershell
tar -xzf opencode-1.18.27-offline-<새 타임스탬프>.tar.gz
cd 1.18.27
powershell -ExecutionPolicy Bypass -File .\install-opencode.ps1
```

- 바이너리 덮어쓰기 → `y`
- **provider 설정 수정 → `N`** (기존 apiKey·엔드포인트 유지)

설정을 바꾸고 싶을 때만 `y`를 누르면 현재 값을 보여주고 하나씩 수정할 수 있습니다.

```
현재 설정:
  provider id    internal
  baseURL        http://ollama.ai.koscom.co.kr/v1
  apiKey         {env:OPENCODE_INTERNAL_API_KEY}
  └ 실제 값      sk-AX-...7890
  ...
설정을 수정하시겠습니까? (y/N):
```

수정 시 `opencode.json.bak-<타임스탬프>` 백업이 남습니다.

### 설정만 바꾸기 (재설치 없이)

```powershell
notepad "$env:USERPROFILE\.config\opencode\opencode.json"
opencode debug config          # 병합 결과 확인 (파싱 에러도 여기서 드러남)
```

> `opencode.json`에 **주석을 넣지 마세요.** opencode는 읽을 수 있어도
> `gdc --init-opencode`가 거부합니다.

apiKey만 교체:

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_INTERNAL_API_KEY","sk-새키","User")
```

---

## 4. 삭제

```powershell
cd 1.18.27
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

현재 설치 상태를 먼저 보여주고 항목별로 물어봅니다. **완전 초기화**는:

```powershell
$env:ALL=1; $env:WITH_DATA=1; $env:WITH_BUN=1
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

| 대상 | `ALL=1` 기본 | 비고 |
|---|---|---|
| `gordian-coder\` + bun link | 삭제 | |
| `.opencode\` (exe, .npmrc) | 삭제 | |
| `.config\opencode\` (설정, **apiKey**) | 삭제 | |
| `.cache\opencode\` | 삭제 | |
| `.local\share\opencode\` (세션, auth) | **유지** | `WITH_DATA=1`로 삭제 |
| `.bun\` | **유지** | `WITH_BUN=1`로 삭제 |
| PATH · `OPENCODE_*` · `BUN_INSTALL` | 삭제 | |
| `.bashrc` 블록 | 삭제 | 수정 전 백업 |

세션 기록과 Bun은 일부러 남깁니다 — 인증이 날아가고, Bun은 다른 도구가 쓸 수 있습니다.

### 확인 — 반드시 새 터미널에서

```powershell
where.exe opencode                                  # 아무것도 안 나와야 정상
reg query HKCU\Environment | findstr /i opencode    # 비어야 정상
Get-ChildItem "$env:USERPROFILE" -Force -Filter "*opencode*"
```

> 환경변수 삭제는 **레지스트리**에 반영되지만 **이미 열린 터미널에는 반영되지 않습니다.**
> 지금 창에서 `Get-ChildItem Env:`로 확인하면 여전히 보이는 것이 정상입니다.

---

## 부록: 경로 요약

| 대상 | 경로 |
|---|---|
| 실행 파일 | `%USERPROFILE%\.opencode\bin\opencode.exe` |
| 설정 | `%USERPROFILE%\.config\opencode\opencode.json` |
| apiKey | 사용자 환경변수 `OPENCODE_INTERNAL_API_KEY` + `.config\opencode\env` |
| npm 설정 | `%USERPROFILE%\.opencode\.npmrc`, `%USERPROFILE%\.config\opencode\.npmrc` |
| 세션·인증 | `%USERPROFILE%\.local\share\opencode\` |
| 캐시 | `%USERPROFILE%\.cache\opencode\` |

진단 명령:

```powershell
opencode debug paths       # 실제 경로 확인
opencode debug config      # 병합된 설정 확인
opencode models            # 사용 가능한 모델
```

---

> **설치와 사용 모두 PowerShell 사용을 권장합니다.**
