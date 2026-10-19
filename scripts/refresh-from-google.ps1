<#
  Trial refresh (D-025): copies the Google app's bookings, cancel list, direct calls, triage and clinic calendar into
  Sudarshan. Run by the scheduled task "Sudarshan refresh from Google" every 15 minutes 07:00-21:00 and at 23:30,
  or by hand:
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\refresh-from-google.ps1
  Reads the Google sheet only (read-only token); never touches Yarago. Does nothing once trial.google_master is false
  (cut-over). Each run is recorded in app.import_runs; the log is logs\import.log. Exit code 1 on failure.
  Install the task: scripts\install-refresh.ps1
#>
param([string]$App = 'D:\Sudarshan\app')
$ErrorActionPreference = 'Continue'
$py = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
$logFile = Join-Path $App 'logs/import.log'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
function Log([string]$m) { Add-Content -Path $logFile -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

$t0 = Get-Date
$out = & $py "$App\scripts\import_sheets.py" --scheduled 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$secs = [int]((Get-Date) - $t0).TotalSeconds
# counts only: the importer prints no patient data
$summary = ($out | Select-String -Pattern 'appointments \(appointment\)|removed \(|nothing imported|Error|Traceback' | ForEach-Object { $_.Line.Trim() }) -join '; ' -replace '\s{2,}', ' '
if ($code -eq 0) { Log "ok in ${secs}s: $summary" } else { Log "FAILED (exit $code) in ${secs}s: $(($out | Select-Object -Last 3) -join ' | ')" }
# keep the log small: last 3,000 lines
$lines = Get-Content $logFile -Tail 3000; Set-Content -Path $logFile -Value $lines -Encoding utf8
exit [int]($code -ne 0)
