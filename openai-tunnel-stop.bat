@echo off
title Stop OpenAI Tunnel
cd /d "%~dp0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  echo Dang tat tunnel PID %%a...
  taskkill /PID %%a /F 2>nul
)
echo Xong.
pause