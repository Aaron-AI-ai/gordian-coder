# =============================================================================
# 주의: 이 파일은 반드시 UTF-8 **BOM 포함**으로 저장해야 한다.
# Windows PowerShell 5.1은 BOM이 없으면 .ps1을 시스템 ANSI 코드페이지(한국어
# Windows = CP949)로 읽는다. 그러면 아래 한글이 깨지면서 뒤따르는 " 나 } 같은
# 문자를 삼켜 파싱 자체가 실패한다 (UnexpectedToken / MissingExpression 에러).
# 편집 후에는 BOM이 남아 있는지 `file *.ps1` 로 확인할 것.
# =============================================================================
# =============================================================================
# install-opencode.ps1 - OpenCode 오프라인 설치 (Windows PowerShell)
#
#   fetch-opencode.sh 로 받은 파일이 있는 디렉토리에서 실행합니다.
#   사용 가능한 플랫폼을 보여주고, 감지된 것을 기본값으로 선택하게 합니다.
#
# 환경변수:
#   DIST_DIR       파일 위치 (기본: 이 스크립트가 있는 디렉토리)
#   OPENCODE_DIR   설치 경로 (기본: %USERPROFILE%\.opencode)
#   PLATFORM       플랫폼 직접 지정 (프롬프트 생략)
#   FORCE=1        기존 설치를 확인 없이 덮어쓰기
#   SKIP_CONFIG=1  opencode.json 구성 단계를 건너뜀
#   WITH_PLUGIN_DEPS=1  @opencode-ai/plugin 트리도 배치 (사용자 플러그인 작성용)
#   API_KEY        provider apiKey (지정 시 프롬프트 없이 사용, 무인 설치용)
# =============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir = if ($env:DIST_DIR) { $env:DIST_DIR } else { $ScriptDir }
$OpencodeDir = if ($env:OPENCODE_DIR) { $env:OPENCODE_DIR } else { Join-Path $env:USERPROFILE ".opencode" }

# OpenCode는 이 파일을 자동 생성하지 않으므로 여기서 만든다.
#
# 위치는 문서상 전 플랫폼(Windows 포함) 공통으로 ~/.config/opencode/opencode.json 이다.
# %APPDATA% 가 아니다. OPENCODE_CONFIG_DIR 은 agents/commands/plugins 디렉토리를
# 가리키는 변수라 설정 파일 위치로 쓰면 안 된다 - OpenCode가 읽지 않는 파일에 쓰게 된다.
function Resolve-ConfigPath {
    if ($env:OPENCODE_CONFIG) { return $env:OPENCODE_CONFIG }
    return (Join-Path (Join-Path (Join-Path $env:USERPROFILE ".config") "opencode") "opencode.json")
}

# 설정 파일 경로는 PATH 단계와 설정 단계 양쪽에서 쓰이므로 여기서 한 번만 정한다.
$configPath = Resolve-ConfigPath


function Write-Step($msg) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
}

function Write-Info($msg) { Write-Host "  -> $msg" -ForegroundColor Gray }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  OpenCode 오프라인 설치 (Windows)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# -----------------------------------------------------------------------------
# 1. 사용 가능한 파일 수집
# -----------------------------------------------------------------------------

# opencode-<platform>-<version>.tgz 에서 플랫폼과 버전을 뽑는다.
$entries = @()
$version = ""
foreach ($f in Get-ChildItem -Path $DistDir -Filter "opencode-*.tgz" -ErrorAction SilentlyContinue) {
    if ($f.Name -match '^opencode-(.+)-(\d+\.\d+\.\d+)\.tgz$') {
        $entries += [pscustomobject]@{ Platform = $Matches[1]; File = $f.FullName; Name = $f.Name }
        $version = $Matches[2]
    }
}

if ($entries.Count -eq 0) {
    Write-Err "설치할 파일이 없습니다: $DistDir\opencode-*.tgz"
    Write-Err "fetch-opencode.sh 로 받은 파일과 같은 디렉토리에서 실행하거나,"
    Write-Err "DIST_DIR 환경변수로 위치를 지정해 주세요."
    exit 1
}

