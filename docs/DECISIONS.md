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

### D-026 · 2026-10-19 · Accepted · Pavin, Dr. Sameera
**Doctor summary built in the agreed layout; overview by the local model, shown only when its numbers check out.**
Layout (Dr. Sameera, 19 Oct): header with today's booking, AI overview labelled "AI-generated · verify", alerts
(systemic illness, drug allergies, late/missed follow-ups, dues), findings by eye, vision and pressure (last 5 visits,
trend in logMAR lines), treatment (injections and lasers, next follow-up), last visit. Choices from the data:
(1) **Findings by eye instead of diagnosis**: no coded diagnosis is ever entered, although Yarago's list of 196 with ICD
codes is ready (EMR completeness report). (2) **Allergies and systemic illness say "not recorded", never "none"**
(Yarago often stores the word "null"). (3) **Injection drug from the billing name** ("INTRA VITREAL RAZUMAB(13000)"):
the drug field is never filled. (4) **Next = the follow-up date written at the last visit**: no next-dose date is kept.
(5) **Last visit = the last consultation**: an injection or laser is its own Yarago appointment with an empty history.
Overview: Ollama `qwen3.5:9b` on shichika (setting `ai.overview_model`), sees the facts without name, MRD or ids,
two sentences; shown only when every number in it appears in the facts (`checked`), else "not shown". Prepared
07:00-09:00 for the day's patients (Sudarshan bookings linked to Yarago + Yarago appointments), later only when opened
(booked later or Yarago data changed); one at a time. Facts are always built fresh; every view of an overview is
logged in `app.ai_summary_views`; `app.ai_summaries` is audited (migration 0010). Checked 19 Oct on 3 real patients
(injections, laser, other): 12 of 12 facts match Yarago's raw tables for each.

### D-027 · 2026-10-19 · Accepted · Claude (Pavin asked for the Phase B follow-up board)
**Follow-up board ranks overdue patients by clinical risk, with a call script per tier.** Tiers
(`services/followupRisk.ts`): **Urgent** = an injection in the last 6 months, ROP, retinal detachment, or an infant;
**High** = laser in the last year, an older injection, or diabetic retinopathy / DME, vein occlusion, AMD, vitreous
haemorrhage, uveitis, macular hole / ERM; **Monitor** = coded diabetes, glaucoma / suspect, CSCR, hypertensive or
myopic retinopathy; **Routine** = the rest. The condition is the analytics group of the latest examination findings
(`analytics.categorise`, Dr. Sameera's rules), so the board and the dashboards agree. Within a tier, the most recently
overdue first (most likely to come back). Each row carries the tier's call script filled with the patient, doctor, due
date and treatment; scripts and the clinic name are edited on Settings (Malayalam welcome). The board also shows how
many patients came back within 30 days of a call logged in Sudarshan. Checked 19 Oct on 500 real rows against Yarago's
raw injection table: every injection in the last 6 months is Urgent, no Urgent row without a reason, order correct.
**Imported roles:** the Login sheet's "Opto" is optometrist and "reception" is front desk; the sheet sets a role only
until the person has a Sudarshan password, after which the Users screen owns it.

### D-028 · 2026-10-19 · Accepted · Claude (Pavin asked for the page)
**EMR completeness per month, in Sudarshan, for the clinical SOP.** `analytics.emr_completeness` holds, per month and
visit group (all, new, review), the share of consultations with each of 19 items recorded (8 on the optometry screen,
11 on the doctor screen), and per injection the drug and next date; rebuilt nightly after the analytics
(`analytics.refresh_emr_completeness()`, under a second; its own step, so a failure never undoes the analytics).
Definitions as in the shared report, with one change: **injection and laser appointments are left out of the visit
counts** (none of the 665 in a year has any consultation content), so the page reads 1-7 points higher than the report,
which now says so. "Recorded" = not empty, not "0", not the word "null"; diagnosis counts a choice from Yarago's list
(`tbldiagnosis`) or the coded diagnosis fields. Targets in the setting `emr.targets` (95% for vision, pressure,
diagnosis, systemic illness, allergies, follow-up). Page `/emr-completeness` for clinical access (not front desk);
counts only. Metabase can read the same table.

### D-029 · 2026-10-19 · Accepted · Pavin
**Day prints as in the Google app's Day Overview.** On the day board: **Print** (sort by consult start or by check-in
time; optional "adjust for doctor's late arrival": every consult start moves by the actual doctor start minus the
earliest consult start, the planned time shown struck through) and **Print POA** (one table per plan of action, eye
left out, groups by earliest check-in). Both carry the header, total / confirmed / waiting list / new / old counts
(new = MRD starting N, old = starting S, as the Google app counted) and the plan-of-action breakdown; the day print
adds the scheduling rule notes and special cases. Differences: consult start is the stored one, else slot + longest
preparation (as the rules work it out); **waitlist rows have no consult start** (the import carries stray times such as
00:05, and the Google app left the waiting list out of the delay); the Gemini summary is not printed (D-006); A4
landscape. **Every print is recorded** in `app.print_log` (who, when, which day, kind, rows, doctor start), as the
Google app logged prints; the dialog's "work out delay" preview is not a print.

