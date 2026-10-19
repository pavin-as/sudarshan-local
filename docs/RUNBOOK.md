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
| `SudarshanMetabase` | Management dashboards, `http://shichika:3000` (LAN only); Java 21 and Metabase in `D:\Sudarshan\metabase` | 3000 | `logs\metabase-out.log`, `logs\metabase-err.log` |

The sync service also rebuilds the reporting tables (`analytics`) at 02:30, after the 02:00 backup.

Start order after a reboot is automatic (delayed start; the sync waits for MySQL and Postgres, the server for Postgres).

## 2. Daily health check (1 minute)

```
Get-Service MySQL56, postgresql-16, SudarshanYaragoSync, SudarshanServer, SudarshanMetabase | Format-Table Name, Status
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

**Metabase** (`http://shichika:3000`) has its own logins. First login: `pavin@sampadavr.com` with the temporary
password `METABASE_ADMIN_PASSWORD` from `.env`; change it at once (profile > Account settings). Add other managers in
Metabase > Admin > People. `scripts\metabase_setup.py` uses its own API key (`METABASE_API_KEY`), so password changes do
not affect it.

| Metabase task | How |
|---|---|
| Change a dashboard | Edit the question's SQL or place in `scripts\metabase_dashboards.py`, then `& $py scripts\metabase_setup.py`. Dashboards and questions with the managed names are replaced; to keep your own changes, save a copy under another name. |
| Rebuild the numbers now | `& $py sync\yarago_sync.py analytics` (about 7 s) |
| Weekly email | Monday 07:00, "Clinic week" to pavin@sampadavr.com, sent as admin@gs.sampadavr.com via Gmail (`METABASE_SMTP_*` in `.env`; check with `scripts\check_smtp.py`). |
| Reinstall / upgrade | `scripts\install-metabase.ps1` (version and checksums pinned at the top). |
| Approve diagnosis groups | Dr. Sameera reviews `analytics.category_rule` and sets `approved = true` per rule; text no rule groups: `app.analytics_unmatched`. |

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

**Yarago** is backed up by its own job to the QNAP (`F:\EMR_AUTO_BACKUP`). **Sudarshan** is backed up by
`scripts\backup.ps1` (set up by `scripts\install-backup.ps1`):

| What | When | Where |
|---|---|---|
| Database dump (all Sudarshan data, all table/view definitions; Yarago mirror data left out, a full sync refills it) + git bundle of the code | Daily 02:00, task "Sudarshan backup" | `BACKUP_DIR` in .env (default `F:\SUDARSHAN_BACKUP\daily`), kept 14 days |
| Monthly copy (first backup of each month) | automatic | `...\monthly`, kept 12 months |
| Restore test into a scratch database, counts compared | Every 4 weeks, Sunday 03:00, task "Sudarshan restore test" | result in `logs\backup.log` |

Every run is recorded in `app.backup_runs`; the menu shows managers and admins "Backup <date>" and turns amber if
the last backup failed or is more than a day old. `Invoke-RestMethod http://127.0.0.1:8484/api/health` shows
`lastBackup`, `lastBackupStatus`, `lastRestoreTest`.

Backup by hand: `powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\backup.ps1`
Restore test by hand: `powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\restore-test.ps1`

**Not in the backup: `.env`** (passwords). Keep a copy on a USB stick in a locked drawer, updated whenever it changes.
Without it you can still restore: set new passwords for `postgres`, `sudarshan_app` and `sudarshan_ro` and write a new
.env from `.env.example`.

**If the backup fails:** read `logs\backup.log`. "not reachable" = QNAP off or the share login is missing
(`cmdkey /add:<QNAP> /user:<user> /pass`, then rerun `install-backup.ps1`). Anything else: run `backup.ps1` by hand
and send the log lines.

### Real restore (the database is lost or damaged)

Outside clinic hours if at all possible. Staff use the Google app (until cut-over) or paper meanwhile.
```
Stop-Service SudarshanServer, SudarshanYaragoSync
$pg = "C:\Program Files\PostgreSQL\16\bin"
& "$pg\psql.exe" -U postgres -h 127.0.0.1 -c "ALTER DATABASE sudarshan RENAME TO sudarshan_damaged"
& "$pg\psql.exe" -U postgres -h 127.0.0.1 -c "CREATE DATABASE sudarshan OWNER sudarshan_app ENCODING 'UTF8' TEMPLATE template0"
& "$pg\pg_restore.exe" -U postgres -h 127.0.0.1 -d sudarshan --no-owner --role=sudarshan_app "F:\SUDARSHAN_BACKUP\daily\<newest>.dump"
& $py D:\Sudarshan\app\sync\yarago_sync.py full --force
Start-Service SudarshanYaragoSync, SudarshanServer
```
(If the old database is gone completely, skip the RENAME.) Then check: health, the day board, and
`cd D:\Sudarshan\app\server; npx tsx test\real-data.ts`. Bookings made after the backup time are lost; rebuild them
from the activity log of the damaged database if it can be read, otherwise from staff notes. When all is well:
`DROP DATABASE sudarshan_damaged`.

**Code lost** (folder deleted): `git clone F:\SUDARSHAN_BACKUP\daily\<newest code bundle> D:\Sudarshan\app`, put back
`.env`, run `scripts\install-server.ps1`.

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

`http://shichika:8484` web app · `http://shichika:3000` Metabase · `D:\Sudarshan\app\.env` settings and secrets (admins only) · `D:\Sudarshan\app\logs`
logs · `D:\PostgreSQL\16\data` database files · MySQL 3306 (Yarago) · Postgres 5432 (localhost).
