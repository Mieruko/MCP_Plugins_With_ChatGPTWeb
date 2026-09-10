@echo off
title OpenAI Secure MCP Tunnel - Codex MCP
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0openai-tunnel.ps1" %*
if errorlevel 1 pause