# -----------------------------------------------------------------------------
# 2. 선택
# -----------------------------------------------------------------------------

Write-Step "1/4 설치할 플랫폼 선택"

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$detected = "windows-$arch"

if ($version) { Write-Info "버전: v$version" }
Write-Info "감지된 플랫폼: $detected"

$defaultIdx = $null
Write-Host ""
Write-Host "  사용 가능한 파일:"
for ($i = 0; $i -lt $entries.Count; $i++) {
    $mark = " "
    if ($entries[$i].Platform -eq $detected) { $mark = "*"; $defaultIdx = $i + 1 }
    Write-Host ("   {0} {1,2}) {2,-24} {3}" -f $mark, ($i + 1), $entries[$i].Platform, $entries[$i].Name)
}
Write-Host ""

if ($env:PLATFORM) {
    $choice = $null
    for ($i = 0; $i -lt $entries.Count; $i++) {
        if ($entries[$i].Platform -eq $env:PLATFORM) { $choice = $i + 1 }
    }
    if (-not $choice) {
        Write-Err "PLATFORM=$($env:PLATFORM) 에 해당하는 파일이 없습니다."
        exit 1
    }
    Write-Info "PLATFORM=$($env:PLATFORM) 지정됨"
} else {
    # $input은 PowerShell 자동 변수라 다른 이름을 쓴다.
    $answer = Read-Host "  설치할 번호 [$defaultIdx]"
    $choice = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultIdx } else { $answer }
}

if (-not ($choice -match '^\d+$') -or [int]$choice -lt 1 -or [int]$choice -gt $entries.Count) {
    Write-Err "잘못된 선택입니다: $choice"
    exit 1
}

$selected = $entries[[int]$choice - 1]
Write-Info "선택: $($selected.Platform)"

# Windows에서 실행할 수 없는 바이너리는 스테이징 목적일 수 있으니 막지는 않되 확인받는다.
if (-not $selected.Platform.StartsWith("windows-")) {
    Write-Warn "선택한 플랫폼($($selected.Platform))은 Windows에서 실행할 수 없습니다."
    Write-Warn "다른 서버로 옮길 목적이라면 계속 진행해도 됩니다 (실행 검증은 생략됩니다)."
    if ($env:FORCE -ne "1") {
        $r = Read-Host "  계속하시겠습니까? (y/N)"
        if ($r -ne "y" -and $r -ne "Y") { Write-Err "설치를 중단했습니다."; exit 1 }
    }
}

# -----------------------------------------------------------------------------
# 3. 설치
# -----------------------------------------------------------------------------

Write-Step "2/4 바이너리 설치"

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Err "tar 명령을 찾을 수 없습니다. Windows 10 1803 이상이 필요합니다."
    Write-Err "또는 7-Zip 등으로 $($selected.Name) 을 직접 풀어 package\bin\opencode.exe 를 복사하세요."
    exit 1
}

$existing = Get-Command opencode -ErrorAction SilentlyContinue
if ($existing) {
    Write-Info "기존 OpenCode 발견: v$(& opencode --version 2>$null)"
    if ($env:FORCE -ne "1") {
        $r = Read-Host "  덮어쓰시겠습니까? (y/N)"
        if ($r -ne "y" -and $r -ne "Y") {
            Write-Err "설치를 중단했습니다. FORCE=1 로 확인 없이 덮어쓸 수 있습니다."
            exit 1
        }
    }
}

$binDir = Join-Path $OpencodeDir "bin"
$tempDir = Join-Path $env:TEMP "opencode-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    Write-Info "압축 해제 중..."
    tar -xzf $selected.File -C $tempDir
    if ($LASTEXITCODE -ne 0) { throw "압축 해제 실패" }

    $srcBin = Get-ChildItem -Path $tempDir -Recurse -File |
        Where-Object { $_.Name -eq "opencode.exe" -or $_.Name -eq "opencode" } |
        Select-Object -First 1
    if (-not $srcBin) { throw "아카이브에서 opencode 실행 파일을 찾을 수 없습니다: $($selected.Name)" }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item -Path $srcBin.FullName -Destination (Join-Path $binDir $srcBin.Name) -Force

    Write-Ok "설치 완료: $(Join-Path $binDir $srcBin.Name)"
} finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}

