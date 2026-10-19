# CHANGELOG.md

Every change that reaches shichika, newest first. Write for Pavin: what changed for the clinic, then technical notes.
Add entries under **Unreleased** while working; `update.ps1 -Message` text should match the entry title.
Dates are when deployed on shichika.

## Unreleased
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
