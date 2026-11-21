# W1: clean install + the install wizard walked like a novice (only the big footer button), then the
# health check. Nothing is pre-seeded: no settings.json, so the wizard shows on first launch.
#   pwsh -File scripts\ci\e2e\win-w1-wizard.ps1 -Setup "<path>\Klara Wisper Setup.exe"
# env: PW_DIR (playwright-core install folder), E2E_OUT (artifact folder)
param([Parameter(Mandatory)][string]$Setup)
. "$PSScriptRoot\common.ps1"

try {
  Install-Klara $Setup
  if (Test-Path -LiteralPath (Join-Path $DataDir 'settings.json')) { Fail 'clean machine' 'settings.json already exists' }
  # Claude Desktop "installed": its config folder exists, so the wizard's Claude step connects it.
  New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'Claude') | Out-Null
  Pass 'Claude Desktop folder' (Join-Path $env:APPDATA 'Claude')

  # --health-check: once the wizard's install is done the app writes health.json by itself too.
  $app = Start-Klara @('--remote-debugging-port=9222', '--health-check')
  $shots = Join-Path $Out 'wizard'
  & node (Join-Path $E2E 'wizard.cjs') $shots 2>&1 | Tee-Object -FilePath (Join-Path $Out 'wizard.txt') | Write-Host
  $code = $LASTEXITCODE
  if ($code -ne 0) { Fail 'novice wizard reached the end' "exit $code (see wizard.txt and screenshots)" }
  Pass 'novice wizard reached the end' "$((Get-ChildItem $shots -Filter *.png).Count) screenshots"
  if ($app.HasExited) { Fail 'app keeps running' "exited with $($app.ExitCode)" }

  $s = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $DataDir 'settings.json') | ConvertFrom-Json
  if ($s.onboarded -ne $true) { Fail 'settings.onboarded' "is $($s.onboarded)" } else { Pass 'settings.onboarded' 'true' }

  Wait-Setup $app 35
  Assert-NoFatal
  # The microphone can fail on a runner with no audio device.
  Wait-Health -Required @('app', 'helper', 'engine', 'models', 'transcribe', 'storage', 'claude') -Minutes 25
  Invoke-McpCheck @() 'MCP client (as Claude Desktop)'
  Assert-NoFatal
  Pass 'main.log clean'
} catch {
  if (-not $script:Failed) { Soft-Fail 'unexpected error' $_.Exception.Message } else { Write-Host "::error::$($_.Exception.Message)" }
} finally {
  Save-Artifacts
  Uninstall-Klara
  Write-Summary 'W1 clean install + novice wizard'
}
if ($script:Failed) { exit 1 }
exit 0
