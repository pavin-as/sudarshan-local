<#
  Installs the scheduled task "Sudarshan refresh from Google" (trial, D-025): every 15 minutes 07:00-21:00, and 23:30.
  Run once, in an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-refresh.ps1
  Remove at cut-over (it also stops by itself once trial.google_master is false):
    Unregister-ScheduledTask -TaskName 'Sudarshan refresh from Google' -Confirm:$false
#>
param([string]$App = 'D:\Sudarshan\app')
$ErrorActionPreference = 'Stop'
$name = 'Sudarshan refresh from Google'
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$App\scripts\refresh-from-google.ps1`"" -WorkingDirectory $App
$day = New-ScheduledTaskTrigger -Daily -At 7:00am
$day.Repetition = (New-ScheduledTaskTrigger -Once -At 7:00am -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 14)).Repetition
$night = New-ScheduledTaskTrigger -Daily -At 11:30pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
# runs as this Windows account whether or not it is logged in (S4U: no password stored); it only needs local files and the internet
# the account's real name (SHICHIKA\Admin): $env:USERDOMAIN says WORKGROUP on this machine, which Windows cannot map
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($day, $night) -Settings $settings -Principal $principal | Out-Null
Write-Host "$name registered; first run now..."
Start-ScheduledTask -TaskName $name
Start-Sleep 5
while ((Get-ScheduledTask -TaskName $name).State -eq 'Running') { Start-Sleep 3 }
Write-Host "result: $((Get-ScheduledTaskInfo -TaskName $name).LastTaskResult) (0 = ok)"
Get-Content "$App\logs\import.log" -Tail 2
