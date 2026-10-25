#Requires -RunAsAdministrator
<#
  Connect Sudarshan to the RFM research grader (D-044, D-046), so every Remidio photograph is also graded silently by
  RFM's APTOS and Messidor-2 heads. Safe to run again.
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-rfm.ps1
  1 shared key: kept from graders\rfm\.env (GRADER_API_KEY), or made once; written to Sudarshan's .env (RFM_GRADER_KEY,
    RFM_GRADER_URL); never printed
  2 RFM container started (recreated only when the key is new), port 7861 on this machine only
  3 wait for the heads to load and check /health
  4 restart SudarshanServer so it reads the key
  Run scripts\update.ps1 first (migration 0023 switches the RFM heads on in retina.graders).
#>
$ErrorActionPreference = 'Stop'
$AppEnv = 'D:\Sudarshan\app\.env'
$Rfm    = 'D:\Sudarshan\app\graders\rfm'
$RfmEnv = "$Rfm\.env"

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
$key = Get-EnvValue $RfmEnv 'GRADER_API_KEY'
$newKey = -not $key
if ($newKey) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Set-EnvValue $RfmEnv 'GRADER_API_KEY' $key
  Write-Host '  new key made'
} else { Write-Host '  key already in graders\rfm\.env, kept' }
Set-EnvValue $AppEnv 'RFM_GRADER_URL' 'http://127.0.0.1:7861'
Set-EnvValue $AppEnv 'RFM_GRADER_KEY' $key
& icacls $RfmEnv /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' "$($env:USERNAME):F" | Out-Null
Write-Host '  written to Sudarshan .env (value not shown)'

Write-Host "`n=== 2. RFM container ===" -ForegroundColor Cyan
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is not running. Start it (sign in to Windows on shichika), wait until it is ready, then run this again.'
}
Push-Location $Rfm
try {
  if ($newKey) { & docker compose up -d --force-recreate rfm } else { & docker compose up -d rfm }
  if ($LASTEXITCODE) { throw 'docker compose up failed' }
} finally { Pop-Location }

Write-Host "`n=== 3. Health ===" -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 36 -and -not $ok; $i++) {
  Start-Sleep 5
  try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7861/health' -TimeoutSec 5; $ok = $h.model_loaded -eq $true } catch { }
}
if ($ok) {
  $heads = ($h.heads.PSObject.Properties | ForEach-Object { "$($_.Name) $($_.Value.model_sha256.Substring(0, 12))" }) -join ', '
  Write-Host "  RFM loaded; heads: $heads" -ForegroundColor Green
} else { Write-Host '  not ready after 3 minutes: docker logs sampada-rfm' -ForegroundColor Yellow }

Write-Host "`n=== 4. Restart Sudarshan ===" -ForegroundColor Cyan
Restart-Service SudarshanServer
Write-Host '  SudarshanServer restarted. Retina AI > System lists each grader; new Remidio photographs get an RFM grading within 5 minutes.' -ForegroundColor Green
