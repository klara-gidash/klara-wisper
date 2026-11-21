# W4: upgrade over a running older version. Installs the previous release (v0.1.1), lets it set
# itself up, starts an MCP server process the way Claude Desktop keeps one open (it holds files in the
# engine's Python venv), then runs the NEW installer silently over all of it, launches the new app and
# requires: setup re-sync finishes, health ok, and no "os error 32" (file in use) in main.log.
#   pwsh -File scripts\ci\e2e\win-w4-upgrade.ps1 -OldSetup <v0.1.1 setup.exe> -Setup <new setup.exe>
param([Parameter(Mandatory)][string]$OldSetup, [Parameter(Mandatory)][string]$Setup)
. "$PSScriptRoot\common.ps1"

$mcp = $null
try {
  Install-Klara $OldSetup
  New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'Claude') | Out-Null
  Write-Settings @{ onboarded = $true; autoRecord = $false; autoSummary = $false; launchAtLogin = $false; claudeConnected = $true }
  $old = Start-Klara @('--health-check')
  $stamp = Join-Path $DataDir 'engine\installed.json'
  $deadline = (Get-Date).AddMinutes(35)
  while (-not (Test-Path -LiteralPath $stamp) -and (Get-Date) -lt $deadline) { Start-Sleep 10 }
  if (-not (Test-Path -LiteralPath $stamp)) { Fail 'old version set itself up' 'no engine\installed.json after 35 min' }
  Pass 'old version set itself up'
  $deadline = (Get-Date).AddMinutes(25)
  while (-not (Test-Path -LiteralPath $ClaudeConfig) -and (Get-Date) -lt $deadline) { Start-Sleep 10 }
  if (-not (Test-Path -LiteralPath $ClaudeConfig)) { Fail 'old version connected Claude' "no $ClaudeConfig" }
  Pass 'old version connected Claude' $ClaudeConfig
  $stampBefore = (Get-Item -LiteralPath $stamp).LastWriteTimeUtc

  # Claude Desktop's MCP server stays open during the upgrade.
  $mcp = Start-Process -FilePath python -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Out 'mcp-held-open.txt') `
    -ArgumentList "`"$(Join-Path $E2E 'mcp_check.py')`"", '--config', "`"$ClaudeConfig`"", '--keep-running', '3600'
  Start-Sleep 20
  if ($mcp.HasExited) { Fail 'MCP server held open (as Claude Desktop does)' "exited $($mcp.ExitCode)" }
  Pass 'MCP server held open (as Claude Desktop does)' "pid $($mcp.Id)"
  Move-Item -Force -LiteralPath $LogFile -Destination "$LogFile.old-version" -ErrorAction SilentlyContinue

  # The new installer, silently, while the old app and the MCP server run.
  Install-Klara $Setup  # (Install-Klara stops the app after installing, then we start the new one)
  if (Test-Path -LiteralPath $HealthFile) { Remove-Item -Force -LiteralPath $HealthFile }
  $new = Start-Klara @('--health-check')
  Start-Sleep 30
  Wait-Setup $new 35
  $stampAfter = (Get-Item -LiteralPath $stamp).LastWriteTimeUtc
  if ($stampAfter -gt $stampBefore) { Pass 'setup re-sync wrote a new engine stamp' "$stampAfter" } else { Note 'engine stamp unchanged' 'no re-sync was needed (same engine?)' }
  Wait-Health -Required @('app', 'helper', 'engine', 'models', 'transcribe', 'storage', 'claude') -Minutes 25
  $log = Read-Log
  if ($log -match 'os error 32') { Soft-Fail 'no "os error 32" in main.log' ([regex]::Match($log, '^.*os error 32.*$', 'Multiline').Value.Trim()) } else { Pass 'no "os error 32" in main.log' }
  Assert-NoFatal
  Invoke-McpCheck @() 'MCP client after the upgrade'
} catch {
  if (-not $script:Failed) { Soft-Fail 'unexpected error' $_.Exception.Message } else { Write-Host "::error::$($_.Exception.Message)" }
} finally {
  if ($mcp -and -not $mcp.HasExited) { Stop-Process -Id $mcp.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'klara_engine\.mcp_server' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath "$LogFile.old-version") { Copy-Item -Force -LiteralPath "$LogFile.old-version" -Destination $Out }
  Save-Artifacts
  Uninstall-Klara
  Write-Summary 'W4 upgrade from v0.1.1'
}
if ($script:Failed) { exit 1 }
exit 0
