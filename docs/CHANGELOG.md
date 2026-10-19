# CHANGELOG.md

Every change that reaches shichika, newest first. Write for Pavin: what changed for the clinic, then technical notes.
Add entries under **Unreleased** while working; `update.ps1 -Message` text should match the entry title.
Dates are when deployed on shichika.

## Unreleased
- **Print and Print POA on the day board** (D-029), as in the Google app's Day Overview: the day list sorted by consult
  start or check-in time, with "adjust for doctor's late arrival" (enter the doctor's actual start; every consult
  start moves by the delay, planned time struck through), and the list grouped by plan of action. Counts and the
  plan-of-action breakdown at the top; rule notes after the day list. A4 landscape; every print is recorded.
  Technical: migration 0012 (`app.print_log`), `POST /api/print/day` (`preview` is not logged), `web/src/pages/DayPrint.tsx`
  (`/print?date=&kind=day_consult|day_checkin|poa[&start=HH:MM][&noprint=1]`); trial banner hidden in print.
- **EMR completeness page** (`/emr-completeness`, menu "EMR completeness", D-028): for each item on Yarago's optometry
  and doctor screens and the injection record, the share of consultations where it was recorded, for each of the last
  6 months and the last 12 months, against the SOP targets; all visits, new patients or review visits. Rebuilt nightly.
  Technical: migration 0011 (`analytics.emr_completeness`, `analytics.filled()`, `analytics.refresh_emr_completeness()`,
  setting `emr.targets`), nightly step in `sync/yarago_sync.py`, `routes/emr.ts`, `web/src/pages/EmrCompleteness.tsx`.
- **Follow-up board ranked by clinical risk** (D-027): Urgent (injection in the last 6 months, ROP, detachment), High
  (recent laser, retinal disease under care), Monitor (diabetes, conditions to watch), Routine. Counts per tier at the
  top (click to filter), the reasons beside each patient, a filled-in call script in the call dialog, and how many came
  back after a call. Scripts are edited on Settings > Follow-up call scripts.
  Technical: `services/followupRisk.ts`, `GET/PUT /api/followups/scripts`, ranked `GET /api/followups` (tier, reasons,
  script; `tiers`, `cameBackAfterCall30d`); 6 new checks in `npm run test:rules`.
- **Roles from the Login sheet**: "Opto" is now Optometrist (6 users) and "reception" Front desk; a role set on the
  Users screen is no longer overwritten once the person has a Sudarshan password.
- **Doctor summary** (`/patients/<id>/summary`, D-026), in the layout Dr. Sameera agreed: today's booking, a two-line
  overview written by the local model (labelled "AI-generated · verify", shown only when every number in it is in the
  facts), alerts, findings by eye, vision and pressure, treatment, last visit; every date opens that Yarago visit.
  Prepared for the day's patients from 07:00; opened from the patient page or the appointment panel ("Doctor summary").
  Doctors, optometrists, counsellors and managers see it (clinical access). Every view is logged.
  Technical: `services/summary.ts` (facts), `services/overview.ts` (Ollama, number check, 07:00-09:00 job, one-at-a-time
  queue), `routes/summary.ts`, migration 0010 (audit on `ai_summaries`, `facts_hash`, `checked`, settings
  `ai.overview_model`, `ai.overview_at`), `web/src/pages/DoctorSummary.tsx`; 4 new checks in `npm run test:rules`.
- **EMR data completeness report** for the clinical staff SOP (shared page "EMR data completeness: what to record at
  every visit"): what the optometry and doctor screens leave empty, from 9,118 completed visits.
- **Trial refresh from the Google app** (D-025): every 15 minutes 07:00-21:00 and at 23:30, Sudarshan copies the Google
  app's bookings, cancel list, direct calls, triage and clinic calendar (`scripts/refresh-from-google.ps1`, about 25 s;
  log `logs/import.log`). Records keep their Sudarshan id from one copy to the next. While the trial lasts these are
  read-only in Sudarshan (a plain message says to change them in the Google app) and a banner at the top shows when
  they were last copied. Settings, rules and plans of action are no longer overwritten by the import.
  Technical: importer updates by Google ID (no delete and re-insert), `--scheduled`, read-only Google scopes; migration
  0009 (`trial.google_master`); `lib/trial.ts` guards on appointment, cancel-list, direct-call, triage and calendar
  writes; `fromGoogle` on list rows; `/api/health` gives `googleMaster`, `lastImport`; API test step for the guard.
- **HFA slots are held** for HFA patients until 2 days before the day: a booking with another plan is refused before
  then (the booking dialog says so in red and does not suggest those slots); a manager can book with a reason.
- **Reserved slot blocks as warnings** (rule 17): a booking whose visit type is ROP, injection, laser, dilation, urgent
  new or emergency is warned when it is outside that type's time; other bookings may use those slots, as in the Google app.
- **Plans of action in words** on the board list, cards, appointment panel, confirmations, patient page, cancel list and
  huddle sheet ("REF, DIL, OCT (left eye)" instead of `["REF","DIL","OCT (LE)"]`); the edit box shows the plain list.
