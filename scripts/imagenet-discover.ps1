#Requires -RunAsAdministrator
<#
  Read-only look at the ImageNet PC (192.168.0.152) for the Topcon plan (D-047, docs/OCT_PLAN.md Step 1). Run it ON THE
  IMAGENET PC, in an Administrator PowerShell (paste it, or run the file):
    powershell -ExecutionPolicy Bypass -File imagenet-discover.ps1
  Changes nothing. Prints no patient names, IDs or file names: folders below the data folder are shown as a pattern only
  (letters -> a, digits -> 9). The search reads every folder on every drive: run it outside clinic hours (a few minutes).
  Output: on screen and in imagenet_discover.txt on the Desktop. Bring that file to shichika or paste it to Claude.
  -SearchRoot <folder>: search only that folder (faster, when you already know roughly where the files are).
#>
param([string]$SearchRoot, [string]$OutFile = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'imagenet_discover.txt'))
$ErrorActionPreference = 'SilentlyContinue'
$out = $OutFile
$SearchRoot = $SearchRoot.TrimEnd('\')
function Mask([string]$s) { ($s -creplace '[0-9]', '9') -creplace '[^9\\.\-_ ]', 'a' }

& {
  "== PC: $env:COMPUTERNAME | $((Get-CimInstance Win32_OperatingSystem).Caption) | $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  "IPv4: " + ((Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -notlike '127.*').IPAddress -join ', ')

  "== Drives"
  Get-PSDrive -PSProvider FileSystem | Where-Object Used -ne $null |
    ForEach-Object { '{0}: used {1} GB, free {2} GB' -f $_.Name, [math]::Round($_.Used / 1GB), [math]::Round($_.Free / 1GB) }

  "== Shares (name -> folder; who has what)"
  Get-SmbShare | Where-Object Name -notmatch '^(ADMIN\$|IPC\$|print\$|[A-Z]\$)$' | ForEach-Object {
    '{0} -> {1}' -f $_.Name, $_.Path
    Get-SmbShareAccess -Name $_.Name | ForEach-Object { '    {0}: {1} {2}' -f $_.AccountName, $_.AccessControlType, $_.AccessRight }
  }

  "== Topcon / IMAGEnet / SQL services"
  Get-Service | Where-Object DisplayName -match 'IMAGEnet|Topcon|SQL' |
    ForEach-Object { '{0} [{1}] {2}' -f $_.Name, $_.Status, $_.DisplayName }

  "== Folders holding .fda / .fds files"
  $tops = if ($SearchRoot) { Get-ChildItem -LiteralPath $SearchRoot -Directory -Force } else {
    Get-PSDrive -PSProvider FileSystem | Where-Object Used -ne $null | ForEach-Object { Get-ChildItem $_.Root -Directory -Force } |
      Where-Object FullName -notmatch '^[A-Z]:\\(Windows|\$Recycle\.Bin|System Volume Information)$'
  }
  $files = $tops | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force } |
    Where-Object { $_.Extension -in '.fda', '.fds' }
  if (-not $files) { 'none found' }
  # one group per top folder (of the drive, or of -SearchRoot); the data folder is what all its files' folders share
  $depth = if ($SearchRoot) { ($SearchRoot -split '\\').Count } else { 1 }
  $files | Group-Object { ($_.DirectoryName -split '\\')[0..$depth] -join '\' } | Sort-Object Count -Descending | ForEach-Object {
    $g = $_.Group
    $dirs = @($g.DirectoryName | Sort-Object -Unique)
    $gb = [math]::Round(($g | Measure-Object Length -Sum).Sum / 1GB, 2)
    $span = '{0} to {1}' -f ($g.LastWriteTime | Measure-Object -Minimum).Minimum.ToString('yyyy-MM'), ($g.LastWriteTime | Measure-Object -Maximum).Maximum.ToString('yyyy-MM')
    $fda = @($g | Where-Object Extension -eq '.fda').Count
    if ($g.Count -lt 20 -or $dirs.Count -lt 5) {
      # too few to be the ImageNet store; the full folder could name a patient, so show only the top folder
      '{0}\...  files: {1} (.fda {2})  {3} GB  {4}  [small: exports or copies]' -f $_.Name, $g.Count, $fda, $gb, $span
      return
    }
    $parts = @($dirs | ForEach-Object { , ($_ -split '\\') })
    $n = ($parts | ForEach-Object { $_.Count } | Measure-Object -Minimum).Minimum
    $k = 0
    while ($k -lt $n -and @($parts | ForEach-Object { $_[$k] } | Sort-Object -Unique).Count -eq 1) { $k++ }
    $root = ($parts[0][0..($k - 1)]) -join '\'
    if ($root -match '^[A-Z]:$') { $root += '\' }
    "DATA FOLDER: $root"
    '    files: {0} (.fda {1}, .fds {2})  {3} GB  {4}  folders: {5}' -f $g.Count, $fda, ($g.Count - $fda), $gb, $span, $dirs.Count
    '    layout below it (pattern only):'
    $g | ForEach-Object { Mask ($_.FullName.Substring($root.TrimEnd('\').Length)) } | Group-Object |
      Sort-Object Count -Descending | Select-Object -First 3 | ForEach-Object { '      {0}   x{1}' -f $_.Name, $_.Count }
    '    who can read it (NTFS):'
    (Get-Acl -LiteralPath $root).Access | ForEach-Object { '      {0}: {1} {2}' -f $_.IdentityReference, $_.AccessControlType, $_.FileSystemRights }
  }
} | Tee-Object -FilePath $out
"Saved: $out"
