<#
  READ-ONLY trial of Remidio's Host Gateway API with your own Remidio dashboard login (Retina AI Phase 2 groundwork, D-040).
    powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\remidio-api-trial.ps1 [-Days 7] [-Site <siteCustomIdentifier>] [-Mrn SPD12765]

  Best: generate a client auth token in Remidio Connect (Sites > Integration Settings > API Integrations > Generate Token),
  copy it, run this and press Enter: it is read from the clipboard (then cleared), so no password is used. Type L instead
  to log in with email and password.
  Calls ONLY:  getSites, getExamsByDate (and getPatientWithLastExam when -Mrn is given); loginUser and getAuthToken only
               when no token is pasted.
  NEVER calls: getQueueItem / itemSuccessfullyHandled (the queue: reading it could take photographs away from anyone else),
               createPatientExam, the audit loggers. Nothing is written at Remidio.
  The token or password is asked here, used only for these calls and never stored or shown. Tokens are never printed or saved.
  Do not paste the token into a chat or a file.
  The screen shows a summary WITHOUT patient names (status, field names, counts, SPD-number check, any grade fields): that
  summary (also saved as summary.txt) is safe to paste back to Claude.
  Full answers, with tokens and image signatures removed, go to D:\classification\sampada-retinal-ai\_remidio_trial\
  (administrators only). They hold patient data: delete the folder when the trial is done.
  The client details (clientName, clientIdentificationToken, server address) are read from Remidio's Postman collection
  in the grader's docs folder, so they are never copied into this repository.
#>
param([int]$Days = 7, [string]$Site = '', [string]$Mrn = '', [switch]$SkipExams, [switch]$TryLatestExam)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Collection = 'D:\classification\sampada-retinal-ai\docs\Remidio Host Gateway APIs.postman_collection.json'
$Out = 'D:\classification\sampada-retinal-ai\_remidio_trial'
$summary = New-Object System.Collections.Generic.List[string]
function Hide([string]$text) {                            # tokens and signed-link parts never reach the screen or a file
  if (-not $text) { return $text }
  $t = $text -replace 'eyJ[\w-]+\.[\w-]+\.[\w-]+', '<token removed>'
  return $t -replace '(Signature|GoogleAccessId)=[^&"\s]+', '$1=<removed>'
}
function Say([string]$text, [string]$colour = 'Gray') { $text = Hide $text; Write-Host $text -ForegroundColor $colour; $summary.Add($text) }

# ---------- what Remidio's collection says ----------
$col = Get-Content -Raw -LiteralPath $Collection -Encoding UTF8 | ConvertFrom-Json
$loginReq = ($col.item | Where-Object { $_.name -eq 'Login' }).request
$clientName = ($loginReq.header | Where-Object { $_.key -eq 'clientName' }).value
$clientId = ($loginReq.header | Where-Object { $_.key -eq 'clientIdentificationToken' }).value
$base = $loginReq.url.raw -replace '/api/.*$', ''

function Jwt-Claims([string]$jwt) {
  try {
    $p = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/'); while ($p.Length % 4) { $p += '=' }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
  } catch { return $null }
}
$iss = (Jwt-Claims $clientId).iss
Say "Remidio Host Gateway API trial, $(Get-Date -Format 'yyyy-MM-dd HH:mm')  (read only)" 'Cyan'
Say "  server: $base   client: $clientName   client token issued by: $iss"
if ($iss -match 'staging') { Say '  note: the client token in the collection was issued by Remidio''s STAGING server; the live server may refuse it' 'Yellow' }

