#Requires -RunAsAdministrator
<#
  Installs Metabase (management dashboards, D-020) on shichika as a Windows service, clinic network only.
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-metabase.ps1
  Safe to run again (keeps passwords, data and dashboards; re-applies settings).

  What it does:
   1. Missing secrets are generated into .env (never printed): BI_PG_PASSWORD (login sudarshan_bi),
      METABASE_PG_PASSWORD (Metabase's own settings database), METABASE_ENCRYPTION_KEY, METABASE_ADMIN_PASSWORD.
   2. PostgreSQL: login sudarshan_bi can read the analytics schema and nothing else (checked);
      database "metabase" (owner metabase) holds Metabase's own settings, dashboards and users.
   3. Downloads a Java 21 runtime and Metabase (versions and SHA-256 pinned below) to D:\Sudarshan\metabase.
   4. Service SudarshanMetabase: java -jar metabase.jar on port 3000, 1 GB memory, starts after PostgreSQL.
   5. Firewall: port 3000 open to the local subnet only.
   6. scripts\metabase_setup.py: admin login, the analytics connection, mail, collections, questions, dashboards.
  Logs: D:\Sudarshan\app\logs\metabase-out.log / metabase-err.log
#>
$ErrorActionPreference = 'Stop'
$App   = 'D:\Sudarshan\app'
$Home_ = 'D:\Sudarshan\metabase'
$py    = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
$PgBin = 'C:\Program Files\PostgreSQL\16\bin'
$svc   = 'SudarshanMetabase'
$port  = 3000

# Pinned downloads. Metabase publishes no checksum: the SHA-256 below was recorded at the first download (19 Oct 2026).
$MbVersion = 'v0.63.19'
$MbUrl     = 'https://downloads.metabase.com/v0.63.19.x/metabase.jar'
$MbSha     = '9b113a52142b9b27f53c288624acfd8108996e65acd386b79fa5aa28b4b502fa'
$JreUrl    = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip'
$JreSha    = 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636'

function Read-Env { $c = @{}; foreach ($l in (Get-Content "$App\.env")) { if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $c[$Matches[1]] = $Matches[2].Trim().Trim('"') } }; $c }
function New-Secret([int]$n = 32) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $bytes = New-Object byte[] $n; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
function Sha256([string]$f) { (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower() }

Write-Host "`n=== 1. Secrets in .env ===" -ForegroundColor Cyan
$cfg = Read-Env
foreach ($k in 'BI_PG_PASSWORD', 'METABASE_PG_PASSWORD', 'METABASE_ENCRYPTION_KEY', 'METABASE_ADMIN_PASSWORD') {
  if (-not $cfg[$k]) { Add-Content -Path "$App\.env" -Value "$k=$(New-Secret)" -Encoding ascii; Write-Host "  $k generated" }
  else { Write-Host "  $k kept" }
}
$cfg = Read-Env

Write-Host "`n=== 2. PostgreSQL logins and database ===" -ForegroundColor Cyan
$psql = Join-Path $PgBin 'psql.exe'
$env:PGHOST = '127.0.0.1'; $env:PGPORT = $cfg['PG_PORT']; $env:PGUSER = 'postgres'; $env:PGPASSWORD = $cfg['PG_SUPERUSER_PASSWORD']
$db = $cfg['PG_DB']
function Lit([string]$v) { "'" + ($v -replace "'", "''") + "'" }
# statements go through stdin so no password appears on a command line
$sqlRoles = @"
SELECT 'CREATE ROLE sudarshan_bi LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sudarshan_bi') \gexec
ALTER ROLE sudarshan_bi WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 10 PASSWORD $(Lit $cfg['BI_PG_PASSWORD']);
ALTER ROLE sudarshan_bi SET default_transaction_read_only = on;
ALTER ROLE sudarshan_bi SET statement_timeout = '120s';
SELECT 'CREATE ROLE metabase LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase') \gexec
ALTER ROLE metabase WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD $(Lit $cfg['METABASE_PG_PASSWORD']);
SELECT 'CREATE DATABASE metabase OWNER metabase ENCODING ''UTF8''' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'metabase') \gexec
REVOKE CONNECT ON DATABASE metabase FROM PUBLIC;
GRANT CONNECT ON DATABASE metabase TO metabase;
"@
$sqlRoles | & $psql -d postgres -q -v ON_ERROR_STOP=1; if ($LASTEXITCODE) { throw 'creating logins failed' }
$sqlGrants = @"
REVOKE ALL ON SCHEMA public FROM sudarshan_bi;
GRANT CONNECT ON DATABASE $db TO sudarshan_bi;
GRANT USAGE ON SCHEMA analytics TO sudarshan_bi;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO sudarshan_bi;
ALTER DEFAULT PRIVILEGES FOR ROLE $($cfg['PG_APP_USER']) IN SCHEMA analytics GRANT SELECT ON TABLES TO sudarshan_bi;
"@
$sqlGrants | & $psql -d $db -q -v ON_ERROR_STOP=1; if ($LASTEXITCODE) { throw 'granting analytics failed' }
# prove sudarshan_bi sees analytics and nothing with patient identity
$check = "SELECT has_schema_privilege('sudarshan_bi','analytics','USAGE') AS analytics, " +
         "has_schema_privilege('sudarshan_bi','app','USAGE') OR has_schema_privilege('sudarshan_bi','yarago','USAGE') OR " +
         "has_schema_privilege('sudarshan_bi','clinical','USAGE') OR has_schema_privilege('sudarshan_bi','yarago_staging','USAGE') AS other"
$r = (& $psql -d $db -tA -F '|' -c $check).Trim()
if ($r -ne 't|f') { throw "sudarshan_bi access is not as intended (analytics|other = $r)" }
Write-Host "  sudarshan_bi: reads analytics only (checked); database metabase ready"

