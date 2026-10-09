@echo off
chcp 65001 >nul
REM Doubao local signer service: runs on this PC, serves http://127.0.0.1:8791/doubao/sign
REM Requires: system Edge + playwright-core (bundled with WorkBuddy)
REM Login state comes from doubao_profile/ and doubao_cookie.txt (run doubao_capture.js once to login)
node "E:/workspace/workbuddy-signin/doubao_sign.js"
pause
