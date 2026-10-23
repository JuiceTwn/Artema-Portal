# Builds the installer from a short path (the installer tool can't open files under very long folder names).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:LOCALAPPDATA 'ab'
New-Item -ItemType Directory $work -Force | Out-Null
robocopy $src $work /MIR /XD dist node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
Set-Location $work
if (-not (Test-Path node_modules\electron)) { npm install --no-audit --no-fund }
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
New-Item -ItemType Directory (Join-Path $src 'dist') -Force | Out-Null
Copy-Item (Join-Path $work 'dist\*\*.zip') (Join-Path $src 'dist') -Force
Write-Host "Package: $(Join-Path $src 'dist')"
