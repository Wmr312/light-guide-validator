@echo off
title Light Guide Simulator - Local Server
cd /d "%~dp0"
echo Starting local server...
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
timeout /t 2 >nul
start "" http://localhost:8765/
echo.
echo Opened http://localhost:8765/  (if not, open it manually)
echo Close the PowerShell window to stop the server.
timeout /t 5 >nul
