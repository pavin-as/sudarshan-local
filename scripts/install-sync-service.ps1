#Requires -RunAsAdministrator
<#
  Installs the Yarago sync worker as a Windows service that starts with shichika.
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-sync-service.ps1
  Service name: SudarshanYaragoSync  (runs: python sync\yarago_sync.py service)
  Waits for MySQL56 and postgresql-16; restarts itself 30 s after any crash.
  Logs: D:\Sudarshan\app\logs\yarago_sync.log (+ service-out.log / service-err.log)
  Remove later with:  nssm remove SudarshanYaragoSync confirm
#>
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$py  = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
$svc = 'SudarshanYaragoSync'
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  winget install -e --id NSSM.NSSM --accept-package-agreements --accept-source-agreements
  RefreshPath
}
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw 'NSSM not found after install. Open a new PowerShell window and run this script again.' }

if (Get-Service $svc -ErrorAction SilentlyContinue) {
  & $nssm stop $svc | Out-Null
  & $nssm remove $svc confirm | Out-Null
}
& $nssm install $svc $py "sync\yarago_sync.py service"
& $nssm set $svc AppDirectory $App
& $nssm set $svc DisplayName 'Sudarshan - Yarago sync'
& $nssm set $svc Description 'Mirrors the Yarago EMR (read-only) into PostgreSQL for Sudarshan. Incremental every 150 s, full copy at 01:00.'
& $nssm set $svc Start SERVICE_DELAYED_AUTO_START
& $nssm set $svc DependOnService MySQL56 postgresql-16
& $nssm set $svc AppStdout "$App\logs\service-out.log"
& $nssm set $svc AppStderr "$App\logs\service-err.log"
& $nssm set $svc AppRotateFiles 1
& $nssm set $svc AppRotateBytes 5000000
& $nssm set $svc AppExit Default Restart
& $nssm set $svc AppRestartDelay 30000
& $nssm set $svc AppPriority BELOW_NORMAL_PRIORITY_CLASS
& $nssm start $svc
Start-Sleep -Seconds 20
Get-Service $svc | Format-Table Name, Status, StartType -AutoSize
Write-Host "Last log lines:"
Get-Content "$App\logs\yarago_sync.log" -Tail 8

Set-Location $App
git add -A
if (git status --porcelain) { git commit -q -m 'Sync: guard against unreliable modified columns; Windows service installer'; Write-Host 'git commit created' }
