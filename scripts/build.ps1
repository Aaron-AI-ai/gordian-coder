# Build script for gordian-coder (PowerShell)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Set-Location $ProjectRoot

Write-Host "=== Building gordian-coder ===" -ForegroundColor Cyan

# Clean previous build
Write-Host "[1/3] Cleaning dist..." -ForegroundColor Yellow
if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
}

# Build with bun
Write-Host "[2/3] Building with bun..." -ForegroundColor Yellow
bun build src/index.ts --outdir dist --target bun --format esm
if ($LASTEXITCODE -ne 0) { throw "Bun build failed" }

# Generate type declarations
Write-Host "[3/3] Generating type declarations..." -ForegroundColor Yellow
npx tsc --emitDeclarationOnly
if ($LASTEXITCODE -ne 0) { throw "TypeScript declaration generation failed" }

Write-Host "=== Build complete ===" -ForegroundColor Green
