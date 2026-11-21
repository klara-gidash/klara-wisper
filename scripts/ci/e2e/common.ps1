# Shared helpers for the Windows e2e scenarios (dot-source it: . "$PSScriptRoot\common.ps1").
# Same paths and log-reading rules as scripts\ci\smoke-windows.ps1. Every check prints
# "ok: ..." or "FAIL: ..." and is added to a summary table printed by Write-Summary.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PYTHONUTF8 = '1' # Hebrew in the helper scripts' output

if ($env:GITHUB_ACTIONS -ne 'true' -and $env:KLARA_SMOKE_FORCE -ne '1') {
  Write-Host 'Refusing to run outside GitHub Actions (it installs/uninstalls the app and replaces its settings). Set KLARA_SMOKE_FORCE=1 on a throwaway machine.'
  exit 2
}

$E2E = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Out = if ($env:E2E_OUT) { $env:E2E_OUT } else { Join-Path $Root 'e2e-out' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$script:Results = New-Object System.Collections.ArrayList
$script:Failed = $false

function Set-Paths {
  # Re-read after a scenario changes APPDATA/LOCALAPPDATA (the Hebrew profile test).
  $script:InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\klara-wisper'
  $script:AppExe = Join-Path $InstallDir 'Klara Wisper.exe'
  $script:HelperExe = Join-Path $InstallDir 'resources\helper\KlaraHelper.exe'
  $script:Uninstaller = Join-Path $InstallDir 'Uninstall Klara Wisper.exe'
  $script:DataDir = Join-Path $env:APPDATA 'Klara Wisper'
  $script:LogFile = Join-Path $DataDir 'main.log'
  $script:HealthFile = Join-Path $DataDir 'health.json'
  $script:ClaudeConfig = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
}
Set-Paths
$Models = @('whisper-ivrit-turbo-ct2', 'nemotron-diarization', 'ecapa') # DEFAULT_MODELS on Windows
$Fatal = '(?<!helper )setup failed|engine exited|uncaught'

function Pass([string]$Name, [string]$Detail = '') {
  Write-Host "ok: $Name $Detail"
  [void]$script:Results.Add([pscustomobject]@{ Check = $Name; Result = 'ok'; Detail = $Detail })
}
function Note([string]$Name, [string]$Detail = '') {
  Write-Host "::warning::$Name $Detail"
  [void]$script:Results.Add([pscustomobject]@{ Check = $Name; Result = 'warn'; Detail = $Detail })
}
function Fail([string]$Name, [string]$Detail = '') {
  [void]$script:Results.Add([pscustomobject]@{ Check = $Name; Result = 'FAIL'; Detail = $Detail })
  $script:Failed = $true
  throw "FAIL: $Name $Detail"
}
function Soft-Fail([string]$Name, [string]$Detail = '') {
  # A failed check that should not stop the remaining checks.
  Write-Host "FAIL: $Name $Detail"
  Write-Host "::error::$Name $Detail"
  [void]$script:Results.Add([pscustomobject]@{ Check = $Name; Result = 'FAIL'; Detail = $Detail })
  $script:Failed = $true
}

function Write-Summary([string]$Title) {
  Write-Host "== summary: $Title"
  $script:Results | Format-Table -AutoSize -Wrap Check, Result, Detail | Out-String -Width 200 | Write-Host
  if ($env:GITHUB_STEP_SUMMARY) {
    $md = @("### $Title", '', '| Check | Result | Detail |', '|---|---|---|')
    foreach ($r in $script:Results) { $md += "| $($r.Check) | $($r.Result) | $(($r.Detail -replace '\|', '/') -replace '\r?\n', ' ') |" }
    Add-Content -Encoding UTF8 -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ($md -join "`n")
  }
}

function Read-Log {
  if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
  try {
    $fs = [IO.File]::Open($LogFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try { return (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
  } catch { return '' }
}

function Assert-NoFatal([string]$Where = '') {
  $bad = [regex]::Match((Read-Log), "^.*($Fatal).*$", 'IgnoreCase, Multiline')
  if ($bad.Success) { Fail "main.log has no fatal line$Where" $bad.Value.Trim() }
}

function Install-Klara([string]$Setup) {
  if (-not (Test-Path -LiteralPath $Setup)) { Fail 'installer present' $Setup }
  $p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru
  $null = $p.Handle
  if (-not $p.WaitForExit(600000)) { Fail 'silent install' 'did not finish within 10 minutes' }
  if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) { Fail 'silent install' "exit code $($p.ExitCode)" }
  $deadline = (Get-Date).AddMinutes(2)
  while (-not ((Test-Path -LiteralPath $AppExe) -and (Test-Path -LiteralPath $HelperExe)) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
  if (-not (Test-Path -LiteralPath $AppExe)) { Fail 'silent install' "no $AppExe" }
  Pass 'silent install' (Split-Path -Leaf $Setup)
  Stop-Klara
}

function Stop-Klara {
  foreach ($name in @('Klara Wisper', 'KlaraHelper')) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'klara_engine\.server' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Uninstall-Klara {
  Stop-Klara
  Start-Sleep 3
  if (-not (Test-Path -LiteralPath $Uninstaller)) { Write-Host "no uninstaller at $Uninstaller"; return }
  $u = Start-Process -FilePath $Uninstaller -ArgumentList '/S' -PassThru
  $null = $u.WaitForExit(120000)
  $deadline = (Get-Date).AddMinutes(2)
  while ((Test-Path -LiteralPath $AppExe) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
  if (Test-Path -LiteralPath $AppExe) { Write-Host "::warning::the uninstaller left $AppExe" } else { Write-Host 'ok: uninstalled' }
}

function Write-Settings([hashtable]$Settings) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if (Test-Path -LiteralPath $LogFile) { Move-Item -Force -LiteralPath $LogFile -Destination "$LogFile.before-e2e" }
  if (Test-Path -LiteralPath $HealthFile) { Remove-Item -Force -LiteralPath $HealthFile }
  [IO.File]::WriteAllText((Join-Path $DataDir 'settings.json'), ($Settings | ConvertTo-Json -Compress)) # UTF-8, no BOM
  Pass 'settings seeded' (($Settings.Keys | Sort-Object) -join ',')
}

function Start-Klara([string[]]$AppArgs = @('--health-check')) {
  $env:KLARA_E2E = '1'
  $p = Start-Process -FilePath $AppExe -ArgumentList $AppArgs -PassThru
  $null = $p.Handle
  Pass 'app started' "pid $($p.Id) $($AppArgs -join ' ')"
  return $p
}

function Setup-Done {
  if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'engine\installed.json'))) { return $false }
  foreach ($m in $Models) { if (-not (Test-Path -LiteralPath (Join-Path $DataDir "models\$m\.complete"))) { return $false } }
  return $true
}

function Wait-Setup($App, [int]$Minutes = 30) {
  $start = Get-Date
  $last = $start
  while (-not (Setup-Done)) {
    Assert-NoFatal ' (during setup)'
    if ($App -and $App.HasExited) { Fail 'app keeps running' "exited with $($App.ExitCode)" }
    if (((Get-Date) - $start).TotalMinutes -gt $Minutes) { Fail 'setup finished' "not after $Minutes min" }
    if (((Get-Date) - $last).TotalSeconds -ge 60) { Write-Host ("... setup {0:N0} min" -f ((Get-Date) - $start).TotalMinutes); $last = Get-Date }
    Start-Sleep 5
  }
  Pass 'setup finished' ("{0:N1} min" -f ((Get-Date) - $start).TotalMinutes)
}

function Get-Health { if (Test-Path -LiteralPath $HealthFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $HealthFile | ConvertFrom-Json } }

# Waits until health.json shows every required item ok ("warn" allowed for $AllowWarn), or times out.
function Wait-Health([string[]]$Required, [string[]]$AllowWarn = @('transcribe'), [int]$Minutes = 20) {
  $deadline = (Get-Date).AddMinutes($Minutes)
  $bad = @()
  while ((Get-Date) -lt $deadline) {
    $h = Get-Health
    if ($h) {
      $bad = @()
      foreach ($id in $Required) {
        $it = $h.items | Where-Object { $_.id -eq $id } | Select-Object -First 1
        $st = if ($it) { $it.status } else { 'missing' }
        if ($st -ne 'ok' -and -not ($st -eq 'warn' -and $AllowWarn -contains $id)) { $bad += "$id=$st $($it.code) $($it.detail)" }
      }
      if ($bad.Count -eq 0) { break }
    }
    Start-Sleep 10
  }
  $h = Get-Health
  if ($h) { $h.items | Format-Table -AutoSize id, status, code, detail, ms | Out-String -Width 200 | Write-Host }
  if (-not $h) { Fail 'health.json' "none after $Minutes min" }
  if ($bad.Count) { Fail 'health ok' ($bad -join '; ') }
  foreach ($it in $h.items) { if ($Required -notcontains $it.id) { Write-Host "  (info) health $($it.id): $($it.status) $($it.code)" } }
  Pass 'health ok' ($Required -join ',')
}

function Invoke-McpCheck([string[]]$Extra = @(), [string]$Name = 'MCP client') {
  & python (Join-Path $E2E 'mcp_check.py') --config $ClaudeConfig @Extra 2>&1 | Tee-Object -FilePath (Join-Path $Out 'mcp-check.txt') -Append | Write-Host
  if ($LASTEXITCODE -ne 0) { Soft-Fail $Name 'see mcp-check.txt' } else { Pass $Name ($Extra -join ' ') }
}

function Save-Artifacts {
  foreach ($f in @($LogFile, "$LogFile.before-e2e", $HealthFile, (Join-Path $DataDir 'settings.json'), (Join-Path $DataDir 'upcoming.json'), $ClaudeConfig)) {
    if ($f -and (Test-Path -LiteralPath $f)) { Copy-Item -Force -LiteralPath $f -Destination $Out }
  }
}
