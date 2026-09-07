# Build only. No link, no PATH changes - use scripts/setup.ps1 for that.
# ponytail: delegates to package.json "build" so the entry point list lives in one place.

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

Write-Host "=== Building gordian-coder ===" -ForegroundColor Cyan

Write-Host "[1/2] Cleaning dist..." -ForegroundColor Yellow
if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }

Write-Host "[2/2] Building (bundle + type declarations)..." -ForegroundColor Yellow
bun run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

Write-Host "=== Build complete: $ProjectRoot\dist ===" -ForegroundColor Green
