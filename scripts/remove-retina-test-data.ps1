#Requires -RunAsAdministrator
<#
  Remove the September test data of the retina grader (D-040; Pavin, 25 Oct: random fundus photographs with made-up
  MRDs, not patients). Run once, after update.ps1 has applied migration 0019 (which removes the copies in Sudarshan).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\remove-retina-test-data.ps1
  Shows what it will delete and asks for YES first. Deleted files cannot be brought back.
  1 stop the grader container   2 delete the old test databases   3 remove the log lines with typed names / phones
  4 start the grader again and wait for the model
#>
$ErrorActionPreference = 'Stop'
$G = 'D:\classification\sampada-retinal-ai'
$files = @("$G\data\records.db", "$G\data\records.db-shm", "$G\data\records.db-wal",
           "$G\_preprod-artifacts\records-preprod.db", "$G\_preprod-artifacts\records-preprod.db-shm", "$G\_preprod-artifacts\records-preprod.db-wal") |
         Where-Object { Test-Path $_ }
$pattern = 'name=|mobile=|patient_name'
$logs = @("$G\logs\app.log", "$G\_diag\e2e.txt", "$G\_diag\ingest.txt") + @(Get-ChildItem "$G\logs\app.log.*" -ErrorAction SilentlyContinue | ForEach-Object FullName)
$logs = $logs | Where-Object { (Test-Path $_) -and (Select-String -Path $_ -Pattern $pattern -Quiet) }

Write-Host "`nWill delete these files:" -ForegroundColor Cyan
if ($files) { $files | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  (none left)' }
Write-Host "Will remove the lines with typed names or phone numbers from:" -ForegroundColor Cyan
if ($logs) { $logs | ForEach-Object { Write-Host ("  {0}  ({1} lines)" -f $_, (Select-String -Path $_ -Pattern $pattern).Count) } } else { Write-Host '  (none left)' }
if (-not $files -and -not $logs) { Write-Host "`nNothing to do."; return }
if ((Read-Host "`nType YES to delete them") -cne 'YES') { Write-Host 'Nothing was changed.'; return }

Write-Host "`n=== 1. Stop the grader ===" -ForegroundColor Cyan
Push-Location "$G\docker"
try { & docker compose stop app; if ($LASTEXITCODE) { throw 'docker compose stop failed' } } finally { Pop-Location }

Write-Host "`n=== 2. Test databases ===" -ForegroundColor Cyan
foreach ($f in $files) { Remove-Item -LiteralPath $f -Force; Write-Host "  deleted $f" }

Write-Host "`n=== 3. Log lines ===" -ForegroundColor Cyan
foreach ($f in $logs) {
  $keep = Get-Content -LiteralPath $f | Where-Object { $_ -notmatch $pattern }
  Set-Content -LiteralPath $f -Value $keep -Encoding utf8
  Write-Host "  cleaned $f"
}

Write-Host "`n=== 4. Start the grader ===" -ForegroundColor Cyan
Push-Location "$G\docker"
try { & docker compose start app; if ($LASTEXITCODE) { throw 'docker compose start failed' } } finally { Pop-Location }
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep 5
  try { $ok = (Invoke-RestMethod -Uri 'http://127.0.0.1:7860/health' -TimeoutSec 5).model_loaded -eq $true } catch { }
}
if ($ok) { Write-Host '  grader ready' -ForegroundColor Green } else { Write-Host '  not ready after 2.5 minutes: see logs\app.log in the grader folder' -ForegroundColor Yellow }
if (Test-Path "$G\data\records.db") { Write-Host '  WARNING: records.db was made again (old grader code?)' -ForegroundColor Red }
else { Write-Host '  no records.db (as intended: records live in Sudarshan)' }