### D-030 · 2026-10-19 · Accepted · Pavin (option b)
**Early booking limit, as in the Google app, blocking with a manager override.** The further away a day is, the smaller
the share of its maximum slots that may be booked: 10+ days 51%, 5-9 days 79%, 4 days 85%, 1-3 days 95%, same day 100%
(the Google app's defaults; its own settings were not in the import). "% used" = bookings with a time / maximum slots,
rounded as the Google app did (above .5 up); waitlist and cancelled bookings do not count; at or over the limit a booking
that adds a place (new, waitlist given a slot, moved from another day) is refused. A change of time on the same day is
not limited. **A manager or admin may book anyway with a written reason** (logged), like a full day: the Google app
allowed no override; Pavin chose this on 19 Oct. This is an exception to D-022 (rules only warn), because the limit
protects capacity rather than the shape of the day. Shown as soon as a date is chosen (book, reschedule, follow-up and
direct-call bookings all use the same dialog and check), with the unlock table (a Sunday unlock moves to Saturday);
held days are marked on the date strips. Bands are changed by an admin on Settings (10-100%, rising as the day gets
closer, a same-day band). On 19 Oct, 7 of the next 16 open days were already over their limit.

### D-031 · 2026-10-19 · Accepted · Claude (Pavin asked for the Google app's rule; handled as D-030)
**Waiting list size, as in the Google app, refused when full with a manager override.** A day's waiting list holds at
most ceil(maximum slots x 15%) (38 slots -> 6, 15 slots -> 3; Google app checkWaitingListLimit). A booking without a time,
a move to the waitlist, or a cancelled booking restored to the waitlist is refused when that day's list is full; a
patient already on that day's waitlist keeps their place. No waitlist on a day without maximum slots. A manager or
admin may add anyway with a written reason, as for the early booking limit (D-030); the Google app allowed no override.
Giving a waitlist patient a slot on a full day was already refused ("the day is full", manager override), matching the
Google app's locked type box. The percentage is changed by an admin on Settings. On 19 Oct two days were already over:
22 Oct (7 of 6) and 31 Oct (6 of 6).

### D-032 · 2026-10-19 · Accepted · Pavin asked; Claude chose the sources
**Pharmacy analytics in the analytics schema and a Metabase "Pharmacy" dashboard.** Tables `analytics.dim_medicine`,
`dim_wholesaler`, `fact_pharmacy_sale`, `fact_pharmacy_purchase`, rebuilt nightly by `analytics.refresh_pharmacy()`
(its own step after the analytics, under a second). Sources: Yarago's optical+pharmacy module (sale lines, orders,
`tbl_mst_product`, purchase invoices and lines, `tbl_mst_vendor`); pharmacy = categories 3, 5, 6, 7, 8 (optical left
out). **Manufacturer = the company most often named on the medicine's purchase invoices**, because Yarago stores no
manufacturer on the medicine (99% of sales value covered). Sales are what patients paid (after discount and returns,
with GST); purchases are invoice line totals, so "bought vs sold" is not profit. Patients only as the random analytics key.
Definitions in METRICS.md.

### D-033 · 2026-10-19 · Accepted · Pavin asked; Claude chose the method
**What we owe each wholesaler, live, and purchases at invoice value.** Yarago keeps one payment row per purchase invoice
(invoice amount, paid, adjustment, credit note) and staff record a settlement as one lump adjustment against a single
invoice that covers many (302 invoices look "overpaid" by Rs 1.88 crore in all). So the balance is **per wholesaler**:
invoiced minus paid, adjusted and credited; open invoices are worked out **oldest-paid-first**. These are views
(`analytics.wholesaler_invoice`, `wholesaler_balance`, `wholesaler_open_invoice`) over the Yarago mirror, not nightly
tables, and the three purchase and payment tables moved to the 150-second sync, so the balance is minutes old. This
departs from D-020 (analytics rebuilt nightly) for these figures only. **Correction to D-032:** the purchase line total
in Yarago is the *selling* value (unit selling price x quantity); purchases are now the invoice amount spread over the
invoice's lines by selling value (12 months on 19 Oct: Rs 30.1 lakh, not Rs 53.1 lakh). Balances on 19 Oct: KP KC Rs 3.72
lakh, SRM Associates Rs 1.12 lakh, Central Agencies Rs 1.00 lakh; leftovers from 2021-22: Malabar Drugs Rs 8,274 and two
invoices with no wholesaler Rs 48,505 (to check in Yarago).