# ---------- helpers ----------
function Call([string]$method, [string]$path, [hashtable]$extra = @{}, [string]$json = '') {
  $h = @{ clientName = $clientName; clientIdentificationToken = $clientId }
  foreach ($k in $extra.Keys) { $h[$k] = $extra[$k] }
  $p = @{ Uri = "$base$path"; Method = $method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 60 }
  if ($json) { $p.Body = [Text.Encoding]::UTF8.GetBytes($json); $p.ContentType = 'application/json' }
  try {
    $r = Invoke-WebRequest @p
    $text = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
    return @{ status = [int]$r.StatusCode; text = $text; headers = $r.Headers }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ status = 0; text = $_.Exception.Message; headers = @{} } }
    $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    return @{ status = [int]$resp.StatusCode; text = $text; headers = $resp.Headers }
  } catch {
    # refused before sending (e.g. a bad character in a header): nothing reached Remidio
    return @{ status = 0; text = "not sent: $($_.Exception.Message)"; headers = @{} }
  }
}
function Parse([string]$text) { try { return $text | ConvertFrom-Json } catch { return $null } }
function Short([string]$text) { $t = (Hide $text) -replace '\s+', ' '; if ($t.Length -gt 160) { $t.Substring(0, 160) + '...' } else { $t } }
function Shape($res) {                                    # what an answer looks like, for telling one 404 from another
  $ct = try { [string]$res.headers['Content-Type'] } catch { '' }
  $sv = try { [string]$res.headers['Server'] } catch { '' }
  return "HTTP $($res.status), $($res.text.Length) characters$(if ($ct) { ", $ct" })$(if ($sv) { ", server $sv" })$(if ($res.text) { ": $(Short $res.text)" })"
}
function Save([string]$name, [string]$text) { Set-Content -LiteralPath (Join-Path $Out "$name.json") -Value (Hide $text) -Encoding utf8 }

function Find-Token($o, [string]$path = '$') {           # first JWT-looking string, with where it was
  if ($null -eq $o) { return $null }
  if ($o -is [string]) { if ($o -match '^(Bearer )?eyJ[\w-]+\.[\w-]+\.[\w-]+$') { return @{ path = $path; value = ($o -replace '^Bearer ', '') } }; return $null }
  if ($o -is [System.Array]) { for ($i = 0; $i -lt $o.Count; $i++) { $f = Find-Token $o[$i] "$path[$i]"; if ($f) { return $f } }; return $null }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $o.PSObject.Properties) { $f = Find-Token $p.Value "$path.$($p.Name)"; if ($f) { return $f } }
  }
  return $null
}
function Token-From($res) {
  $f = Find-Token (Parse $res.text)
  if ($f) { return $f }
  if ($res.text -match '^\s*"?(eyJ[\w-]+\.[\w-]+\.[\w-]+)"?\s*$') { return @{ path = 'whole answer'; value = $Matches[1] } }
  foreach ($k in @($res.headers.Keys)) {
    if ($k -match '(?i)token|auth') { $f = Find-Token ([string]$res.headers[$k]) "header $k"; if ($f) { return $f } }
  }
  return $null
}
function Find-Objects($o, [string]$prop, $acc) {          # every object that has a property called $prop
  if ($null -eq $o) { return }
  if ($o -is [System.Array]) { foreach ($x in $o) { Find-Objects $x $prop $acc }; return }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    if ($o.PSObject.Properties.Name -contains $prop) { [void]$acc.Add($o) }
    foreach ($p in $o.PSObject.Properties) { Find-Objects $p.Value $prop $acc }
  }
}
function Biggest-List($o) {                               # the longest list of objects in an answer (the exams)
  $best = @()
  if ($o -is [System.Array]) { if ($o.Count -gt $best.Count -and $o[0] -is [System.Management.Automation.PSCustomObject]) { $best = $o }; foreach ($x in $o) { $b = Biggest-List $x; if ($b.Count -gt $best.Count) { $best = $b } } }
  elseif ($o -is [System.Management.Automation.PSCustomObject]) { foreach ($p in $o.PSObject.Properties) { $b = Biggest-List $p.Value; if ($b.Count -gt $best.Count) { $best = $b } } }
  return ,$best
}
function Walk($o, [string]$path, $paths, $values) {       # field paths and their types; leaf values by field name
  if ($null -eq $o) { $paths[$path] = 'null'; return }
  if ($o -is [System.Array]) { $paths[$path] = "list"; foreach ($x in $o) { Walk $x "$path[]" $paths $values }; return }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $o.PSObject.Properties) { Walk $p.Value "$path.$($p.Name)" $paths $values }; return
  }
  $paths[$path] = $o.GetType().Name
  $leaf = ($path -split '\.')[-1] -replace '\[\]', ''
  if (-not $values.ContainsKey($leaf)) { $values[$leaf] = New-Object System.Collections.Generic.List[string] }
  $values[$leaf].Add([string]$o)
}

