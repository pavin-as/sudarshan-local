<#
  Nightly backup of Sudarshan (run by the scheduled task "Sudarshan backup", or by hand):
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\backup.ps1

  Writes to BACKUP_DIR from .env (set by install-backup.ps1), e.g. F:\SUDARSHAN_BACKUP:
    daily\sudarshan_YYYY-MM-DD_HHMM.dump   PostgreSQL custom-format dump of database "sudarshan":
                                           all of app.* (bookings, users, audit log ...) and every table and view
                                           definition. The Yarago mirror's DATA is left out (it is a copy of Yarago,
                                           which has its own backup, and is rebuilt by one full sync after a restore).
    daily\code_YYYY-MM-DD_HHMM.bundle      the git repository (all code and history; it is not on GitHub)
    daily\metabase_YYYY-MM-DD_HHMM.dump    Metabase's own database (dashboards, logins, subscriptions), once installed
    monthly\                               first backup of each month, kept 12 months
    fundus\                                fundus photographs from Remidio and the Maestro2 (D-041, D-048), added to, never pruned
    oct\                                   OCT / OCTA scans from the Maestro2 (D-049), added to, never pruned
  Daily files are kept 14 days. Every dump is checked readable (pg_restore --list) before it counts.
  Each run is recorded in app.backup_runs and logs\backup.log. Exit code 1 on failure.
  Not included on purpose: .env (secrets). Keep a copy of it somewhere safe offline (RUNBOOK.md).
#>
param(
  [string]$App = 'D:\Sudarshan\app',
  [string]$Target = '',
  [string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin',
  [int]$KeepDays = 14,
  [int]$KeepMonths = 12
)
# Continue: Windows PowerShell 5.1 turns any stderr line of a native tool into a terminating error under 'Stop'.
# Failures are caught explicitly ($LASTEXITCODE, -ErrorAction Stop on the file steps).
$ErrorActionPreference = 'Continue'
$logFile = Join-Path $App 'logs/backup.log'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
function Log([string]$m) { $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Add-Content -Path $logFile -Value $line; Write-Host $line }

# ---- settings from .env (never printed)
$cfg = @{}
foreach ($l in (Get-Content (Join-Path $App '.env') -ErrorAction Stop)) {
  if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim().Trim('"') }
}
if (-not $Target) { $Target = $cfg['BACKUP_DIR'] }
if (-not $Target) { throw 'No backup folder: set BACKUP_DIR in .env (install-backup.ps1 does this).' }
$exe = if ($IsLinux -or $IsMacOS) { '' } else { '.exe' }
$pgDump = Join-Path $PgBin "pg_dump$exe"; $pgRestore = Join-Path $PgBin "pg_restore$exe"; $psql = Join-Path $PgBin "psql$exe"
foreach ($t in $pgDump, $pgRestore, $psql) { if (-not (Test-Path $t)) { throw "Not found: $t" } }
$env:PGHOST = if ($cfg['PG_HOST']) { $cfg['PG_HOST'] } else { '127.0.0.1' }
$env:PGPORT = if ($cfg['PG_PORT']) { $cfg['PG_PORT'] } else { '5432' }
$env:PGUSER = 'postgres'
$env:PGPASSWORD = $cfg['PG_SUPERUSER_PASSWORD']
$db = if ($cfg['PG_DB']) { $cfg['PG_DB'] } else { 'sudarshan' }

function Record([string]$status, [string]$file, [long]$bytes, [string]$details, [string]$msg, [datetime]$started) {
  # values go in dollar-quoted literals through stdin (Windows PowerShell mangles quotes in native arguments)
  $L = { param($v) if ($null -eq $v -or "$v" -eq '') { 'NULL' } else { '$bk$' + ("$v" -replace '\$bk\$', '') + '$bk$' } }
  $q = "INSERT INTO app.backup_runs (kind, started_at, finished_at, status, file, bytes, details, message) VALUES ('backup', " +
       (& $L $started.ToString('o')) + "::timestamptz, now(), " + (& $L $status) + ", " + (& $L $file) + ", " +
       (& $L $(if ($bytes) { $bytes } else { '' })) + "::bigint, " + (& $L $details) + "::jsonb, " + (& $L $msg) + ");"
  $q | & $psql -d $db -q -v ON_ERROR_STOP=1 2>&1 | Out-Null
  if ($LASTEXITCODE) { Log "WARNING: could not record the run in app.backup_runs" }
}

