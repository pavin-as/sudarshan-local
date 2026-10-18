# Sudarshan - status and handoff
Last updated: 2026-10-18 (late). Plan: "Sudarshan Local Migration Plan" (Claude Docs). Read CLAUDE.md first.

## Done (Phase A)
- Read-only MySQL user `sudarshan_ro` on Yarago (MySQL 5.6, db `yghealthcarecombined`, 127.0.0.1:3306).
- PostgreSQL 16.15 (service `postgresql-16`, localhost only, data `D:\PostgreSQL\16\data`), db `sudarshan`,
  owner `sudarshan_app`. Secrets in `.env` (admin-only ACL, git-ignored).
- Node 24.19, Git 2.49, Python 3.13 (`C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe`).
- Sync worker `sync/yarago_sync.py`, Windows service `SudarshanYaragoSync` (NSSM): incremental every 150 s,
  full copy at 01:00. First full copy: 553 tables, 11.4M rows, 2.4 min; hot-table counts match Yarago.
  Runs logged in `app.sync_runs`; log `logs/yarago_sync.log`.
- Clinical views (`db/views/`): clinical.patient, visit, visit_exam_finding, va_iop_trend, injection, laser,
  followup, followup_current, patient_flow, visit_timeline, patient_due. Applied by `scripts/migrate.py`
  and re-applied after every full copy.
- Admin update command: `powershell -ExecutionPolicy Bypass -File D:\Sudarshan\app\scripts\update.ps1 -Message "..."`
  (migrations + views, restart sync service, health check `scripts/check_views.py`, git commit).

## Facts learned about Yarago data
- Visit record = `tbl_patient_appointment_history` (1 row per appointment). Vision/IOP/refraction stored as
  display text ("6/9", "N6", "14") despite `_id` column names. BCVA = `visionvadv_*`, pinhole = `ph_*`,
  unaided = `dva_*`, IOP = `oeiop_*` (fallback latest `tbloptometryexamination`).
- Complaints / ophthalmic history / advice / exam findings: id list + aligned right/left flag lists
  ('1,3,' + '1,0,' + '0,1,') -> `clinical.list_items()`. Diagnosis is mostly free text (`final_diagnosis`).
- Clinical child tables (bcva, ucva, diagnosis, complaints ...) are append-only: each save inserts new rows.
  Latest row per appointment is current. They have no modified date; sync picks them up by new id.
- 6 child tables lack an index on their visit column in Yarago -> edits to old visits arrive with the nightly copy.
- `tblpatientissurgery.LstmodifiedDate` is unreliable; sync uses new ids only for it.
- Malayalam text is UTF-8 stored in latin1 columns; sync `fix_mojibake()` repairs it (effective from the
  next full copy).
- Station timer (`tbltimerpatientwaiting`) logs clicks; durations come from gaps between stations
  (`clinical.visit_timeline`). Station ids: 1 Check in, 2 optometry, 3 Room In, 4 Exam before dilatation,
  6 Exam after dilatation, 8 Check Out.
- Appointment status labels are inferred (app.code_labels, confirmed=false): 0 booked/not arrived,
  1 checked in, 2 in examination, 3 completed, 4 cancelled. Confirm against Yarago screens.
- Dues: `tbl_patient_payment_mainduedetails.dueAmtTowardsHospital` = patient owes clinic (24 patients now).

## Baseline numbers (last 90 days, median / p90 minutes)
check-in->optometry 6 / 21, optometry incl. dilation 51 / 159, optometry->doctor 40 / 75,
with doctor 12 / 87, total 107 / 198.
Latest follow-up per patient: overdue <=30d 271, 31-90d 367, 91-365d 1,537, >1y 7,769, returned 1,978, upcoming 242.

## Open items
- [ ] Confirm appointment status labels (then set confirmed=true in app.code_labels).
- [ ] Firewall rule blocking MySQL 3306 from LAN (check no LAN client uses it first); later rotate MySQL root password.
- [x] App schema `db/migrations/0003_app_core.sql`: users, sessions, doctors, calendar, appointments +
      appointment_events, direct_calls, triage, followup_actions, messages, payments, kpi_daily, ai_summaries.
- [x] New audit log: trigger on every app table -> `app.audit_log` (who, plain summary, field changes; passwords
      never stored). Readable feed `app.audit_feed` (db/views/30_app_audit.sql). App sets per transaction:
      `SET LOCAL app.user_id`, `app.audit_summary`, `app.source`, `app.request_id`.
- [x] Sheets importer `scripts/import_sheets.py` (live sheet or --xlsx, --dry-run; repeatable; old AuditLog and
      passwords never imported; links MRD -> Yarago patient; past bookings without a Yarago visit -> no_show).
- [ ] Run the import on shichika and review its warnings.
- [ ] Code-modernization plugin: preflight, assess, map, extract-rules on `legacy/sudarshan`.
- [ ] Phase B: doctor summary (layout draft in the plan doc, Dr. Sameera to review), follow-up board.

## Next step
Phase B starts with the doctor summary built on clinical.visit / va_iop_trend / injection / laser /
visit_exam_finding / followup_current / patient_due, generated locally (Ollama) from 07:00 for booked patients.
