# =============================================================================
# 주의: 이 파일은 반드시 UTF-8 **BOM 포함**으로 저장해야 한다.
# Windows PowerShell 5.1은 BOM이 없으면 .ps1을 시스템 ANSI 코드페이지(한국어
# Windows = CP949)로 읽는다. 그러면 아래 한글이 깨지면서 뒤따르는 " 나 } 같은
# 문자를 삼켜 파싱 자체가 실패한다 (UnexpectedToken / MissingExpression 에러).
# 편집 후에는 BOM이 남아 있는지 확인할 것.
# =============================================================================
# =============================================================================
# uninstall.ps1 - gordian-coder / OpenCode 제거 (Windows PowerShell)
#
#   무엇이 설치돼 있는지 먼저 보여주고, 항목별로 확인을 받아 지웁니다.
#
# 환경변수:
#   ALL=1           프롬프트 없이 진행 (아래 "기본 제외" 항목은 여전히 제외)
#   WITH_DATA=1     opencode 세션 DB / auth.json 까지 삭제
#   WITH_BUN=1      Bun 런타임까지 삭제
#   INSTALL_DIR     gordian-coder 설치 경로 (기본 %USERPROFILE%\gordian-coder)
#   OPENCODE_DIR    opencode 설치 경로 (기본 %USERPROFILE%\.opencode)
#   BUN_DIR         Bun 경로 (기본 %USERPROFILE%\.bun)
# =============================================================================

$ErrorActionPreference = "Stop"

$InstallBase = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:USERPROFILE "gordian-coder" }
$OpencodeBase = if ($env:OPENCODE_DIR) { $env:OPENCODE_DIR } else { Join-Path $env:USERPROFILE ".opencode" }
$BunBase = if ($env:BUN_DIR) { $env:BUN_DIR } else { Join-Path $env:USERPROFILE ".bun" }
$ConfigDir = Join-Path (Join-Path $env:USERPROFILE ".config") "opencode"
$DataDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".local") "share") "opencode"
$CacheDir = Join-Path (Join-Path $env:USERPROFILE ".cache") "opencode"

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

function Confirm-Step($msg) {
    if ($env:ALL -eq "1") { return $true }
    $r = Read-Host "  $msg (y/N)"
    return ($r -eq "y" -or $r -eq "Y")
}

# 삭제는 사용자 홈 아래로만 허용한다. 경로 변수가 비거나 잘못 들어왔을 때
# 엉뚱한 곳을 지우는 사고를 막기 위한 최소한의 방어선.
function Remove-Safely($target, $label) {
    if (-not $target -or $target -eq $env:USERPROFILE) {
        Write-Err "안전 검사 실패 - 삭제하지 않습니다: '$target'"
        return
    }
    if (-not $target.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Err "홈 디렉토리 밖이라 삭제하지 않습니다: $target"
        return
    }
    if (-not (Test-Path $target)) {
        Write-Info "$label - 없음 (건너뜀)"
        return
    }
    Remove-Item -Recurse -Force $target
    Write-Ok "$label 삭제: $target"
}