# -----------------------------------------------------------------------------
# 4. PATH 등록 + 확인
# -----------------------------------------------------------------------------

Write-Step "3/4 PATH 등록"

if (-not $selected.Platform.StartsWith("windows-")) {
    Write-Info "다른 OS용 바이너리라 PATH 등록과 실행 확인을 건너뜁니다."
} else {
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
        Write-Info "사용자 PATH에 추가됨: $binDir"
    } else {
        Write-Info "사용자 PATH에 이미 존재: $binDir"
    }

    $env:Path = "$binDir;$env:Path"

    # OpenCode는 기동 시 models.dev에서 모델 카탈로그를 받아온다. 폐쇄망에서는 이
    # 호출이 타임아웃까지 매달려 화면이 한참 비어 있다가 실패한다.
    #   - 카탈로그를 캐시에 미리 넣으면 그게 먼저 반환되어 대기가 사라지고
    #   - OPENCODE_DISABLE_MODELS_FETCH 로 60분마다 도는 재조회까지 끈다.
    # OpenCode는 ~/.opencode 를 플러그인 디렉토리로 보고 그 안 package.json의
    # 의존성(@opencode-ai/plugin)을 npm에서 설치한다. "background dependency install"
    # 이라는 이름과 달리 기동을 붙잡아, 폐쇄망에서는 레지스트리 접속이 실패할 때까지
    # (약 70초) 화면이 비어 있다. 미리 받아둔 트리를 넣어 그 호출 자체를 없앤다.
    # 설치 대상은 ~/.opencode 와 설정 디렉토리 두 곳이다. OpenCode가 두 곳 모두를
    # 플러그인 디렉토리로 보고 각각 의존성을 설치하려 들기 때문이다.
    # Copy-Item -Recurse 로 파일 4천 개를 옮기면 Windows에서 수 분이 걸린다. tar로 푼다.
    # 기동을 붙잡던 70초의 정체는 npm 재시도 백오프였다. .npmrc 로 끊는다.
    $npmrc = @"
