#Requires -RunAsAdministrator
<#
  Connect Sudarshan to the research DR grader (D-040). Safe to run again.
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-retina-ai.ps1
  1 shared key: made once, written to Sudarshan's .env (RETINA_AI_KEY) and the grader's docker\.env (GRADER_API_KEY);
    never printed
  2 grader container recreated with the new settings (port 7860 on this machine only, old Gradio page off)
  3 wait for the model to load (about a minute) and check /health
  4 remove the old LAN firewall rule for port 7860, if there is one
  Then run scripts\update.ps1 (migration 0018, rebuild, restart SudarshanServer so it reads the key).
#>
$ErrorActionPreference = 'Stop'
$AppEnv    = 'D:\Sudarshan\app\.env'
$Grader    = 'D:\classification\sampada-retinal-ai'
$GraderEnv = "$Grader\docker\.env"

function Get-EnvValue([string]$file, [string]$key) {
  if (-not (Test-Path $file)) { return '' }
  $line = Get-Content $file | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($line) { return $line.Substring($key.Length + 1).Trim() } else { return '' }
}
function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  # rewrites the file in place, so its access rights (admin only for Sudarshan's .env) stay as they are
  $lines = @(if (Test-Path $file) { Get-Content $file } else { @() })
  if ($lines | Where-Object { $_ -match "^$key=" }) { $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } } }
  else { $lines += "$key=$value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

Write-Host "`n=== 1. Shared key ===" -ForegroundColor Cyan
$key = Get-EnvValue $AppEnv 'RETINA_AI_KEY'
if (-not $key) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Write-Host '  new key made'
} else { Write-Host '  key already in Sudarshan .env, kept' }
if (-not (Get-EnvValue $AppEnv 'RETINA_AI_URL')) { Set-EnvValue $AppEnv 'RETINA_AI_URL' 'http://127.0.0.1:7860' }
Set-EnvValue $AppEnv 'RETINA_AI_KEY' $key
Set-EnvValue $GraderEnv 'GRADER_API_KEY' $key
# the grader's .env now holds a secret: administrators and SYSTEM only (Docker Desktop runs as the signed-in admin)
& icacls $GraderEnv /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' "$($env:USERNAME):F" | Out-Null
Write-Host '  written to both .env files (value not shown)'

Write-Host "`n=== 2. Grader container ===" -ForegroundColor Cyan
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is not running. Start it (sign in to Windows on shichika), wait until it is ready, then run this again.'
}
Push-Location "$Grader\docker"
try { & docker compose up -d --force-recreate app; if ($LASTEXITCODE) { throw 'docker compose up failed' } } finally { Pop-Location }

Write-Host "`n=== 3. Health ===" -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep 5
  try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7860/health' -TimeoutSec 5; $ok = $h.model_loaded -eq $true } catch { }
}
if ($ok) { Write-Host "  model loaded, calibration $($h.output_calibration), version $($h.app_version)" -ForegroundColor Green }
else { Write-Host '  not ready after 2.5 minutes: run scripts\logs.bat in the grader folder' -ForegroundColor Yellow }
$lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress
if ($lan) {
  try { Invoke-WebRequest -Uri "http://${lan}:7860/health" -TimeoutSec 3 -UseBasicParsing | Out-Null; Write-Host "  WARNING: still reachable on $lan" -ForegroundColor Red }
  catch { Write-Host "  not reachable on the LAN address $lan (as intended)" }
}

Write-Host "`n=== 4. Old firewall rule ===" -ForegroundColor Cyan
$rules = Get-NetFirewallRule -DisplayName 'Sampada Retinal AI (LAN only)' -ErrorAction SilentlyContinue   # made by open-firewall-RUN-AS-ADMIN.bat
if ($rules) { $rules | ForEach-Object { Write-Host "  removing '$($_.DisplayName)'"; Remove-NetFirewallRule -Name $_.Name } }
else { Write-Host '  none found' }

Write-Host "`nNext: powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1 -Message 'Retina AI (D-040)'" -ForegroundColor Cyan
