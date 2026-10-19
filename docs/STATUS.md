# Sudarshan - status and handoff
Last updated: 2026-10-18 (night). Plan: docs/PLAN.md (exported from the Claude Docs plan). Read CLAUDE.md first; the other docs are listed there.

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
- Appointment status labels confirmed from data (migration 0004): 0 booked/not arrived (11 of 673 ever
  checked in), 1 checked in, 2 in examination, 3 completed, 4 cancelled.
- Dues: `tbl_patient_payment_mainduedetails.dueAmtTowardsHospital` = patient owes clinic (24 patients now).

## Baseline numbers (last 90 days, median / p90 minutes)
check-in->optometry 6 / 21, optometry incl. dilation 51 / 159, optometry->doctor 40 / 75,
with doctor 12 / 87, total 107 / 198.
Latest follow-up per patient: overdue <=30d 271, 31-90d 367, 91-365d 1,537, >1y 7,769, returned 1,978, upcoming 242.

## Open items
- [x] Appointment status labels confirmed (0004).
- [ ] Firewall rule blocking MySQL 3306 from LAN (check no LAN client uses it first); later rotate MySQL root password.
- [x] App schema `db/migrations/0003_app_core.sql`: users, sessions, doctors, calendar, appointments +
      appointment_events, direct_calls, triage, followup_actions, messages, payments, kpi_daily, ai_summaries.
- [x] New audit log: trigger on every app table -> `app.audit_log` (who, plain summary, field changes; passwords
      never stored). Readable feed `app.audit_feed` (db/views/30_app_audit.sql). App sets per transaction:
      `SET LOCAL app.user_id`, `app.audit_summary`, `app.source`, `app.request_id`.
- [x] Sheets importer `scripts/import_sheets.py` (live sheet or --xlsx, --dry-run; repeatable; old AuditLog and
      passwords never imported; links MRD -> Yarago patient; past bookings without a Yarago visit -> no_show).
- [x] Import run on shichika 18 Oct: 20,072 appointments (15,613 linked to a Yarago patient, 9,557 matched to the
      visit, 1,132 past bookings -> no_show), 14 users, 3 doctors, 26,180 appointment events, 4,140 follow-up notes.
      Warnings: 393 duplicate AppointmentIDs across sheets (kept the most current), 66 orphan remarks.
- [ ] ~4,400 imported bookings have no Yarago link (booked before an MRD existed): second pass by phone + name,
      flagged for a person to confirm.
- [x] sudershanWebsite.xlsx deleted (19 Oct).
- [x] API server `server/` (Fastify + TypeScript), see server/README.md: login/sessions/roles, users admin,
      calendar (capacity, holidays, doctor hours/leave), appointments (book/move/cancel/confirm/remarks, per-day
      lock, Yarago live stage on the board), patients (search, page, visit detail), follow-up board + call log,
      activity log. 38-check API test passes on the test database. Service `SudarshanServer`, port 8484,
      installer `scripts/install-server.ps1`.
- [x] Port the 16 scheduling rules (legacy RuleEngine.js / checks.md) as booking warnings (19 Oct, D-021).
- [x] Web UI (`web/`, React + Vite + TypeScript), served by the API server at http://shichika:8484:
      login, day board (slots, live Yarago stage, waitlist), booking dialog, appointment drawer (story, confirm,
      reschedule, cancel, link new patient to Yarago), confirmation calls (day-before, 4-day), patients,
      follow-up calls, activity log, clinic calendar, users. Font bundled (no internet needed).
- [ ] Code-modernization plugin: preflight and assess done (analysis/sudarshan/); map, extract-rules to do.
- [ ] Phase B: doctor summary (layout draft in the plan doc, Dr. Sameera to review), follow-up board.

- [x] Backups: Sudarshan nightly 02:00 to QNAP (scripts/backup.ps1, install-backup.ps1), restore test every 4 weeks; Yarago has its own backup (F:\EMR_AUTO_BACKUP).
- [ ] Off-site copy of backups (decision P-4).
- [ ] Caddy / HTTPS; close MySQL 3306 to LAN.

- [x] Scheduling rules (16) as booking warnings, each with a test (`npm run test:rules`, 30 checks); rule cards
      `analysis/sudarshan/rules/RULE_CARDS.md`.
- [x] Pavin and Dr. Sameera reviewed the 16 rules (19 Oct): all stay warnings for now (D-022).
- [ ] Later: which rules block (P-1), then build blocking with a manager override and a reason.
- [ ] Settings screen for the rule switches and numbers (now only in `app.settings`).
- [x] Analytics schema + first KPIs + Metabase (19 Oct, D-020, D-023): migration 0006 (`analytics`, rebuilt nightly
      02:30 by the sync service, 7 s), login `sudarshan_bi` (analytics only, checked), Metabase v0.63.19 service
      `SudarshanMetabase` at http://shichika:3000 (LAN only, Java 21 pinned, own database `metabase` in the nightly backup),
      dashboards Clinic week / Retina care / Money / Front desk (35 questions), weekly "Clinic week" email Monday 07:00 to
      admin@gs.sampadavr.com from admin@gs.sampadavr.com via Gmail (test sent 19 Oct). Definitions and source checks: METRICS.md.
- [ ] Pavin: first Metabase login (admin@gs.sampadavr.com, temporary password METABASE_ADMIN_PASSWORD in `.env`), change it.
- [ ] Pavin: confirm September's injection count (analytics says 16 given) and the other September figures in METRICS.md.
- [ ] Dr. Sameera: approve the diagnosis-group and visit-purpose rules (`analytics.category_rule`); review
      `app.analytics_unmatched`. Confirm the injection-adherence definition (post-injection follow-up within 7 days).
- [x] Today page (`/today`) and printable huddle sheet (`/huddle`, next open day by default), 19 Oct: live in-clinic list
      from Yarago's station timer (longest first), arrivals without a Sudarshan booking, next 7 days against capacity, to-do
      counts (confirmation calls, follow-ups, waitlist, rule warnings), today's median waits. API `GET /api/today`,
      `GET /api/huddle`. During the trial the booking figures are those imported on 18 Oct; live in-clinic data is real.
- [x] Direct calls (`/calls`) and cancel list (`/cancelled`), 19 Oct (migration 0007).
- [x] Triage (`/triage`), 19 Oct: same questions and scoring as the Google app (checked on all 212 imported assessments).
- [ ] Pavin: the Google app stopped front-desk (level 4) logins from logging direct calls for *old* patients. Not
      carried over; say if it is still wanted.
- [ ] Importer: 27 imported bookings have the time 00:00 (4 upcoming), probably bookings without a time in the Google app;
      import them as waitlist instead (confirm with Pavin).
- [ ] Importer: 1,828 imported bookings had no BookingDate and were stamped with the import day; store NULL instead
      (analytics already treats them as "booking date not known").
- [ ] Not in Yarago: patient PIN/area (geography KPI), coded diagnoses, surgery advice. Raise with the clinic if wanted.

## Next step
The remaining front-desk lists (direct calls, triage, cancel list, month view, settings). Phase B starts with the doctor summary built on clinical.visit / va_iop_trend / injection / laser /
visit_exam_finding / followup_current / patient_due, generated locally (Ollama) from 07:00 for booked patients.
