# W2: a full call. Virtual audio (win-audio.ps1), a Google Meet event in a local .ics, a fake
# "zoom.exe" that holds the microphone, Hebrew audio on both sides, then:
#   recording starts by itself -> live transcript has Hebrew mic AND system lines -> Claude's MCP
#   server sees it live and sees the calendar event -> the call ends -> the meeting is finished
#   (meta.json done, audio.m4a, calendar title) -> list_meetings shows it -> uninstall.
#   pwsh -File scripts\ci\e2e\win-w2-call.ps1 -Setup "<path>\Klara Wisper Setup.exe"
# env: E2E_OUT (sounddevice installed for the setup-python interpreter)
param([Parameter(Mandatory)][string]$Setup)
. "$PSScriptRoot\common.ps1"
. "$PSScriptRoot\win-audio.ps1"

$Title = 'בדיקת שיחה'
$ClipMine = Join-Path $Root 'engine\tests\audio\he.wav'          # my side (into CABLE Input = the mic)
$ClipOther = Join-Path $Root 'engine\tests\audio\conversation.wav' # the other side (default output)
# The fake call app: a copy of python.exe named zoom.exe next to the real one (it needs the DLLs there)
# running hold_mic.py, which keeps the default microphone open (ffmpeg's dshow input can't open
# VB-Cable on Windows Server).
$PyDir = Split-Path -Parent (Get-Command python).Source
$Zoom = Join-Path $PyDir 'zoom.exe'
$Folder = Join-Path $env:RUNNER_TEMP 'KlaraMeetings'
$Ics = Join-Path $Out 'calendar.ics'
$ConsentKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'
$ConsentName = $Zoom -replace '\\', '#'
$zoomProc = $null
$wroteConsent = $false

function Get-Meeting([string]$Dir) { Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Dir 'meta.json') | ConvertFrom-Json }
function Get-Segments([string]$Dir) {
  $f = Join-Path $Dir 'transcript.json'
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  try { return @((Get-Content -Raw -Encoding UTF8 -LiteralPath $f | ConvertFrom-Json).segments) } catch { return @() }
}
function Count-Hebrew($Segs, [string]$Stream) { @($Segs | Where-Object { $_.stream -eq $Stream -and $_.text -match '[\u0590-\u05FF]' }).Count }

