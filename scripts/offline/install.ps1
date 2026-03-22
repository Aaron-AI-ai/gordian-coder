# =============================================================================
# install.ps1 - gordian-coder 오프라인 설치 스크립트 (Windows PowerShell)
# 인터넷 연결 없이 Bun 설치, 의존성 복원, 프로젝트 빌드를 수행합니다.
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

# 필수 디렉토리 확인
$requiredDirs = @("bin", "packages", "project")
foreach ($dir in $requiredDirs) {
    $dirPath = Join-Path $ScriptDir $dir
    if (-not (Test-Path $dirPath)) {
        Write-Err "오프라인 패키지 구조가 올바르지 않습니다: $dir 폴더 없음"
        Write-Err "prepare.sh를 먼저 실행해 주세요."
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

Write-Step "1/4 Bun 설치"

$bunArchive = Join-Path $ScriptDir "bin" "bun-${platform}.zip"

if (-not (Test-Path $bunArchive)) {
    Write-Err "Bun 바이너리를 찾을 수 없습니다: $bunArchive"
    exit 1
}

$bunBinDir = Join-Path $BunInstallDir "bin"
$installBun = $true

# 기존 bun 확인
$existingBun = Get-Command bun -ErrorAction SilentlyContinue
if ($existingBun) {
    $existingVer = & bun --version 2>$null
    Write-Info "기존 Bun 발견: v$existingVer"
    $response = Read-Host "  Bun을 덮어쓰시겠습니까? (y/N)"
    if ($response -ne "y" -and $response -ne "Y") {
        Write-Info "기존 Bun 유지"
        $installBun = $false
    }
}

if ($installBun) {
    # 설치 디렉토리 생성
    New-Item -ItemType Directory -Force -Path $bunBinDir | Out-Null

    # zip 해제
    $tempDir = Join-Path $env:TEMP "bun-install-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    Write-Info "Bun 압축 해제 중..."
    Expand-Archive -Path $bunArchive -DestinationPath $tempDir -Force

    # bun.exe 찾기 및 복사
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

# PATH에 bun 추가 (현재 세션)
$env:Path = "$bunBinDir;$env:Path"
$env:BUN_INSTALL = $BunInstallDir

# 사용자 PATH에 영구 등록
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bunBinDir*") {
    [System.Environment]::SetEnvironmentVariable(
        "Path",
        "$bunBinDir;$userPath",
        "User"
    )
    Write-Info "시스템 PATH에 Bun 경로 추가됨"
} else {
    Write-Info "시스템 PATH에 Bun 경로 이미 존재"
}

# BUN_INSTALL 환경변수 등록
[System.Environment]::SetEnvironmentVariable("BUN_INSTALL", $BunInstallDir, "User")

# 설치 확인
$bunVer = & bun --version 2>$null
Write-Info "Bun 버전: $bunVer"

# -----------------------------------------------------------------------------
# 2. 프로젝트 복사
# -----------------------------------------------------------------------------

Write-Step "2/4 프로젝트 설치"

if (Test-Path $InstallBase) {
    Write-Info "기존 설치 발견: $InstallBase"
    $response = Read-Host "  덮어쓰시겠습니까? (y/N)"
    if ($response -ne "y" -and $response -ne "Y") {
        Write-Err "설치 중단. INSTALL_DIR 환경변수로 다른 경로를 지정할 수 있습니다."
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $InstallBase | Out-Null

$projectSource = Join-Path $ScriptDir "project"
Write-Info "프로젝트 복사 중..."
Copy-Item -Path "$projectSource\*" -Destination $InstallBase -Recurse -Force

Write-Ok "프로젝트 복사 완료: $InstallBase"

# -----------------------------------------------------------------------------
# 3. 의존성 복원
# -----------------------------------------------------------------------------

Write-Step "3/4 의존성 복원"

$nodeModulesArchive = Join-Path $ScriptDir "packages" "node_modules.tar.gz"

if (-not (Test-Path $nodeModulesArchive)) {
    Write-Err "node_modules 아카이브를 찾을 수 없습니다."
    exit 1
}

Write-Info "node_modules 압축 해제 중..."

# tar가 있으면 사용 (Windows 10 이상 기본 포함)
if (Get-Command tar -ErrorAction SilentlyContinue) {
    tar -xzf $nodeModulesArchive -C $InstallBase
} else {
    Write-Err "tar 명령을 사용할 수 없습니다. Windows 10 이상이 필요합니다."
    Write-Err "또는 7-Zip 등으로 수동으로 압축을 해제해 주세요:"
    Write-Err "  대상: $InstallBase"
    Write-Err "  파일: $nodeModulesArchive"
    exit 1
}

Write-Ok "의존성 복원 완료"

# -----------------------------------------------------------------------------
# 4. 빌드 및 링크
# -----------------------------------------------------------------------------

Write-Step "4/4 빌드 및 링크"

Set-Location $InstallBase

Write-Info "프로젝트 빌드 중..."
& bun run build
if ($LASTEXITCODE -ne 0) { throw "빌드 실패" }

Write-Info "글로벌 링크 등록 중..."
& bun link
if ($LASTEXITCODE -ne 0) { throw "링크 실패" }

Write-Ok "빌드 및 링크 완료"

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
