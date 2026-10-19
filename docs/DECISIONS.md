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

### D-016 · 2026-10-18 · Superseded by D-025 · Claude
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

### D-020 · 2026-10-19 · Accepted · Pavin
**Analytics: `analytics` schema + Metabase.** Nightly-rebuilt fact and dimension tables in PostgreSQL are the single
source for every report; patients pseudonymous there (key, age band, area; no name, phone, MRD); read-only login
`sudarshan_bi` limited to that schema. Management BI is **Metabase** self-hosted on shichika (LAN only); staff-facing
figures live inside Sudarshan. Why: one definition per number, no clinic data in cloud BI, low cost and resources.
Rejected: Superset (heavier), Grafana (monitoring tool), Power BI Service (cloud). Plan section "Analytics and
business intelligence"; first KPIs listed there.

### D-021 · 2026-10-19 · Accepted · Claude
**Scheduling rules ported as the Google app ran them, with four deliberate changes; all warnings.**
The checks, thresholds and levels follow `RuleEngine.js` and the live `RuleSettings` values (rule cards in
`analysis/sudarshan/rules/RULE_CARDS.md`). Changes: (1) consult start, when not stored, is worked out as slot + longest
preparation time of the plan (the Google app's own formula); before, only ~13% of bookings had it, so the consult-time
rules rarely ran. (2) Special cases and children also come from the booking dialog's tick boxes (VIP, BNI, Wheelchair,
SVV advised, Kids), not only remarks text. (3) Rules run over the whole clinic day (one slot grid), live while booking,
not only on a button press for one doctor. (4) Rule 14 (time per plan of action), designed but never run in the Google
app, is built but off: on real bookings it would fire about 12 times a day. The Gemini summary is not ported (D-006).
Which rules block: P-1.

### D-022 · 2026-10-19 · Accepted · Pavin, Dr. Sameera
**All 16 scheduling rules stay warnings for now; none blocks a booking.** Pavin and Dr. Sameera reviewed the rules
(`docs/RULES_FOR_REVIEW.md`) and decided that, for the present, every rule only warns. Which rules become blocks will be
decided later (P-1 stays open for that); until then do not build blocking.

### D-023 · 2026-10-19 · Accepted · Claude (Pavin approved the phase)
**Analytics built as planned (D-020), with what Yarago actually holds.**
(1) **Clinical group from coded examination findings**, not diagnosis: Yarago's coded diagnosis link is empty and both
"final diagnosis" fields hold the visit plan ("ref+dil", "re ivr"). Findings are grouped by editable regex rules
(`analytics.category_rule`), the plan note likewise into a visit purpose; rules stay unapproved until Dr. Sameera
approves them. (2) **Injection adherence = back for the first planned follow-up after an injection within 7 days**,
because Yarago stores no planned date for the next dose. (3) **Patient key is random** (`app.analytics_patient_key`),
not a hash, so it cannot be recomputed from a patient id. (4) **Staff-typed text is never copied to analytics**
(cancel reasons grouped by keyword). (5) **Metabase v0.63.19 on its own Java 21 runtime**, both pinned with SHA-256,
with its settings in its own PostgreSQL database; dashboards are defined in code (`scripts/metabase_dashboards.py`) so
they can be rebuilt. (6) **Weekly email via Gmail (admin@gs.sampadavr.com)**: the sampadavr.com Zoho mail is on the
free plan, which does not allow SMTP. Mail to pavin@sampadavr.com was blocked, so the Metabase login and the weekly
email both use admin@gs.sampadavr.com (Pavin, 19 Oct). (7) Large money totals shown in lakh, as Metabase cannot group digits the Indian way.
Not built: patient geography (no PIN/area in Yarago), surgery advised-not-done (no surgery advice recorded).

### D-024 · 2026-10-19 · Accepted · Pavin
**HFA slots held; other reserved blocks as warnings; no-time bookings are waitlist; plans shown in words.**
(1) **HFA slots** (the Google app's HFA block: Mon, Thu, Sat around 09:20-09:40) are refused to other plans until 2 days
before the appointment date; from then anyone may book them. A manager can book earlier with a written reason (like a
full day). Rule 9 shows it as "Against rule" in the booking dialog. (2) **The other reserved blocks** (injection Wed
09:00-12:20, laser Tue 14:00-17:30, ROP Wed 13:50-17:00, dilation, urgent new, emergency) only warn: as in the Google app
(getAllowedSlots), a booking whose *visit type* is one of these is warned when outside its time (rule 17); other bookings
may use those slots. A first reading that warned every booking inside a block gave 10 warnings a day and was dropped.
(3) A Google-app booking **without a time is the waiting list** (importer and migration 0008). (4) **Old patients may be
logged as direct calls** by every role (the Google app's front-desk restriction is not carried over). (5) Plans of action
are shown as words ("REF, DIL, OCT (left eye)"), never as the stored JSON. (6) Patient search takes the MRD number with
or without "SPD".

### D-025 · 2026-10-19 · Accepted · Pavin
**Until cut-over, Sudarshan is refreshed from the Google app every 15 minutes, and the Google app is the master.**
`scripts/refresh-from-google.ps1` (task "Sudarshan refresh from Google", 07:00-21:00 every 15 min and 23:30, ~25 s a
run) runs the importer, which now **updates records in place by their Google ID** (Sudarshan ids never change; records
deleted in the sheet are removed). While the setting `trial.google_master` is true, Sudarshan refuses changes to
imported bookings, the cancel list, direct calls, triage and the clinic calendar (they would be overwritten), and shows
a trial banner with the time of the last copy; practice bookings made in Sudarshan (named TEST) work as before.
Settings, rules, lists and plans of action are only filled when missing: **Sudarshan's Settings page is their master
from now on**. The importer reads the sheet with a read-only token (the service account itself can edit the sheet;
Pavin may reduce it to Viewer). Cut-over: stop booking in the Google app, one last refresh, set `trial.google_master` to
false, remove the task (RUNBOOK 8). Why: staff and the dashboards see current figures during the trial, the daily
comparison with the Google app becomes possible, and import problems show up now rather than on cut-over night.
Supersedes D-016 (delete and re-import).

## Proposed (not yet decided)

- **P-1** (later) Which of the 16 scheduling rules should *block* a booking rather than warn; for now all warn (D-022). Owner: Pavin, Dr. Sameera. List with real-data counts and suggestions: `docs/RULES_FOR_REVIEW.md`.
- **P-2** Second-pass linking of ~4,400 imported bookings without a Yarago patient (phone + name, confirmed by a person).
- **P-4** Off-site copy of the Sudarshan backups (encrypted cloud or a drive taken home weekly).
- **P-3** Keep the Google app read-only for 3 months after cut-over (plan), then archive the spreadsheet.
