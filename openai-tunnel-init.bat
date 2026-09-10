@echo off
title OpenAI Tunnel Setup - Codex MCP
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0openai-tunnel.ps1" -Init
pause