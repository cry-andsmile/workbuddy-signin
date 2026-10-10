@echo off
chcp 65001 >nul
REM Doubao local signer service (self-healing): serves http://127.0.0.1:8791
REM Kill any process holding port 8791 to avoid EADDRINUSE, then run node in a restart loop.
:loop
powershell -NoProfile -Command "try { Get-NetTCPConnection -LocalPort 8791 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } } catch {}"
timeout /t 1 >nul
node "E:/workspace/workbuddy-signin/doubao_sign.js"
echo [doubao_signer] node exited, restart in 5s...
timeout /t 5 >nul
goto loop
