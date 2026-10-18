#Requires -RunAsAdministrator
<#
  Sudarshan Phase A setup for shichika. Safe to re-run.
  Run in an Administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\phaseA-setup.ps1
  Does:  1 .env with generated passwords   2 MySQL read-only user sudarshan_ro
         3 PostgreSQL 16 (localhost only, data on D:)   4 Node.js 24 LTS, Git, Python packages
         5 legacy code snapshot + git repo
  Log:   D:\Sudarshan\setup\phaseA-setup.log  (no passwords are written to it)
#>
$ErrorActionPreference = 'Stop'
$App    = 'D:\Sudarshan\app'
$LogDir = 'D:\Sudarshan\setup'
New-Item -ItemType Directory -Force $App, $LogDir | Out-Null
Start-Transcript -Path "$LogDir\phaseA-setup.log" -Append | Out-Null

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function NewPw([int]$n = 24) {
  $c = [char[]]((48..57) + (65..90) + (97..122))
  -join (1..$n | ForEach-Object { $c | Get-Random })
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
$results = [ordered]@{}

# ---------------------------------------------------------------- 1. .env
Step '1. Secrets file (.env)'
$envFile = Join-Path $App '.env'
$cfg = [ordered]@{}
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $cfg[$matches[1]] = $matches[2] }
}
foreach ($k in 'YARAGO_RO_PASSWORD', 'PG_SUPERUSER_PASSWORD', 'PG_APP_PASSWORD') { if (-not $cfg[$k]) { $cfg[$k] = NewPw } }
$cfg['YARAGO_HOST'] = '127.0.0.1'; $cfg['YARAGO_PORT'] = '3306'; $cfg['YARAGO_DB'] = 'yghealthcarecombined'; $cfg['YARAGO_RO_USER'] = 'sudarshan_ro'
$cfg['PG_HOST'] = '127.0.0.1'; $cfg['PG_PORT'] = '5432'; $cfg['PG_DB'] = 'sudarshan'; $cfg['PG_APP_USER'] = 'sudarshan_app'
$cfg.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -Encoding ascii $envFile
icacls $envFile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" "$($env:USERNAME):F" | Out-Null
Ok "$envFile written (administrators only)"
$results['.env'] = 'ok'

# ---------------------------------------------------------------- 2. MySQL read-only user
Step '2. Yarago MySQL read-only user (sudarshan_ro)'
$mysql = 'C:\Program Files\MySQL\MySQL Server 5.6\bin\mysql.exe'
if (-not (Test-Path $mysql)) { throw "mysql.exe not found at $mysql" }
$rootSec = Read-Host 'Enter the Yarago MySQL root password' -AsSecureString
$env:MYSQL_PWD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($rootSec))
$ro = $cfg['YARAGO_RO_PASSWORD']
$sql = ''
foreach ($h in 'localhost', '127.0.0.1') {
  $n = & $mysql -u root -N -e "SELECT COUNT(*) FROM mysql.user WHERE user='sudarshan_ro' AND host='$h'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not log in to MySQL as root (wrong password?)' }
  if ([int]$n -gt 0) { $sql += "SET PASSWORD FOR 'sudarshan_ro'@'$h' = PASSWORD('$ro');`n" }
  else               { $sql += "CREATE USER 'sudarshan_ro'@'$h' IDENTIFIED BY '$ro';`n" }
  $sql += "GRANT SELECT, SHOW VIEW ON yghealthcarecombined.* TO 'sudarshan_ro'@'$h';`n"
}
$sql += "FLUSH PRIVILEGES;`n"
$sql | & $mysql -u root
if ($LASTEXITCODE -ne 0) { throw 'Creating sudarshan_ro failed' }
$bind = & $mysql -u root -N -e "SHOW VARIABLES LIKE 'bind_address'"
$env:MYSQL_PWD = $ro
$cnt = & $mysql -u sudarshan_ro -h 127.0.0.1 -N -e "SELECT COUNT(*) FROM yghealthcarecombined.tblpatientregistration"
if ($LASTEXITCODE -ne 0) { throw 'sudarshan_ro cannot read Yarago' }
$ErrorActionPreference = 'Continue'
$deny = & $mysql -u sudarshan_ro -h 127.0.0.1 -N -e "CREATE TABLE yghealthcarecombined.zz_sudarshan_write_test (x int)" 2>&1
$ErrorActionPreference = 'Stop'
Remove-Item Env:\MYSQL_PWD
Ok "sudarshan_ro reads Yarago: $cnt patients"
if ("$deny" -match 'denied') { Ok 'sudarshan_ro is blocked from writing (as intended)' } else { Warn "Write test did not fail as expected: $deny" }
Write-Host "  MySQL bind_address: $bind"
$listen = netstat -ano | Select-String ':3306\s+\S+\s+LISTENING'
Write-Host "  Port 3306 listening on: $($listen -join '; ')"
if ("$listen" -match '0\.0\.0\.0:3306|\[::\]:3306') { Warn 'MySQL accepts LAN connections. Left unchanged (other Yarago PCs may use it); review later.' }
$results['mysql_ro'] = "ok ($cnt patients readable)"

