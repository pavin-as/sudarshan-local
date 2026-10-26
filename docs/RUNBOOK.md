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
| Docker container `sampada-retinal-ai` (not a Windows service) | Research DR grader for the Retina AI page (D-040), `D:\classification\sampada-retinal-ai`; starts with Docker Desktop, i.e. **only after someone signs in to Windows** | 7860, this machine only | `D:\classification\sampada-retinal-ai\logs\app.log` |

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

**Metabase** (`http://shichika:3000`) has its own logins. First login: `admin@gs.sampadavr.com` with the temporary
password `METABASE_ADMIN_PASSWORD` from `.env`; change it at once (profile > Account settings). Add other managers in
Metabase > Admin > People. `scripts\metabase_setup.py` uses its own API key (`METABASE_API_KEY`), so password changes do
not affect it.

| Metabase task | How |
|---|---|
| Change a dashboard | Edit the question's SQL or place in `scripts\metabase_dashboards.py`, then `& $py scripts\metabase_setup.py`. Dashboards and questions with the managed names are replaced; to keep your own changes, save a copy under another name. |
| Rebuild the numbers now | `& $py sync\yarago_sync.py analytics` (about 7 s) |
| Weekly email | Monday 07:00, "Clinic week" to admin@gs.sampadavr.com, sent as admin@gs.sampadavr.com via Gmail (`METABASE_SMTP_*` in `.env`; check with `scripts\check_smtp.py`). |
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

## 7. Refresh from Google Sheets (trial, D-025)

