#Requires -RunAsAdministrator
<#
  Connect Sudarshan to Zoho Books, READ ONLY, for the money reconciliation (D-052). Safe to run again (e.g. to change the
  bank account or after the Self Client was deleted).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-zoho.ps1
  Before (Zoho admin, about 5 minutes; RUNBOOK 14):
    1 https://api-console.zoho.in > Add Client > Self Client > Create. Note the Client ID and Client Secret.
    2 Self Client > Generate Code, scope exactly:
        ZohoBooks.banking.READ,ZohoBooks.customerpayments.READ,ZohoBooks.settings.READ
      time 10 minutes, description "Sudarshan reconciliation (read only)". Copy the code.
  This script:
    1 swaps the code for a refresh token (refused if Zoho grants anything but READ scopes)
    2 reads the organisation's bank accounts and asks which ones are the clinic's
    3 reads the last 7 days of bank lines once and prints only counts (no descriptions, no amounts)
    4 writes ZOHO_* into Sudarshan's .env (values never shown) and restarts SudarshanServer
  Nothing is written to Zoho, ever: Sudarshan's Zoho client refuses any request but a read (and the token refresh).
#>
$ErrorActionPreference = 'Stop'
$AppEnv = 'D:\Sudarshan\app\.env'
$Dc = 'in'
$OrgId = '60020700170'          # Sampada VR Speciality eye care LLP (Zoho Books, India)
$Accounts = "https://accounts.zoho.$Dc"
$Books = "https://www.zohoapis.$Dc/books/v3"

