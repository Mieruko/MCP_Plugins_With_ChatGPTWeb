# Expose MCP server qua Cloudflare Tunnel (thay ngrok)
param(
    [int]$Port = 3000
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Get-CloudflaredPath {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $local = Join-Path $ScriptDir "cloudflared.exe"
    if (Test-Path $local) { return $local }

    return $null
}

$cloudflared = Get-CloudflaredPath
if (-not $cloudflared) {
    Write-Host ""
    Write-Host "[LOI] Chua co cloudflared!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Cai bang 1 trong cac cach sau:" -ForegroundColor Yellow
    Write-Host "  scoop install cloudflared"
    Write-Host "  winget install --id Cloudflare.cloudflared"
    Write-Host ""
    Write-Host "Hoac tai ve dat vao thu muc nay:" -ForegroundColor Yellow
    Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    Write-Host ""
    Read-Host "Nhan Enter de dong"
    exit 1
}

Write-Host ""
Write-Host "=== Cloudflare Tunnel ===" -ForegroundColor Cyan
Write-Host "Local:  http://localhost:$Port"
Write-Host "Public: (URL hien ben duoi, dang *.trycloudflare.com)"
Write-Host ""
Write-Host "Connector URL cho ChatGPT (dung 1 trong 2):" -ForegroundColor Green
Write-Host "  https://<url-ben-duoi>"
Write-Host "  https://<url-ben-duoi>/mcp"
Write-Host ""
Write-Host "Nhan Ctrl+C de dung tunnel" -ForegroundColor DarkGray
Write-Host ""

& $cloudflared tunnel --url "http://localhost:$Port"