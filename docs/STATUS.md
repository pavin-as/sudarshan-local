# Sudarshan - status and handoff
Last updated: 2026-10-25. Plan: docs/PLAN.md (exported from the Claude Docs plan). Read CLAUDE.md first; the other docs are listed there.

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
- [x] Phase B: doctor summary built (19 Oct, D-026): layout approved by Dr. Sameera; local-model overview from 07:00
      with a number check; verified on 3 real patients (12/12 facts match Yarago raw tables each).
- [x] Phase B: follow-up board ranked by clinical risk with call scripts (19 Oct, D-027); ranking checked on 500 real rows.
- [x] Follow-up cards by team: ROP, Injection, Laser, Diabetic retinopathy, Other retina, Routine (23 Oct, D-038); ROP exit (mature retina) confirmed by Dr. Sameera 24 Oct.
- [x] Patients page: cards by group (ROP, injection, laser, DR, glaucoma, squint, myopia, low vision, other retina) with paged lists and Print (24 Oct, D-039); rebuilt nightly.
- [x] Follow-up call scripts removed (24 Oct, D-038); nothing for staff to rewrite.
- [ ] Pavin: deactivate the leftover `zz_check` login on the Users page (by 12 pm, 24 Oct).
- [x] Phase B: EMR completeness page per month (19 Oct, D-028). Phase B is complete.
- [x] Day prints: Print (consult start / check-in, doctor late arrival) and Print POA on the day board (19 Oct, D-029).
- [x] Early booking limit with manager override (19 Oct, D-030).
- [x] Waiting list size with manager override (19 Oct, D-031).
- [x] Metabase Pharmacy dashboard: medicine sales, manufacturers, wholesalers (19 Oct, D-032).
- [x] What we owe wholesalers, live (19 Oct, D-033); purchases corrected to invoice value.
- [ ] Pharmacy: check in Yarago the 2021-22 leftovers (Malabar Drugs Rs 8,274; two invoices without a wholesaler, Rs 48,505).
- [ ] Pavin: test logins per role (see RUNBOOK 10); Google-app passwords were pasted into a chat on 19 Oct and are
      not used by Sudarshan, but should be changed in the Google app too.
- [ ] Pavin: share the EMR completeness report with the clinical staff (https://claude.ai/artifact/EfVt9jujDutkEzYGTxsqCa,
      Share menu); agree targets; Dr. Sameera to check the 196-diagnosis list. Sudarshan to show the monthly percentages.
- [x] Dr. Sameera approved the doctor summary layout (19 Oct).

- [x] Backups: Sudarshan nightly 02:00 to QNAP (scripts/backup.ps1, install-backup.ps1), restore test every 4 weeks; Yarago has its own backup (F:\EMR_AUTO_BACKUP).
- [ ] Off-site copy of backups (decision P-4).
- [ ] Caddy / HTTPS; close MySQL 3306 to LAN.

- [x] Scheduling rules (16) as booking warnings, each with a test (`npm run test:rules`, 30 checks); rule cards
      `analysis/sudarshan/rules/RULE_CARDS.md`.
- [x] Pavin and Dr. Sameera reviewed the 16 rules (19 Oct): all stay warnings for now (D-022).
- [ ] Later: which rules block (P-1), then build blocking with a manager override and a reason.
- [x] Settings screen (`/settings`), 19 Oct: rule switches and numbers, booking grid, lists, plans of action.
- [x] Analytics schema + first KPIs + Metabase (19 Oct, D-020, D-023): migration 0006 (`analytics`, rebuilt nightly
      02:30 by the sync service, 7 s), login `sudarshan_bi` (analytics only, checked), Metabase v0.63.19 service
      `SudarshanMetabase` at http://shichika:3000 (LAN only, Java 21 pinned, own database `metabase` in the nightly backup),
      dashboards Clinic week / Retina care / Money / Front desk (35 questions), weekly "Clinic week" email Monday 07:00 to
      admin@gs.sampadavr.com from admin@gs.sampadavr.com via Gmail (test sent 19 Oct). Definitions and source checks: METRICS.md.
- [x] Pavin: first Metabase login (admin@gs.sampadavr.com, temporary password METABASE_ADMIN_PASSWORD in `.env`), change it. Done (Pavin, 19 Oct).
- [ ] Pavin: confirm September's injection count (analytics says 16 given) and the other September figures in METRICS.md.
- [ ] Dr. Sameera: approve the diagnosis-group and visit-purpose rules (`analytics.category_rule`); review
      `app.analytics_unmatched`. Confirm the injection-adherence definition (post-injection follow-up within 7 days).