Write-Host "`n=== 3. Java 21 and Metabase $MbVersion ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Home_, "$Home_\plugins", "$App\logs" | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$java = Get-ChildItem "$Home_\jre" -Recurse -Filter java.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $java) {
  $zip = "$Home_\jre.zip"
  Invoke-WebRequest $JreUrl -OutFile $zip -UseBasicParsing
  if ((Sha256 $zip) -ne $JreSha) { Remove-Item $zip; throw 'Java download checksum does not match - not installed' }
  Expand-Archive $zip "$Home_\jre" -Force; Remove-Item $zip
  $java = Get-ChildItem "$Home_\jre" -Recurse -Filter java.exe | Select-Object -First 1
}
Write-Host "  java: $($java.FullName)"
$jar = "$Home_\metabase.jar"; $verFile = "$Home_\metabase.version"
$have = if (Test-Path $verFile) { (Get-Content $verFile).Trim() } else { '' }
if (-not (Test-Path $jar) -or $have -ne $MbVersion) {
  Write-Host "  downloading Metabase $MbVersion (about 660 MB)..."
  Invoke-WebRequest $MbUrl -OutFile "$jar.download" -UseBasicParsing
  $sha = Sha256 "$jar.download"
  if ($MbSha -and $sha -ne $MbSha) { Remove-Item "$jar.download"; throw "Metabase download checksum $sha does not match the pinned one - not installed" }
  if (Get-Service $svc -ErrorAction SilentlyContinue) { Stop-Service $svc }
  Move-Item -Force "$jar.download" $jar
  Set-Content $verFile $MbVersion
  Write-Host "  metabase.jar SHA-256 $sha$(if (-not $MbSha) { '  (record this in `$MbSha)' })"
} else { Write-Host "  metabase $MbVersion already present (SHA-256 $(Sha256 $jar))" }

Write-Host "`n=== 4. Windows service $svc ===" -ForegroundColor Cyan
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw 'NSSM not found (it was installed with the sync service).' }
if (Get-Service $svc -ErrorAction SilentlyContinue) { & $nssm stop $svc | Out-Null } else { & $nssm install $svc $java.FullName | Out-Null }
$jvm = "-Xmx1g -XX:+UseG1GC -Duser.timezone=Asia/Kolkata -Dfile.encoding=UTF-8 -jar `"$jar`""
& $nssm set $svc Application $java.FullName | Out-Null
& $nssm set $svc AppParameters $jvm | Out-Null
& $nssm set $svc AppDirectory $Home_ | Out-Null
& $nssm set $svc DisplayName 'Sudarshan - Metabase dashboards' | Out-Null
& $nssm set $svc Description 'Management dashboards over the analytics schema (clinic LAN only, D-020).' | Out-Null
& $nssm set $svc Start SERVICE_DELAYED_AUTO_START | Out-Null
& $nssm set $svc DependOnService postgresql-16 | Out-Null
# settings for Metabase; the service configuration is readable by administrators only, like .env
& $nssm set $svc AppEnvironmentExtra `
  "MB_DB_TYPE=postgres" "MB_DB_HOST=127.0.0.1" "MB_DB_PORT=$($cfg['PG_PORT'])" "MB_DB_DBNAME=metabase" "MB_DB_USER=metabase" `
  "MB_DB_PASS=$($cfg['METABASE_PG_PASSWORD'])" "MB_ENCRYPTION_SECRET_KEY=$($cfg['METABASE_ENCRYPTION_KEY'])" `
  "MB_JETTY_HOST=0.0.0.0" "MB_JETTY_PORT=$port" "MB_PLUGINS_DIR=$Home_\plugins" "MB_REPORT_TIMEZONE=Asia/Kolkata" `
  "MB_ANON_TRACKING_ENABLED=false" "MB_CHECK_FOR_UPDATES=false" "MB_SITE_LOCALE=en" "MB_SEND_EMAIL_ON_FIRST_LOGIN_FROM_NEW_DEVICE=false" | Out-Null
& $nssm set $svc AppStdout "$App\logs\metabase-out.log" | Out-Null
& $nssm set $svc AppStderr "$App\logs\metabase-err.log" | Out-Null
& $nssm set $svc AppRotateFiles 1 | Out-Null
& $nssm set $svc AppRotateBytes 10000000 | Out-Null
& $nssm set $svc AppExit Default Restart | Out-Null
& $nssm set $svc AppRestartDelay 30000 | Out-Null
& $nssm start $svc | Out-Null

Write-Host "`n=== 5. Firewall: clinic network only ===" -ForegroundColor Cyan
$rule = 'Sudarshan Metabase (LAN)'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
Write-Host "  port $port open to the local subnet only"

Write-Host "`n=== 6. Waiting for Metabase (first start takes a few minutes) ===" -ForegroundColor Cyan
$ok = $false
foreach ($i in 1..90) {
  Start-Sleep 5
  try { $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 5; if ($h.status -eq 'ok') { $ok = $true; break } } catch {}
}
if (-not $ok) { Get-Content "$App\logs\metabase-err.log" -Tail 30 -ErrorAction SilentlyContinue; throw 'Metabase did not become healthy. Last log lines are above.' }
Write-Host "  Metabase answering on http://shichika:$port"

Write-Host "`n=== 7. Connection, mail, dashboards ===" -ForegroundColor Cyan
Set-Location $App
& $py scripts\metabase_setup.py; if ($LASTEXITCODE) { throw 'metabase_setup.py failed' }
Write-Host "`nDone. Open http://shichika:$port - first login: admin@gs.sampadavr.com with the temporary password METABASE_ADMIN_PASSWORD in .env; change it at once." -ForegroundColor Green
