#Requires -RunAsAdministrator
<#
  Connect Sudarshan to Remidio's Host Gateway API for fundus photographs (D-041). Safe to run again (e.g. after a new
  token was generated in Remidio Connect, which cancels the old one).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-remidio.ps1
  Before: Remidio Connect > Sites > Integration Settings > API Integrations > Generate Token, and copy the token.
  1 tokens into Sudarshan's .env (never shown): the client auth token from the clipboard (then cleared), and the
    PACS_GATEWAY client token from Remidio's Postman collection in the grader's docs folder
  2 photo folder D:\Sudarshan\data\fundus, administrators and the service (SYSTEM) only
  3 restart SudarshanServer so it reads the tokens
  The receiver stays as it was (off after first install): switch it on Retina AI > System (peek first, then on), and
  Cloud Data Queue must be On in Remidio Connect.
#>
$ErrorActionPreference = 'Stop'
$AppEnv = 'D:\Sudarshan\app\.env'
$Collection = 'D:\classification\sampada-retinal-ai\docs\Remidio Host Gateway APIs.postman_collection.json'
$PhotoDir = 'D:\Sudarshan\data\fundus'

function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  # rewrites the file in place, so its access rights (administrators only) stay as they are
  $lines = @(if (Test-Path $file) { Get-Content $file } else { @() })
  if ($lines | Where-Object { $_ -match "^$key=" }) { $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } } }
  else { $lines += "$key=$value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

Write-Host "`n=== 1. Tokens ===" -ForegroundColor Cyan
$col = Get-Content -Raw -LiteralPath $Collection -Encoding UTF8 | ConvertFrom-Json
$login = ($col.item | Where-Object { $_.name -eq 'Login' }).request
$clientId = ($login.header | Where-Object { $_.key -eq 'clientIdentificationToken' }).value
$clientName = ($login.header | Where-Object { $_.key -eq 'clientName' }).value
$url = $login.url.raw -replace '/api/.*$', ''
if (-not $clientId -or -not $url) { throw "Could not read the client token from $Collection" }
Write-Host 'Copy the client auth token in Remidio Connect (Integration Settings > API Integrations), then come back here.'
Read-Host 'Press Enter to read it from the clipboard (it is not shown)' | Out-Null
$token = ([string](Get-Clipboard -Raw)) -replace '[\s\x00-\x1F\x7F]', ''
try { Set-Clipboard -Value ' ' } catch { }
if ($token -notmatch '^[\x21-\x7E]{20,}$') { throw 'The clipboard does not hold a token. Copy it again in Remidio Connect and run this again.' }
Set-EnvValue $AppEnv 'REMIDIO_URL' $url
Set-EnvValue $AppEnv 'REMIDIO_CLIENT_NAME' $clientName
Set-EnvValue $AppEnv 'REMIDIO_CLIENT_ID_TOKEN' $clientId
Set-EnvValue $AppEnv 'REMIDIO_CLIENT_AUTH_TOKEN' $token
Set-EnvValue $AppEnv 'REMIDIO_SITE' 'TIRUR'
Set-EnvValue $AppEnv 'RETINA_PHOTO_DIR' $PhotoDir
$token = $null
Write-Host "  written to $AppEnv (values not shown); server $url, site TIRUR"

Write-Host "`n=== 2. Photo folder ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $PhotoDir | Out-Null
& icacls $PhotoDir /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
Write-Host "  $PhotoDir (administrators and SYSTEM only)"

Write-Host "`n=== 3. Restart the server ===" -ForegroundColor Cyan
if (Get-Service SudarshanServer -ErrorAction SilentlyContinue) { Restart-Service SudarshanServer; Start-Sleep 4; (Get-Service SudarshanServer).Status }
else { Write-Host '  SudarshanServer is not installed' -ForegroundColor Yellow }

Write-Host "`nNext: Remidio Connect > Integration Settings > Cloud Data Queue = On, then Sudarshan > Retina AI > System: Peek, then On." -ForegroundColor Cyan