### D-034 · 2026-10-20 · Accepted · Pavin asked for it ("Phase 4 test-mode build"); Claude chose the design
**WhatsApp reminders and Razorpay payment links built now, in test mode; live only after cut-over.** Each has a switch
(settings `messaging.mode`, `payments.mode`): off / test / live. **Test mode** touches only practice bookings (named
TEST, or ZZ Test in the API test); WhatsApp goes only to the numbers on Settings (staff phones); Razorpay must have test
keys (`rzp_test_`, checked from the key id). **Live** can be set only by an admin and is refused while
`trial.google_master` is true (D-025): until cut-over the Google app sends the clinic's reminders, and two systems would
message patients twice. **A person always sends**: the day's reminders from the WhatsApp page (preview with who gets it
and why the others do not, then a confirm), one reminder or a payment link from the appointment panel. The outbox
worker only delivers what a person queued, one message at a time; a message interrupted by a restart is marked "not
delivered", never resent by itself. A reminder already sent for that appointment day is not sent again unless someone
chooses "Send again". **Templates** are AiSensy campaigns (Meta-approved), filled with values in order; the reminder keeps
the Google app's campaign `sudarsdhan_appointment` and wording (name, "17-June-2026", "4:10 PM"); the payment-link
template needs a new approved template with the link, so until then a link is sent from WhatsApp on the PC (wa.me, the
Google app's own phase 1) or copied. **Payment links**: made by front desk and counsellors with a checked phone number,
amount within settings (default Rs 500, Rs 100-5000), valid 24 hours (15 minutes since D-035); Razorpay gets the patient's name, phone and
"<clinic> appointment <date>" only, never the plan or a note; our reference `SUD-<id>` stops a second link for one
request. Status by asking Razorpay every minute for open links and pending refunds (D-017); "Check payment now" asks at
once. An amount paid that differs from the link is flagged "to check". **Refunds by admins only** (the Google app's
decision), never more than paid, with an idempotency key. **A paid link does not change the appointment** (no slot hold
and release as the Google app's plan designed): see P-5. Who: messages to one patient = front desk, counsellor, manager,
admin; the day's broadcast = manager, admin (Google app levels 1 and 3); doctors and optometrists see what was sent.

### D-035 · 2026-10-21 · Accepted · Pavin asked ("Link expiry set to 15 minutes")
**Payment links stay open 15 minutes, not 24 hours.** Setting `payments.link_minutes` (default 15, 15 to 10080; replaces
`payments.link_hours`). Razorpay will not take payment on a link after its `expire_by`, so a patient cannot pay late on
an old link; 15 minutes is the shortest Razorpay accepts, and 30 seconds are added for the trip to Razorpay. This is the
first step of the prepaid-slot plan Pavin described (at most 4 prepaid slots a day for bookings today to 3 days ahead,
one open link at a time, slot booked when paid); the slot quota and hold are not built yet (P-5). Chosen over a
self-hosted UPI gateway (YouPI-PG) or a plain UPI QR to the clinic's account: those pay straight into the account, so
nothing can stop a payment after the 15 minutes, and they cannot tell which booking a payment belongs to.

## Proposed (not yet decided)

- **P-1** (later) Which of the 16 scheduling rules should *block* a booking rather than warn; for now all warn (D-022). Owner: Pavin, Dr. Sameera. List with real-data counts and suggestions: `docs/RULES_FOR_REVIEW.md`.
- **P-2** Second-pass linking of ~4,400 imported bookings without a Yarago patient (phone + name, confirmed by a person).
- **P-4** Off-site copy of the Sudarshan backups (encrypted cloud or a drive taken home weekly).
- **P-3** Keep the Google app read-only for 3 months after cut-over (plan), then archive the spreadsheet.
- **P-5** Payments and the booking: should a paid link confirm the appointment, and should urgent same-day bookings be held
  only until paid (the Google app's plan: 15-minute hold, slot released if unpaid, late payments to a person)? For now a
  payment is recorded beside the booking and changes nothing (D-034). Also: which visits need an advance at all. Owner: Pavin.
  21 Oct, Pavin's direction: at most 4 prepaid slots a day (today to 3 days ahead), one 15-minute link at a time (D-035),
  slot booked when paid; a missed payment is collected at the visit. Still to settle: amount, late payment = rebook or refund.
- **P-6** Patient privacy notice for appointment messages (WhatsApp) and payment links, naming AiSensy and Razorpay as
  processors; needed before WhatsApp or payments go live (COMPLIANCE). Owner: Pavin.
