<#
  The isolated TEST database on shichika (Pavin, 26 Oct 2026; CLAUDE.md, TESTING.md 1): PostgreSQL 16 in Docker on
  127.0.0.1:55432, synthetic data only, never the clinic's database. Its passwords and the tests' env file live in
  D:\Sudarshan\testdb (outside git).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\testdb.ps1 up      start it and apply every migration and view
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\testdb.ps1 down    stop it (data kept for next time)
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\testdb.ps1 reset   remove its data and start again empty
  Then run a test with:  $env:SUDARSHAN_ENV = 'D:\Sudarshan\testdb\test.env'; cd server; npx tsx test/<name>.test.ts
#>
param([ValidateSet('up', 'down', 'reset')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'
$App = Split-Path $PSScriptRoot -Parent
$Dir = 'D:\Sudarshan\testdb'
$Compose = Join-Path $App 'server\test\db\docker-compose.yml'
$Secret = Join-Path $Dir 'pg_superuser.secret'
$EnvFile = Join-Path $Dir 'test.env'
$Container = 'sudarshan-testdb'

function NewSecret { -join ((1..32) | ForEach-Object { [char](Get-Random -InputObject ([int[]](48..57 + 65..90 + 97..122))) }) }
function Dc { & docker compose -f $Compose @args; if ($LASTEXITCODE) { throw "docker compose $args failed" } }
function Psql([string]$user, [string]$pw, [string]$db, [string[]]$more, [switch]$Lenient) {
  if ($Lenient) {   # Windows PowerShell turns a native program's error output into a stopping error under 'Stop'
    $ErrorActionPreference = 'Continue'
    & docker exec -e "PGPASSWORD=$pw" -e "PGOPTIONS=-c client_min_messages=warning" $Container psql -q -U $user -d $db @more 2>&1 | Out-Null; return
  }
  & docker exec -e "PGPASSWORD=$pw" -e "PGOPTIONS=-c client_min_messages=warning" $Container psql -v ON_ERROR_STOP=1 -q -U $user -d $db @more
  if ($LASTEXITCODE) { throw "psql failed ($db)" }
}

New-Item -ItemType Directory -Force $Dir | Out-Null
$env:TESTDB_SECRET_FILE = $Secret
if (-not (Test-Path $Secret)) { [IO.File]::WriteAllText($Secret, (NewSecret)) }
$super = (Get-Content $Secret -Raw).Trim()

if ($Action -eq 'down') { Dc stop; 'Test database stopped (data kept).'; return }
if ($Action -eq 'reset') { Dc down -v; 'Test database removed.' }

if (-not (Test-Path $EnvFile)) {
  $newAppSecret = NewSecret          # not $app: PowerShell names ignore case, and $App is the app folder
  @(
    '# TEST database only (scripts\testdb.ps1): Docker on 127.0.0.1:55432, synthetic data. Never the clinic database.',
    'PG_HOST=127.0.0.1', 'PG_PORT=55432', 'PG_DB=sudarshan_test', 'PG_APP_USER=sudarshan_app', "PG_APP_PASSWORD=$newAppSecret",
    'SERVER_PORT=8585', 'COOKIE_SECURE=false', 'SESSION_HOURS=12', "RETINA_PHOTO_DIR=$Dir\fundus"
  ) | Set-Content -Encoding ascii $EnvFile
}
$appPw = ((Get-Content $EnvFile | Where-Object { $_ -like 'PG_APP_PASSWORD=*' }) -replace '^PG_APP_PASSWORD=', '').Trim()

Dc up -d
$ready = $false
foreach ($i in 1..60) { & docker exec $Container pg_isready -q -U postgres 2>$null; if ($LASTEXITCODE -eq 0) { $ready = $true; break }; Start-Sleep 1 }
if (-not $ready) { throw 'The test database did not start within 60 s' }

$exists = & docker exec -e "PGPASSWORD=$super" $Container psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'sudarshan_test'"
if ($exists -ne '1') {
  Psql postgres $super postgres @('-c', "CREATE ROLE sudarshan_app LOGIN PASSWORD '$appPw'", '-c', 'CREATE DATABASE sudarshan_test OWNER sudarshan_app')
  'Made database sudarshan_test.'
}

# the empty Yarago stand-in, then every migration and view in name order (all idempotent), as the app's own login
& docker exec $Container rm -rf /tmp/sql | Out-Null
& docker exec $Container mkdir -p /tmp/sql | Out-Null
& docker cp (Join-Path $App 'db\migrations') "${Container}:/tmp/sql/migrations" | Out-Null
& docker cp (Join-Path $App 'db\views') "${Container}:/tmp/sql/views" | Out-Null
& docker cp (Join-Path $App 'server\test\yarago_stub.sql') "${Container}:/tmp/sql/yarago_stub.sql" | Out-Null
Psql sudarshan_app $appPw sudarshan_test @('-f', '/tmp/sql/yarago_stub.sql')
# A fresh database needs some views before some migrations (0006 reads clinical views), so the first pass is lenient
# and the second must run without a single error.
$n = 0
foreach ($strict in $false, $true) {
  foreach ($folder in 'migrations', 'views') {
    foreach ($f in Get-ChildItem (Join-Path $App "db\$folder") -Filter *.sql | Sort-Object Name) {
      Psql sudarshan_app $appPw sudarshan_test @('-f', "/tmp/sql/$folder/$($f.Name)") -Lenient:(-not $strict)
      if ($strict) { $n++ }
    }
  }
}
"Test database ready on 127.0.0.1:55432 ($n migration and view files applied). Env file: $EnvFile"
