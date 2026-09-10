# OpenAI Secure MCP Tunnel — URL on dinh, khong doi moi lan chay (thay cloudflared)
param(
    [int]$Port = 0,
    [int]$HealthPort = 0,
    [switch]$Install,
    [switch]$Doctor,
    [switch]$Init,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$TUNNEL_VERSION = "v0.0.10"
$BinDir = Join-Path $ScriptDir "bin"
$TunnelExe = Join-Path $BinDir "tunnel-client.exe"
$ProfileName = "codex-local"
$ProfileDir = Join-Path $ScriptDir "profiles"
$ProfileFile = Join-Path $ProfileDir "$ProfileName.yaml"
$ZipName = "tunnel-client-$TUNNEL_VERSION-windows-amd64.zip"
$DownloadUrl = "https://github.com/openai/tunnel-client/releases/download/$TUNNEL_VERSION/$ZipName"

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) { return $null }
    $line = Get-Content ".env" | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim("'").Trim('"')
}

function Set-DotEnvValue([string]$Name, [string]$Value) {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
    }
    $lines = Get-Content ".env"
    $found = $false
    $out = foreach ($line in $lines) {
        if ($line -match "^\s*$Name\s*=" -and -not $line.TrimStart().StartsWith("#")) {
            $found = $true
            "$Name=$Value"
        } else {
            $line
        }
    }
    if (-not $found) {
        $out += "$Name=$Value"
    }
    Set-Content ".env" -Value $out -Encoding UTF8
}

function Get-TunnelClientPath {
    if (Test-Path $TunnelExe) { return $TunnelExe }
    $cmd = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Install-TunnelClient {
    if (Test-Path $TunnelExe) {
        Write-Host "tunnel-client da co: $TunnelExe" -ForegroundColor Green
        return $TunnelExe
    }

    Write-Host "Dang tai tunnel-client $TUNNEL_VERSION ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $zipPath = Join-Path $env:TEMP $ZipName

    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $BinDir -Force

    $candidates = Get-ChildItem -Path $BinDir -Recurse -Filter "tunnel-client.exe" -ErrorAction SilentlyContinue
    if ($candidates.Count -eq 0) {
        throw "Khong tim thay tunnel-client.exe trong $ZipName"
    }

    $extracted = $candidates[0].FullName
    if ($extracted -ne $TunnelExe) {
        Move-Item -Path $extracted -Destination $TunnelExe -Force
        Get-ChildItem $BinDir -Directory | Where-Object { $_.Name -ne "." } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Write-Host "Da cai: $TunnelExe" -ForegroundColor Green
    return $TunnelExe
}

function Get-PortOwnerPid([int]$TargetPort) {
    $lines = netstat -ano | Select-String ":$TargetPort\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
        $processId = [int]$parts[-1]
        if ($processId -gt 0) { return $processId }
    }
    return $null
}

function Test-TunnelHealthy([int]$TargetHealthPort) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetHealthPort/readyz" -UseBasicParsing -TimeoutSec 2
        return $resp.Content -match "ready"
    } catch {
        return $false
    }
}

function Stop-ExistingTunnel([int]$TargetHealthPort) {
    $ownerPid = Get-PortOwnerPid -TargetPort $TargetHealthPort
    if (-not $ownerPid) { return }
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { "unknown" }
    Write-Host "Dang tat tunnel cu (PID $ownerPid - $name)..." -ForegroundColor Yellow
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

function Ensure-Profile([string]$McpUrl, [string]$TunnelId, [int]$TargetHealthPort) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    $yaml = @"
config_version: 1
control_plane:
  tunnel_id: $TunnelId
  api_key: env:OPENAI_TUNNEL_API_KEY
log:
  level: info
  format: struct-text
health:
  listen_addr: 127.0.0.1:$TargetHealthPort
mcp:
  server_urls:
    - channel: main
      url: $McpUrl
"@
    Set-Content -Path $ProfileFile -Value $yaml -Encoding UTF8
}