The scheduled task **Sudarshan refresh from Google** runs `scripts\refresh-from-google.ps1` every 15 minutes
07:00-21:00 and at 23:30 (about 25 s; reads the sheet only). Install once, in an administrator PowerShell:
`powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\install-refresh.ps1`.
Check: `Get-Content D:\Sudarshan\app\logs\import.log -Tail 5`, or the banner time in the app (amber after an hour).
By hand, any time:
```
& $py D:\Sudarshan\app\scripts\import_sheets.py --dry-run     # read and map, roll back
& $py D:\Sudarshan\app\scripts\import_sheets.py               # copy now
```
Records keep their Sudarshan id; ones deleted in the sheet are removed. Bookings made in Sudarshan are never touched.
Settings, rules and plans of action are only filled when missing (Sudarshan's Settings page owns them).
If it fails, the log shows the last lines of the error; most often the internet or the Google key file
(`GSHEET_CREDS` in `.env`, default `C:\scripts\gsheet_creds.json`).

## 8. Cut-over (draft, to be rehearsed)

1. Backups working and a restore tested.
2. Caddy / HTTPS in place.
3. Shadow run: staff book in the Google app; Sudarshan follows every 15 minutes. For an agreed period, compare daily
   (day board, cancel list, direct calls, rule warnings, huddle sheet) and practise in Sudarshan on TEST bookings.
4. Evening before: stop booking in the Google app, run the refresh once more by hand and check the counts, then
   `UPDATE app.settings SET value = 'false' WHERE key = 'trial.google_master';` (as `sudarshan_app`), remove the task
   (`Unregister-ScheduledTask -TaskName 'Sudarshan refresh from Google' -Confirm:$false`), remove TEST bookings.
5. Morning: staff use Sudarshan only. Google app kept read-only for 3 months.
6. Delete the exported spreadsheet copies; rotate the old Google app keys.
7. WhatsApp and payments go live only now (section 11): stop the Google app's Broadcast page first, so patients do not
   get the reminder twice.

## 10. Seeing Sudarshan as each role

Sudarshan does not use the Google app's passwords. To see what a role sees, an admin makes one test login per role on
**Users > Add user** (the one-time password is shown once; the first login asks for a new one):
`test_doctor` (Doctor), `test_manager` (Manager), `test_opto` (Optometrist), `test_frontdesk` (Front desk). Use a
second browser or a private window to stay logged in as yourself. Real staff get their own one-time password from
Users > "Give password" on their row when they start using Sudarshan. Deactivate the test logins before go-live.

| Role | Sees |
|---|---|
| Admin | everything, including Users |
| Manager | everything except Users and Retina AI |
| Doctor | board, patients, clinical detail, the doctor summary, fundus photographs; **writes fundus reports** (D-042); Retina AI (research, D-040); cannot book |
| Optometrist | board, patients, clinical detail, the doctor summary, fundus photographs and reports (read); cannot book |
| Counsellor | as front desk, plus clinical detail and the doctor summary |
| Front desk | board, booking, calls, lists, patients without clinical detail |

## 9. Ports and paths quick reference

`http://shichika:8484` web app · `http://shichika:3000` Metabase · `D:\Sudarshan\app\.env` settings and secrets (admins only) · `D:\Sudarshan\app\logs`
logs · `D:\PostgreSQL\16\data` database files · MySQL 3306 (Yarago) · Postgres 5432 (localhost).

## 11. WhatsApp and payment links (D-034)

Both have a switch on **Settings**: Off, Test mode, Live. They start in **test mode**: only bookings named TEST get a
message or a payment link, WhatsApp goes only to the test numbers on Settings, and Razorpay must have *test* keys.
Live can be chosen only by an admin and only after cut-over (Sudarshan refuses it while the Google app is the master).

Keys go in `D:\Sudarshan\app\.env` (never anywhere else), then restart the server (`Restart-Service SudarshanServer`):
```
AISENSY_API_KEY=<the NEW AiSensy key: the old one was in git history and must be rotated first>
RAZORPAY_KEY_ID=rzp_test_...        # test keys until go-live; rzp_live_... after
RAZORPAY_KEY_SECRET=...
```
Settings shows "key is set" / "test keys" without ever showing the key. shichika needs outbound HTTPS to
`backend.aisensy.com` and `api.razorpay.com`; nothing comes in (Razorpay is asked every minute, no webhook).

Trying it (test mode):
1. Settings > WhatsApp: add your own mobile as a test number. Check the AiSensy campaign name of the reminder template
   (the Google app used `sudarsdhan_appointment`).
2. Book a practice patient named `TEST <name>` for tomorrow with your mobile. WhatsApp page: the list shows who would get
   the reminder and why the others would not; press Send. The message arrives on your phone within seconds.
3. In that booking's panel: Make a payment link (Rs 100 or more), pay it with a Razorpay test card or UPI test id;
   within a minute (or with "Check payment now") it shows Paid. An admin can then refund it.

If the server stops while sending, the message being sent is marked "not delivered" and is never resent by itself;
check with the patient. Not-delivered messages are listed on the WhatsApp page: call those patients.

Going live (after cut-over): rotate the AiSensy key, put the Razorpay live keys in `.env` (after KYC), restart the server,
then an admin sets both switches to Live. Back to Off at any time stops new sends; links already sent stay payable.

## 12. Retina AI (research DR grader, D-040)

The **Retina AI** page (admin and doctors) sends a fundus photograph to the grader container in
`D:\classification\sampada-retinal-ai` and keeps the result in Sudarshan. Research use only: never for a clinical decision.

**First setup (once, outside clinic hours), PowerShell as Administrator, Docker Desktop running:**
```
powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-retina-ai.ps1
powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1 -Message "Retina AI (D-040)"
```
The first makes the shared key (never shown) in both `.env` files, recreates the container on 127.0.0.1:7860 with the old
Gradio page off, waits for the model (about a minute), checks the LAN address no longer answers and removes the old firewall
rule. The second applies the migrations and restarts the server. (Done 25 Oct, then `scripts\remove-retina-test-data.ps1`
once, to delete the September test data: it asks for YES first.)

**After a reboot** the page says "not available" until someone signs in to Windows on shichika (Docker Desktop starts at
sign-in) and the model has loaded (about a minute). Retina AI > System shows the state. Nothing else in Sudarshan depends on it.

**Grading a folder** (e.g. exported from the Remidio dashboard): put the JPG/PNG files in
`D:\classification\sampada-retinal-ai\ingest\incoming`, optionally with `metadata.csv`
(`filename,mrd_no,eye,reference_grade`; eye `Right (OD)` / `Left (OS)` / `RE` / `LE`), then
```
cd D:\Sudarshan\app\server; node dist\cli.js retina-batch --dry-run
node dist\cli.js retina-batch --graded-by <username of the doctor who gave the reference grades>
```
Files move to `ingest\processed` or `ingest\failed`. Put only grades given **without** seeing the AI result in
`reference_grade`: they are saved as blinded. The output names files and MRDs only.

**Photographs from Remidio (D-041), first time** (PowerShell as Administrator):
1. Remidio Connect > Sites > Integration Settings > API Integrations > **Generate Token**, copy it.
2. `powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-remidio.ps1`, press Enter at the prompt
   (tokens into `.env`, photo folder `D:\Sudarshan\data\fundus`, server restarted).
3. Remidio Connect > Integration Settings > **Cloud Data Queue: On** > Submit. Leave Gateway IP/Port, Offline Mode and the
   webhooks off.
4. Sudarshan > Retina AI > System > **Peek**, take one photograph on the FOP (a staff volunteer under a known SPD number),
   wait a minute or press **Check now**. "Latest queue items" shows its fields; nothing is taken.
5. If it shows an IMAGE with `image.path` and `patient.mrn`: **On**. Within a minute the photograph is on the Photographs tab
   and the patient page, and graded soon after.
**Photographs taken before the queue was on** (Remidio does not send these): download them by hand, then import.
1. Remidio Connect > Exams (Device FOP): press **Download** on each exam with an SPD number (rows with 0 images have a grey
   Download: nothing to fetch). The zips land in `C:\Users\Admin\Downloads`; leave them zipped or extracted, both work.
2. PowerShell **as Administrator** (the photo folder is administrators-only):
   ```
   cd D:\Sudarshan\app\server
   node dist\cli.js retina-remidio-import C:\Users\Admin\Downloads --dry-run
   node dist\cli.js retina-remidio-import C:\Users\Admin\Downloads
   ```
   The dry run shows what would be kept (eye, field, quality, day; no names). Run it again any time: photographs already in
   Sudarshan are skipped. `--all` also keeps numbers that are not SPD numbers (unlinked).
3. Within a few minutes they are graded; see Retina AI > Photographs and each patient's page. Then delete the downloads
   (patient data) from the Downloads folder.

**Measuring the AI (D-043; method in AI_EVALUATION.md).** Retina AI > Evaluation (admin): New evaluation set, check the
counts, Make draft set, then **Freeze** before quoting any figure; Download report / CSV per model.
On a public dataset (not stored in Sudarshan), e.g. APTOS 2019 (Kaggle competition data: `train.csv` and
`train_images`, in `D:\datasets\APTOS2019`), PowerShell, any user, Docker running, outside clinic hours (about 40 min):
```
cd D:\Sudarshan\app\server
node dist\cli.js retina-eval-external "D:\datasets\APTOS2019\train_images" --labels "D:\datasets\APTOS2019\train.csv" --name "APTOS 2019 train"
```
(IDRiD on IEEE DataPort needs a subscription now; the command also reads IDRiD and Messidor-2 label files.)
The report and per-image CSV land in `D:\Sudarshan\app\outputs\retina-eval\`; add the result to AI_EVALUATION.md section 5.

**RFM research grader (D-044)**: container `sampada-rfm`, 127.0.0.1:7861, separate from Arko007 (7860). Weights in
`D:\models\rfm\weights` (`rfm-1.3.pt`, `heads\aptos.pt`, `heads\messidor.pt`,
`heads\idrid.pt`, both licence texts); its key in `D:\Sudarshan\app\graders\rfm\.env` (never committed). Start / rebuild:
`cd D:\Sudarshan\app\graders\rfm; docker compose up -d --build`; health `http://127.0.0.1:7861/health` (shows each head's
checksum). It refuses to start if a weights file's checksum or pickle check fails (see `docker logs sampada-rfm`). Benchmark
with the same command as above plus `--grader rfm --head aptos|messidor|idrid` (PowerShell: first
`$env:RFM_GRADER_KEY = (Get-Content D:\Sudarshan\app\graders\rfm\.env | Select-String '^GRADER_API_KEY=').Line.Split('=',2)[1]`);
compare runs with `node dist\cli.js retina-eval-compare --labels <csv> --run "Name=<csv>" --run "Name=<csv>"`. The heads
must only be judged on images they did not train on (APTOS head: split `e` of RFM's `datasets/aptos-2019_splits.csv`, made into
`D:\datasets\APTOS2019\rfm_untouched_test_e.csv`).

