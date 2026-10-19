# DECISIONS.md - why Sudarshan is built the way it is

One entry per decision: what we chose, why, and what we gave up. **Append only.** To change a decision, add a new entry
that supersedes the old one, and mark the old one "Superseded by D-0xx". Agents: if your work would contradict a
decision here, stop and ask Pavin instead of quietly working around it.

Format: `D-NNN · date · status (Accepted / Superseded / Proposed) · decided by`

---

### D-001 · 2026-10-18 · Accepted · Pavin
**Run Sudarshan locally on shichika; retire the Google Apps Script app after cut-over.**
Why: the full Yarago database is on the same machine; Sheets limits (speed, concurrency, row-number logic, security gaps
found by the assessment) are not worth fixing. The Google app stays live, unchanged, until the new one passes its shadow
run. Do not spend effort improving the Google app.

### D-002 · 2026-10-18 · Accepted · Pavin
**Yarago is read directly, read-only.** The clinic owns Yarago. A MySQL user `sudarshan_ro` with SELECT only is used,
and only by `sync/`. Nothing ever writes to Yarago.

### D-003 · 2026-10-18 · Accepted · Claude (stack left to Claude by Pavin)
**Stack:** PostgreSQL 16, Python 3.13 for the sync only, Node.js 24 + TypeScript + Fastify for the API, React + Vite +
TypeScript for the web app, NSSM Windows services. Why: one language for app logic (the legacy rule engine is JS),
types catch mistakes, Postgres handles concurrent writes, roles, JSON and (later) vector search.

### D-004 · 2026-10-18 · Accepted · Claude
**Mirror all of Yarago into Postgres (`yarago` schema); the app never queries MySQL.**
Incremental every 150 s (id and/or modified date, 10-minute overlap; child tables re-copied by visit id), full copy
nightly at 01:00 into `yarago_staging` and swapped in. Why: a Yarago outage or upgrade never stops booking, and heavy
reads never touch the EMR. Cost: data can be up to ~3 minutes old; some edits to old visits wait for the nightly copy.

### D-005 · 2026-10-18 · Accepted · Claude
**Decode Yarago once, in `clinical` views.** Neither the app nor any AI reads raw Yarago codes. Views are re-applied
after every full copy.

### D-006 · 2026-10-18 · Accepted · Pavin / Claude
**Patient-identifiable data never goes to a cloud model.** Local model (Ollama, 12-14B) for anything with patient
identity; cloud models only for de-identified or aggregate data. **AI drafts, a person acts**: AI never writes
clinical records or sends messages by itself.

### D-007 · 2026-10-18 · Accepted · Pavin
**Do not import the old AuditLog.** Pavin: "ignore the audit log data completely ... build a better audit log structure
and easy to understand form of presentation." The new log (trigger-based, plain sentences, field-by-field) starts clean.
Supersedes the plan's "16k existing rows imported".

### D-008 · 2026-10-18 · Accepted · Claude
**Audit by database trigger, not by application code.** Every insert/update/delete on audited `app` tables is logged by
`app.audit_trigger()`; the app supplies who and a plain sentence per transaction (`withTx`). Why: no code path can
forget to log. Passwords are logged only as "(changed)". Bulk imports log one `import_runs` row instead.

### D-009 · 2026-10-18 · Accepted · Claude
**No unique (date, slot) constraint; capacity enforced in `services/booking.ts` under a per-day advisory lock.**
Why: families sometimes share a slot and managers need a recorded override ("book anyway: reason"); a constraint would
block both. The lock still makes two simultaneous bookings of the last slot impossible.

### D-010 · 2026-10-18 · Accepted · Claude
**Booking model copied from the Google app:** a day is bookable only when its maximum slots (planningB) is above 0;
slots on a fixed grid (09:00-17:50, every 10 min, from `app.settings`); one patient per slot; no time = waitlist;
no booking on holidays, with a doctor on leave, or twice for the same patient on one day. The 16 scheduling rules
(checks.md / RuleEngine.js) come next as **warnings**, not blocks, until Pavin and Dr. Sameera decide which must block.

### D-011 · 2026-10-18 · Accepted · Claude
**Logins:** own `app.users`, bcrypt (12 rounds), session id in an HTTP-only SameSite=strict cookie, 12 h sliding
expiry, 5 wrong passwords per user per computer in 15 minutes then a 15-minute wait. No passwords imported from the
Login sheet: an admin issues a one-time temporary password (Users screen, or `node dist/cli.js temp-password` on
shichika) that must be changed at first login.

### D-012 · 2026-10-18 · Accepted · Claude
**Serve on `http://shichika:8484`, LAN subnet only, until Caddy is added.** 8080 is avoided (Tomcat). Before go-live:
Caddy with internal TLS at `https://sudarshan.local`, then `COOKIE_SECURE=true`.

### D-013 · 2026-10-18 · Accepted · Claude
**Appointment status labels for Yarago `nstatus_id` confirmed from data** (0 booked/not arrived, 1 checked in,
2 in examination, 3 completed, 4 cancelled), migration 0004. The board's "live stage" combines these with the station
timer.

### D-014 · 2026-10-19 · Accepted · Claude
**Web app styling: hand-written CSS with design tokens, Atkinson Hyperlegible bundled locally** (no CDN; works without
internet). Supersedes "Tailwind" in the plan. See DESIGN.md.

### D-015 · 2026-10-18 · Accepted · Pavin
**Full effort on the local system now.** "Don't look into improvement in Google app script now ... make your full
effort in the development of the code in the local system." Consequence: booking, calendar and confirmation screens
were built early; they stay in **trial** (TEST-named bookings only) until cut-over. The doctor summary follows the
scheduling rules.

### D-016 · 2026-10-18 · Accepted · Claude
**Sheets importer is repeatable** (`scripts/import_sheets.py`): it deletes what it imported before and imports again,
so every rehearsal uses fresh data and cut-over is one more run. Past bookings with a known patient but no Yarago visit
that day become `no_show`.

### D-017 · 2026-10-18 · Accepted · Claude
**Razorpay by polling, no webhook**, so nothing on shichika is reachable from the internet.

### D-018 · 2026-10-19 · Accepted · Pavin
**Project documents in `docs/`** (PLAN, STATUS, SCHEMA, DESIGN, TESTING, RUNBOOK, COMPLIANCE, DECISIONS, CHANGELOG);
agents read them before working (CLAUDE.md). Supersedes the Claude Docs plan as the working copy.

### D-019 · 2026-10-19 · Accepted · Pavin / Claude
**Backups:** Yarago keeps its own backup (`F:\EMR_AUTO_BACKUP`). Sudarshan's nightly backup (02:00, after the full
copy) is a `pg_dump` of the whole database **without the Yarago mirror's data**, plus a git bundle of the code, to the
QNAP; 14 daily and 12 monthly kept; restore test every 4 weeks. Why leave out the mirror: it duplicates Yarago's own
backup and is refilled by one full sync (minutes), keeping each backup small. `.env` is not backed up with the data
(secrets); a copy is kept offline.

## Proposed (not yet decided)

- **P-1** Which of the 16 scheduling rules should *block* a booking rather than warn. Owner: Pavin, Dr. Sameera.
- **P-2** Second-pass linking of ~4,400 imported bookings without a Yarago patient (phone + name, confirmed by a person).
- **P-4** Off-site copy of the Sudarshan backups (encrypted cloud or a drive taken home weekly).
- **P-3** Keep the Google app read-only for 3 months after cut-over (plan), then archive the spreadsheet.