- [x] Today page (`/today`) and printable huddle sheet (`/huddle`, next open day by default), 19 Oct: live in-clinic list
      from Yarago's station timer (longest first), arrivals without a Sudarshan booking, next 7 days against capacity, to-do
      counts (confirmation calls, follow-ups, waitlist, rule warnings), today's median waits. API `GET /api/today`,
      `GET /api/huddle`. During the trial the booking figures come from the Google app, refreshed every 15 minutes (D-025).
- [x] Direct calls (`/calls`) and cancel list (`/cancelled`), 19 Oct (migration 0007).
- [x] Month view (`/month`), 19 Oct.
- [x] Reserved slot blocks (Pavin, 19 Oct; D-024): HFA held until 2 days before (manager override); other blocks are
      rule 17 warnings for bookings of that visit type outside their time.
- [x] Triage (`/triage`), 19 Oct: same questions and scoring as the Google app (checked on all 212 imported assessments).
- [x] Direct calls for old patients allowed for every role (Pavin, 19 Oct; D-024).
- [x] Google-app bookings without a time are waitlist (Pavin, 19 Oct): importer fixed, 27 corrected (migration 0008).
- [x] Trial refresh from the Google app every 15 minutes (19 Oct, D-025): importer updates in place by Google ID, imported
      records and the calendar read-only in Sudarshan while `trial.google_master` is true, trial banner. Run by hand 19 Oct
      (24 s, 66 new bookings since 18 Oct, ids unchanged across runs).
- [ ] Pavin: register the refresh task once, in an administrator PowerShell: `scripts\install-refresh.ps1`.
- [ ] Pavin (optional): in the Google sheet's Share dialog, reduce the service account to Viewer (it can edit today;
      the importer already uses a read-only token).
- [ ] Importer: 1,828 imported bookings had no BookingDate and were stamped with the import day; store NULL instead
      (analytics already treats them as "booking date not known").
- [ ] Not in Yarago: patient PIN/area (geography KPI), coded diagnoses, surgery advice. Raise with the clinic if wanted.

