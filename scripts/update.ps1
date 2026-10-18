#Requires -RunAsAdministrator
<#
  Apply the latest Sudarshan changes on shichika (safe to run any time):
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1
  1 database migrations + views   2 restart the Yarago sync service (loads new code)
  3 quick check of the views      4 git commit of everything new
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
Write-Host "`n=== 3. View check ===" -ForegroundColor Cyan
& $py scripts\check_views.py
Write-Host "`n=== 4. Git ===" -ForegroundColor Cyan
git add -A
if (git status --porcelain) { git commit -q -m $Message; Write-Host '  git commit created' } else { Write-Host '  nothing to commit' }
