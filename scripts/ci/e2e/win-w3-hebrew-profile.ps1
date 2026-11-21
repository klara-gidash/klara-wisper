# W3: a Hebrew Windows user name. APPDATA, LOCALAPPDATA, USERPROFILE and HOMEPATH point under
# C:\Users\קלרה-בדיקה\..., then: silent install, setup, health (Claude self-test included) and the
# MCP client, all with non-ASCII paths everywhere (install folder, data folder, Python venv, models,
# claude_desktop_config.json).
#   pwsh -File scripts\ci\e2e\win-w3-hebrew-profile.ps1 -Setup "<path>\Klara Wisper Setup.exe"
param([Parameter(Mandatory)][string]$Setup)
. "$PSScriptRoot\common.ps1"

$HebProfile = 'C:\Users\קלרה-בדיקה'
try {
  $roaming = Join-Path $HebProfile 'AppData\Roaming'
  $local = Join-Path $HebProfile 'AppData\Local'
  New-Item -ItemType Directory -Force -Path $roaming, $local, (Join-Path $local 'Temp'), (Join-Path $HebProfile 'Documents') | Out-Null
  $env:USERPROFILE = $HebProfile
  $env:HOMEDRIVE = 'C:'
  $env:HOMEPATH = $HebProfile.Substring(2)
  $env:APPDATA = $roaming
  $env:LOCALAPPDATA = $local
  $env:TEMP = Join-Path $local 'Temp'
  $env:TMP = $env:TEMP
  # The environment alone isn't enough: Electron (app.getPath) and the NSIS installer ask Windows for
  # the known folders, which follow "User Shell Folders". Redirect those too (throwaway runner).
  $usf = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $sf = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
  foreach ($k in @($usf, $sf)) {
    Set-ItemProperty -LiteralPath $k -Name 'AppData' -Value $roaming
    Set-ItemProperty -LiteralPath $k -Name 'Local AppData' -Value $local
    Set-ItemProperty -LiteralPath $k -Name 'Personal' -Value (Join-Path $HebProfile 'Documents')
  }
  Set-Paths
  Pass 'Hebrew profile' "$env:APPDATA | $env:LOCALAPPDATA"

  # The installer is per-user and puts the app under %LOCALAPPDATA%\Programs.
  Install-Klara $Setup
  if (-not $AppExe.StartsWith($local)) { Fail 'installed under the Hebrew profile' $AppExe }
  Pass 'installed under the Hebrew profile' $AppExe
  New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'Claude') | Out-Null
  $folder = Join-Path $HebProfile 'Documents\Klara Wisper'
  Write-Settings @{ onboarded = $true; autoRecord = $false; autoSummary = $false; launchAtLogin = $false; claudeConnected = $true; folder = $folder }
  $app = Start-Klara @('--health-check')
  Wait-Setup $app 35
  Wait-Health -Required @('app', 'helper', 'engine', 'models', 'transcribe', 'storage', 'claude') -Minutes 25
  $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $ClaudeConfig
  if ($cfg -notmatch 'klara_engine\.mcp_server') { Fail 'claude_desktop_config.json has klara-wisper' $cfg }
  Pass 'claude_desktop_config.json has klara-wisper' $ClaudeConfig
  Invoke-McpCheck @() 'MCP client under the Hebrew profile'
  Assert-NoFatal
  Pass 'main.log clean'
} catch {
  if (-not $script:Failed) { Soft-Fail 'unexpected error' $_.Exception.Message } else { Write-Host "::error::$($_.Exception.Message)" }
} finally {
  Save-Artifacts
  Uninstall-Klara
  Write-Summary 'W3 Hebrew profile path'
}
if ($script:Failed) { exit 1 }
exit 0