$started = Get-Date
$stamp = $started.ToString('yyyy-MM-dd_HHmm')
$daily = Join-Path $Target 'daily'; $monthly = Join-Path $Target 'monthly'
$dump = Join-Path $daily "sudarshan_$stamp.dump"
$bundle = Join-Path $daily "code_$stamp.bundle"
try {
  if (-not (Test-Path $Target)) { throw "Backup folder $Target is not reachable (QNAP offline or drive not mapped?)" }
  New-Item -ItemType Directory -Force -Path $daily, $monthly -ErrorAction Stop | Out-Null
  Log "backup started -> $dump"

  # 1. database dump (written as .partial, renamed only after it reads back)
  $partial = "$dump.partial"
  $out = & $pgDump -d $db -Fc -Z 6 "--exclude-table-data=yarago.*" "--exclude-table-data=yarago_staging.*" -f $partial 2>&1
  if ($LASTEXITCODE) { throw "pg_dump failed: $out" }
  $list = & $pgRestore --list $partial 2>&1
  if ($LASTEXITCODE) { throw "dump is not readable: $list" }
  $entries = ($list | Where-Object { $_ -notmatch '^;' -and $_.Trim() }).Count
  if ($entries -lt 50) { throw "dump looks incomplete ($entries entries)" }
  Move-Item -Force $partial $dump -ErrorAction Stop
  $bytes = (Get-Item $dump -ErrorAction Stop).Length
  Log ("database dump ok: {0:N1} MB, {1} entries" -f ($bytes / 1MB), $entries)

  # 1b. Metabase's own database, if Metabase is installed (dashboards, logins, the weekly email)
  $mbDump = Join-Path $daily "metabase_$stamp.dump"; $mbOk = $false
  $hasMb = (& $psql -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname = 'metabase'" 2>&1) -join ''
  if ($hasMb.Trim() -eq '1') {
    $out = & $pgDump -d metabase -Fc -Z 6 -f "$mbDump.partial" 2>&1
    if ($LASTEXITCODE) { Log "WARNING: Metabase dump failed: $out" }
    else { Move-Item -Force "$mbDump.partial" $mbDump; $mbOk = $true; Log ("metabase dump ok: {0:N1} MB" -f ((Get-Item $mbDump).Length / 1MB)) }
  }

  # 2. code (git bundle of every branch and its history)
  $codeOk = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $g = & git -c "safe.directory=*" -C $App bundle create $bundle --all 2>&1
    if ($LASTEXITCODE) { Log "WARNING: git bundle failed: $g" } else { $codeOk = $true; Log "code bundle ok" }
  } else { Log "WARNING: git not found, code not bundled" }

  # 2b. fundus photographs from Remidio (D-041): copied into <backup>\fundus, new and changed files only. Nothing is
  #     ever deleted there (photographs are clinical records), so this folder is not part of the daily/monthly rotation.
  $photoDir = if ($cfg['RETINA_PHOTO_DIR']) { $cfg['RETINA_PHOTO_DIR'] } else { 'D:\Sudarshan\data\fundus' }
  $photosOk = $null
  if (Test-Path $photoDir) {
    $rc = & robocopy $photoDir (Join-Path $Target 'fundus') /E /XO /R:2 /W:5 /NP /NFL /NDL /NJH /NJS 2>&1
    $photosOk = $LASTEXITCODE -lt 8                 # robocopy: 0-7 = copied / nothing to copy, 8+ = failure
    if ($photosOk) { Log "fundus photographs copied (robocopy code $LASTEXITCODE)" } else { Log "WARNING: fundus photograph copy failed (robocopy code $LASTEXITCODE): $rc" }
  }
  # 2c. OCT / OCTA scans from the Maestro2 (D-049): the same way, into <backup>\oct
  $octDir = if ($cfg['OCT_DIR']) { $cfg['OCT_DIR'] } else { 'D:\Sudarshan\data\oct\store' }
  $octOk = $null
  if (Test-Path $octDir) {
    $rc = & robocopy $octDir (Join-Path $Target 'oct') /E /XO /R:2 /W:5 /NP /NFL /NDL /NJH /NJS 2>&1
    $octOk = $LASTEXITCODE -lt 8
    if ($octOk) { Log "OCT scans copied (robocopy code $LASTEXITCODE)" } else { Log "WARNING: OCT scan copy failed (robocopy code $LASTEXITCODE): $rc" }
  }

  # 3. counts of the main tables, kept with the run for comparison in restore tests
  $counts = & $psql -d $db -tA -c "SELECT json_build_object('appointments',(SELECT count(*) FROM app.appointments),'appointment_events',(SELECT count(*) FROM app.appointment_events),'users',(SELECT count(*) FROM app.users),'audit_log',(SELECT count(*) FROM app.audit_log),'followup_actions',(SELECT count(*) FROM app.followup_actions))" 2>&1
  if ($LASTEXITCODE) { $counts = '{}' }

  # 4. monthly copy: first backup of the month
  $monthTag = $started.ToString('yyyy-MM')
  if (-not (Get-ChildItem $monthly -Filter "sudarshan_$monthTag-*.dump" -ErrorAction SilentlyContinue)) {
    Copy-Item $dump $monthly -ErrorAction Stop
    if ($codeOk) { Copy-Item $bundle $monthly }
    if ($mbOk) { Copy-Item $mbDump $monthly }
    Log "monthly copy kept for $monthTag"
  }

  # 5. retention
  $cut = $started.AddDays(-$KeepDays)
  Get-ChildItem $daily -File | Where-Object { $_.LastWriteTime -lt $cut -and $_.Name -match '^(sudarshan_|code_|metabase_)' } | Remove-Item -Force
  Get-ChildItem $daily -File -Filter '*.partial' | Where-Object { $_.LastWriteTime -lt $started.AddHours(-6) } | Remove-Item -Force
  $mcut = $started.AddMonths(-$KeepMonths)
  Get-ChildItem $monthly -File | Where-Object { $_.LastWriteTime -lt $mcut } | Remove-Item -Force

  $details = '{"entries":' + $entries + ',"code_bundle":' + ($codeOk.ToString().ToLower()) + ',"metabase":' + ($mbOk.ToString().ToLower()) +
             ',"fundus_photos":' + $(if ($null -eq $photosOk) { 'null' } else { $photosOk.ToString().ToLower() }) +
             ',"oct_scans":' + $(if ($null -eq $octOk) { 'null' } else { $octOk.ToString().ToLower() }) + ',"counts":' + ($counts -join '') + '}'
  Record 'ok' $dump $bytes $details '' $started
  Log ("backup finished in {0:N0} s" -f ((Get-Date) - $started).TotalSeconds)
  exit 0
} catch {
  $msg = $_.Exception.Message
  Log "BACKUP FAILED: $msg"
  if (Test-Path "$dump.partial") { Remove-Item -Force "$dump.partial" -ErrorAction SilentlyContinue }
  Record 'failed' '' 0 '' $msg $started
  exit 1
}
