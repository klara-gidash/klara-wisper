# Gives a Windows runner (no sound card) virtual audio for the call test:
#   - Windows Audio services started,
#   - VB-Cable: "CABLE Input" (playback) -> "CABLE Output" (recording) = MY side (the microphone),
#   - Scream (optional, a second virtual playback device) as the default output = the OTHER side,
#     which the app records as system audio (loopback of the default output),
#   - default recording device = CABLE Output (AudioDeviceCmdlets).
# Dot-source after common.ps1. Sets $script:OtherSide = 'scream' | 'cable' (fallback: both sides go
# through VB-Cable, so mic and system hear the same audio; reported as a warning).
$VbCableChoco = if ($env:VBCABLE_CHOCO_VERSION) { $env:VBCABLE_CHOCO_VERSION } else { '2.1.5.8' }
$VbCableZip = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
$ScreamZip = 'https://github.com/duncanthrax/scream/releases/download/4.0/Scream4.0.zip'
$AudioCmdletsVersion = '3.1.0.2'

function Get-Endpoints {
  Get-AudioDevice -List | Select-Object Index, Type, Default, Name, ID
}

function Initialize-Audio {
  foreach ($svc in @('AudioEndpointBuilder', 'Audiosrv')) {
    Set-Service -Name $svc -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service -Name $svc -ErrorAction SilentlyContinue
  }
  if ((Get-Service Audiosrv).Status -ne 'Running') { Fail 'Windows Audio service' (Get-Service Audiosrv).Status }
  Pass 'Windows Audio service' 'running'

  if (-not (Get-Module -ListAvailable AudioDeviceCmdlets | Where-Object { $_.Version -eq $AudioCmdletsVersion })) {
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
    Install-Module AudioDeviceCmdlets -RequiredVersion $AudioCmdletsVersion -Scope CurrentUser -Force
  }
  Import-Module AudioDeviceCmdlets -RequiredVersion $AudioCmdletsVersion

  # VB-Cable: choco first (pinned), then the official driver pack.
  if (-not (Get-PnpDevice -FriendlyName '*VB-Audio*' -ErrorAction SilentlyContinue)) {
    & choco install vb-cable --version $VbCableChoco -y --no-progress 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0 -or -not (Get-PnpDevice -FriendlyName '*VB-Audio*' -ErrorAction SilentlyContinue)) {
      Write-Host 'choco vb-cable did not install the driver; trying the official driver pack'
      $dir = Join-Path $env:RUNNER_TEMP 'vbcable'
      New-Item -ItemType Directory -Force $dir | Out-Null
      Invoke-WebRequest -UseBasicParsing $VbCableZip -OutFile "$dir\vbcable.zip"
      Expand-Archive -Force "$dir\vbcable.zip" $dir
      $p = Start-Process -FilePath "$dir\VBCABLE_Setup_x64.exe" -ArgumentList '-i', '-h' -PassThru -Wait
      Write-Host "VBCABLE_Setup_x64 exit code $($p.ExitCode)"
    }
  }
  Restart-Service Audiosrv -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep 3
    $rec = Get-Endpoints | Where-Object { $_.Type -eq 'Recording' -and $_.Name -like '*CABLE Output*' } | Select-Object -First 1
  } while (-not $rec -and (Get-Date) -lt $deadline)
  Get-Endpoints | Format-Table -AutoSize Index, Type, Default, Name | Out-String -Width 200 | Write-Host
  if (-not $rec) { Fail 'VB-Cable "CABLE Output" recording device' 'not found' }
  Pass 'VB-Cable "CABLE Output" recording device' $rec.Name
  $script:CableOutputName = $rec.Name
  Set-AudioDevice -ID $rec.ID | Out-Null
  Pass 'default recording device' $rec.Name

  # The other side: Scream as the default playback device (its signed release, its own install batch).
  $script:OtherSide = 'cable'
  try {
    $dir = Join-Path $env:RUNNER_TEMP 'scream'
    New-Item -ItemType Directory -Force $dir | Out-Null
    Invoke-WebRequest -UseBasicParsing $ScreamZip -OutFile "$dir\scream.zip"
    Expand-Archive -Force "$dir\scream.zip" $dir
    $bat = Get-ChildItem -Recurse -LiteralPath $dir -Filter 'install-x64.bat' | Select-Object -First 1
    if (-not $bat) { throw 'install-x64.bat not in the Scream zip' }
    Push-Location $bat.DirectoryName
    try { & cmd.exe /c "echo.| `"$($bat.FullName)`"" 2>&1 | Write-Host } finally { Pop-Location }
    Restart-Service Audiosrv -Force -ErrorAction SilentlyContinue
    Start-Sleep 5
    $scream = Get-Endpoints | Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*Scream*' } | Select-Object -First 1
    if (-not $scream) { throw 'no Scream playback device after install' }
    Set-AudioDevice -ID $scream.ID | Out-Null
    $script:OtherSide = 'scream'
    Pass 'other side: default playback device' $scream.Name
  } catch {
    $cableIn = Get-Endpoints | Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*CABLE Input*' } | Select-Object -First 1
    if ($cableIn) { Set-AudioDevice -ID $cableIn.ID | Out-Null }
    Note 'other side: no second virtual output' "($($_.Exception.Message)); default playback = CABLE Input, so mic and system hear the same audio"
  }
  # Re-assert the recording default (installing a device can move it).
  Set-AudioDevice -ID $rec.ID | Out-Null
  Get-Endpoints | Format-Table -AutoSize Index, Type, Default, Name | Out-String -Width 200 | Write-Host
}