function Test-McpServer([int]$TargetPort) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/health" -UseBasicParsing -TimeoutSec 3
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Show-ConnectorGuide([string]$TunnelId, [int]$UiPort = 8080) {
    Write-Host ""
    Write-Host "=== ChatGPT Connector (chi lam 1 lan) ===" -ForegroundColor Cyan
    Write-Host "1. Giu terminal nay chay (tunnel-client)"
    Write-Host "2. Mo: https://chatgpt.com/#settings/Connectors"
    Write-Host "3. Them connector -> Connection: Tunnel -> chon 'my tunnel'"
    Write-Host "   Hoac dan tunnel_id: $TunnelId"
    Write-Host "4. Settings -> Apps -> dat quyen connector"
    Write-Host "5. Refresh connector, mo chat moi"
    Write-Host ""
    Write-Host "Admin UI: http://127.0.0.1:$UiPort/ui" -ForegroundColor Green
    Write-Host "Health:   http://127.0.0.1:$UiPort/readyz" -ForegroundColor Green
    Write-Host ""
    Write-Host "LUU Y: Khong bam 'Luon cho phep' tren popup ChatGPT" -ForegroundColor Yellow
}

function Invoke-TunnelInit {
    Write-Host ""
    Write-Host "=== OpenAI Tunnel — Cai dat lan dau ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Can 2 gia tri tu OpenAI Platform:" -ForegroundColor Yellow
    Write-Host "  Tunnels:  https://platform.openai.com/settings/organization/tunnels"
    Write-Host "  API Keys: https://platform.openai.com/settings/organization/api-keys"
    Write-Host "  (Dung Runtime API key, KHONG dung Admin key)" -ForegroundColor DarkGray
    Write-Host ""

    $existingId = Get-DotEnvValue "OPENAI_TUNNEL_ID"
    $existingKey = Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"

    if ($existingId) {
        $tunnelId = $existingId
        Write-Host "Tunnel ID (tu .env): $tunnelId"
    } else {
        $tunnelId = Read-Host "Nhap OPENAI_TUNNEL_ID (tunnel_...)"
    }

    if ($existingKey) {
        $apiKey = $existingKey
        Write-Host "API Key: **** (tu .env)"
    } else {
        $apiKey = Read-Host "Nhap OPENAI_TUNNEL_API_KEY (sk-...)"
    }

    if (-not $tunnelId -or $tunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
        throw "OPENAI_TUNNEL_ID khong hop le. Dang tunnel_ + 32 ky tu hex."
    }
    if (-not $apiKey) {
        throw "OPENAI_TUNNEL_API_KEY trong."
    }

    Set-DotEnvValue "OPENAI_TUNNEL_ID" $tunnelId
    Set-DotEnvValue "OPENAI_TUNNEL_API_KEY" $apiKey

    $envPort = Get-DotEnvValue "PORT"
    $resolvedPort = if ($Port -gt 0) { $Port } elseif ($envPort) { [int]$envPort } else { 3000 }
    $envHealth = Get-DotEnvValue "OPENAI_TUNNEL_HEALTH_PORT"
    $resolvedHealth = if ($HealthPort -gt 0) { $HealthPort } elseif ($envHealth) { [int]$envHealth } else { 8080 }
    $mcpUrl = "http://127.0.0.1:$resolvedPort/mcp"
    Ensure-Profile -McpUrl $mcpUrl -TunnelId $tunnelId -TargetHealthPort $resolvedHealth

    $bin = Install-TunnelClient
    $env:OPENAI_TUNNEL_API_KEY = $apiKey
    $env:CONTROL_PLANE_API_KEY = $apiKey
    $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId

    Write-Host ""
    Write-Host "Chay doctor..." -ForegroundColor Yellow
    & $bin doctor --profile-file $ProfileFile --explain
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Doctor that bai — kiem tra tunnel_id, api key, va quyen Tunnels Read+Use" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Da luu vao .env. Lan sau chi can:" -ForegroundColor Green
    Write-Host "  .\start.ps1 -Force          # terminal 1"
    Write-Host "  .\openai-tunnel.bat         # terminal 2"
    Show-ConnectorGuide -TunnelId $tunnelId
}

# --- Main ---

if ($Init) {
    Invoke-TunnelInit
    exit 0
}

if ($Install) {
    Install-TunnelClient | Out-Null
    exit 0
}

