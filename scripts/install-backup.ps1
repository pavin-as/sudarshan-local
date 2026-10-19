#Requires -RunAsAdministrator
<#
  Sets up Sudarshan's nightly backup to the QNAP (run once; safe to run again):
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-backup.ps1
  Optional: -Target <folder>   (default F:\SUDARSHAN_BACKUP, next to EMR_AUTO_BACKUP)

  1. works out whether F: is a network share or a disk (the task needs to reach it at 02:00 with nobody logged in)
  2. creates the folder and saves BACKUP_DIR in .env
  3. applies migration 0005 (table app.backup_runs)
  4. scheduled tasks: "Sudarshan backup" daily 02:00 (after the 01:00 Yarago full copy),
                      "Sudarshan restore test" every 4 weeks, Sunday 03:00
  5. runs a backup and a restore test now, through the task, to prove it works unattended
#>
param([string]$Target = 'F:\SUDARSHAN_BACKUP')
$ErrorActionPreference = 'Stop'
$App = 'D:\Sudarshan\app'
$py  = 'C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe'
$pgBin = 'C:\Program Files\PostgreSQL\16\bin'
if (-not (Test-Path "$pgBin\pg_dump.exe")) { throw "pg_dump not found in $pgBin" }

Write-Host "`n=== 1. Where the backups go ===" -ForegroundColor Cyan
$runAsSystem = $true
$drive = (Split-Path -Qualifier $Target -ErrorAction SilentlyContinue)
if ($drive) {
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'" -ErrorAction SilentlyContinue
  $unc = $null
  if ($disk -and $disk.DriveType -eq 4) { $unc = $disk.ProviderName }
  elseif (-not $disk) {
    # mapped drives made in a normal window are invisible to an administrator window; read the mapping instead
    $reg = Get-ItemProperty "HKCU:\Network\$($drive.TrimEnd(':'))" -ErrorAction SilentlyContinue
    if ($reg) { $unc = $reg.RemotePath }
    else { throw "$drive is not visible. Map the QNAP share as $drive (reconnect at sign-in) or pass -Target \\QNAP\share\SUDARSHAN_BACKUP" }
  }
  if ($unc) {
    $Target = $Target -replace "^$([regex]::Escape($drive))", $unc
    $runAsSystem = $false
    Write-Host "  $drive is the network share $unc; the task will use $Target"
  } else {
    Write-Host "  $drive is a disk on this computer (e.g. the QNAP over iSCSI); the task can run as SYSTEM"
  }
} else { $runAsSystem = $false }   # UNC path given

New-Item -ItemType Directory -Force -Path $Target | Out-Null
"write test" | Set-Content "$Target\.write_test"; Remove-Item "$Target\.write_test"
Write-Host "  folder ready: $Target"

# save BACKUP_DIR in .env (replace the line if it exists)
$envFile = "$App\.env"
$lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*BACKUP_DIR\s*=' })
$lines += "BACKUP_DIR=$Target"
Set-Content -Path $envFile -Value $lines -Encoding ASCII
Write-Host "  BACKUP_DIR saved in .env"
if ($runAsSystem) { icacls $envFile /grant "SYSTEM:R" | Out-Null }   # the task reads .env as SYSTEM

Write-Host "`n=== 2. Database table for backup records ===" -ForegroundColor Cyan
Set-Location $App
& $py scripts\migrate.py | Select-String '0005|views' ; if ($LASTEXITCODE) { throw 'migrate failed' }

Write-Host "`n=== 3. Scheduled tasks ===" -ForegroundColor Cyan
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$tasks = @(
  @{ Name = 'Sudarshan backup';       Script = 'backup.ps1';       Trigger = New-ScheduledTaskTrigger -Daily -At 2:00am },
  @{ Name = 'Sudarshan restore test'; Script = 'restore-test.ps1'; Trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At 3:00am }
)
$cred = $null
if (-not $runAsSystem) {
  Write-Host "  The QNAP share needs your Windows login to reach it at night. Enter the password for $env:USERDOMAIN\$env:USERNAME"
  Write-Host "  (it goes to Windows Task Scheduler only; it is not saved by Sudarshan)."
  $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the backup task'
}
foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$App\scripts\$($t.Script)`"" -WorkingDirectory $App
  Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
  if ($runAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $t.Trigger -Settings $settings -Principal $principal | Out-Null
  } else {
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $t.Trigger -Settings $settings -RunLevel Highest `
      -User $cred.UserName -Password $cred.GetNetworkCredential().Password | Out-Null
  }
  Write-Host "  $($t.Name): registered"
}

Write-Host "`n=== 4. First backup and restore test (through the tasks, as they will run at night) ===" -ForegroundColor Cyan
function RunTask([string]$name) {
  Start-ScheduledTask -TaskName $name
  Start-Sleep 3
  while ((Get-ScheduledTask -TaskName $name).State -eq 'Running') { Start-Sleep 3 }
  return (Get-ScheduledTaskInfo -TaskName $name).LastTaskResult
}
$r1 = RunTask 'Sudarshan backup'
$r2 = if ($r1 -eq 0) { RunTask 'Sudarshan restore test' } else { -1 }
Get-Content "$App\logs\backup.log" -Tail 10
if ($r1 -ne 0) {
  Write-Host "`nThe backup task failed (result $r1). If the log says the folder is not reachable, Windows has no saved login for the QNAP:" -ForegroundColor Yellow
  Write-Host "  cmdkey /add:<QNAP name or IP> /user:<QNAP user> /pass        (then run this script again)"
} elseif ($r2 -ne 0) { Write-Host "`nBackup worked but the restore test failed (result $r2); see the log above." -ForegroundColor Yellow }
else { Write-Host "`nBackup and restore test both worked." -ForegroundColor Green }
Get-ChildItem "$Target\daily" | Sort-Object LastWriteTime -Descending | Select-Object -First 4 Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime | Format-Table -AutoSize

Write-Host "`n=== 5. Git ===" -ForegroundColor Cyan
git add -A
if (git status --porcelain) { git commit -q -m 'Nightly backup to QNAP with monthly restore test'; Write-Host '  git commit created' } else { Write-Host '  nothing to commit' }