function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  # rewrites the file in place, so its access rights (administrators only) stay as they are
  $lines = @(if (Test-Path $file) { Get-Content $file } else { @() })
  if ($lines | Where-Object { $_ -match "^$key=" }) { $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } } }
  else { $lines += "$key=$value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

function FromClipboard([string]$what, [string]$pattern, [string]$example) {
  # Ctrl+V does not paste at a hidden prompt (it sends one control character), so secrets come from the clipboard,
  # which is cleared straight after; the value is never shown
  Read-Host "Copy the $what in the Zoho API console, then press Enter here" | Out-Null
  $v = ([string](Get-Clipboard -Raw)) -replace '[\s\x00-\x1F\x7F]', ''
  try { Set-Clipboard -Value ' ' } catch { }
  if ($v -notmatch $pattern) { throw "The clipboard does not hold a $what (it looks like $example). Copy it again and run this again." }
  Write-Host "  $what read ($($v.Length) characters, not shown; clipboard cleared)"
  $v
}
function ZohoProblem($err) {
  # Zoho's own error code only (never the values sent); no response at all means the network
  $resp = $err.Exception.Response
  if (-not $resp) { return "Zoho could not be reached ($($err.Exception.Message))" }
  $body = $null
  try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json } catch { }
  "Zoho answered HTTP $([int]$resp.StatusCode)$(if ($body.error) { " ($($body.error))" } elseif ($body.message) { " ($($body.message))" })"
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "`n=== 1. Zoho Self Client ===" -ForegroundColor Cyan
$clientKey = (Read-Host 'Client ID (paste with a right-click or Ctrl+V; it is not secret)').Trim()
if ($clientKey -notmatch '^1000\.[A-Z0-9]{10,}$') { throw 'That does not look like a Zoho Client ID (1000.XXXX...). Copy it again from the API console.' }
$clientSecretText = FromClipboard 'Client Secret' '^[A-Za-z0-9]{20,}$' 'a long string of letters and digits'
$grantText = FromClipboard 'code from Generate Code' '^1000\.[A-Za-z0-9]+\.[A-Za-z0-9]+$' '1000.xxxx.xxxx'
try {
  $tok = Invoke-RestMethod -Method Post -Uri "$Accounts/oauth/v2/token" -TimeoutSec 30 -Body @{
    code = $grantText; client_id = $clientKey; client_secret = $clientSecretText; grant_type = 'authorization_code' }
} catch { throw "$(ZohoProblem $_). Nothing was saved. Generate a new code (codes last 10 minutes and work once) and run this again." }
$grantText = $null
if ($tok.error) {
  $why = switch ($tok.error) { 'invalid_client' { 'the Client ID or Client Secret is wrong' } 'invalid_code' { 'the code is wrong, used already or older than 10 minutes' } default { $tok.error } }
  throw "Zoho refused the sign-in: $why ($($tok.error)). Nothing was saved. Generate a new code and run this again."
}
if (-not $tok.refresh_token) { throw 'Zoho returned no refresh token. Generate a new code (Self Client > Generate Code) and run this again.' }
if ($tok.scope) {
  $notRead = @(($tok.scope -split '[ ,]') | Where-Object { $_ -and $_ -notmatch '\.READ$' })
  if ($notRead.Count) { throw "The code grants more than reading ($($notRead -join ', ')). Generate a new code with the READ scopes only." }
}
$headers = @{ Authorization = "Zoho-oauthtoken $($tok.access_token)" }
Write-Host '  signed in (read only)'

Write-Host "`n=== 2. Bank accounts ===" -ForegroundColor Cyan
try { $acc = Invoke-RestMethod -Uri "$Books/bankaccounts?organization_id=$OrgId&filter_by=Status.Active" -Headers $headers -TimeoutSec 30 }
catch { throw "$(ZohoProblem $_) listing the bank accounts: check that the code has ZohoBooks.banking.READ. Nothing was saved." }
$banks = @($acc.bankaccounts | Where-Object { $_.account_type -eq 'bank' })
if (-not $banks.Count) { throw 'Zoho lists no bank accounts for this organisation.' }
for ($i = 0; $i -lt $banks.Count; $i++) {
  $b = $banks[$i]
  $feed = if ($b.feeds_last_refresh_date) { "bank feed refreshed $($b.feeds_last_refresh_date)" } else { 'no bank feed' }
  Write-Host ("  {0}. {1}  ({2})" -f ($i + 1), $b.account_name, $feed)
}
$default = @(for ($i = 0; $i -lt $banks.Count; $i++) { if ($banks[$i].feeds_last_refresh_date) { $i + 1 } }) -join ','
if (-not $default) { $default = '1' }
$pick = (Read-Host "Which accounts receive the clinic's UPI and card settlements? Numbers, comma-separated [$default]").Trim()
if (-not $pick) { $pick = $default }
$chosen = @($pick -split ',' | ForEach-Object { $n = [int]$_.Trim(); if ($n -lt 1 -or $n -gt $banks.Count) { throw "No account number $n" }; $banks[$n - 1] })
Write-Host "  chosen: $(($chosen | ForEach-Object { $_.account_name }) -join '; ')"

Write-Host "`n=== 3. One test read (counts only) ===" -ForegroundColor Cyan
$to = (Get-Date).ToString('yyyy-MM-dd'); $from = (Get-Date).AddDays(-7).ToString('yyyy-MM-dd')
foreach ($b in $chosen) {
  # Zoho ignores the date filter on this list and leaves uncategorised feed lines out of Status.All: read the newest
  # page of each and keep the last 7 days. Zoho's "debit" is money INTO the bank account (the ledger's side).
  $lines = @()
  foreach ($f in 'Status.All', 'Status.Uncategorized') {
    try { $tx = Invoke-RestMethod -Uri "$Books/banktransactions?organization_id=$OrgId&account_id=$($b.account_id)&filter_by=$f&per_page=200" -Headers $headers -TimeoutSec 30 }
    catch { throw "$(ZohoProblem $_) listing bank lines: check the ZohoBooks.banking.READ scope. Nothing was saved." }
    $lines += @($tx.banktransactions | Where-Object { $_.date -ge $from -and $_.date -le $to })
  }
  $byStatus = ($lines | Group-Object status | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
  $credits = @($lines | Where-Object { $_.debit_or_credit -eq 'debit' }).Count
  $noSide = @($lines | Where-Object { -not $_.debit_or_credit }).Count
  Write-Host ("  {0}: {1} lines in 7 days ({2}); money in {3}" -f $b.account_name, $lines.Count, $byStatus, $credits)
  if ($noSide) { Write-Host "  $noSide lines carry no debit/credit field: tell Claude before using the reconciliation" -ForegroundColor Yellow }
}
try { $cp = Invoke-RestMethod -Uri "$Books/customerpayments?organization_id=$OrgId&date_start=$from&date_end=$to&per_page=200" -Headers $headers -TimeoutSec 30
      Write-Host "  customer payments in 7 days: $(@($cp.customerpayments).Count)" }
catch { throw "$(ZohoProblem $_) listing customer payments: check ZohoBooks.customerpayments.READ. Nothing was saved." }

Write-Host "`n=== 4. Sudarshan's .env ===" -ForegroundColor Cyan
Set-EnvValue $AppEnv 'ZOHO_DC' $Dc
Set-EnvValue $AppEnv 'ZOHO_ORG_ID' $OrgId
Set-EnvValue $AppEnv 'ZOHO_CLIENT_ID' $clientKey
Set-EnvValue $AppEnv 'ZOHO_CLIENT_SECRET' $clientSecretText
Set-EnvValue $AppEnv 'ZOHO_REFRESH_TOKEN' $tok.refresh_token
Set-EnvValue $AppEnv 'ZOHO_BANK_ACCOUNTS' (($chosen | ForEach-Object { $_.account_id }) -join ',')
$clientSecretText = $null; $tok = $null; $headers = $null
Write-Host "  written to $AppEnv (values not shown)"
if (Get-Service SudarshanServer -ErrorAction SilentlyContinue) { Restart-Service SudarshanServer; Start-Sleep 4; "  SudarshanServer: $((Get-Service SudarshanServer).Status)" }
else { Write-Host '  SudarshanServer is not installed' -ForegroundColor Yellow }

Write-Host "`nNext: Sudarshan > Reconciliation > Fetch from Zoho. The copy then refreshes every two hours, 08:00-22:00." -ForegroundColor Cyan
