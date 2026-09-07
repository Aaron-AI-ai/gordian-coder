# =============================================================================
# 주의: 이 파일은 반드시 UTF-8 **BOM 포함**으로 저장해야 한다.
# Windows PowerShell 5.1은 BOM이 없으면 .ps1을 시스템 ANSI 코드페이지(한국어
# Windows = CP949)로 읽는다. 그러면 아래 한글이 깨지면서 뒤따르는 " 나 } 같은
# 문자를 삼켜 파싱 자체가 실패한다 (UnexpectedToken / MissingExpression 에러).
# 편집 후에는 BOM이 남아 있는지 `file *.ps1` 로 확인할 것.
# =============================================================================
# =============================================================================
# install.ps1 - gordian-coder 오프라인 설치 (Windows PowerShell)
#
#   tar -xzf gordian-coder-offline-<version>.tar.gz
#   cd offline-package; .\install.ps1
#
# 인터넷 연결 없이 Bun 설치 → 빌드 산출물 배치 → 글로벌 링크를 수행합니다.
# dist는 의존성이 번들된 산출물이라 대상 서버에서 빌드하지 않습니다.
#
# 환경변수:
#   INSTALL_DIR  설치 경로 (기본 %USERPROFILE%\gordian-coder)
#   BUN_DIR      Bun 설치 경로 (기본 %USERPROFILE%\.bun)
#   FORCE=1      기존 설치 경로를 확인 없이 덮어쓰기
#   SKIP_BUN=1   Bun 설치 건너뜀 (대상 서버에 이미 Bun이 있는 경우)
#   FORCE_BUN=1  기존 Bun을 확인 없이 번들된 버전으로 덮어쓰기
#
# FORCE는 Bun에 영향을 주지 않습니다 - 기존 Bun은 FORCE_BUN 없이는 교체되지 않습니다.
# =============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallBase = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:USERPROFILE "gordian-coder" }
$BunInstallDir = if ($env:BUN_DIR) { $env:BUN_DIR } else { Join-Path $env:USERPROFILE ".bun" }

# -----------------------------------------------------------------------------
# 함수 정의
# -----------------------------------------------------------------------------

function Write-Step($msg) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
}

function Write-Info($msg) {
    Write-Host "  → $msg" -ForegroundColor Gray
}

function Write-Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Err($msg) {
    Write-Host "  [ERROR] $msg" -ForegroundColor Red
}

# -----------------------------------------------------------------------------
# 사전 체크
# -----------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  gordian-coder 오프라인 설치 (Windows)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

foreach ($rel in @("bin", "project\dist")) {
    if (-not (Test-Path (Join-Path $ScriptDir $rel))) {
        Write-Err "오프라인 패키지 구조가 올바르지 않습니다: $rel 없음"
        Write-Err "압축을 푼 offline-package 디렉토리 안에서 실행해 주세요."
        exit 1
    }
}

# 플랫폼 감지
$arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$platform = "windows-$arch"
Write-Info "감지된 플랫폼: $platform"

if ($arch -eq "x86") {
    Write-Err "32비트 Windows는 지원하지 않습니다."
    exit 1
}

# -----------------------------------------------------------------------------
# 1. Bun 설치
# -----------------------------------------------------------------------------

Write-Step "1/3 Bun 설치"

$bunArchive = Join-Path (Join-Path $ScriptDir "bin") "bun-${platform}.zip"
$bunBinDir = Join-Path $BunInstallDir "bin"
$hasBun = [bool](Get-Command bun -ErrorAction SilentlyContinue)

# 설치 여부 결정. 기존 Bun은 명시적 동의 없이는 건드리지 않는다.
if ($env:SKIP_BUN -eq "1") {
    $installBun = $false
    Write-Info "SKIP_BUN=1 - Bun 설치 건너뜀"
} elseif (-not $hasBun) {
    $installBun = $true
} elseif ($env:FORCE_BUN -eq "1") {
    $installBun = $true
    Write-Info "기존 Bun v$(& bun --version 2>$null) -> FORCE_BUN=1, 덮어씀"
} else {
    Write-Info "기존 Bun 발견: v$(& bun --version 2>$null)"
    $response = Read-Host "  Bun을 덮어쓰시겠습니까? (y/N)"
    $installBun = ($response -eq "y" -or $response -eq "Y")
    if (-not $installBun) { Write-Info "기존 Bun 유지" }
}

if (-not $installBun -and -not $hasBun) {
    Write-Err "Bun이 없는데 설치를 건너뛰었습니다. Bun 없이는 실행할 수 없습니다."
    exit 1
}

