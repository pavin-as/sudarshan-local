<#
  Proves the latest backup can be restored (run monthly by the scheduled task "Sudarshan restore test", or by hand):
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\restore-test.ps1 [-File <path to .dump>]
  Restores into a scratch database "sudarshan_restore_test", compares the main table counts with the counts recorded
  when the backup was made, then drops the scratch database. The live database is only read (and gets one
  app.backup_runs row). Exit code 1 on failure.

  A REAL restore (after losing the database) is described in docs/RUNBOOK.md section 6.
#>
param(
  [string]$App = 'D:\Sudarshan\app',
  [string]$File = '',
  [string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin'
)
# Continue: Windows PowerShell 5.1 turns any stderr line of a native tool into a terminating error under 'Stop'.
# Failures are caught explicitly ($LASTEXITCODE, -ErrorAction Stop on the file steps).
$ErrorActionPreference = 'Continue'
$logFile = Join-Path $App 'logs/backup.log'
function Log([string]$m) { $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Add-Content -Path $logFile -Value $line; Write-Host $line }

$cfg = @{}
foreach ($l in (Get-Content (Join-Path $App '.env') -ErrorAction Stop)) { if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim().Trim('"') } }
$exe = if ($IsLinux -or $IsMacOS) { '' } else { '.exe' }
$pgRestore = Join-Path $PgBin "pg_restore$exe"; $psql = Join-Path $PgBin "psql$exe"
$env:PGHOST = if ($cfg['PG_HOST']) { $cfg['PG_HOST'] } else { '127.0.0.1' }
$env:PGPORT = if ($cfg['PG_PORT']) { $cfg['PG_PORT'] } else { '5432' }
$env:PGUSER = 'postgres'; $env:PGPASSWORD = $cfg['PG_SUPERUSER_PASSWORD']
$db = if ($cfg['PG_DB']) { $cfg['PG_DB'] } else { 'sudarshan' }
$scratch = 'sudarshan_restore_test'
$L = { param($v) if ($null -eq $v -or "$v" -eq '') { 'NULL' } else { '$bk$' + ("$v" -replace '\$bk\$', '') + '$bk$' } }

$started = Get-Date
$status = 'failed'; $msg = ''; $details = ''
try {
  if (-not $File) {
    $dir = Join-Path $cfg['BACKUP_DIR'] 'daily'
    $latest = Get-ChildItem $dir -Filter 'sudarshan_*.dump' -ErrorAction Stop | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "No backup found in $dir" }
    $File = $latest.FullName
  }
  Log "restore test of $File"
  & $psql -d postgres -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $scratch" -c "CREATE DATABASE $scratch ENCODING 'UTF8' TEMPLATE template0" 2>&1 | Out-Null
  if ($LASTEXITCODE) { throw 'could not create the scratch database' }
  $out = & $pgRestore --no-owner --no-privileges --exit-on-error -d $scratch $File 2>&1
  if ($LASTEXITCODE) { throw "pg_restore failed: $($out | Select-Object -First 5)" }

  $sql = "SELECT json_build_object('appointments',(SELECT count(*) FROM app.appointments),'appointment_events',(SELECT count(*) FROM app.appointment_events),'users',(SELECT count(*) FROM app.users),'audit_log',(SELECT count(*) FROM app.audit_log),'followup_actions',(SELECT count(*) FROM app.followup_actions))"
  $restored = (& $psql -d $scratch -tA -c $sql) -join ''
  $views = (& $psql -d $scratch -tA -c "SELECT count(*) FROM information_schema.views WHERE table_schema IN ('clinical','app')") -join ''
  $expected = (("SELECT details->'counts' FROM app.backup_runs WHERE kind = 'backup' AND status = 'ok' AND file = " + (& $L $File) + " ORDER BY id DESC LIMIT 1") | & $psql -d $db -tA) -join ''
  $r = $restored | ConvertFrom-Json
  $problems = @()
  if ($expected) {
    $e = $expected | ConvertFrom-Json
    foreach ($k in $e.PSObject.Properties.Name) { if ([long]$r.$k -ne [long]$e.$k) { $problems += "$k restored $($r.$k), expected $($e.$k)" } }
  } else { Log "note: no recorded counts for this file; comparing nothing" }
  if ([int]$views -lt 10) { $problems += "only $views views restored" }
  $details = '{"file_counts":' + $restored + ',"views":' + $views + '}'
  if ($problems) { throw ($problems -join '; ') }
  $status = 'ok'
  Log "restore test ok: $restored, $views views"
} catch {
  $msg = $_.Exception.Message
  Log "RESTORE TEST FAILED: $msg"
} finally {
  & $psql -d postgres -q -c "DROP DATABASE IF EXISTS $scratch" 2>&1 | Out-Null
  $q = "INSERT INTO app.backup_runs (kind, started_at, finished_at, status, file, details, message) VALUES ('restore_test', " +
       (& $L $started.ToString('o')) + "::timestamptz, now(), " + (& $L $status) + ", " + (& $L $File) + ", " + (& $L $details) + "::jsonb, " + (& $L $msg) + ");"
  $q | & $psql -d $db -q 2>&1 | Out-Null
}
if ($status -ne 'ok') { exit 1 }
exit 0