# ---------------------------------------------------------------- 3. PostgreSQL 16
Step '3. PostgreSQL 16'
$pgBin  = 'C:\Program Files\PostgreSQL\16\bin'
$pgData = 'D:\PostgreSQL\16\data'
if (-not (Test-Path "$pgBin\psql.exe")) {
  New-Item -ItemType Directory -Force (Split-Path $pgData) | Out-Null
  $ov = "--mode unattended --unattendedmodeui none --superpassword $($cfg['PG_SUPERUSER_PASSWORD']) --serverport 5432 --servicename postgresql-16 --datadir $pgData --disable-components pgAdmin,stackbuilder"
  winget install -e --id PostgreSQL.PostgreSQL.16 --override $ov --accept-package-agreements --accept-source-agreements
  if (-not (Test-Path "$pgBin\psql.exe")) { throw 'PostgreSQL install did not complete. Install it from https://www.enterprisedb.com/downloads/postgres-postgresql-downloads (version 16, Windows x86-64), data folder D:\PostgreSQL\16\data, then re-run this script.' }
  Ok 'PostgreSQL 16 installed'
} else { Ok 'PostgreSQL 16 already installed' }
$psql = "$pgBin\psql.exe"
$env:PGPASSWORD = $cfg['PG_SUPERUSER_PASSWORD']
$settings = @(
  "ALTER SYSTEM SET listen_addresses = 'localhost'",
  "ALTER SYSTEM SET shared_buffers = '1GB'",
  "ALTER SYSTEM SET effective_cache_size = '3GB'",
  "ALTER SYSTEM SET work_mem = '16MB'",
  "ALTER SYSTEM SET maintenance_work_mem = '256MB'",
  "ALTER SYSTEM SET max_connections = '50'",
  "ALTER SYSTEM SET timezone = 'Asia/Kolkata'"
)
foreach ($s in $settings) { & $psql -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -q -c $s; if ($LASTEXITCODE -ne 0) { throw "PostgreSQL setting failed: $s" } }
Restart-Service postgresql-16
Start-Sleep -Seconds 5
$roleSql = @'
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sudarshan_app') THEN
    CREATE ROLE sudarshan_app LOGIN PASSWORD '__PW__';
  ELSE
    ALTER ROLE sudarshan_app LOGIN PASSWORD '__PW__';
  END IF;
END $do$;
'@ -replace '__PW__', $cfg['PG_APP_PASSWORD']
$tmp = New-TemporaryFile
Set-Content -Path $tmp -Value $roleSql -Encoding ascii
& $psql -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -q -f $tmp
Remove-Item $tmp
if ($LASTEXITCODE -ne 0) { throw 'Creating role sudarshan_app failed' }
$hasDb = & $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_database WHERE datname = 'sudarshan'"
if ("$hasDb".Trim() -ne '1') {
  & $psql -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE sudarshan OWNER sudarshan_app ENCODING 'UTF8' TEMPLATE template0"
  if ($LASTEXITCODE -ne 0) { throw 'Creating database sudarshan failed' }
}
$env:PGPASSWORD = $cfg['PG_APP_PASSWORD']
Get-ChildItem "$App\db\migrations\*.sql" | Sort-Object Name | ForEach-Object {
  & $psql -U sudarshan_app -h 127.0.0.1 -d sudarshan -v ON_ERROR_STOP=1 -q -f $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
  Ok "migration $($_.Name)"
}
$schemas = & $psql -U sudarshan_app -h 127.0.0.1 -d sudarshan -tAc "SELECT string_agg(schema_name, ', ' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('yarago','yarago_staging','clinical','app')"
$pgver = & $psql -U sudarshan_app -h 127.0.0.1 -d sudarshan -tAc "SHOW server_version"
Remove-Item Env:\PGPASSWORD
Ok "PostgreSQL $pgver, database sudarshan, schemas: $schemas"
$results['postgres'] = "ok ($pgver)"

# ---------------------------------------------------------------- 4. Node.js 24 LTS, Git, Python packages
Step '4. Node.js 24 LTS, Git, Python packages'
RefreshPath
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeOk = ((node --version) -match '^v2[4-9]\.') }
if (-not $nodeOk) { winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements; RefreshPath }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements; RefreshPath }
$py = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
& $py -m pip install --quiet --upgrade -r "$App\sync\requirements.txt"
Ok "node $(node --version), npm $(npm --version), $(git --version), $(& $py --version)"
$results['tools'] = "node $(node --version)"

# ---------------------------------------------------------------- 5. legacy snapshot + git
Step '5. Legacy snapshot and git repository'
robocopy 'E:\sudarshanOngoingOld' "$App\legacy\sudarshan" /E /XD .opencode .swarm node_modules /XF '._*' /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
$global:LASTEXITCODE = 0
$files = (Get-ChildItem "$App\legacy\sudarshan" -Recurse -File).Count
Ok "legacy/sudarshan: $files files"
git config --global --add safe.directory D:/Sudarshan/app
Push-Location $App
if (-not (Test-Path '.git')) {
  git init -b main | Out-Null
  git config user.name 'Pavin'
  git config user.email 'admin@gs.sampadavr.com'
}
git add -A
if (git status --porcelain) { git commit -q -m 'Phase A: project scaffold and legacy Sudarshan snapshot'; Ok 'git commit created' } else { Ok 'nothing new to commit' }
$tracked = git ls-files | Select-String -Pattern '(^|/)\.env$'
if ($tracked) { Warn '.env is tracked by git - remove it!' } else { Ok '.env is not tracked by git' }
Pop-Location
$results['repo'] = "ok ($files legacy files)"

Step 'Summary'
$results.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-10} {1}" -f $_.Key, $_.Value) }
Stop-Transcript | Out-Null
