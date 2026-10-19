#Requires -RunAsAdministrator
<#
  Builds the Sudarshan API server and runs it as a Windows service that starts with shichika.
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-server.ps1
  Service name: SudarshanServer   (runs: node server\dist\index.js)   Port: 8484 (SERVER_PORT in .env)
  Logs: D:\Sudarshan\app\logs\server-out.log / server-err.log
  Safe to run again after code changes (rebuilds and restarts).
#>
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$py  = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
$svc = 'SudarshanServer'
$port = 8484
$envLine = Get-Content "$App\.env" -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*SERVER_PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($envLine -and $envLine -match '(\d+)\s*$') { $port = [int]$Matches[1] }

Write-Host "`n=== 1. Node.js ===" -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js not found. Install Node.js 24 LTS (winget install OpenJS.NodeJS.LTS) and open a new window.' }
$ver = (& $node -v).TrimStart('v'); Write-Host "  node $ver at $node"
if ([int]($ver.Split('.')[0]) -lt 22) { throw "Node.js $ver is too old; need 22 or newer." }

Write-Host "`n=== 2. Database migrations ===" -ForegroundColor Cyan
Set-Location $App
& $py scripts\migrate.py; if ($LASTEXITCODE) { throw 'migrate failed' }

Write-Host "`n=== 3. Install packages and build ===" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'          # npm writes progress to stderr
foreach ($part in 'server', 'web') {
  Write-Host "  $part"
  Set-Location "$App\$part"
  & npm ci --no-audit --no-fund 2>&1 | Select-Object -Last 2
  if ($LASTEXITCODE) { throw "npm ci failed in $part" }
  & npm run build 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE) { throw "build failed in $part" }
}
$ErrorActionPreference = 'Stop'
Set-Location "$App\server"

Write-Host "`n=== 4. Windows service ===" -ForegroundColor Cyan
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw 'NSSM not found (it was installed with the sync service). Open a new PowerShell window and retry.' }
if (Get-Service $svc -ErrorAction SilentlyContinue) {
  & $nssm stop $svc | Out-Null
} else {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy) { throw "Port $port is already used by process $($busy[0].OwningProcess). Set SERVER_PORT=<free port> in .env and run again." }
  & $nssm install $svc $node "dist\index.js"
}
& $nssm set $svc Application $node | Out-Null
& $nssm set $svc AppParameters "dist\index.js" | Out-Null
& $nssm set $svc AppDirectory "$App\server" | Out-Null
& $nssm set $svc DisplayName 'Sudarshan - API server' | Out-Null
& $nssm set $svc Description 'Sudarshan appointment system web/API server (clinic LAN only).' | Out-Null
& $nssm set $svc Start SERVICE_DELAYED_AUTO_START | Out-Null
& $nssm set $svc DependOnService postgresql-16 | Out-Null
& $nssm set $svc AppEnvironmentExtra NODE_ENV=production | Out-Null
& $nssm set $svc AppStdout "$App\logs\server-out.log" | Out-Null
& $nssm set $svc AppStderr "$App\logs\server-err.log" | Out-Null
& $nssm set $svc AppRotateFiles 1 | Out-Null
& $nssm set $svc AppRotateBytes 5000000 | Out-Null
& $nssm set $svc AppExit Default Restart | Out-Null
& $nssm set $svc AppRestartDelay 10000 | Out-Null
& $nssm start $svc | Out-Null

Write-Host "`n=== 5. Firewall: clinic network only ===" -ForegroundColor Cyan
$rule = 'Sudarshan server (LAN)'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
Write-Host "  port $port open to the local subnet only"

Write-Host "`n=== 6. Health check ===" -ForegroundColor Cyan
$ok = $false
foreach ($i in 1..15) {
  Start-Sleep 2
  try { $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 5; $ok = $true; break } catch {}
}
if (-not $ok) { Get-Content "$App\logs\server-err.log" -Tail 20 -ErrorAction SilentlyContinue; throw 'Server did not answer. Last error lines are above.' }
Write-Host "  server answering on http://shichika:$port  (database time $($h.dbTime), last Yarago sync $($h.lastTableSync))"

Write-Host "`n=== 7. Check every screen's query against real data (read only) ===" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
& npx tsx test\real-data.ts 2>&1
$ErrorActionPreference = 'Stop'

Write-Host "`n=== 8. Git ===" -ForegroundColor Cyan
Set-Location $App
git add -A
if (git status --porcelain) { git commit -q -m 'Sudarshan server and web app'; Write-Host '  git commit created' } else { Write-Host '  nothing to commit' }

Write-Host "`n=== 9. Your login ===" -ForegroundColor Cyan
Set-Location "$App\server"
& $node dist\cli.js list-users
$u = Read-Host "Type your username from the list for a one-time password (or press Enter to skip)"
if ($u.Trim()) { & $node dist\cli.js temp-password $u.Trim() }
Write-Host "Open http://shichika:$port (or http://localhost:$port on this computer) and log in." -ForegroundColor Yellow