function Plain([securestring]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
& icacls $Out /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' "$($env:USERNAME):(OI)(CI)F" | Out-Null
Write-Host ''
# Preferred: the client auth token from Remidio Connect > Sites > Integration Settings > API Integrations > Generate Token.
# Then no password is needed at all. (Generating a new one there cancels the old one.) It is read from the clipboard,
# because Ctrl+V does not paste at a hidden prompt in Windows PowerShell (it types an invisible control character).
Write-Host 'Copy the client auth token in Remidio Connect (Integration Settings > API Integrations), then come back here.'
$choice = Read-Host 'Press Enter to read it from the clipboard (it is not shown), or type L and Enter to log in with email and password instead'
$tokenIn = ''
if ($choice.Trim() -notmatch '^(?i)l$') {
  $tokenIn = ([string](Get-Clipboard -Raw)) -replace '[\s\x00-\x1F\x7F]', ''      # spaces and line breaks picked up when copying
  try { Set-Clipboard -Value ' ' } catch { }                                      # do not leave the token on the clipboard
  if ($tokenIn -notmatch '^[\x21-\x7E]{20,}$') {
    Say "`nStopped: the clipboard does not hold a token ($(if ($tokenIn) { "$($tokenIn.Length) characters, not a token" } else { 'it is empty' })). Copy the token again in Remidio Connect, then run this again." 'Red'
    $summary | Set-Content (Join-Path $Out 'summary.txt'); return
  }
}

if ($tokenIn) {
  Say "`n=== 1-2. Client auth token from the dashboard (login skipped) ===" 'Cyan'
  $claims = Jwt-Claims $tokenIn
  Say "  token read from the clipboard ($($tokenIn.Length) characters; clipboard cleared); looks like a JWT: $($null -ne $claims)$(if ($claims.iss) { "; issued by: $($claims.iss)" })$(if ($claims.systemActorID) { "; for: $($claims.systemActorID)" })"
  $auth = @{ clientAuthToken = $tokenIn }
  $tokenIn = $null
} else {
  # ---------- 1. log in ----------
  $email = Read-Host 'Remidio dashboard email (the login you use on the Remidio website)'
  $loginJson = @{ emailAddress = $email; password = (Plain (Read-Host 'Password (not shown, not saved)' -AsSecureString)) } | ConvertTo-Json -Compress
  Say "`n=== 1. Log in (loginUser) ===" 'Cyan'
  $r = Call 'POST' '/api/user/loginUser' @{} $loginJson
  $loginJson = $null
  Save '1-login' $r.text
  $bearer = Token-From $r
  Say "  HTTP $($r.status); login token: $(if ($bearer) { "found at $($bearer.path)" } else { 'NOT found' })"
  if (-not $bearer) { Say "  answer: $(Short $r.text)" 'Yellow'; Say "`nStopped: the login was not accepted. Check the email and password on the Remidio website first." 'Red'; $summary | Set-Content (Join-Path $Out 'summary.txt'); return }

  # ---------- 2. API key ----------
  Say "`n=== 2. API key (getAuthToken) ===" 'Cyan'
  $r = Call 'GET' '/api/gateway/getAuthToken' @{ Authorization = "Bearer $($bearer.value)" }
  Save '2-auth-token' $r.text
  $apiKey = Token-From $r
  Say "  HTTP $($r.status); API key: $(if ($apiKey) { "found at $($apiKey.path)" } else { 'NOT found' })"
  if (-not $apiKey) { Say "  answer: $(Short $r.text)" 'Yellow'; Say '  trying the next steps with the login token instead' 'Yellow' }
  $auth = @{ Authorization = "Bearer $($bearer.value)"; clientAuthToken = $(if ($apiKey) { $apiKey.value } else { $bearer.value }) }
}

# ---------- 3. sites ----------
Say "`n=== 3. Sites (getSites) ===" 'Cyan'
$r = Call 'GET' '/api/gateway/getSites' $auth
Save '3-sites' $r.text
$sites = New-Object System.Collections.ArrayList
Find-Objects (Parse $r.text) 'siteName' $sites            # TIRUR has no siteCustomIdentifier (25 Oct): find sites by name
Say "  HTTP $($r.status); $($sites.Count) site(s)"
foreach ($s in $sites) { Say "    '$($s.siteName)'  |  custom id: $(if ($s.siteCustomIdentifier) { $s.siteCustomIdentifier } else { 'none' })  |  id: $($s.siteId)" }
if (-not $sites.Count) { Say "  answer: $(Short $r.text)" 'Yellow' }
$chosen = $sites | Where-Object { "$($_.siteName) $($_.siteCustomIdentifier)" -match '(?i)tirur' } | Select-Object -First 1
if (-not $chosen -and $sites.Count -eq 1) { $chosen = $sites[0] }
# what to put in getExamsByDate's {siteCustomId}: -Site if given, else the custom id, else try the numeric id and the name
$siteTries = [ordered]@{}
if ($Site) { $siteTries['-Site'] = $Site }
elseif ($chosen) {
  if ($chosen.siteCustomIdentifier) { $siteTries['custom id'] = [string]$chosen.siteCustomIdentifier }
  if ($chosen.siteId) { $siteTries['site id'] = [string]$chosen.siteId }
  if ($chosen.siteName) { $siteTries['site name'] = ([string]$chosen.siteName).Trim() }
}
if (-not $siteTries.Count) { Say "`nStopped: say which site with -Site <id> (from the list above)." 'Red'; $summary | Set-Content (Join-Path $Out 'summary.txt'); return }
Say "  will try as the site in the exams call: $(($siteTries.Keys | ForEach-Object { "$_ '$($siteTries[$_])'" }) -join ', ')"
$siteId = @($siteTries.Values)[0]                       # for step 5; replaced by the one that works in step 4

# ---------- 4. exams by date ----------
Say "`n=== 4. Exams of the last $Days days (getExamsByDate) ===" 'Cyan'
$end = Get-Date; $start = $end.AddDays(-$Days)
$formats = [ordered]@{
  'unix ms'    = { param($d) [string]([DateTimeOffset]$d).ToUnixTimeMilliseconds() }
  'yyyy-MM-dd' = { param($d) $d.ToString('yyyy-MM-dd') }
  'dd-MM-yyyy' = { param($d) $d.ToString('dd-MM-yyyy') }
  'yyyyMMdd'   = { param($d) $d.ToString('yyyyMMdd') }
}
$exams = $null; $examsText = $null; $examsCount = -1
if ($SkipExams) { Say '  skipped (-SkipExams)'; $siteTries = [ordered]@{} }
:tries foreach ($sk in $siteTries.Keys) {
  foreach ($name in $formats.Keys) {
    $s = & $formats[$name] $start; $e = & $formats[$name] $end
    $r = Call 'GET' "/api/gateway/getExamsByDate/$s/$e/$([uri]::EscapeDataString($siteTries[$sk]))" $auth
    $parsed = Parse $r.text
    $n = if ($r.status -eq 200 -and $parsed) { (Biggest-List $parsed).Count } else { -1 }
    Say "  site as $($sk.PadRight(9)) dates as $($name.PadRight(11)) -> $(if ($n -ge 0) { "HTTP 200, $n record(s)" } else { Shape $r })"
    if ($n -gt $examsCount) { $exams = $parsed; $examsText = $r.text; $examsCount = $n; $siteId = $siteTries[$sk] }
    if ($n -gt 0) { break tries }                     # a combination that returns exams: stop asking
  }
}
if ($exams) {
  Save '4-exams' $examsText
  Say "  using site '$siteId' (answers with no records may only mean no exams in the last $Days days: try -Days 60)"
  $list = Biggest-List $exams
  $paths = @{}; $values = @{}
  Walk $exams '$' $paths $values
  Say "  $($list.Count) record(s) in the answer"
  Say "  fields (name : type):"
  $paths.Keys | Sort-Object | ForEach-Object { Say "    $_ : $($paths[$_])" }
  # the questions that matter for Phase 2, answered without showing who the patients are
  # NOT $mrn: PowerShell names ignore case, so $mrn IS the -Mrn parameter (25 Oct: that sent every MRN to step 5)
  $mrnValues = New-Object System.Collections.Generic.List[string]
  foreach ($k in $values.Keys) { if ($k -match '(?i)^(mrn|mrd|mrdno|mrd_no)$') { foreach ($v in $values[$k]) { $mrnValues.Add($v) } } }
  $spd = @($mrnValues | Where-Object { $_ -match '^(?i)SPD\s*\d{1,6}$' }).Count
  $otherShapes = @($mrnValues | Where-Object { $_ -notmatch '^(?i)SPD\s*\d{1,6}$' } | ForEach-Object { ($_ -replace '\d', '9') -replace '[A-Za-z]', 'A' } | Group-Object | ForEach-Object { "$($_.Name) x$($_.Count)" })
  Say "  MRN values: $($mrnValues.Count), in SPD form: $spd, other: $($mrnValues.Count - $spd)$(if ($otherShapes.Count) { " (shapes: $($otherShapes -join ', '))" })"
  foreach ($k in @('laterality', 'examState', 'deviceType', 'quality', 'field', 'type')) {
    if ($values.ContainsKey($k)) { Say "  $k values: $((@($values[$k] | Sort-Object -Unique) | Select-Object -First 12) -join ', ')" }
  }
  $images = @($values.Keys | Where-Object { $_ -match '(?i)path|url' } | ForEach-Object { $values[$_] } | Where-Object { $_ -match '^https://' }).Count
  Say "  image links in the answer: $images"
  $gradeKeys = @($values.Keys | Where-Object { $_ -match '(?i)grade|diagnos|retinopath|severity|refer|impression|finding|report|result|dr[A-Z_]|^dr$' })
  if ($gradeKeys.Count) {
    Say '  fields that may hold a grade or report (distinct values, at most 12):' 'Green'
    foreach ($k in $gradeKeys) { Say "    $k : $((@($values[$k] | ForEach-Object { if ($_.Length -gt 60) { $_.Substring(0, 60) + '...' } else { $_ } } | Sort-Object -Unique) | Select-Object -First 12) -join ' | ')" }
  } else { Say '  no field looks like a DR grade or report' 'Yellow' }
} elseif (-not $SkipExams) {
  Say '  no combination worked' 'Yellow'
  # Control calls: is it the call that is missing, or the site it was given? (both read nothing)
  Say "`n=== 4b. Control: what a missing site and a missing call look like ===" 'Cyan'
  $d = (Get-Date).ToString('yyyy-MM-dd')
  Say "  exams call, site that cannot exist   -> $(Shape (Call 'GET' "/api/gateway/getExamsByDate/$d/$d/ZZ-NO-SUCH-SITE" $auth))"
  Say "  call name that cannot exist          -> $(Shape (Call 'GET' '/api/gateway/zzNoSuchCall' $auth))"
  Say "  sites call again, for comparison     -> $(Shape (Call 'GET' '/api/gateway/getSites' $auth) | ForEach-Object { $_ -replace ':.*$', '' })"
  Say '  reading: if the made-up call name answers differently from the exams call, the exams call exists and only'
  Say '  the site identifier is missing (set one in Remidio Connect > Configure Site Settings, then run with -Site <it>).'
  Say '  If they answer the same, the exams call is not on the live server under this name: a question for Remidio.'
}

# ---------- 5. one patient (only when asked) ----------
# -Mrn SPD12345, or -TryLatestExam: the SPD number of the most recent exam in step 4 (never shown). One SPD number only.
$lookupMrn = ''
if ($PSBoundParameters.ContainsKey('Mrn')) { $lookupMrn = $Mrn }
elseif ($TryLatestExam -and $exams) {
  $latest = @((Biggest-List $exams) | Where-Object { "$($_.patientDetails.mrn)".Trim() -match '^(?i)SPD\d{1,6}$' } |
              Sort-Object { [long]$_.examDetails.examDate } -Descending) | Select-Object -First 1
  if ($latest) { $lookupMrn = "$($latest.patientDetails.mrn)".Trim().ToUpper(); Say "`n  step 5 uses the SPD number of the most recent exam ($([DateTimeOffset]::FromUnixTimeMilliseconds([long]$latest.examDetails.examDate).ToLocalTime().ToString('yyyy-MM-dd')); number not shown)" }
  else { Say "`n  -TryLatestExam: no exam with an SPD number in the last $Days days" 'Yellow' }
}
if ($lookupMrn -match '^(?i)SPD\d{1,6}$') {
  Say "`n=== 5. Latest exam of one MRN (getPatientWithLastExam) ===" 'Cyan'
  $r = Call 'GET' "/api/gateway/getPatientWithLastExam/$([uri]::EscapeDataString($siteId))/$([uri]::EscapeDataString($lookupMrn))" $auth
  Save '5-patient' $r.text
  $paths = @{}; $values = @{}; $p = Parse $r.text
  if ($r.status -eq 200 -and $p) {
    Walk $p '$' $paths $values
    Say "  HTTP 200; fields:"
    $paths.Keys | Sort-Object | ForEach-Object { Say "    $_ : $($paths[$_])" }
    # the question for already-taken photographs: does this answer carry links that can be downloaded?
    $links = @($values.Values | ForEach-Object { $_ } | Where-Object { $_ -match '^https://' })
    $signed = @($links | Where-Object { $_ -match 'Signature=' })
    $hosts = @($links | ForEach-Object { ([uri]$_).Host } | Group-Object | ForEach-Object { "$($_.Name) x$($_.Count)" })
    $mins = @($signed | ForEach-Object { if ($_ -match 'Expires=(\d+)') { [int](([long]$Matches[1] - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) / 60) } })
    Say "  download links: $($links.Count) ($(if ($hosts) { $hosts -join ', ' } else { 'none' })), signed: $($signed.Count)$(if ($mins) { ", valid about $(($mins | Measure-Object -Minimum).Minimum) more minutes" })" $(if ($signed.Count) { 'Green' } else { 'Yellow' })
  }
  else { Say "  HTTP $($r.status): $(Short $r.text)" 'Yellow' }
}

$bearer = $null; $apiKey = $null; $auth = $null
$summary | Set-Content -LiteralPath (Join-Path $Out 'summary.txt') -Encoding utf8
Write-Host "`nSummary (no patient names) saved to $Out\summary.txt: paste it back to Claude." -ForegroundColor Cyan
Write-Host "Full answers (patient data) are in $Out (administrators only): delete the folder when done." -ForegroundColor Cyan
