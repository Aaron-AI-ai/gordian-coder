@echo off
REM 이 파일은 UTF-8(BOM 없음)이다. cmd는 현재 코드페이지로 한 줄씩 읽으므로
REM 65001로 바꿔야 아래 한글이 깨지지 않는다. BOM은 cmd가 첫 줄에 그대로
REM 출력해버리므로 붙이지 않는다.
chcp 65001 >nul
REM =============================================================================
REM install.bat - gordian-coder 오프라인 설치 (Windows CMD 래퍼)
REM PowerShell install.ps1을 실행합니다.
REM =============================================================================

echo.
echo ============================================
echo   gordian-coder 오프라인 설치
echo ============================================
echo.

REM PowerShell 실행 정책 확인 및 스크립트 실행
where powershell >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] PowerShell을 찾을 수 없습니다.
    echo         Windows PowerShell 5.1 이상이 필요합니다.
    pause
    exit /b 1
)

REM 현재 디렉토리의 install.ps1 실행
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] 설치 중 오류가 발생했습니다.
    pause
    exit /b 1
)

pause