- **Patient search by MRD number**: "12345", "spd12345" and "SPD 12345" all find SPD12345 first.
- **Bookings without a time** in the Google app are now waitlist (27 imported at 00:00 corrected; importer fixed).
- Direct calls: old patients can be logged by every role (confirmed).
  Technical: `services/reserved.ts`, `isKind` + rule 17 in `services/rules.ts`, HFA hold in `services/booking.ts`,
  migration 0008, `planText` in `web/src/format.ts`; 34 rule checks, API test step for the hold. D-024.
- **Settings** (`/settings`, managers and admins): the scheduling rules (switch each on or off, change its numbers, with
  the Google app's default shown where it differs), the booking grid (slot length, first slot, end of day), the visit
  and patient type lists, and the plans of action (preparation and consultation minutes, priority, hide/show). Every
  change goes to the activity log. The Google app's reserved slot blocks (HFA, injection, laser, ROP, dilation,
  emergency) are shown for reference. Fixed on the way: the visit-type list was one comma-joined line, so the booking
  dialog offered it as a single choice. Not carried over: the API-key page (secrets stay in .env) and maintenance mode.
  Technical: `routes/settings.ts`, `RULE_FIELDS` / `RULE_SWITCH_LABELS` in `services/rules.ts`, API test steps.
- **Month view** (`/month`): the month as a Monday-Sunday calendar; each day shows booked of maximum slots (red when
  over), waitlist, new patients, injections / lasers / ROP / HFA / AT-Gonio planned, and scheduling-rule warnings for
  days still to come; month totals on top; a click opens the day board. Technical: `routes/month.ts`, `pages/Month.tsx`.
- **Triage** (`/triage`): the Google app's seven urgency questions, word for word, with the result shown as the
  answers are picked (any serious answer = Emergency, else any moderate = Urgent, else Not urgent). Save, then book
  straight away (the booking dialog opens with the urgency set; the decision "Booked: today / tomorrow / later date"
  is recorded by itself) or record another decision. Pending assessments are listed first, emergencies at the top; the
  menu shows how many wait. All 212 imported assessments score exactly as the Google app scored them.
  Technical: `services/triage.ts` (questions, scoring), `routes/triage.ts`, `test/triage.test.ts` (7 checks, in
  `npm run test:rules`), API test steps.
- **Direct calls** (`/calls`): log a phone call (Yarago patient or new patient, appointment or enquiry, referral,
  urgency, what they said), then book it straight from the call (the booking dialog opens with the caller's details)
  or close it with a reason (enquiry answered / did not want an appointment); closed calls can be opened again.
  Open calls are listed emergencies first, then longest waiting. The 63 calls open in the Google app are there.
- **Cancel list** (`/cancelled`): cancelled bookings to call back - log each call with a call-again date, rebook
  (Restore), or take the booking off the list with a reason; cancelling can set a call-back date. Shows when a patient
  already has a new booking. Holds the same 61 bookings as the Google app's cancel sheet (archived and old_cancel rows
  are off the list). Menu shows how many calls and call-backs are waiting; the Today page counts them too.
  Technical: migration 0007, `routes/directCalls.ts`, `routes/cancelList.ts`, cancel accepts `callbackOn`, importer
  fills call-back date and cancel-list state; API test steps for both lists.
- **Today** page (first menu item): who is in the clinic right now and for how long (longest first, live from Yarago's
  station timer), patients who arrived without a Sudarshan booking, the next 7 days against maximum slots, and the work
  waiting (confirmation calls, follow-up calls, waitlists, scheduling-rule warnings) with links to where it is done.
  **Huddle sheet** (`/huddle`): the next open day on one printable page - summary (booked, new, not confirmed,
  dilation, injections, lasers, AT/Gonio, HFA, ROP), rule warnings, every booking with plan, doctor, confirmation and
  rule flag; the printout reminds staff it contains patient names. Technical: `server/src/routes/today.ts`,
  `web/src/pages/Today.tsx`, `Huddle.tsx`, print styles; API test and real-data steps.
- Management dashboards: Metabase at `http://shichika:3000` (clinic network only) with four dashboards - Clinic week,
  Retina care, Money, Front desk - built on a new reporting schema rebuilt every night at 02:30. Patients appear there
  only as a random number and an age band. "Clinic week" is emailed to Pavin every Monday 07:00 (from
  admin@gs.sampadavr.com through Gmail). September's visits, billing, optical and collections match Yarago exactly.
  Found on the way: Yarago records no usable diagnosis (both "final diagnosis" fields hold the visit plan), so clinical
  groups come from the coded examination findings by rules for Dr. Sameera to approve; no patient PIN/area; no surgery advice.
  Technical: migration 0006 (`analytics` schema, `analytics.refresh()`, `app.analytics_patient_key`,
  `app.analytics_unmatched`), sync mode `analytics` + nightly schedule, `scripts/install-metabase.ps1` (Java 21 + Metabase
  v0.63.19, SHA-256 pinned, NSSM service `SudarshanMetabase`, roles `sudarshan_bi` / `metabase`, firewall),
  `scripts/metabase_setup.py` + `metabase_dashboards.py` (API, idempotent), `scripts/check_smtp.py`, backup includes the
  `metabase` database. Docs: METRICS.md (definitions, source checks), SCHEMA, RUNBOOK, COMPLIANCE, D-023.
