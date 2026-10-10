@echo off
chcp 65001 >nul
REM Doubao signer autostart installer (double-click once, run as admin when prompted)
REM Self-elevate to administrator if not already
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
echo Registering scheduled task DoubaoSignService ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_doubao_task.ps1"
echo.
echo Starting service now ...
schtasks /run /tn DoubaoSignService
echo.
echo Done. Doubao signer will auto-start at logon and self-heal on crash.
echo You never need to open doubao_signer.bat manually again.
echo Check status anytime with:  schtasks /query /tn DoubaoSignService
pause