$envPort = Get-DotEnvValue "PORT"
$resolvedPort = if ($Port -gt 0) { $Port } elseif ($envPort) { [int]$envPort } else { 3000 }
$envHealth = Get-DotEnvValue "OPENAI_TUNNEL_HEALTH_PORT"
$resolvedHealth = if ($HealthPort -gt 0) { $HealthPort } elseif ($envHealth) { [int]$envHealth } else { 8080 }
$tunnelId = Get-DotEnvValue "OPENAI_TUNNEL_ID"
$apiKey = Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"

if (-not $tunnelId -or -not $apiKey) {
    Write-Host ""
    Write-Host "[CHUA CAU HINH] Chay setup lan dau:" -ForegroundColor Yellow
    Write-Host "  .\openai-tunnel-init.bat" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Hoac them vao .env:" -ForegroundColor DarkGray
    Write-Host "  OPENAI_TUNNEL_ID=tunnel_..."
    Write-Host "  OPENAI_TUNNEL_API_KEY=sk-..."
    exit 1
}

$bin = Get-TunnelClientPath
if (-not $bin) {
    $bin = Install-TunnelClient
}

$mcpUrl = "http://127.0.0.1:$resolvedPort/mcp"
Ensure-Profile -McpUrl $mcpUrl -TunnelId $tunnelId -TargetHealthPort $resolvedHealth

$env:OPENAI_TUNNEL_API_KEY = $apiKey
$env:CONTROL_PLANE_API_KEY = $apiKey
$env:CONTROL_PLANE_TUNNEL_ID = $tunnelId

$existingPid = Get-PortOwnerPid -TargetPort $resolvedHealth
if ($existingPid -and (Test-TunnelHealthy $resolvedHealth)) {
    if (-not $Force) {
        Write-Host ""
        Write-Host "[OK] Tunnel DA CHAY san (PID $existingPid, port $resolvedHealth)" -ForegroundColor Green
        Write-Host "Khong can mo lai — chi chay 1 instance tunnel-client." -ForegroundColor Yellow
        Write-Host "Muon restart: .\openai-tunnel.bat -Force" -ForegroundColor DarkGray
        Write-Host "Hoac tat: Stop-Process -Id $existingPid -Force" -ForegroundColor DarkGray
        Show-ConnectorGuide -TunnelId $tunnelId -UiPort $resolvedHealth
        exit 0
    }
    Stop-ExistingTunnel -TargetHealthPort $resolvedHealth
} elseif ($existingPid) {
    if ($Force) {
        Stop-ExistingTunnel -TargetHealthPort $resolvedHealth
    } else {
        Write-Host ""
        Write-Host "[LOI] Port $resolvedHealth dang bi PID $existingPid chiem (khong phai tunnel healthy)" -ForegroundColor Red
        Write-Host "Chay lai voi -Force de tat process cu, hoac doi port trong .env:" -ForegroundColor Yellow
        Write-Host "  OPENAI_TUNNEL_HEALTH_PORT=8081" -ForegroundColor Cyan
        exit 1
    }
}

if ($Doctor) {
    & $bin doctor --profile-file $ProfileFile --explain
    exit $LASTEXITCODE
}

if (-not (Test-McpServer $resolvedPort)) {
    Write-Host ""
    Write-Host "[CANH BAO] MCP server chua chay tai http://127.0.0.1:$resolvedPort" -ForegroundColor Yellow
    Write-Host "Mo terminal khac va chay: .\start.ps1 -Force" -ForegroundColor Cyan
    Write-Host ""
    $answer = Read-Host "Van chay tunnel? (y/n)"
    if ($answer -notmatch '^[yY]') { exit 1 }
}

Write-Host ""
Write-Host "=== OpenAI Secure MCP Tunnel ===" -ForegroundColor Cyan
Write-Host "Tunnel ID:  $tunnelId"
Write-Host "MCP local:  $mcpUrl"
Write-Host "Health UI:  http://127.0.0.1:$resolvedHealth/ui"
Write-Host ""
Write-Host "URL on dinh — khong doi moi lan chay (khac cloudflared)" -ForegroundColor Green
Write-Host "Nhan Ctrl+C de dung tunnel" -ForegroundColor DarkGray
Write-Host ""

Show-ConnectorGuide -TunnelId $tunnelId -UiPort $resolvedHealth

& $bin run --profile-file $ProfileFile
exit $LASTEXITCODE