# 아카이브 확인은 실제로 설치할 때만 - 이미 Bun이 있으면 해당 플랫폼 zip이 없어도 무방.
if ($installBun -and -not (Test-Path $bunArchive)) {
    Write-Err "Bun 바이너리를 찾을 수 없습니다: $bunArchive"
    Write-Err "이미 Bun이 설치된 서버라면 SKIP_BUN=1 로 건너뛸 수 있습니다."
    exit 1
}

if ($installBun) {
    New-Item -ItemType Directory -Force -Path $bunBinDir | Out-Null

    $tempDir = Join-Path $env:TEMP "bun-install-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    # Expand-Archive는 PS 5.1에서 항목마다 파이프라인을 거쳐 매우 느리다(수 분).
    # 내장 tar(bsdtar)가 zip도 처리하며 훨씬 빠르다. 없으면 .NET, 그다음 Expand-Archive.
    Write-Info "Bun 압축 해제 중..."
    $unzipped = $false
    if (Get-Command tar -ErrorAction SilentlyContinue) {
        tar -xf $bunArchive -C $tempDir 2>$null
        if ($LASTEXITCODE -eq 0) { $unzipped = $true }
    }
    if (-not $unzipped) {
        try {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($bunArchive, $tempDir)
            $unzipped = $true
        } catch {
            Write-Warn "빠른 해제 실패 - Expand-Archive로 재시도합니다 (수 분 걸릴 수 있음)"
        }
    }
    if (-not $unzipped) {
        Expand-Archive -Path $bunArchive -DestinationPath $tempDir -Force
    }

    $bunExe = Get-ChildItem -Path $tempDir -Filter "bun.exe" -Recurse | Select-Object -First 1
    if (-not $bunExe) {
        Write-Err "아카이브에서 bun.exe를 찾을 수 없습니다."
        Remove-Item -Recurse -Force $tempDir
        exit 1
    }

    Copy-Item -Path $bunExe.FullName -Destination (Join-Path $bunBinDir "bun.exe") -Force
    Remove-Item -Recurse -Force $tempDir

    Write-Ok "Bun 설치 완료: $(Join-Path $bunBinDir 'bun.exe')"
}

# 기존 Bun을 그대로 쓰는 경우엔 PATH도 환경변수도 건드리지 않는다.
if ($installBun) {
    $env:Path = "$bunBinDir;$env:Path"
    $env:BUN_INSTALL = $BunInstallDir

    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$bunBinDir*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$bunBinDir;$userPath", "User")
        Write-Info "시스템 PATH에 Bun 경로 추가됨"
    } else {
        Write-Info "시스템 PATH에 Bun 경로 이미 존재"
    }

    [System.Environment]::SetEnvironmentVariable("BUN_INSTALL", $BunInstallDir, "User")
}

Write-Info "Bun 버전: $(& bun --version 2>$null)"

# -----------------------------------------------------------------------------
# 2. 빌드 산출물 배치
# -----------------------------------------------------------------------------

Write-Step "2/3 빌드 산출물 배치"

if (Test-Path $InstallBase) {
    Write-Info "기존 설치 발견: $InstallBase"
    if ($env:FORCE -ne "1") {
        $response = Read-Host "  덮어쓰시겠습니까? (y/N)"
        if ($response -ne "y" -and $response -ne "Y") {
            Write-Err "설치 중단. 다른 경로는 INSTALL_DIR, 자동 덮어쓰기는 FORCE=1을 사용하세요."
            exit 1
        }
    }
    # 이전 버전의 dist가 남지 않도록 제거
    $oldDist = Join-Path $InstallBase "dist"
    if (Test-Path $oldDist) { Remove-Item -Recurse -Force $oldDist }
}

New-Item -ItemType Directory -Force -Path $InstallBase | Out-Null

Write-Info "복사 중..."
Copy-Item -Path (Join-Path $ScriptDir "project\*") -Destination $InstallBase -Recurse -Force

Write-Ok "설치 완료: $InstallBase"

# -----------------------------------------------------------------------------
# 3. 글로벌 링크
# -----------------------------------------------------------------------------

Write-Step "3/3 글로벌 링크"

Set-Location $InstallBase

& bun link
if ($LASTEXITCODE -ne 0) { throw "링크 실패" }

Write-Ok "링크 완료"

# -----------------------------------------------------------------------------
# 설치 완료
# -----------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  gordian-coder 설치 완료!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  설치 경로: $InstallBase" -ForegroundColor White
Write-Host "  Bun 경로:  $(Join-Path $bunBinDir 'bun.exe')" -ForegroundColor White
Write-Host ""
Write-Host "  사용 가능한 명령어:" -ForegroundColor White
Write-Host "    gdc --help      도움말" -ForegroundColor White
Write-Host "    gdc --init      Cline 훅 설치" -ForegroundColor White
Write-Host ""
Write-Host "  ※ 새 터미널을 열어야 PATH가 적용됩니다." -ForegroundColor Yellow
Write-Host ""