- Scheduling rules: the Google app's 16 rules now show as warnings. The booking dialog and the reschedule panel say,
  before you book, if a time goes against a rule (e.g. "Check: new patient at 09:40, before 10:00"); the day board lists
  the day's findings and marks the cards; the appointment panel shows its own. Nothing is blocked: Pavin and
  Dr. Sameera reviewed the rules and keep all as warnings for now (D-022); blocks will be decided later.
  Technical: `server/src/services/rules.ts` (pure, ported from `RuleEngine.js`), `routes/rules.ts`
  (`GET /api/rules/day`, `POST /api/rules/check`), `test/rules.test.ts` (30 checks, `npm run test:rules`), API test and
  `real-data.ts` steps; web `components/RuleNotes.tsx`. Rule cards: `analysis/sudarshan/rules/RULE_CARDS.md`. No
  migration. Consult start is worked out from slot + plan preparation time when not stored; rule 14 is off (D-021).
- Plan: analytics and business intelligence added (analytics schema, first KPIs, Metabase), D-020.
- Nightly backup of Sudarshan to the QNAP at 02:00 (database without the Yarago copy, plus the code), 14 daily and
  12 monthly kept, restore test every 4 weeks; the menu shows managers and admins when the last backup ran and warns
  if it failed or is over a day old. Technical: `scripts/backup.ps1`, `restore-test.ps1`, `install-backup.ps1`,
  migration 0005 `app.backup_runs`, `/api/health` reports the last backup.
- Project documents: PLAN, SCHEMA, DESIGN, TESTING, RUNBOOK, COMPLIANCE, DECISIONS, CHANGELOG in `docs/`; CLAUDE.md
  points agents to them.

## 2026-10-19 - Web app (trial)
- Staff can log in at `http://shichika:8484` and use: day board with live Yarago stage, booking dialog, appointment
  panel (history, confirm, reschedule, cancel with reason, link a new patient to Yarago), confirmation calls (day-before
  and 4-day, Sundays skipped), patients, follow-up calls, activity log, clinic calendar, users.
- Trial only: the Google app remains the real booking system; practice bookings are named TEST.
- Technical: `web/` (React 18 + Vite + TypeScript, Atkinson Hyperlegible bundled); server serves `web/dist`
  (`@fastify/static`, files looked up per request, missing assets 404 instead of returning the page); multi-day
  appointment lists skip the per-booking Yarago lookup; booking "booked by" shows "in the Google app" for imported rows.
  `update.ps1` and `install-server.ps1` build both server and web.

## 2026-10-18 - API server
- Logins with personal passwords (bcrypt, lockout after 5 tries, forced change of temporary passwords), roles,
  calendar (daily slots, holidays, doctor hours and leave), appointments (book, waitlist, reschedule, restore, cancel,
  confirm, remarks, manual arrival), patients (search, page, visit detail), follow-up board and call log, activity log.
- Booking checks as in the Google app (day open, slot grid, one patient per slot, holiday, leave, no double booking),
  per-day lock, manager override with reason.
- Yarago appointment status labels confirmed (migration 0004); booking settings added.
- Technical: service `SudarshanServer` on 8484, firewall rule for the local subnet; `scripts/install-server.ps1`;
  38-check API test; read-only real-data check. Fixed during testing: auth hook was not applied to all routes
  (fastify-plugin), editing an appointment wiped fields that were not sent.

## 2026-10-18 - App schema, audit log, Sheets import
- Sudarshan's own tables (migration 0003) and the new audit log: every change recorded by the database with who, a plain
  sentence and before/after per field; readable feed `app.audit_feed`.
- Imported from Google Sheets: 20,072 appointments (15,613 linked to Yarago patients, 9,557 matched to visits,
  1,132 past bookings marked did-not-come), 14 users (no passwords), 3 doctors, calendar, settings, 26,180 history
  events, 4,140 follow-up notes, direct calls, triage, messages, daily KPIs. The old AuditLog was not imported.

## 2026-10-18 - Clinical views and visit timeline
- Decoded views over the mirror (patients, visits, findings, vision/IOP trend, injections, laser, follow-ups, dues),
  per-visit timeline from the station timer, follow-up state per patient; Malayalam text repair.

## 2026-10-18 - Yarago sync
- Full mirror of Yarago into PostgreSQL (553 tables, 11.4M rows, 2.4 min first copy); service
  `SudarshanYaragoSync` every 150 s and a full copy at 01:00; guard for unreliable modified dates.

## 2026-10-18 - Phase A setup
- Read-only MySQL user, PostgreSQL 16, Node.js 24, Git, project folder and legacy snapshot.
