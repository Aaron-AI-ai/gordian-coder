# Setup script for gordian-coder (Windows PowerShell)
# Builds, links, and ensures bun bin is on PATH.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$BunBin = "$env:USERPROFILE\.bun\bin"

Set-Location $ProjectRoot

Write-Host "=== gordian-coder setup ===" -ForegroundColor Cyan

# 1. Build
Write-Host "[1/3] Building..." -ForegroundColor Yellow
bun run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# 2. Link globally
Write-Host "[2/3] Linking globally..." -ForegroundColor Yellow
bun link
if ($LASTEXITCODE -ne 0) {
    Write-Host "Link failed!" -ForegroundColor Red
    exit 1
}

# 3. Ensure bun bin is on PATH
Write-Host "[3/3] Checking PATH..." -ForegroundColor Yellow

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -split ";" | Where-Object { $_ -eq $BunBin }) {
    Write-Host "  [OK] $BunBin already in PATH" -ForegroundColor Green
} else {
    $NewPath = "$BunBin;$CurrentPath"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    $env:Path = "$BunBin;$env:Path"
    Write-Host "  [OK] Added $BunBin to PATH" -ForegroundColor Green
}

# Verify
Write-Host ""
$GdcPath = Get-Command gdc -ErrorAction SilentlyContinue
if ($GdcPath) {
    Write-Host "=== Setup complete ===" -ForegroundColor Green
    Write-Host "  gdc is available at: $($GdcPath.Source)" -ForegroundColor White
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor Cyan
    Write-Host "  gdc --init          Install Cline hooks (local project)"
    Write-Host "  gdc --init --global Install Cline hooks (global)"
    Write-Host "  gdc --help          Show help"
} else {
    Write-Host "=== Setup complete ===" -ForegroundColor Green
    Write-Host "  Restart PowerShell to use gdc command" -ForegroundColor Yellow
}