- [x] Phase 4 in **test mode** (20 Oct, D-034): WhatsApp page (the day's reminders: preview, then send), reminder and
      payment link from the appointment panel, Payments page, Settings (off / test / live, test numbers, templates,
      amounts), outbox worker, Razorpay checked every minute, refunds by admins. Migration 0015. 18 + 7 checks with AiSensy
      and Razorpay faked; screens checked in a browser on demo data.
- [ ] Pavin: new AiSensy key (rotate the old one first) and Razorpay **test** keys into `.env`; add your mobile as a test
      number; try RUNBOOK 11 with a TEST booking. Tell me the AiSensy campaign names if not `sudarsdhan_appointment`.
- [ ] Pavin: ask AiSensy / Meta for a payment-link template (name, amount, link); until then links go by WhatsApp on the PC.
- [x] Payment links open 15 minutes (21 Oct, D-035), migration 0016.
- [x] New-patient temporary IDs (NDC_date_time_id) and Today's "without a booking" matched by MRD / mobile + name
      (21 Oct, D-036). Still to do: suggest the Yarago link when a new patient registers (P-2 covers the backlog).
- [ ] Prepaid slots (P-5 direction, 21 Oct): at most 4 a day, today to 3 days ahead, one open link at a time, hold while
      the link is open, booked when paid. Waiting on Pavin: amount, and late payment = rebook or refund.
- [ ] Pavin: P-5 (should a paid link confirm the booking / hold urgent slots?) and P-6 (privacy notice naming AiSensy and Razorpay).
- [ ] Before go-live of Phase 4: Razorpay KYC and live keys; cut-over done; Google app Broadcast page no longer used.

- [x] Direction recorded (21 Oct, D-037): Sudarshan replaces Yarago, queue management included (PLAN.md "Later"). Not scheduled.

- [x] Retina AI Phase 1 built (25 Oct, D-040): research DR grader page for admin and doctors, records in `app.dr_gradings`,
      doctors' blinded grades, agreement figures, folder import and old-records copy on the console. Migration 0018.
      9 checks without a database pass; the 15-check API test (`test/retina.test.ts`) and a browser check still need the
      test database (not run on shichika).
- [x] Deployed 25 Oct: grader on 127.0.0.1 only, model guard fixed (it had refused the model since 21 Sep), migration
      0018; `real-data.ts` Retina AI reads pass (grader ready, key set).
- [x] September test records removed from Sudarshan (25 Oct, migration 0019): 0 gradings left, 4 removals in the activity log.
- [ ] Pavin: `scripts\remove-retina-test-data.ps1` (grader's test databases and log lines with typed names; asks for YES).
- [ ] Pavin: Remidio Connect > Sites > Integration Settings > Generate Token and copy it, then run
      `scripts\remidio-api-trial.ps1` and press Enter (it reads the token from the clipboard and clears it; Ctrl+V does not
      paste at a hidden prompt: first try on 25 Oct sent nothing for that reason). Read-only try of Remidio's API.
      **25 Oct, 14:24: the live server accepts the dashboard token with the collection's PACS_GATEWAY client token**
      (getSites 200, site "TIRUR", id 6542143548030976, no custom identifier). 14:30: getExamsByDate exists (an unknown
      call answers 500, it answers 404) but finds no site by id, name or a made-up value: it needs the site's custom
      identifier. Pavin to set Site Identifier `TIRUR` in Remidio Connect > Configure Site Settings (Data Storage Location
      stays "Remidio Cloud", needed for the hosted API; ABDM ID untouched), then run the trial with `-Site TIRUR`.
      **14:34: it works.** Site Identifier TIRUR set; `getExamsByDate/<yyyy-MM-dd>/<yyyy-MM-dd>/TIRUR` returned 91 exams
      (9 Sep to 24 Oct, 87 patients, 180 FOP photos 2866x2866, 1 per eye mostly, 162 of sufficient quality). MRNs: 51 SPD
      (all 51 found in Yarago), 39 "WSD", 1 typo. Remidio's birth date is always 1 January (age typed), so match by SPD
      number only; sex agrees 49 of 51. No doctor reports in these exams (reportDate 0, all ACTIVE). Photo paths in this
      answer are storage paths, not downloadable links: the signed links come with Cloud Data Queue items (Postman sample).
      Script bug in step 5 sent the 91 MRNs to Remidio once (COMPLIANCE, incident 25 Oct); fixed.
- [x] Remidio photo receiver built (25 Oct, D-041): queue reader, photos kept on shichika and in the backup, linked by SPD
      number, graded by the research model, shown on Retina AI and the patient page; switch off / peek / on. Migration
      0020. 13 checks without a database pass; `test/remidio.test.ts` (11) and a browser check need the test database.
- [x] Deployed 25 Oct (`915f63d`): setup-remidio.ps1 run, Cloud Data Queue On, receiver in Peek: queue empty (HTTP 404);
      the queue does not hold past exams. getPatientWithLastExam answers 404 too.
- [ ] Tomorrow (clinic open): take one FOP photograph, Check now in Peek, then switch the receiver On.
- [x] First import from Remidio Connect downloads works (25 Oct): 2 photographs of one SPD patient kept and graded.
- Remidio reports, past year (counted 25 Oct, read only): 760 exams; AI reports none (aiReport, mediosAIReport, gmaReport
  empty for all: Remidio's AI is not used). Doctor reports only for 223 exams taken 10-16 Mar 2026 (reported 11-16 Mar, one
  doctor, 652 photographs, 1 with an SPD number: a screening batch). Diagnoses are codes: NP (174 right / 173 left eyes),
  H40.0 glaucoma suspect 29, NA 10, E08.33 moderate NPDR 4/3, E08.37 2/1, E08.32 0/1, H35.36 drusen 3/4, H35.03 1,
  H35.02 1, UG 1/3. The report also has referRequired, comments and a report file (path).
- [x] Fundus reports in Sudarshan built (25 Oct, D-042): doctors report and grade Remidio photographs on "Fundus
      reports" and the patient page; clinical roles read; corrections need a reason; grades feed Retina AI agreement.
      Migration 0021. 17 checks without a database pass; `test/fundus.test.ts` (7) and a browser check need the test database.
- [ ] Pavin: `update.ps1` to deploy; tell the doctors to report in Sudarshan (Fundus reports), not in Remidio Connect.
- [x] Step 1 of the AI plan (25 Oct, D-043): evaluation harness (Retina AI > Evaluation: frozen sets, per-model metrics
      with patient-level 95% intervals, report, CSV without names) and console benchmark on public datasets; Phase 01
      report in AI_EVALUATION.md (original benchmark cannot be reproduced: none was published). Migration 0022.
      On 25 Oct: 2 photographs, 0 doctor reports, so no local figures yet.
- [x] External check 25 Oct on APTOS 2019 (3,662 images; IDRiD needs an IEEE subscription): the existing model is weak:
      referable DR sensitivity 70.4%, specificity 63.1%, AUROC 0.70, kappa 0.44; 25% of proliferative DR called "No DR"
      (AI_EVALUATION.md section 5). Decision: replace it as the default once a better model is shown on the same sets.
- [ ] Doctors report every FOP session in Sudarshan; photograph known DR patients on the FOP to reach ~100 referable eyes.
- [x] RFM installed safely (25 Oct, D-044): own container 127.0.0.1:7861, pinned checksums, tensor-only pickles,
      `weights_only=True`, no RFM code run; reproduces RFM's published APTOS AUROC exactly (0.946).
- [x] Screening-first evaluation (25 Oct, D-045) on APTOS, cut-offs from validation only: RFM APTOS head 99.1%
      sensitivity / 84.8% specificity, 1 PDR cleared; RFM Messidor-2 head 99.6% / 34.2%, no severe/PDR cleared; Arko007
      must refer everyone. Recommendation: both RFM heads in silent mode on Sampada photographs (AI_EVALUATION.md 5).
- [ ] Pavin + legal: RFM heads (no licence stated: ask the author), DINOv3 terms, the NHS-data question; before any use
      beyond research.
- [ ] Pavin + Dr. Sameera: agree the acceptance criteria (proposed: referable sensitivity >= 95% with lower bound >= 90%,
      no severe/PDR cleared, NPV >= 98%).
- [x] Silent RFM grading built (25 Oct, D-046): every Remidio photograph graded by Arko007 and both RFM heads, research
      screening outcome per grading (Retina AI page only), doctor's grade shared across models, evaluation set roles
      (validation / test, no shared patient), screening figures per model. Migration 0023; `setup-rfm.ps1`.
- [ ] Deploy D-046: `update.ps1`, then `setup-rfm.ps1` (admin); check Retina AI > System lists three graders as Ready.
- [ ] When ~100 referable eyes are reported: frozen Sampada validation set, then a separate test set; re-choose cut-offs.
- [ ] Pavin to decide: use the March batch (doctor-graded) to measure the research model (import with --all, doctor's codes
      as blinded doctor grades: NP = 0, E08.32 = 1, E08.33 = 2, E08.34 = 3, E08.35 = 4, UG / NA = not gradable). Those
      patients are mostly not in Yarago.
- [x] Already-taken photographs: `cli retina-remidio-import` built (25 Oct); dry run on one real download matched 2 of 2.
- [ ] Pavin: `update.ps1` (deploys the import command), then download the SPD exams in Remidio Connect and run the import
      (RUNBOOK 12, "Photographs taken before the queue was on"); then delete the downloads.
- [ ] Pavin (after asking the team): what "WSD" numbers are; then keep or skip photographs without a Yarago SPD number.
- [ ] Remidio: photographs of exams from before the queue was switched on; what itemSuccessfullyHandled expects;
      whether doctor reports come through the queue. Paste back `summary.txt`
      (no names); then delete `D:\classification\sampada-retinal-ai\_remidio_trial`. Leave Cloud Data Queue, Gateway IP/Port,
      Offline Mode and webhooks off until the trial and the Remidio call say what they do.
- [ ] Remidio call, added from their Integration Settings screen: what the Gateway IP / Port / Offline Mode expect (a local
      Remidio gateway would keep images inside the clinic), whether the Cloud Data Queue carries doctor reports (the
      webhook list has "Doctor Reports"), and whether the PACS_GATEWAY client token in the collection works on production.
- [ ] Pavin / a doctor: no real fundus photographs yet. When the first Remidio photographs arrive (MRD = SPD number),
      grade one on the Retina AI page and check it looks right (not yet tried through Sudarshan; the grader itself was
      checked with a synthetic image). Until then the page can be opened, but there is nothing to grade.
- [ ] Retina AI Phase 2: Remidio Host Gateway API pull (Postman collection in `D:\classification\sampada-retinal-ai\docs\`).
      Waiting on Remidio: TIRUR production credentials and site id, body of `itemSuccessfullyHandled`, date format of
      `getExamsByDate`, whether any queue item or export carries the doctor's DR grade, whether anything else reads the queue.
- [ ] Pavin: what goes in the MRN field on the Remidio FOP (the Yarago SPD number?): decides whether Phase 2 can match
      patients by itself.

- [x] Topcon Maestro2 plan accepted (25 Oct, D-047, `docs/OCT_PLAN.md`): the export tool runs on shichika.
- [ ] Topcon Maestro2. Pavin:
  - ask Topcon, at the OCTA licence visit, for an export tool Research key for shichika's Hardware ID, and the plan's
    section 7 questions;
  - give the read-only share path on the ImageNet PC.

  Then Step 0 (.NET 10 Desktop Runtime, tool folder, Hardware ID) and Step 1 (first export of three studies).

## Next step
Trial running on live Google data (D-025). Remaining, in order:
1. **Shadow run** (Phase C gate): staff keep booking in the Google app; daily comparison of the day board, cancel list,
   direct calls, rule warnings and huddle sheet; staff practise on TEST bookings. Before it ends: Caddy + HTTPS, MySQL
   3306 closed to the LAN, the second-pass patient linking (P-2), which rules block (P-1).
2. **Cut-over** (RUNBOOK 8): evening switch, `trial.google_master` false, Google app read-only for 3 months (P-3).
3. **Phase B** done: doctor summary (D-026), follow-up board (D-027), EMR completeness page (D-028).
4. **After cut-over:** switch WhatsApp and payments to live (built in test mode, D-034; RUNBOOK 11), no-show risk score,
   ask-the-data for Pavin, off-site backup copy (P-4).
