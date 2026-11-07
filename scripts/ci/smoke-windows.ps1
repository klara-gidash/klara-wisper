# Smoke test of the Windows installer on a CI machine (GitHub Actions windows-latest):
#   1. installs release\Klara Wisper Setup.exe silently (per user: %LOCALAPPDATA%\Programs\klara-wisper),
#   2. marks onboarding as done, so the first launch runs the setup by itself (src/main/setup.ts),
#   3. starts the app and follows %APPDATA%\Klara Wisper\main.log until Python, the locked packages
#      and the models are installed and the engine process (python -m klara_engine.server) runs,
#   4. always prints main.log, then quits the app and uninstalls it.
# Exit code 0 = passed. From the repo root, after scripts\make-windows.ps1:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke-windows.ps1
# It overwrites %APPDATA%\Klara Wisper\settings.json and uninstalls the app, so it refuses to run
# outside GitHub Actions unless KLARA_SMOKE_FORCE=1 (use a throwaway PC or VM).
param(
  [int]$SetupMinutes = 25,  # Python + packages + models (about 2 GB) on a fresh machine
  [int]$EngineMinutes = 5   # from the end of setup until the engine process shows up
)
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -and $env:KLARA_SMOKE_FORCE -ne '1') {
  Write-Host 'Refusing to run outside GitHub Actions (it replaces the settings and uninstalls the app). Set KLARA_SMOKE_FORCE=1 on a throwaway machine.'
  exit 2
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Setup = Join-Path $Root 'release\Klara Wisper Setup.exe'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\klara-wisper'
$AppExe = Join-Path $InstallDir 'Klara Wisper.exe'
$HelperExe = Join-Path $InstallDir 'resources\helper\KlaraHelper.exe'
$Uninstaller = Join-Path $InstallDir 'Uninstall Klara Wisper.exe'
$DataDir = Join-Path $env:APPDATA 'Klara Wisper'
$LogFile = Join-Path $DataDir 'main.log'
$Stamp = Join-Path $DataDir 'engine\installed.json'
$Models = @('whisper-ivrit-turbo-ct2', 'nemotron-diarization', 'ecapa') # DEFAULT_MODELS on Windows (src/main/setup.ts)
# "setup failed" is the first-run setup (setup.ts); "helper setup failed" (index.ts, e.g. a hotkey
# the CI machine refuses) is not fatal.
$Fatal = '(?<!helper )setup failed|engine exited|uncaught'
$SettingsJson = '{"onboarded":true,"autoRecord":false,"autoSummary":false,"launchAtLogin":false,"claudeConnected":false}'

function Fail([string]$Message) { throw "SMOKE FAILED: $Message" }

# main.log is appended to by the app while we read it: open it shared, never lock it.
function Read-Log {
  if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
  try {
    $fs = [IO.File]::Open($LogFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try {
      $reader = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
      return $reader.ReadToEnd()
    } finally {
      $fs.Dispose()
    }
  } catch {
    return ''
  }
}

function Get-EngineProcess {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -like 'python*' -and $_.CommandLine -and $_.CommandLine -match 'klara_engine\.server' } |
    Select-Object -First 1
}

function Stop-App {
  foreach ($name in @('Klara Wisper', 'KlaraHelper')) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'klara_engine' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Uninstall-App {
  if (-not (Test-Path -LiteralPath $Uninstaller)) {
    Write-Host "no uninstaller at $Uninstaller"
    return
  }
  Write-Host '== uninstalling'
  $u = Start-Process -FilePath $Uninstaller -ArgumentList '/S' -PassThru
  $null = $u.WaitForExit(120000)
  # NSIS uninstallers copy themselves to %TEMP% and carry on from there: wait for the files to go.
  $deadline = (Get-Date).AddMinutes(2)
  while ((Test-Path -LiteralPath $AppExe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (Test-Path -LiteralPath $AppExe) {
    Write-Host "::warning::the uninstaller left $AppExe behind"
  } else {
    Write-Host 'ok: uninstalled'
  }
}

$failed = $false
try {
  # 1. Silent install. Start-Process -Wait would also wait for anything the installer starts, so
  #    wait for the installer process itself.
  if (-not (Test-Path -LiteralPath $Setup)) { Fail "installer not found: $Setup" }
  Write-Host "== installing $Setup"
  $p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru
  $null = $p.Handle # keeps the exit code readable after the process ends
  if (-not $p.WaitForExit(600000)) { Fail 'the installer did not finish within 10 minutes' }
  Write-Host "installer exit code: $($p.ExitCode)"
  if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) { Fail "the installer failed (exit code $($p.ExitCode))" }

  # 2. The app and the helper are in place.
  $deadline = (Get-Date).AddMinutes(2)
  while (-not ((Test-Path -LiteralPath $AppExe) -and (Test-Path -LiteralPath $HelperExe)) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
  }
  foreach ($f in @($AppExe, $HelperExe)) {
    if (-not (Test-Path -LiteralPath $f)) { Fail "missing after install: $f" }
    Write-Host "ok: $f"
  }
  Stop-App # a silent install doesn't start the app, but make sure no copy runs with other settings

  # 3. Onboarding done: the first launch installs the engine and the models by itself.
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if (Test-Path -LiteralPath $LogFile) { Move-Item -Force -LiteralPath $LogFile -Destination "$LogFile.before-smoke" }
  [IO.File]::WriteAllText((Join-Path $DataDir 'settings.json'), $SettingsJson) # UTF-8, no BOM

  # 4. Start the app and follow main.log.
  Write-Host "== starting $AppExe"
  $app = Start-Process -FilePath $AppExe -PassThru
  $null = $app.Handle
  $start = Get-Date
  $sawStarted = $false
  $sawHelper = $false
  $setupAt = $null
  $lastReport = $start
  while ($true) {
    Start-Sleep -Seconds 5
    $log = Read-Log
    $bad = [regex]::Match($log, "^.*($Fatal).*$", 'IgnoreCase, Multiline')
    if ($bad.Success) { Fail "main.log: $($bad.Value.Trim())" }
    if ($app.HasExited) { Fail "the app exited (exit code $($app.ExitCode))" }
    $minutes = ((Get-Date) - $start).TotalMinutes

    # 5. The packaged app started, and its helper answered.
    if (-not $sawStarted -and $log -match 'started \(packaged: true\)') { $sawStarted = $true; Write-Host 'ok: "started (packaged: true)"' }
    if (-not $sawHelper -and $log -match 'helper permissions') { $sawHelper = $true; Write-Host 'ok: "helper permissions" (the helper is running)' }
    if (-not $sawStarted -and $minutes -gt 2) { Fail 'no "started (packaged: true)" in main.log after 2 minutes' }
    if (-not $sawHelper -and $minutes -gt 5) { Fail 'no "helper permissions" in main.log after 5 minutes (did KlaraHelper.exe start?)' }

    # 6. Setup: the engine stamp and every model's .complete marker.
    if ($null -eq $setupAt) {
      $missing = @()
      if (-not (Test-Path -LiteralPath $Stamp)) { $missing += 'engine\installed.json' }
      foreach ($m in $Models) {
        if (-not (Test-Path -LiteralPath (Join-Path $DataDir "models\$m\.complete"))) { $missing += "models\$m" }
      }
      if ($missing.Count -eq 0) {
        $setupAt = Get-Date
        Write-Host ("ok: setup finished after {0:N1} minutes" -f $minutes)
      } elseif ($minutes -gt $SetupMinutes) {
        Fail "setup not finished after $SetupMinutes minutes, still missing: $($missing -join ', ')"
      } elseif (((Get-Date) - $lastReport).TotalSeconds -ge 60) {
        Write-Host ("... {0:N0} min, waiting for: {1}" -f $minutes, ($missing -join ', '))
        $lastReport = Get-Date
      }
      continue
    }

    # 7. The engine process runs.
    if ($sawStarted -and $sawHelper) {
      $engine = Get-EngineProcess
      if ($engine) {
        Write-Host "ok: engine process $($engine.ProcessId): $($engine.CommandLine)"
        break
      }
      if (((Get-Date) - $setupAt).TotalMinutes -gt $EngineMinutes) {
        Fail "no python process running klara_engine.server $EngineMinutes minutes after setup finished"
      }
    }
  }

  # A crash while the engine loads its models shows up within seconds: watch a little longer.
  Start-Sleep -Seconds 30
  $bad = [regex]::Match((Read-Log), "^.*($Fatal).*$", 'IgnoreCase, Multiline')
  if ($bad.Success) { Fail "main.log: $($bad.Value.Trim())" }
  if ($app.HasExited) { Fail "the app exited (exit code $($app.ExitCode))" }
  if (-not (Get-EngineProcess)) { Fail 'the engine process is gone' }
} catch {
  $failed = $true
  Write-Host "::error::$($_.Exception.Message)"
} finally {
  # 8. Always: the log, then quit and uninstall.
  Write-Host '== main.log'
  $log = Read-Log
  if ($log) { Write-Host $log } else { Write-Host '(no main.log)' }
  if ($failed) {
    Write-Host '== data folder'
    foreach ($d in @($DataDir, (Join-Path $DataDir 'engine'), (Join-Path $DataDir 'models'))) {
      if (Test-Path -LiteralPath $d) { Get-ChildItem -Force -LiteralPath $d | Format-Table -AutoSize Mode, LastWriteTime, Length, Name | Out-String | Write-Host }
    }
  }
  try { Stop-App } catch { Write-Host "stopping the app: $($_.Exception.Message)" }
  Start-Sleep -Seconds 3
  try { Uninstall-App } catch { Write-Host "::warning::uninstall: $($_.Exception.Message)" }
}

if ($failed) { exit 1 }
Write-Host 'SMOKE PASSED'
exit 0
