param([switch]$PlanOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $repoRoot '.computer-use-runtime\windows'
$pythonPath = Join-Path $runtimeRoot 'Scripts\python.exe'
$backendPath = Join-Path $runtimeRoot 'Scripts\windows-mcp.exe'
$requirementsPath = Join-Path $PSScriptRoot 'computer-windows-requirements.txt'
if ($env:OS -ne 'Windows_NT') { throw 'Windows-MCP requires Windows.' }
if ($PlanOnly) {
    Write-Output "Private venv: $runtimeRoot"
    Write-Output 'Python: 3.14.7; package: windows-mcp==0.8.6; installer: uv; dependencies locked'
    Write-Output "COMPUTER_WINDOWS_COMMAND=$backendPath"
    exit 0
}
$uvPath = (Get-Command uv -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & $uvPath venv --python 3.14.7 $runtimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the private Python environment.' }
}
& $pythonPath -c 'import sys; assert sys.version_info[:3] == (3, 14, 7), "Private runtime requires Python 3.14.7"'
if ($LASTEXITCODE -ne 0) { throw 'Use a private Python 3.14.7 venv; existing runtime was not modified.' }
& $uvPath pip sync --python $pythonPath $requirementsPath
if ($LASTEXITCODE -ne 0) { throw 'Could not install Windows-MCP.' }
& $uvPath pip freeze --python $pythonPath | Set-Content -LiteralPath (Join-Path $runtimeRoot 'installed-requirements.txt') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Could not record installed dependency versions.' }
Write-Output "Installed private backend: $backendPath"
Write-Output 'Set COMPUTER_WINDOWS_ENABLED=true and the following path in .env when ready:'
Write-Output "COMPUTER_WINDOWS_COMMAND=$backendPath"
Write-Output 'No server restart or desktop control was performed by this script.'
