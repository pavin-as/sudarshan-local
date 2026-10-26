#Requires -RunAsAdministrator
<#
  Read-only share of the IMAGEnet data folder for shichika (D-047, docs/OCT_PLAN.md Step 1). Run it ON THE IMAGENET PC
  (192.168.0.152), in an Administrator PowerShell, after imagenet-discover.ps1 has shown the DATA FOLDER:
    powershell -ExecutionPolicy Bypass -File imagenet-share-readonly.ps1
  Makes:
    - a local account sudarshan_ro (no administrator rights, password chosen by you; Claude never sees it)
    - a hidden share SudarshanOCT$ on the data folder, READ only, for that account only
    - only if the folder does not already let ordinary signed-in accounts read it: a read-only permission entry for
      sudarshan_ro on the folder (asks first)
  Does not change, move or delete any ImageNet file, and does not touch IMAGEnet, its database or the firewall.
  A second folder (for example the Jukebox archive) gets its own share name; the account is reused:
    powershell -ExecutionPolicy Bypass -File imagenet-share-readonly.ps1 -DataFolder E:\Jukebox -Share 'SudarshanJukebox$'
  Undo (same window):
    Remove-SmbShare -Name 'SudarshanOCT$' -Force; Remove-LocalUser -Name sudarshan_ro
    icacls "<data folder>" /remove sudarshan_ro      (only if the permission entry was added)
#>
param([string]$DataFolder, [string]$Share = 'SudarshanOCT$')
$ErrorActionPreference = 'Stop'
$Account = 'sudarshan_ro'

if ((Get-NetIPAddress -AddressFamily IPv4).IPAddress -contains '192.168.0.49') {
  throw 'This is shichika. Run this on the ImageNet PC (192.168.0.152).'
}
if (Get-SmbShare -Name $Share -ErrorAction SilentlyContinue) { throw "Share $Share already exists: nothing changed." }

if (-not $DataFolder) { $DataFolder = Read-Host 'Folder to share (the path, for example D:\IMAGEnet6\Data; YES comes later)' }
$DataFolder = $DataFolder.Trim().Trim('"')
if ($DataFolder -eq 'YES') { throw 'Type the folder path first (for example D:\IMAGEnet6\Data); YES is asked afterwards.' }
if (-not (Test-Path -LiteralPath $DataFolder -PathType Container)) { throw "Folder not found: $DataFolder" }
$count = @(Get-ChildItem -LiteralPath $DataFolder -Recurse -File -Filter *.fda -ErrorAction SilentlyContinue | Select-Object -First 50).Count
"Folder: $DataFolder  (.fda files seen: $count$(if ($count -eq 50) {'+'}))"
if ((Read-Host 'Share this folder READ ONLY to shichika? Type YES') -cne 'YES') { 'Stopped: nothing changed.'; return }

# 1 the account
if (-not (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue)) {
  $pw = Read-Host "Choose a password for $Account (you type it again once on shichika)" -AsSecureString
  New-LocalUser -Name $Account -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
    -Description 'Sudarshan read-only OCT copies (D-047)' | Out-Null   # Windows allows 48 characters
  "Account $env:COMPUTERNAME\$Account made (not an administrator)."
} else { "Account $Account already exists: kept as it is." }

# 2 folder permission: only if ordinary signed-in accounts cannot already read it
$readers = (Get-Acl -LiteralPath $DataFolder).Access | Where-Object {
  $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -and
  $_.IdentityReference.Value -in 'Everyone', 'NT AUTHORITY\Authenticated Users', "$env:COMPUTERNAME\$Account", "$Account"
}
if ($readers) {
  "Folder already readable by: $(($readers.IdentityReference.Value | Sort-Object -Unique) -join ', '); no permission change."
} elseif ((Read-Host "Add a READ-only permission for $Account on this folder? Type YES") -ceq 'YES') {
  icacls $DataFolder /grant "${Account}:(OI)(CI)RX" | Out-Null
  "Read-only permission added (undo: icacls `"$DataFolder`" /remove $Account)."
} else { "No permission added: shichika may not be able to read the files." }

# 3 the share: read for sudarshan_ro only
New-SmbShare -Name $Share -Path $DataFolder -ReadAccess "$env:COMPUTERNAME\$Account" -CachingMode None `
  -Description 'Sudarshan read-only (D-047)' | Out-Null
Get-SmbShareAccess -Name $Share | Where-Object AccountName -notmatch "\\$Account$" |
  ForEach-Object { Revoke-SmbShareAccess -Name $Share -AccountName $_.AccountName -Force | Out-Null }
"Share \\$env:COMPUTERNAME\$Share made. Access:"
Get-SmbShareAccess -Name $Share | ForEach-Object { '    {0}: {1} {2}' -f $_.AccountName, $_.AccessControlType, $_.AccessRight }
""
"Next, on shichika (your own PowerShell, not Claude's), type the same password when asked:"
"    cmdkey /add:192.168.0.152 /user:$env:COMPUTERNAME\$Account /pass"
