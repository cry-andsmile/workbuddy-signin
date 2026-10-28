@echo off
cd /d "%~dp0"
echo [Qoder] Extracting token from local Qoder client...
D://Dev//python.exe "%~dp0refresh_qoder_from_local.py" --claim
echo.
echo Done. Press any key to exit.
pause >nul