try {
  Initialize-Audio
  & python -X utf8 (Join-Path $E2E 'play.py') --list 2>&1 | Write-Host

  # A Windows 10/11 PC lets desktop apps use the microphone unless the user turned it off. Windows
  # Server's privacy default is "Deny" (written once something first records), so set the PC default.
  $mic = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
  foreach ($k in @("HKLM\$mic", "HKCU\$mic", "HKCU\$mic\NonPackaged")) {
    Write-Host "before: $k = $((Get-ItemProperty -LiteralPath "Registry::$k" -ErrorAction SilentlyContinue).Value)"
    & reg.exe add $k /v Value /t REG_SZ /d Allow /f | Out-Null
  }
  Note 'microphone privacy switches' 'set to Allow (the Windows 10/11 default; Server defaults to Deny)'
  Install-Klara $Setup
  New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'Claude'), $Folder | Out-Null
  & python -X utf8 (Join-Path $E2E 'make_ics.py') $Ics
  if ($LASTEXITCODE -ne 0) { Fail 'calendar .ics' 'make_ics.py failed' }
  $env:KLARA_E2E_ICS_FILE = $Ics
  Write-Settings @{ onboarded = $true; autoRecord = $true; autoSummary = $false; keepAudio = $true; launchAtLogin = $false; claudeConnected = $true; folder = $Folder }
  $app = Start-Klara @('--health-check')
  Wait-Setup $app 35
  Wait-Health -Required @('app', 'helper', 'engine', 'models', 'transcribe', 'storage', 'claude') -Minutes 25
  $micItem = (Get-Health).items | Where-Object { $_.id -eq 'microphone' } | Select-Object -First 1
  if ($micItem.status -ne 'ok') { Soft-Fail 'health microphone (VB-Cable counts as a mic with KLARA_E2E=1)' "$($micItem.status) $($micItem.code) $($micItem.detail)" } else { Pass 'health microphone' $micItem.detail }

  # --- the call: "zoom.exe" (python.exe renamed) holding the default microphone.
  Copy-Item -Force -LiteralPath (Get-Command python).Source -Destination $Zoom
  $logBefore = (Read-Log).Length
  $zoomProc = Start-Process -FilePath $Zoom -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Out 'zoom-out.txt') -RedirectStandardError (Join-Path $Out 'zoom-err.txt') `
    -ArgumentList '-X', 'utf8', "`"$(Join-Path $E2E 'hold_mic.py')`"", '1200'
  Start-Sleep 5
  if ($zoomProc.HasExited) { Fail 'fake call app holds the microphone' "zoom.exe exited $($zoomProc.ExitCode): $(Get-Content -Raw -ErrorAction SilentlyContinue (Join-Path $Out 'zoom-err.txt'))" }
  Pass 'fake call started' "zoom.exe pid $($zoomProc.Id) holding $CableOutputName"
  foreach ($k in @("HKLM\$mic", "HKCU\$mic", "HKCU\$mic\NonPackaged")) { Write-Host "after the call app opened the mic: $k = $((Get-ItemProperty -LiteralPath "Registry::$k" -ErrorAction SilentlyContinue).Value)" }
  Start-Sleep 15
  $entry = Get-ItemProperty -LiteralPath (Join-Path $ConsentKey $ConsentName) -ErrorAction SilentlyContinue
  if ($entry -and $entry.LastUsedTimeStart -and $entry.LastUsedTimeStop -eq 0) {
    Pass 'Windows marked zoom.exe as using the microphone' 'consent store written by Windows'
  } else {
    $now = [DateTime]::UtcNow.ToFileTimeUtc()
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\$ConsentName" /v LastUsedTimeStart /t REG_QWORD /d $now /f | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\$ConsentName" /v LastUsedTimeStop /t REG_QWORD /d 0 /f | Out-Null
    $wroteConsent = $true
    Note 'consent store' 'Windows did not write it within 15 s; wrote LastUsedTimeStart/Stop for zoom.exe by hand'
  }

  # Recording starts by itself.
  $deadline = (Get-Date).AddSeconds(90)
  $m = $null
  while ((Get-Date) -lt $deadline) {
    $m = [regex]::Match((Read-Log).Substring([Math]::Min($logBefore, (Read-Log).Length)), 'call recording started (\S+) folder=(.+?)\s*$', 'Multiline')
    if ($m.Success) { break }
    Start-Sleep 3
  }
  if (-not $m -or -not $m.Success) { Fail 'recording started within 90 s' 'no "call recording started" in main.log' }
  $MeetingId = $m.Groups[1].Value
  $MeetingDir = $m.Groups[2].Value
  Pass 'recording started within 90 s' "$MeetingId $MeetingDir"

  # Both sides speak Hebrew, at different times, until both show up in the live transcript.
  $deadline = (Get-Date).AddMinutes(6)
  $mic = 0; $sys = 0
  while ((Get-Date) -lt $deadline) {
    & python -X utf8 (Join-Path $E2E 'play.py') $ClipMine 'CABLE Input' 2>&1 | Write-Host
    Start-Sleep 4
    & python -X utf8 (Join-Path $E2E 'play.py') $ClipOther 'default' 2>&1 | Write-Host
    Start-Sleep 10
    $segs = Get-Segments $MeetingDir
    $mic = Count-Hebrew $segs 'mic'; $sys = Count-Hebrew $segs 'system'
    Write-Host "... live transcript: $($segs.Count) lines, Hebrew mic=$mic system=$sys"
    if ($mic -ge 1 -and $sys -ge 1) { break }
  }
  $levels = [regex]::Matches((Read-Log), '^.*levels \(30s\).*$', 'Multiline') | Select-Object -Last 1
  if ($levels) { Write-Host "last levels line: $($levels.Value.Trim())" }
  $meta = Get-Meeting $MeetingDir
  if ($meta.status -ne 'recording') { Soft-Fail 'meeting status during the call' $meta.status } else { Pass 'meeting status during the call' 'recording' }
  if ($mic -lt 1) { Soft-Fail 'live transcript: Hebrew line from my side (mic)' "mic=$mic" } else { Pass 'live transcript: Hebrew line from my side (mic)' "$mic" }
  if ($sys -lt 1) { Soft-Fail 'live transcript: Hebrew line from the other side (system)' "system=$sys" } else { Pass 'live transcript: Hebrew line from the other side (system)' "$sys" }
  if ($OtherSide -ne 'scream') { Note 'mic/system separation not proven' 'both sides went through VB-Cable' }

  Invoke-McpCheck @('--live', '--upcoming', $Title) 'MCP during the call (live transcript, calendar)'

  # --- end the call.
  Stop-Process -Id $zoomProc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep 5
  $entry = Get-ItemProperty -LiteralPath (Join-Path $ConsentKey $ConsentName) -ErrorAction SilentlyContinue
  if ($wroteConsent -or ($entry -and $entry.LastUsedTimeStop -eq 0)) {
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\$ConsentName" /v LastUsedTimeStop /t REG_QWORD /d ([DateTime]::UtcNow.ToFileTimeUtc()) /f | Out-Null
  }
  Pass 'call ended' 'zoom.exe stopped'
  $deadline = (Get-Date).AddMinutes(6)
  while ((Get-Date) -lt $deadline) {
    $meta = Get-Meeting $MeetingDir
    if ($meta.status -in @('done', 'error')) { break }
    Start-Sleep 5
  }
  if ($meta.status -ne 'done') { Soft-Fail 'meeting finished (meta.json done)' $meta.status } else { Pass 'meeting finished (meta.json done)' }
  if (-not (Test-Path -LiteralPath (Join-Path $MeetingDir 'audio.m4a'))) { Soft-Fail 'audio.m4a kept' 'missing' } else { Pass 'audio.m4a kept' ("{0:N0} KB" -f ((Get-Item -LiteralPath (Join-Path $MeetingDir 'audio.m4a')).Length / 1KB)) }
  if ($meta.title -ne $Title) { Soft-Fail 'title from the calendar' "'$($meta.title)' (source $($meta.titleSource))" } else { Pass 'title from the calendar' $meta.title }
  Invoke-McpCheck @('--meeting', $Title) 'MCP after the call (list_meetings)'
  Assert-NoFatal
  Pass 'main.log clean'
} catch {
  if (-not $script:Failed) { Soft-Fail 'unexpected error' $_.Exception.Message } else { Write-Host "::error::$($_.Exception.Message)" }
} finally {
  if ($zoomProc -and -not $zoomProc.HasExited) { Stop-Process -Id $zoomProc.Id -Force -ErrorAction SilentlyContinue }
  Save-Artifacts
  if ($MeetingDir -and (Test-Path -LiteralPath $MeetingDir)) {
    $dest = Join-Path $Out 'meeting'
    New-Item -ItemType Directory -Force $dest | Out-Null
    Get-ChildItem -LiteralPath $MeetingDir -File | Where-Object { $_.Name -ne 'audio.m4a' } | Copy-Item -Destination $dest -Force
  }
  Uninstall-Klara
  Write-Summary 'W2 full call'
}
if ($script:Failed) { exit 1 }
exit 0
