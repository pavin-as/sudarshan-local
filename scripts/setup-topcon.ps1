#Requires -RunAsAdministrator
<#
  Connect Sudarshan to the ImageNet PC's read-only share for Topcon Maestro2 photographs (D-048, docs/OCT_PLAN.md Step 3).
  Safe to run again (e.g. after the sudarshan_ro password was changed on the ImageNet PC).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-topcon.ps1
  Before: the share \\192.168.0.152\SudarshanOCT$ and its account OCT_PC\sudarshan_ro exist (imagenet-share-readonly.ps1,
  RUNBOOK 13) and the Kaspersky rule on the ImageNet PC lets shichika in.
  1 checks Topcon's export tool, the isolated Python (tools\oct-venv: pydicom, OpenJPEG, Pillow) and the converter
  2 the share's address and account, and its password (typed here, never shown) into Sudarshan's .env: the server runs as
    SYSTEM, which cannot use a password saved with cmdkey in someone's own sign-in
  3 the work folder D:\Sudarshan\data\oct\work\import, administrators and SYSTEM only (it holds copies of exams briefly)
  4 restart SudarshanServer so it reads the settings
  The import stays as it was (off after first install): Retina AI > System > Topcon Maestro2: Peek, then On.
#>
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$AppEnv = Join-Path $App '.env'
$Tool = 'D:\Sudarshan\tools\topcon\DicomOctExport-3.0.0.39\DicomOctExport.exe'
$Python = 'D:\Sudarshan\tools\oct-venv\Scripts\python.exe'
$Share = '\\192.168.0.152\SudarshanOCT$'
$Account = 'OCT_PC\sudarshan_ro'
$Work = 'D:\Sudarshan\data\oct\work\import'

function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  # rewrites the file in place, so its access rights (administrators only) stay as they are
  $lines = @(if (Test-Path $file) { Get-Content $file } else { @() })
  if ($lines | Where-Object { $_ -match "^$key=" }) { $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } } }
  else { $lines += "$key=$value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

Write-Host "`n=== 1. Programs ===" -ForegroundColor Cyan
foreach ($f in $Tool, $Python, (Join-Path $App 'scripts\topcon_photo.py')) {
  if (-not (Test-Path $f)) { throw "Missing: $f (RUNBOOK 13)" }
  Write-Host "  found $f"
}
& $Python -I -c "import pydicom, openjpeg, PIL, numpy" 2>$null
if ($LASTEXITCODE) { throw "The isolated Python lacks pydicom / pylibjpeg-openjpeg / Pillow / numpy (RUNBOOK 13)" }
Write-Host '  the isolated Python has pydicom, OpenJPEG, Pillow and numpy'

Write-Host "`n=== 2. Share and password ===" -ForegroundColor Cyan
$sec = Read-Host "Password of $Account (as set on the ImageNet PC; not shown)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if (-not $plain) { throw 'No password typed: nothing changed.' }
if ($plain -match '["\r\n]') { throw 'The password holds a double quote or a line break, which .env cannot store: choose another on the ImageNet PC.' }
Set-EnvValue $AppEnv 'TOPCON_SHARE' $Share
Set-EnvValue $AppEnv 'TOPCON_DATA_DIR' 'Data'
Set-EnvValue $AppEnv 'TOPCON_SHARE_USER' $Account
Set-EnvValue $AppEnv 'TOPCON_SHARE_PASSWORD' ('"' + $plain + '"')
Set-EnvValue $AppEnv 'TOPCON_TOOL' $Tool
Set-EnvValue $AppEnv 'OCT_PYTHON' $Python
Set-EnvValue $AppEnv 'TOPCON_WORK_DIR' $Work
$plain = $null; $sec = $null
Write-Host "  written to $AppEnv (password not shown); share $Share as $Account"

Write-Host "`n=== 3. Work folder ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Work | Out-Null
& icacls 'D:\Sudarshan\data\oct' /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' "$env:COMPUTERNAME\Admin:(OI)(CI)F" | Out-Null
Write-Host "  $Work (administrators and SYSTEM only)"

Write-Host "`n=== 4. Restart the server ===" -ForegroundColor Cyan
if (Get-Service SudarshanServer -ErrorAction SilentlyContinue) { Restart-Service SudarshanServer; Start-Sleep 4; (Get-Service SudarshanServer).Status }
else { Write-Host '  SudarshanServer is not installed' -ForegroundColor Yellow }

Write-Host "`nNext: Sudarshan > Retina AI > System > Photographs from the Topcon Maestro2: Peek, Check now; then On." -ForegroundColor Cyan
