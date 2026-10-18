#Requires -RunAsAdministrator
<#
  Apply the latest Sudarshan changes on shichika (safe to run any time):
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1 -Message "what changed"
  1 database migrations + views   2 restart the Yarago sync service (loads new code)
  3 rebuild + restart the API server (if installed)   4 quick check of the views   5 git commit
#>
param([string]$Message = 'Update')
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$py  = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
Set-Location $App
Write-Host "`n=== 1. Migrations and views ===" -ForegroundColor Cyan
& $py scripts\migrate.py; if ($LASTEXITCODE) { throw 'migrate failed' }
Write-Host "`n=== 2. Restart sync service ===" -ForegroundColor Cyan
if (Get-Service SudarshanYaragoSync -ErrorAction SilentlyContinue) { Restart-Service SudarshanYaragoSync; Start-Sleep 3; (Get-Service SudarshanYaragoSync).Status }
Write-Host "`n=== 3. API server ===" -ForegroundColor Cyan
if (Get-Service SudarshanServer -ErrorAction SilentlyContinue) {
  Set-Location "$App\server"
  $ErrorActionPreference = 'Continue'
  & npm ci --no-audit --no-fund 2>&1 | Select-Object -Last 2
  & npm run build 2>&1 | Select-Object -Last 3
  $built = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = 'Stop'
  Set-Location $App
  if (-not $built) { throw 'server build failed - the running server was left as it was' }
  Restart-Service SudarshanServer; Start-Sleep 4; (Get-Service SudarshanServer).Status
} else { Write-Host '  not installed yet (scripts\install-server.ps1)' }
Write-Host "`n=== 4. View check ===" -ForegroundColor Cyan
& $py scripts\check_views.py
Write-Host "`n=== 5. Git ===" -ForegroundColor Cyan
git add -A
if (git status --porcelain) { git commit -q -m $Message; Write-Host '  git commit created' } else { Write-Host '  nothing to commit' }