**Silent RFM grading (D-046).** Once, after `update.ps1` (migration 0023): PowerShell as Administrator,
`powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-rfm.ps1` (writes `RFM_GRADER_URL` / `RFM_GRADER_KEY`
into Sudarshan's .env without showing them, starts the container, restarts SudarshanServer). Retina AI > System then lists
`arko`, `rfm:aptos`, `rfm:messidor` as Ready; each new Remidio photograph gets three gradings within 5 minutes. To switch
a model off, change the setting `retina.graders` (Settings, admin). Outcomes are research only and shown on the Retina AI
page only. Cut-offs: Evaluation tab, make and freeze a **Validation** set, then a separate **Test** set (patients already in
the validation set are left out), open the test set and choose "Chosen on validation set ...".

A new token in Remidio Connect cancels the old one: run `setup-remidio.ps1` again. Receiver problems show on the System tab
("Last look"); the photographs are in the nightly backup's `fundus\` folder.

**Problems:** System tab says the key does not match → run `setup-retina-ai.ps1` again, then `Restart-Service SudarshanServer`.
"Older version without the Sudarshan connection" → the container still runs old code: `cd D:\classification\sampada-retinal-ai\docker`,
`docker compose up -d --force-recreate app`. Grader log: `D:\classification\sampada-retinal-ai\logs\app.log`.

## 13. Topcon DICOM OCT Export Tool (D-047, `docs/OCT_PLAN.md`)
Set up on 25 Oct 2026 (Step 0).
- **Tool:** `D:\Sudarshan\tools\topcon\DicomOctExport-3.0.0.39\` (v3.0.0.39, a copy of Topcon's zip, SHA-256
  `22E50BF6...1E21`). The manual is beside it in `D:\Sudarshan\tools\topcon\`. It needs the .NET 10 Desktop Runtime,
  installed with winget on 25 Oct (10.0.13, alongside .NET 6 and 8).
- **Config** (`DicomOctExport.dll.config`, with Topcon's original kept as `.topcon-original`):
  - `TempDir` is `D:\Sudarshan\data\oct\work\temp`;
  - the log goes to `D:\Sudarshan\data\oct\work\log\app_<pid>.log`;
  - `NoPrompt=true`, `CPUCores=4`.

  `CleanupPrviouslyRanOutputs=true` is Topcon's default: **always give a new, empty output folder.**
- **Data:** `D:\Sudarshan\data\oct\` holds `incoming\` (copied `.fda`), `dicom\` (exports) and `work\` (temp and logs). Access
  is Administrators, SYSTEM and `shichika\Admin` only (the explicit user entry lets a non-elevated session work). Temp files
  and logs may hold patient names. Not yet in the nightly backup (Step 4 of the plan).
- **Licence tier:** every run prints `parser access level: <tier>, id: <Hardware ID>`.
  - shichika: **US tier, Hardware ID `410689457`** (the same on three runs, 25 Oct).
  - The Research key from Topcon is a file `DicomOCTExport.exe.license`, placed in the tool folder. The next run should
    say Research.
- **Dry run** (lists the jobs, writes nothing):

  ```
  cd D:\Sudarshan\data\oct\work
  D:\Sudarshan\tools\topcon\DicomOctExport-3.0.0.39\DicomOctExport.exe <file.fda> <new output folder> -norun -verbose:jobs
  ```

  Plain `-verbose` is refused: it needs a mode (`:jobs` or `:dir`).
- **Export:** the same command with `-allDcm` in place of `-norun`, into `D:\Sudarshan\data\oct\dicom\<new folder>`. Exit
  code 2 means no `.fda` was found.
- **Read-only access to the ImageNet PC** (once). Both scripts run on 192.168.0.152, in an Administrator PowerShell.
  1. `scripts\imagenet-discover.ps1` changes nothing. It lists drives, shares, Topcon/SQL services and the
     **DATA FOLDER** that holds the `.fda` files. Folders below that are shown as a pattern only (letters a, digits 9), so
     no patient names appear. Output goes to `imagenet_discover.txt` on the Desktop.
  2. `scripts\imagenet-share-readonly.ps1` asks for that folder and for YES. It makes:
     - a local account `sudarshan_ro` that is not an administrator, with a password Pavin chooses;
     - a hidden share `SudarshanOCT$` on the folder, read-only, for that account only.

     If ordinary signed-in accounts cannot already read the folder, it adds a read-only folder permission, and asks first.
     It refuses to run on shichika. The undo commands are in its header.
  3. On shichika, in Pavin's own PowerShell, store the password once:
     `cmdkey /add:192.168.0.152 /user:<IMAGENET-PC-NAME>\sudarshan_ro /pass`.
     After that `\\192.168.0.152\SudarshanOCT$` opens read-only.
  4. **The firewall on OCT_PC is Kaspersky** (Windows Firewall is off there). Done 26 Oct:
     - a Kaspersky packet rule "Sudarshan read-only share from shichika (D-047)": Allow, Inbound, TCP, local port 445,
       remote address 192.168.0.49, at the top of the list;
     - `Block-SmbShareAccess` denies `sudarshan_ro` on `D`, `IMAGEnet6` and `Users`, which give Everyone Full.

     Kaspersky asks for a confirmation that clicks from RustDesk cannot answer: someone at OCT_PC must click Save and
     Confirm.
  - On 26 Oct the share was `D:\IMAGEnet6`; live exams are in its `Data` folder.
  - If the share stops opening: check that the Kaspersky rule is still Active and at the top, and that `cmdkey /list` on
    shichika shows 192.168.0.152.
- **Maestro2 photographs into Sudarshan** (D-048, Step 3). Once, outside clinic hours:
  1. `update.ps1` (migration 0024, new server and screens).
  2. In an administrator PowerShell, run `scripts\setup-topcon.ps1`. It checks the tool, the isolated Python and the
     converter, asks for `sudarshan_ro`'s password (stored in `.env`, never shown), makes the work folder and restarts the
     server.
  3. Retina AI > System > Photographs from the Topcon Maestro2: **Peek**, then **Check now**. The first time, the start
     point becomes "now", so wait for one new exam: you should see its protocol, eye and "patient ID AAA99999" and
     "nothing kept".
  4. Then **On**. Each new exam's colour photograph appears within a few minutes on Fundus reports, the patient page and
     Retina AI > Photographs ("Topcon Maestro2"), and is graded silently.
  5. Earlier exams: set "Import exams saved from" to an earlier time. They are converted 3 a minute, oldest first.
- **Maestro2 problems** show on the System tab ("Last look"; the latest exams with their outcome):
  - "could not sign in" or "cannot read the ImageNet exam folder": the ImageNet PC is off, the Kaspersky rule changed,
    or the password changed (run `setup-topcon.ps1` again).
  - "the export tool made no DICOM files": look at the newest log in `D:\Sudarshan\data\oct\work\log`. It is patient
    data: do not copy it anywhere.
  - An exam that fails 5 times is left in IMAGEnet ("gave up").
- **OCT / OCTA scans** (D-049) come with each exam once the new version is deployed. Exams already imported get their OCT
  added automatically. Doctors open a scan from the fundus report session ("OCT / OCTA scans"), or from the patient
  page.
- **IMAGEnet's past exams and the Jukebox** (D-049). Outside clinic hours:
  1. On the ImageNet PC (Administrator PowerShell, in the folder holding `imagenet-share-readonly.ps1`), share each archive
     read-only:
     `powershell -ExecutionPolicy Bypass -File .\imagenet-share-readonly.ps1 -DataFolder E:\Jukebox -Share 'SudarshanJukeboxE$'`
     and the same with `F:\Jukebox` and `'SudarshanJukeboxF$'`.

     Then deny `sudarshan_ro` on any share made since (the earlier `Block-SmbShareAccess` line again).
  2. On shichika (Administrator PowerShell):
     `powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\setup-topcon.ps1 -Archives 'E=\\192.168.0.152\SudarshanJukeboxE$;F=\\192.168.0.152\SudarshanJukeboxF$'`
  3. Retina AI > System: set "Import exams saved from" to 01/03/2021 00:00.
     - Past exams are converted only in the backfill window (20:00-07:00 and Sundays), newest first, 3 a minute.
     - Their photographs are graded in the same window.
     - Their sessions do not go on "To report".
  - Check the space first: about 83 MB per OCTA exam, 9 MB per radial exam. The whole history may need 150-300 GB, and
    D: has about 218 GB free. The backup copies it again to `F:\SUDARSHAN_BACKUP\oct`.
- **Checking Sudarshan's CST against IMAGEnet** (D-050). On shichika, in an Administrator PowerShell:
  1. Write the sheet. It measures anything not measured yet and keeps values typed in earlier:
     `cd D:\Sudarshan\app\server; node dist/cli.js oct-thickness-sheet`
     (only today's: add `--from 2026-10-26`).
  2. Open `D:\Sudarshan\data\oct\work\cst_check.csv` in Excel. For as many rows as you like, find the scan in IMAGEnet
     (patient, time, eye) and type IMAGEnet's central subfield thickness (µm) into `imagenet_cst_um`. Save as CSV.
  3. Compare: `node dist/cli.js oct-thickness-compare`. It prints the agreement only, for each definition (ILM-BM,
     ILM-OS/RPE).
  4. If Pavin accepts it:
     `node dist/cli.js oct-thickness-compare --record ILM-BM --by "Name"`
     (or `ILM-OS/RPE`, whichever matches IMAGEnet). The screens then show the check instead of "not yet checked".
  5. Delete the sheet afterwards: it names patients.
- **Orthanc / OHIF evaluation** (D-049): a throwaway container on 127.0.0.1:8042 with two de-identified exams.
  - Open: `http://127.0.0.1:8042/ohif/`
  - Remove: `docker compose -f D:\Sudarshan\app\server\test\orthanc-eval\docker-compose.yml down -v`, then delete
    `D:\Sudarshan\data\oct\work\deid`.
- **The isolated test database** (developers): `scripts\testdb.ps1 up` / `down` / `reset`; tests with
  `$env:SUDARSHAN_ENV='D:\Sudarshan\testdb\test.env'`. Synthetic data only.

