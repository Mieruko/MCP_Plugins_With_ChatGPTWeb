@echo off
title Cloudflare Tunnel - Codex MCP
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1"
if errorlevel 1 pause