@echo off
chcp 65001 >nul
REM Doubao local signer service: serves http://127.0.0.1:8791/doubao/sign
REM Before start, kill any process already holding port 8791 (avoids EADDRINUSE on double-click)
powershell -NoProfile -Command "try { Get-NetTCPConnection -LocalPort 8791 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } } catch {}"
timeout /t 1 >nul
node "E:/workspace/workbuddy-signin/doubao_sign.js"
pause
