# CHANGELOG.md

Every change that reaches shichika, newest first. Write for Pavin: what changed for the clinic, then technical notes.
Add entries under **Unreleased** while working; `update.ps1 -Message` text should match the entry title.
Dates are when deployed on shichika.

## Unreleased
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