function Get-SizeText($path) {
    if (-not (Test-Path $path)) { return "-" }
    $bytes = (Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { return "0" }
    return "{0:N1} MB" -f ($bytes / 1MB)
}

# -----------------------------------------------------------------------------
# 1. 현재 설치 상태
# -----------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  gordian-coder / OpenCode 제거 (Windows)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

Write-Step "1/3 현재 설치 상태"

foreach ($row in @(
    @{ n = "gordian-coder";     p = $InstallBase },
    @{ n = "opencode 실행파일"; p = $OpencodeBase },
    @{ n = "opencode 설정";     p = $ConfigDir },
    @{ n = "opencode 데이터";   p = $DataDir },
    @{ n = "Bun 런타임";        p = $BunBase }
)) {
    Write-Host ("  {0,-20} {1,-50} {2}" -f $row.n, $row.p, (Get-SizeText $row.p))
}

Write-Host ""
$gdcCmd = Get-Command gdc -ErrorAction SilentlyContinue
if ($gdcCmd) { Write-Info "gdc: $($gdcCmd.Source)" }
$ocCmd = Get-Command opencode -ErrorAction SilentlyContinue
if ($ocCmd) { Write-Info "opencode: $($ocCmd.Source)" }

Write-Host ""
Write-Warn "설정(opencode.json, apiKey)과 데이터(세션 DB, auth.json)는 복구되지 않습니다."

# -----------------------------------------------------------------------------
# 2. 삭제
# -----------------------------------------------------------------------------

Write-Step "2/3 삭제"

if (Confirm-Step "gordian-coder를 삭제할까요? ($InstallBase)") {
    # 디렉토리를 지우기 전에 링크를 먼저 끊어야 죽은 링크가 남지 않는다.
    if ((Test-Path (Join-Path $InstallBase "package.json")) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
        Push-Location $InstallBase
        & bun unlink 2>$null | Out-Null
        Pop-Location
    }
    foreach ($n in @("gdc", "gordian-coder-cli", "gordian-coder-mcp")) {
        foreach ($ext in @("", ".exe", ".cmd", ".ps1", ".bunx")) {
            $f = Join-Path (Join-Path $BunBase "bin") "$n$ext"
            if (Test-Path $f) { Remove-Item -Force $f }
        }
    }
    $globalLink = Join-Path (Join-Path (Join-Path $BunBase "install") "global") "node_modules\gordian-coder"
    if (Test-Path $globalLink) { Remove-Item -Recurse -Force $globalLink }
    Remove-Safely $InstallBase "gordian-coder"
    Write-Ok "글로벌 링크 정리 완료"
}

if (Confirm-Step "opencode 실행 파일을 삭제할까요? ($OpencodeBase)") {
    Remove-Safely $OpencodeBase "opencode"
}

if (Confirm-Step "opencode 설정을 삭제할까요? ($ConfigDir - opencode.json, apiKey 포함)") {
    Remove-Safely $ConfigDir "opencode 설정"
}

if (Confirm-Step "opencode 캐시를 삭제할까요? ($CacheDir - 모델 카탈로그)") {
    Remove-Safely $CacheDir "opencode 캐시"
}

if ($env:WITH_DATA -eq "1") {
    Remove-Safely $DataDir "opencode 데이터"
} elseif (Test-Path $DataDir) {
    if ($env:ALL -eq "1") {
        Write-Info "opencode 데이터 유지 (WITH_DATA=1 로 삭제 가능): $DataDir"
    } elseif (Confirm-Step "opencode 데이터(세션 DB, auth.json)도 삭제할까요? ($DataDir)") {
        Remove-Safely $DataDir "opencode 데이터"
    }
}

if ($env:WITH_BUN -eq "1") {
    Remove-Safely $BunBase "Bun 런타임"
} elseif (Test-Path $BunBase) {
    if ($env:ALL -eq "1") {
        Write-Info "Bun 유지 (WITH_BUN=1 로 삭제 가능): $BunBase"
    } elseif (Confirm-Step "Bun 런타임도 삭제할까요? (다른 도구가 쓰고 있을 수 있습니다)") {
        Remove-Safely $BunBase "Bun 런타임"
    }
}

# -----------------------------------------------------------------------------
# 3. 환경변수 정리
# -----------------------------------------------------------------------------

Write-Step "3/3 환경변수 정리"

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
    $drop = @((Join-Path $BunBase "bin"), (Join-Path $OpencodeBase "bin"))
    $kept = $userPath.Split(';') | Where-Object {
        $entry = $_.TrimEnd('\')
        $_ -and ($drop -notcontains $entry)
    }
    $newPath = ($kept -join ';')
    if ($newPath -ne $userPath) {
        if (Confirm-Step "사용자 PATH에서 설치 경로를 제거할까요?") {
            [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            Write-Ok "PATH 정리 완료"
        }
    } else {
        Write-Info "PATH에 남은 설치 경로가 없습니다."
    }
}

# 설치 스크립트가 만든 apiKey 환경변수 (OPENCODE_*_API_KEY)
$apiVars = [System.Environment]::GetEnvironmentVariables("User").Keys |
    Where-Object { $_ -like "OPENCODE_*_API_KEY" }
foreach ($v in $apiVars) {
    if (Confirm-Step "환경변수 $v 를 삭제할까요? (apiKey)") {
        [System.Environment]::SetEnvironmentVariable($v, $null, "User")
        Write-Ok "$v 삭제"
    }
}
if (-not $apiVars) { Write-Info "삭제할 apiKey 환경변수가 없습니다." }

# 설치가 만든 나머지 OPENCODE_* 변수 (DISABLE 4종 + CONFIG)
$otherVars = [System.Environment]::GetEnvironmentVariables("User").Keys |
    Where-Object { $_ -like "OPENCODE_DISABLE_*" -or $_ -eq "OPENCODE_CONFIG" }
foreach ($v in $otherVars) {
    if (Confirm-Step "환경변수 $v 를 삭제할까요?") {
        [System.Environment]::SetEnvironmentVariable($v, $null, "User")
        Write-Ok "$v 삭제"
    }
}
if (-not $otherVars) { Write-Info "삭제할 OPENCODE_* 설정 변수가 없습니다." }

# Git Bash / MobaXterm 용 .bashrc 블록도 걷어낸다.
$bashHomes = @($env:USERPROFILE, (Join-Path $env:USERPROFILE "Documents\MobaXterm\home"))
foreach ($h in $bashHomes) {
    $rc = Join-Path $h ".bashrc"
    if (-not (Test-Path $rc)) { continue }
    $c = Get-Content -Raw $rc
    if ($c -notmatch "gordian-coder \(offline install\) --- BEGIN") { continue }
    if (Confirm-Step "$rc 에서 설치 스크립트가 추가한 블록을 지울까요?") {
        Copy-Item $rc "$rc.bak-$(Get-Date -Format 'yyyyMMddTHHmmss')" -Force
        $c = [regex]::Replace($c,
            "(?s)# opencode / gordian-coder \(offline install\) --- BEGIN.*?--- END\r?\n?", "")
        [IO.File]::WriteAllText($rc, $c.TrimEnd() + "`n", (New-Object Text.UTF8Encoding($false)))
        Write-Ok "정리 완료: $rc"
    }
}

if ([System.Environment]::GetEnvironmentVariable("BUN_INSTALL", "User")) {
    if (Confirm-Step "환경변수 BUN_INSTALL 을 삭제할까요?") {
        [System.Environment]::SetEnvironmentVariable("BUN_INSTALL", $null, "User")
        Write-Ok "BUN_INSTALL 삭제"
    }
}

# -----------------------------------------------------------------------------
# 요약
# -----------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  제거 완료" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  남아 있는 항목:"
foreach ($p in @($InstallBase, $OpencodeBase, $ConfigDir, $DataDir, $CacheDir, $BunBase)) {
    if (Test-Path $p) { Write-Host "    - $p" }
}
Write-Host ""
Write-Host "  새 터미널을 열어야 PATH 변경이 반영됩니다." -ForegroundColor Yellow
Write-Host ""