# opencode 오프라인 설치 (gordian-coder)
#
# opencode는 기동할 때 이 디렉토리에 @opencode-ai/plugin 을 설치하려 한다.
# 폐쇄망에서는 실패할 수밖에 없는데, npm 기본 재시도(2회: 10초 + 60초)
# 때문에 기동이 약 70초 지연된다. 아래 두 줄이 그 대기를 없앤다.
#   offline        네트워크를 아예 시도하지 않는다
#   fetch-retries  실패해도 재시도하지 않는다 (70초의 정체)
offline=true
fetch-retries=0
"@
    foreach ($d in @($OpencodeDir, (Split-Path -Parent $configPath))) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        [IO.File]::WriteAllText((Join-Path $d ".npmrc"), $npmrc, (New-Object Text.UTF8Encoding($false)))
        Write-Ok "npm 재시도 차단: $(Join-Path $d '.npmrc')"
    }

    # 사용자가 직접 만든 플러그인이 @opencode-ai/plugin 을 import 하는 경우에만 필요하다.
    # 파일 4천 개를 쓰는 비용이 커서 기본값은 끔.
    $depsTar = Join-Path $DistDir "plugin-deps.tar.gz"
    if ($env:WITH_PLUGIN_DEPS -eq "1" -and (Test-Path $depsTar)) {
        foreach ($d in @($OpencodeDir, (Split-Path -Parent $configPath))) {
            # 같은 버전이 이미 있으면 건드리지 않는다. 파일 4천 개를 다시 쓰는 비용이 크다.
            $marker = Join-Path $d "node_modules\@opencode-ai\plugin\package.json"
            if ((Test-Path $marker) -and ((Get-Content -Raw $marker) -match "`"version`":\s*`"$version`"")) {
                Write-Info "플러그인 의존성 이미 배치됨 (v$version): $d"
                continue
            }
            Write-Info "플러그인 의존성 푸는 중: $d"
            Write-Info "  파일 약 4천 개라 수 분 걸릴 수 있습니다 (실시간 백신 검사)."
            New-Item -ItemType Directory -Force -Path $d | Out-Null
            $existing = Join-Path $d "node_modules"
            if (Test-Path $existing) { Remove-Item -Recurse -Force $existing }
            tar -xzf $depsTar -C $d
            if ($LASTEXITCODE -ne 0) { throw "플러그인 의존성 압축 해제 실패" }
            Write-Ok "플러그인 의존성 배치: $(Join-Path $d 'node_modules')"
        }
    } else {
        Write-Info "플러그인 의존성 배치 생략 (필요하면 WITH_PLUGIN_DEPS=1)"
    }

    # 폐쇄망에서 기동을 붙잡는 바깥 호출을 전부 끈다.
    #   MODELS_FETCH  모델 카탈로그 조회 (10초 타임아웃 + 재시도)
    #   LSP_DOWNLOAD  언어 서버 자동 다운로드 - 프로젝트를 열 때마다 시도한다
    #   AUTOUPDATE    새 버전 확인
    #   SHARE         세션 공유 업로드 (폐쇄망에서는 나갈 곳도 없다)
    foreach ($v in @(
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_SHARE"
    )) {
        [System.Environment]::SetEnvironmentVariable($v, "1", "User")
        Set-Item -Path "Env:$v" -Value "1"
    }
    Write-Info "오프라인 설정: MODELS_FETCH / LSP_DOWNLOAD / AUTOUPDATE / SHARE 차단"

    # Git Bash, MobaXterm 등은 HOME이 달라 설정 파일이 갈라진다. 한 파일로 고정한다.
    [System.Environment]::SetEnvironmentVariable("OPENCODE_CONFIG", $configPath, "User")
    Write-Info "설정 파일 고정: OPENCODE_CONFIG=$configPath"

    # --- Git Bash / MobaXterm ---------------------------------------------
    # 두 셸은 Windows 사용자 환경변수를 물려받지만, rc에서 PATH를 다시 잡거나
    # 홈이 달라지는 경우가 있어 .bashrc 에도 명시해 둔다. 드라이브 마운트 표기가
    # 셸마다 달라(/c, /drives/c, /cygdrive/c) 존재하는 경로만 PATH에 넣는다.
    $winBin = (Join-Path $binDir "").TrimEnd('\')
    $bunBin = Join-Path (Join-Path $env:USERPROFILE ".bun") "bin"
    $rel = $winBin.Substring(2) -replace '\\', '/'      # C:\Users\me\... -> /Users/me/...
    $bunRel = $bunBin.Substring(2) -replace '\\', '/'
    $drive = $winBin.Substring(0, 1).ToLower()

    $bashBlock = @"
# opencode / gordian-coder (offline install) --- BEGIN
# 드라이브 마운트 표기는 셸마다 다르다. 존재하는 것만 PATH에 추가한다.
for _d in /$drive$rel /drives/$drive$rel /cygdrive/$drive$rel; do
  [ -d "`$_d" ] && export PATH="`$_d:`$PATH"
done
for _d in /$drive$bunRel /drives/$drive$bunRel /cygdrive/$drive$bunRel; do
  [ -d "`$_d" ] && export PATH="`$_d:`$PATH"
done
unset _d
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_LSP_DOWNLOAD=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_SHARE=1
export OPENCODE_CONFIG="$configPath"
# MinTTY에서는 TUI가 안 그려질 수 있다. winpty가 있으면 그걸로 감싼다.
command -v winpty >/dev/null 2>&1 && alias opencode='winpty opencode'
# opencode / gordian-coder (offline install) --- END
"@

    # Git Bash는 %USERPROFILE%\.bashrc, MobaXterm은 자체 홈을 쓴다.
    $bashHomes = @($env:USERPROFILE)
    $mobaHome = Join-Path $env:USERPROFILE "Documents\MobaXterm\home"
    if (Test-Path $mobaHome) { $bashHomes += $mobaHome }

    foreach ($h in $bashHomes) {
        $rc = Join-Path $h ".bashrc"
        $existing = if (Test-Path $rc) { Get-Content -Raw $rc } else { "" }
        if ($existing -match "gordian-coder \(offline install\) --- BEGIN") {
            # 기존 블록을 통째로 갈아끼운다 (경로가 바뀌었을 수 있다).
            $existing = [regex]::Replace(
                $existing,
                "(?s)# opencode / gordian-coder \(offline install\) --- BEGIN.*?--- END\r?\n?",
                "")
        }
        [IO.File]::WriteAllText($rc, ($existing.TrimEnd() + "`n`n" + $bashBlock),
                                (New-Object Text.UTF8Encoding($false)))
        Write-Ok "셸 설정 추가: $rc"
    }
    Write-Info "Git Bash / MobaXterm 에서도 새 터미널을 열면 적용됩니다."

    $ver = & (Join-Path $binDir "opencode.exe") --version 2>$null
    Write-Ok "실행 확인: v$ver"
}

# -----------------------------------------------------------------------------
# 5. opencode.json 구성
# -----------------------------------------------------------------------------

Write-Step "4/4 opencode.json 구성"

function Format-Key($k) {
    if (-not $k) { return "(없음)" }
    if ($k.Length -le 12) { return "****" }
    return "$($k.Substring(0,6))...$($k.Substring($k.Length-4))"
}

# apiKey는 opencode.json에 평문으로 두지 않는다. 설정에는 {env:NAME} 참조만 쓰고
# 실제 값은 사용자 환경변수(레지스트리 HKCU)에 넣는다 - 다른 계정에서는 보이지 않는다.
function Get-EnvVarName($providerId) {
    $upper = ($providerId.ToUpper() -replace '[^A-Z0-9]', '_')
    return "OPENCODE_${upper}_API_KEY"
}

# "{env:NAME}" -> NAME, 그 외에는 빈 문자열
function Get-EnvRefName($value) {
    if ($value -match '^\{env:(.+)\}$') { return $Matches[1] }
    return ""
}

function Get-UserEnvValue($name) {
    $v = [System.Environment]::GetEnvironmentVariable($name, "User")
    if ($v) { return $v }
    return [System.Environment]::GetEnvironmentVariable($name, "Process")
}

function Read-WithDefault($label, $default) {
    $v = Read-Host ("    {0} [{1}]" -f $label, $default)
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}

function Show-ProviderSettings($title, $pid_, $name, $npm, $baseUrl, $key, $envVar, $mid, $ctx, $out) {
    Write-Host ""
    Write-Host "  $title"
    Write-Host ("    {0,-14} {1}" -f "provider id", $pid_)
    Write-Host ("    {0,-14} {1}" -f "name", $name)
    Write-Host ("    {0,-14} {1}" -f "npm", $npm)
    Write-Host ("    {0,-14} {1}" -f "baseURL", $baseUrl)
    if ($envVar) {
        Write-Host ("    {0,-14} {1}" -f "apiKey", "{env:$envVar}")
        Write-Host ("    {0,-14} {1}" -f "  실제 값", (Format-Key $key))
    } else {
        Write-Host ("    {0,-14} {1}" -f "apiKey", ((Format-Key $key) + " (평문)"))
    }
    Write-Host ("    {0,-14} {1}" -f "model id", $mid)
    Write-Host ("    {0,-14} {1}" -f "context", $ctx)
    Write-Host ("    {0,-14} {1}" -f "output", $out)
    Write-Host "    -> 기본 모델    $pid_/$mid"
    Write-Host ""
}

# 이미지의 사내 설정을 기본값으로 둔다. apiKey만 기본값이 없다.
$curPId = "internal"
$curPName = "Koscom LLM"
$curPNpm = "@ai-sdk/openai-compatible"
$curPBaseUrl = "http://ollama.ai.koscom.co.kr/v1"
$curPApiKey = ""
$curMId = "Qwen-Coder"
$curMName = "Qwen-Coder"
$curMContext = 131072
$curMOutput = 40960
$oldPId = ""
$curEnvVar = ""

if ($env:SKIP_CONFIG -eq "1") {
    Write-Info "SKIP_CONFIG=1 - 건너뜀"
} elseif (-not $selected.Platform.StartsWith("windows-")) {
    Write-Info "다른 OS용 설치라 설정 구성을 건너뜁니다."
} else {
    Write-Info "설정 파일: $configPath"
    if ($env:OPENCODE_CONFIG) { Write-Info "경로 근거: OPENCODE_CONFIG" }

    $cfg = $null
    if (Test-Path $configPath) {
        try {
            $cfg = Get-Content -Raw -Path $configPath -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Write-Err "설정 파일을 파싱할 수 없습니다: $configPath"
            Write-Err "주석이나 문법 오류가 있으면 자동 수정하지 않습니다. 직접 고친 뒤 다시 실행하세요."
            $cfg = $null
            $configPath = $null
        }
    } else {
        Write-Info "설정 파일이 없습니다. 새로 만듭니다."
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configPath) | Out-Null
    }

    if ($configPath) {
        # 기존 값을 프롬프트 기본값으로 끌어올린다.
        if ($cfg -and $cfg.provider) {
            $pid_ = ($cfg.provider.PSObject.Properties | Select-Object -First 1).Name
            if ($pid_) {
                $p = $cfg.provider.$pid_
                $oldPId = $pid_; $curPId = $pid_
                if ($p.name) { $curPName = $p.name }
                if ($p.npm) { $curPNpm = $p.npm }
                if ($p.options.baseURL) { $curPBaseUrl = $p.options.baseURL }
                if ($p.options.apiKey) {
                    # {env:NAME} 참조면 실제 값은 사용자 환경변수 쪽에 있다.
                    $ref = Get-EnvRefName $p.options.apiKey
                    if ($ref) {
                        $curEnvVar = $ref
                        $curPApiKey = Get-UserEnvValue $ref
                    } else {
                        $curPApiKey = $p.options.apiKey
                    }
                }
                if ($p.models) {
                    $mid = ($p.models.PSObject.Properties | Select-Object -First 1).Name
                    if ($mid) {
                        $m = $p.models.$mid
                        $curMId = $mid
                        if ($m.name) { $curMName = $m.name }
                        if ($m.limit.context) { $curMContext = $m.limit.context }
                        if ($m.limit.output) { $curMOutput = $m.limit.output }
                    }
                }
            }
        }

        if ($oldPId) {
            Show-ProviderSettings "현재 설정:" $curPId $curPName $curPNpm $curPBaseUrl $curPApiKey $curEnvVar $curMId $curMContext $curMOutput
        }

        $doConfigure = $true
        if ($env:API_KEY) {
            # API_KEY를 명시했다는 건 설정하겠다는 뜻이다 - FORCE보다 우선한다.
        } elseif ($oldPId -and $curPApiKey) {
            if ($env:FORCE -eq "1") {
                $doConfigure = $false
            } else {
                $r = Read-Host "  설정을 수정하시겠습니까? (y/N)"
                if ($r -ne "y" -and $r -ne "Y") { $doConfigure = $false }
            }
            if (-not $doConfigure) { Write-Info "기존 설정을 유지합니다." }
        }

        if ($doConfigure) {
            Write-Host "  provider 정보를 입력하세요 (엔터 = 기본값)"
            Write-Host ""
            $newPId = Read-WithDefault "provider id" $curPId
            $newPName = Read-WithDefault "name       " $curPName
            $newPNpm = Read-WithDefault "npm        " $curPNpm
            $newPBaseUrl = Read-WithDefault "baseURL    " $curPBaseUrl

            # apiKey는 기본값을 두지 않는다 - 빈 값이면 OpenCode가 인증에 실패한다.
            $newPApiKey = $env:API_KEY
            while (-not $newPApiKey) {
                if ($curPApiKey) {
                    $v = Read-Host ("    apiKey      [{0}] (엔터=유지)" -f (Format-Key $curPApiKey))
                    $newPApiKey = if ([string]::IsNullOrWhiteSpace($v)) { $curPApiKey } else { $v }
                } else {
                    $newPApiKey = Read-Host "    apiKey      (필수)"
                    if (-not $newPApiKey) { Write-Warn "apiKey는 반드시 입력해야 합니다." }
                }
            }

            $newMId = Read-WithDefault "model id   " $curMId
            $newMName = Read-WithDefault "model name " $curMName
            $newMContext = Read-WithDefault "context    " $curMContext
            $newMOutput = Read-WithDefault "output     " $curMOutput

            # provider id가 바뀌면 변수명도 따라간다. 기존 참조가 있으면 그대로 쓴다.
            if ($curEnvVar -and $newPId -eq $curPId) {
                $newEnvVar = $curEnvVar
            } else {
                $newEnvVar = Get-EnvVarName $newPId
            }

            if (Test-Path $configPath) {
                $backup = "$configPath.bak-$(Get-Date -Format 'yyyyMMddTHHmmss')"
                Copy-Item -Path $configPath -Destination $backup -Force
                Write-Info "백업: $backup"
            }

            # 비밀값은 사용자 환경변수(HKCU)로, 설정에는 참조만.
            [System.Environment]::SetEnvironmentVariable($newEnvVar, $newPApiKey, "User")
            Set-Item -Path "Env:$newEnvVar" -Value $newPApiKey
            Write-Ok "비밀값 저장: 사용자 환경변수 $newEnvVar"

            if (-not $cfg) { $cfg = [pscustomobject]@{} }
            # provider id를 바꿨으면 옛 항목을 남기지 않는다.
            if (-not $cfg.PSObject.Properties['provider']) {
                $cfg | Add-Member -NotePropertyName provider -NotePropertyValue ([pscustomobject]@{})
            }
            if ($oldPId -and $oldPId -ne $newPId) {
                $cfg.provider.PSObject.Properties.Remove($oldPId)
            }
            $providerValue = [pscustomobject]@{
                npm     = $newPNpm
                name    = $newPName
                options = [pscustomobject]@{ baseURL = $newPBaseUrl; apiKey = "{env:$newEnvVar}" }
                models  = [pscustomobject]@{ $newMId = [pscustomobject]@{
                    name  = $newMName
                    limit = [pscustomobject]@{ context = [int]$newMContext; output = [int]$newMOutput }
                } }
            }
            if ($cfg.provider.PSObject.Properties[$newPId]) {
                $cfg.provider.$newPId = $providerValue
            } else {
                $cfg.provider | Add-Member -NotePropertyName $newPId -NotePropertyValue $providerValue
            }

            foreach ($kv in @(
                @{ n = '$schema'; v = "https://opencode.ai/config.json" },
                @{ n = 'autoupdate'; v = $false },
                @{ n = 'plugin'; v = @() }
            )) {
                if (-not $cfg.PSObject.Properties[$kv.n]) {
                    $cfg | Add-Member -NotePropertyName $kv.n -NotePropertyValue $kv.v
                }
            }
            if ($cfg.PSObject.Properties['model']) {
                $cfg.model = "$newPId/$newMId"
            } else {
                $cfg | Add-Member -NotePropertyName model -NotePropertyValue "$newPId/$newMId"
            }

            $json = $cfg | ConvertTo-Json -Depth 20
            [IO.File]::WriteAllText($configPath, $json + "`n", (New-Object Text.UTF8Encoding($false)))
            Write-Ok "저장됨: $configPath"
            Show-ProviderSettings "적용된 설정:" $newPId $newPName $newPNpm $newPBaseUrl $newPApiKey $newEnvVar $newMId $newMContext $newMOutput
        }
    }

    # 플러그인 등록은 이 스크립트가 대신 하지 않는다 - 사용자가 직접 실행한다.
    Write-Info "플러그인 등록은 아래를 직접 실행하세요:"
    Write-Info "  gdc --init-opencode --global"
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  OpenCode 설치 완료" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  플랫폼:    $($selected.Platform)"
if ($version) { Write-Host "  버전:      v$version" }
Write-Host "  설치 경로: $binDir"
if ($configPath) { Write-Host "  설정 파일: $configPath" }
Write-Host ""
if ($selected.Platform.StartsWith("windows-")) {
    Write-Host "  새 터미널을 열어야 PATH가 적용됩니다." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  플러그인 등록:"
    Write-Host "    gdc --init-opencode --global"
    Write-Host ""
}
