#Requires -RunAsAdministrator
<#
  First Yarago -> PostgreSQL sync. Run in an Administrator PowerShell, outside clinic hours:
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\sync-first-run.ps1
  1 applies database migrations  2 full copy of all Yarago tables (about 10-20 min)
  3 one incremental cycle  4 row-count check of the hot tables  5 git commit
  Log: D:\Sudarshan\app\logs\yarago_sync.log
#>
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$py  = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
Set-Location $App
Write-Host "`n=== 1. Migrations ===" -ForegroundColor Cyan
& $py scripts\migrate.py;                      if ($LASTEXITCODE) { throw 'migrations failed' }
Write-Host "`n=== 2. Full copy (10-20 min) ===" -ForegroundColor Cyan
& $py sync\yarago_sync.py full --force;        if ($LASTEXITCODE) { throw 'full copy failed - see logs\yarago_sync.log' }
Write-Host "`n=== 3. Incremental cycle ===" -ForegroundColor Cyan
& $py sync\yarago_sync.py incremental;         if ($LASTEXITCODE) { throw 'incremental failed' }
Write-Host "`n=== 4. Row counts (hot tables) ===" -ForegroundColor Cyan
& $py sync\yarago_sync.py verify
Write-Host "`n=== 5. Status and git ===" -ForegroundColor Cyan
& $py sync\yarago_sync.py status
git add -A
if (git status --porcelain) { git commit -q -m 'Yarago sync worker, migration 0002, migrate script'; Write-Host '  git commit created' }
