# RUNBOOK.md - running Sudarshan on shichika

For whoever looks after shichika (Pavin, or an agent helping him). Commands are for **PowerShell run as
Administrator** unless marked *(Command Prompt)*. Paste one line at a time.

App folder `D:\Sudarshan\app` · Python `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe` (below: `$py`)
· set it once per window: `$py = "C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe"`

## 1. What runs where

| Service (Windows name) | What it is | Port | Logs |
|---|---|---|---|
| `MySQL56` | Yarago EMR database (MySQL 5.6, `yghealthcarecombined`) | 3306 | MySQL data dir |
| `Tomcat7`, `Tomcat9_AutoDB` | Yarago web app and its backup | 8080 etc. | Tomcat |
| `postgresql-16` | Sudarshan database `sudarshan` (data `D:\PostgreSQL\16\data`) | 5432, localhost only | Postgres log dir |
| `SudarshanYaragoSync` | Mirrors Yarago into Postgres: every 150 s, full copy at 01:00 | none | `logs\yarago_sync.log`, `logs\service-*.log` |
| `SudarshanServer` | API + web app, `http://shichika:8484` (LAN only) | 8484 | `logs\server-out.log`, `logs\server-err.log` |

Start order after a reboot is automatic (delayed start; the sync waits for MySQL and Postgres, the server for Postgres).

## 2. Daily health check (1 minute)

```
Get-Service MySQL56, postgresql-16, SudarshanYaragoSync, SudarshanServer | Format-Table Name, Status
Invoke-RestMethod http://127.0.0.1:8484/api/health
& $py D:\Sudarshan\app\sync\yarago_sync.py status
```
Healthy: all `Running`; `lastTableSync` within the last few minutes during clinic hours; sync status shows the last
run `ok`.

## 3. Applying an update (new code from development)

```
powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1 -Message "what changed"
```
It: applies migrations and views, restarts the sync, rebuilds server and web and restarts the server (only if both
builds succeed; otherwise the running version is left alone), runs the view check, commits to git.
Do updates **outside clinic hours** when they include migrations.

First-time install of the server only: `scripts\install-server.ps1` (already done 18 Oct 2026).

## 4. Logins

| Task | How |
|---|---|
| Give someone a login | Users screen (admin) > Add user: shows a one-time password. They choose their own at first login. |
| Forgotten password | Users screen > Temporary password. Old sessions are logged out. |
| Someone leaves | Users screen > Deactivate (same day). |
| Locked out after 5 wrong tries | Wait 15 minutes, or give a temporary password. |
| No admin can log in | *(Command Prompt)* `cd /d D:\Sudarshan\app\server` then `node dist\cli.js list-users` then `node dist\cli.js temp-password <username>` |

Never type a password into a command line; the CLI generates one.

## 5. Common problems

**The web page does not open from another computer**
1. On shichika: `Invoke-RestMethod http://127.0.0.1:8484/api/health`. If that fails, see the next item.
2. If it works on shichika only: `Get-NetFirewallRule -DisplayName "Sudarshan server (LAN)"` must exist and be enabled.
   The other computer must be on the same subnet. Re-run `scripts\install-server.ps1` to recreate the rule.

**Server not running / page says something went wrong**
```
Get-Content D:\Sudarshan\app\logs\server-err.log -Tail 40
Restart-Service SudarshanServer
```
Errors include a `requestId`; search `server-out.log` for it.

**Board shows no arrivals / patient data looks old**
```
Get-Content D:\Sudarshan\app\logs\yarago_sync.log -Tail 30
Restart-Service SudarshanYaragoSync
```
If Yarago (MySQL56) was down, the sync catches up by itself when it is back. Edits to old visits in six Yarago tables
arrive only with the 01:00 full copy (known limitation).

**Full copy needed during the day** (e.g. after a Yarago upgrade): only if necessary, it reads the whole EMR:
`& $py D:\Sudarshan\app\sync\yarago_sync.py full --force`

**Yarago upgraded and tables changed:** the sync logs the change and rebuilds the table at the next full copy; views
are re-applied automatically. If a view fails, the log line `view file ...` names it; fix it in `db/views/`.

**Disk full:** `logs\` rotates at 5 MB per file. Check `D:\PostgreSQL\16\data` size and free space on D:.

## 6. Backups and restore

**Not set up yet. This is the top task before go-live** (COMPLIANCE.md section 4). Planned:
- Nightly 02:00 `pg_dump -Fc sudarshan` to the QNAP share, keep 30 days, weekly copy off-site.
- Nightly dump of Yarago MySQL too (the clinic's EMR is on the same machine).
- Monthly restore test into a scratch database, written up here.

Until then, the Google app is the fallback for bookings, and Yarago's own backup (Tomcat9_AutoDB) covers the EMR.

## 7. Re-importing from Google Sheets

Repeatable; replaces the previous import (bookings made in Sudarshan itself are kept):
```
& $py D:\Sudarshan\app\scripts\import_sheets.py --dry-run
& $py D:\Sudarshan\app\scripts\import_sheets.py
```
Review the counts and warnings. Run outside clinic hours.

## 8. Cut-over (draft, to be rehearsed)

1. Backups working and a restore tested.
2. Caddy / HTTPS in place.
3. Shadow run: staff book in both systems for an agreed period; differences reviewed daily.
4. Evening before: stop booking in the Google app, final import, remove TEST bookings, check counts.
5. Morning: staff use Sudarshan only. Google app kept read-only for 3 months.
6. Delete the exported spreadsheet copies; rotate the old Google app keys.

## 9. Ports and paths quick reference

`http://shichika:8484` web app · `D:\Sudarshan\app\.env` settings and secrets (admins only) · `D:\Sudarshan\app\logs`
logs · `D:\PostgreSQL\16\data` database files · MySQL 3306 (Yarago) · Postgres 5432 (localhost).
