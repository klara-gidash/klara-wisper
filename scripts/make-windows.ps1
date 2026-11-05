# Builds release\Klara Wisper Setup.exe on a Windows 10/11 x64 PC (per-user installer, no admin rights).
# Needs: Node 24 (with npm) and the .NET 8 SDK on PATH. Run from the repo:
#   powershell -ExecutionPolicy Bypass -File scripts\make-windows.ps1
# Like the Mac build, the app ships uv (pinned, checksum-verified) and the engine source; on first
# launch it installs Python + the locked packages into %APPDATA%\Klara Wisper\engine and downloads
# the models (src/main/setup.ts). See WINDOWS.md.
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

$UvVersion = '0.13.5'
$UvSha256 = 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a' # uv-x86_64-pc-windows-msvc.zip

# 1. uv.exe, pinned and checksum-verified
$uvDir = Join-Path $Root 'build\uv-win'
$uvExe = Join-Path $uvDir 'uv.exe'
$haveUv = (Test-Path $uvExe) -and ((& $uvExe --version) -match " $UvVersion ")
if (-not $haveUv) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("klara-uv-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'uv.zip'
  Invoke-WebRequest -UseBasicParsing "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($got -ne $UvSha256) { throw "uv download checksum mismatch: $got" }
  Expand-Archive -Path $zip -DestinationPath $tmp
  New-Item -ItemType Directory -Force -Path $uvDir | Out-Null
  Copy-Item (Join-Path $tmp 'uv.exe') $uvExe -Force
  Remove-Item -Recurse -Force $tmp
}

# 2. the helper (release: only `serve`, only for its parent Klara Wisper.exe)
$helperOut = Join-Path $Root 'build\win-helper'
if (Test-Path $helperOut) { Remove-Item -Recurse -Force $helperOut }
dotnet publish native\KlaraHelperWin\KlaraHelperWin.csproj -c Release -r win-x64 -o $helperOut
if ($LASTEXITCODE -ne 0) { throw 'helper build failed' }

# 3. the app and the installer
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npx electron-vite build
if ($LASTEXITCODE -ne 0) { throw 'electron-vite build failed' }
$env:KLARA_NO_ENGINE_PATH = '1'
$out = Join-Path $Root 'dist\windows'
npx electron-builder --config electron-builder.config.cjs --win --x64 "-c.directories.output=$out"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'release') | Out-Null
$setup = Join-Path $Root 'release\Klara Wisper Setup.exe'
Copy-Item (Join-Path $out 'Klara Wisper Setup.exe') $setup -Force
$hash = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLower()
Write-Host "built $setup"
Write-Host "sha256 $hash"
