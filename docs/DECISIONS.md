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

### D-036 · 2026-10-21 · Accepted · Pavin (day board/Today review)
**"Without a booking" means no appointment was made before the visit day; a missing MRD does not.** A new patient gets
their MRD only when first registered in Yarago, so a booking made for them earlier has no Yarago patient. Today now
matches each patient who came to a booking by Yarago patient, then MRD, then mobile number plus a shared name word
(never writing the link; the list says "not linked yet"). Names count as the same when they are near spellings
(SAIDALI / SAIDALAVI, B/O and BABY OF ignored); a booking of a new patient who has not come is "not arrived", never
"can't tell". Only a patient with no matching booking is a walk-in. **New-patient bookings get a temporary ID, never an SPD
number** (a no-show must not use up a real MRD): `NDC_YYYYMMDD_HHMMSS_<booking id>` in IST, the time the booking was
first made, the same shape the Google app uses. It stays in `app.appointments.mrd` until the booking is linked to the
Yarago record, which replaces it with the real MRD (the temporary ID stays in the booking's history). Search finds
it by any part. Not automatic: linking is still a person's action (`/api/appointments/:id/link`); P-2 covers the old backlog.

### D-037 · 2026-10-21 · Accepted (direction) · Pavin
**Sudarshan will replace Yarago, and queue management becomes part of Sudarshan.** Not built yet and not scheduled; PLAN.md
has the section "Later: replace Yarago and queue management". Consequences now: (1) the SPD number is the start of a
patient's history, issued only when a new patient has arrived and registered (today by Yarago, later by Sudarshan);
(2) the `NDC_` temporary ID is a booking-time label only: it is replaced by the SPD number when the booking is linked and
is not carried into the patient's record (the audit log still keeps the old value, as for every change); (3) Sudarshan
should keep writing nothing to Yarago and keep reading its stations through `clinical` views, so the queue can later move
to Sudarshan's own tables behind the same views.

### D-038 · 2026-10-23 · Accepted · Pavin (follow-up cards by team); Claude chose the rules and the ROP exit
**Follow-up cards are one team's list each, not risk tiers; a card number means "patients of this group who are overdue and still need a call".**
Cards: ROP, Injection, Laser, Diabetic retinopathy, Other retina, Routine, plus "All patients" (each patient counted once). A
patient can be on several cards, so the cards do not add up to the total; Routine = on none of the others. Rules
(`services/followupRisk.ts` `groupsFor`): Injection/Laser = given/done in the last 12 months; Diabetic retinopathy = latest
exam is DR/DME (coded diabetes alone is Routine); Other retina = vein occlusion, AMD, detachment, vitreous bleed, macular
hole/ERM, uveitis, CSCR, hypertensive or myopic retina; glaucoma is Routine. **ROP list** (checked on real data 23 Oct): the
patient's latest completed visit booked as ROP clinic/screening, or with ROP findings (ROP, prematurity, plus disease, ZONE,
mature retina), is within 12 months **and** has no MATURE RETINA finding. A mature retina ends screening (exit); no ROP visit
for 12 months also exits. **Dr. Sameera confirmed (24 Oct) that "Mature Retina" in the findings means ROP treatment is over.**
Chosen because Yarago has no "ROP finished" field. ROP babies ignore the "Overdue up to N days" choice (they are seen every 1-2 weeks) and the longest
overdue come first; other cards keep most-recently-overdue first. An age-0 infant with no ROP evidence is no longer in the ROP
card (still ranked first in the call order). **The call scripts are removed (Pavin, 24 Oct: they did not match what the cards show, not
needed):** no "What to say" in the call dialog, no Settings section, no `/api/followups/scripts`; D-027's scripts are retired.
The saved texts stay in `app.settings` (`followup.scripts`), unused; `followup.clinic_name` is still read by payment links. Real data:
ROP 32 babies (the old "Urgent" card showed 56, which also held injection and detachment patients). The analytics ROP rule
(Dr. Sameera, D-025) is unchanged.

### D-039 · 2026-10-24 · Accepted · Pavin (cards on the Patients page); Dr. Sameera confirmed the low vision rule
**The Patients page has one card per group with a paged list and Print; the lists are rebuilt nightly.** Cards: ROP, Injection,
Laser, Diabetic retinopathy, Glaucoma, Squint, Myopia, Low vision, Other retina. Only roles with `clinical.read` see them (front
desk keeps the search bar; the lists carry diagnoses). Nothing loads until a card is clicked; a list loads 50 at a time ("Show 50 more"),
with a find box and a sort, and Print fetches the whole list (up to 5,000), on A4 landscape, and records who printed which list in
`app.print_log` (kind `patient_list`). **Nightly, not live (Pavin):** `app.patient_group` is rebuilt by `app.refresh_patient_groups()` after
the 02:30 analytics rebuild, so a diagnosis entered today shows tomorrow; follow-up calls stay live. The table is in `app`, not
`analytics`, because it holds patient ids (the Metabase role cannot read it). Rules: ROP = a completed visit booked as ROP clinic /
screening or with ROP findings (status Active / Completed (mature retina, D-038) / no ROP visit for 12 months); Injection / Laser = at
least one given / done; the condition cards read the **latest examination with findings**, each group matched by its own pattern from
`analytics.category_rule` (so a patient with glaucoma and diabetic retinopathy is on both lists; the dashboards give a patient one
category); Squint and Myopia also count a booking for that clinic; Other retina = the nine conditions of the follow-up card.
**Low vision (WHO, confirmed by Dr. Sameera):** best-corrected vision in the better eye worse than 6/18 at the latest visit with a value
(both eyes must be recorded; a patient with one eye recorded is not counted), or anyone booked for low vision (reason says low vision / LVA).
First build 24 Oct: ROP 829 (60 active, 599 completed, 170 no ROP visit for 12 months), Injection 797, Laser 1,180, Diabetic retinopathy
1,803, Glaucoma 1,208, Squint 906, Myopia 652, Low vision 537 (442 by vision, 54 booked only, 41 both), Other retina 2,442.
Injection counts every injection Yarago marks as given, including sub-Tenon steroid (PST), as the follow-up board does.
**Age of a baby (Pavin, 24 Oct):** under one year the age is shown in days and months ("1 month 10 days"), never "0"; computed from the
Yarago date of birth by `clinical.age_text()`; one year and older stays in years.

### D-040 · 2026-10-25 · Accepted · Pavin asked ("the feature in D:/classification, admin only at present"; then admin + doctor role); Claude chose the design
**The research diabetic retinopathy grader moves into Sudarshan as a "Retina AI" page for admin and doctors, research use only.**
This lifts "the diabetic retinopathy model" out of PLAN.md's "out of scope". The model (Arko007/diabetic-retinopathy-v1, 413 IDRiD
training images, no published accuracy, not checked on Sampada patients) is **not a medical device**: its grade never goes into
clinical records, the doctor summary, follow-up cards or messages; every result says "Research use only" and "AI-generated · verify".
- **Where it runs:** the existing Docker container in `D:\classification\sampada-retinal-ai` (TensorFlow, CPU, 8 cores), now published
  on **127.0.0.1:7860 only** (was the LAN, with no login). Sudarshan's server sends it the photograph (and the file name, nothing about
  the patient) to `POST /api/grade` with a shared key (`RETINA_AI_KEY` = the grader's `GRADER_API_KEY`); the old Gradio page and its
  own `records.db` are switched off (`LEGACY_UI=0`). The photograph is held in memory and never stored, in either place.
- **Who:** new permission `retina_ai.use`, given to admin and the **whole doctor role** (Pavin chose the role over a per-user grant);
  not through the all-permissions list, so managers do not get it. Managers also do not see grades in the activity log (grade fields
  show as "set" / "changed"; sentences never name a grade).
- **Records:** `app.dr_gradings`, append-only by trigger (no delete; only remarks change), audited, in the nightly backup, linked to
  the Yarago patient. Every AI grade shown is logged in `app.dr_grading_views`. **The old `records.db` is not kept (Pavin,
  25 Oct):** its 4 records were random fundus photographs used to try the grader in September, with made-up MRDs, not
  patients. They were copied once on 25 Oct, then removed (migration 0019, in the activity log), and the grader's test
  databases and log lines with typed names are deleted by `scripts/remove-retina-test-data.ps1`. **The first real data
  will be photographs from Remidio, whose MRD is the SPD number.**
- **Validation (the point of the tool):** each doctor can give their own grade (`app.dr_doctor_grades`, one per doctor per
  photograph, or "not gradable"). It counts as **blinded** only if that doctor had not been shown the AI grade before saving it
  (worked out from the view log, again on every change). Doctors can grade first and see the AI grade after; a "To grade" list
  shows photographs without the AI grade. The Agreement tab uses blinded grades by default: exact and within-one agreement,
  quadratic weighted kappa, confusion matrix, and referable DR (grade 2 or worse) sensitivity / specificity.
- **Folder import:** `cli retina-batch` grades a folder with `metadata.csv` (filename, mrd_no, eye, reference_grade); reference
  grades need `--graded-by <user>` and are saved as blinded (they must have been given without the AI result).
- **Later (Phase 2, not built):** pull new photographs from Remidio's Host Gateway API (cloud, outbound only) once the TIRUR
  credentials arrive and the DR-grade field is known; DICOM stays dormant until Remidio confirms where it pushes from.
- **Known limits:** Docker Desktop starts only when someone signs in to Windows on shichika, so after a reboot the page says
  "not available" until then; Sudarshan itself is unaffected.

### D-041 · 2026-10-25 · Accepted · Pavin asked ("when can I see these images in Sudarshan"); Claude chose the design
**Fundus photographs come from Remidio into Sudarshan by themselves, and Sudarshan keeps a copy on shichika.** This changes
D-040's "the photograph is never stored" for Remidio photographs (uploaded photographs are still not kept).
- **How:** the server reads Remidio's Cloud Data Queue for site TIRUR every minute (Host Gateway API, outbound HTTPS only;
  nothing reaches shichika from the internet; webhooks stay off). For each IMAGE item it downloads the photograph and
  Remidio's thumbnail from the signed Google Storage link, stores them in `RETINA_PHOTO_DIR` (`D:\Sudarshan\data\fundus`,
  administrators and SYSTEM only, copied nightly to the backup's `fundus\` folder and never pruned there), records them in
  `app.fundus_photos`, and only then calls `itemSuccessfullyHandled`. A second job grades new photographs with the research
  model (D-040); the grade stays on the Retina AI page.
- **Patients:** matched by the SPD number in the FOP's MRN field. Remidio's birth date is not used (it is always 1 January:
  staff type an age); Remidio's sex is checked against Yarago and a difference is shown. Numbers that are not Yarago SPD
  numbers (e.g. the 39 "WSD" exams seen on 25 Oct) are kept unlinked by default (`retina.remidio_unmatched` = keep / skip,
  Pavin to decide after asking the team); a photograph can be linked to a patient once, never changed or removed.
- **Who sees photographs:** admin and doctors (`retina_ai.use`), on Retina AI (Photographs, To grade, Records) and as
  "Fundus photographs" on the patient page (photographs only, no AI grade). Widening to `clinical.read` is a later decision.
- **Switch:** `retina.remidio_mode` off / peek / on, admins only (Retina AI > System). Peek looks at the next item and shows
  its field names without taking it, to check the real queue item before the first "on". Remidio Connect's Cloud Data Queue
  must be On.
- **Safety:** store before acknowledging (a crash only causes a duplicate, which is recognised); an item that fails 10
  times is logged and taken off so the queue cannot jam (the photograph stays in Remidio's cloud); items that are not
  photographs (doctor reports, videos) are kept whole in `app.remidio_queue_log`, links removed, until Sudarshan reads them.
- **Already-taken photographs (added 25 Oct):** the queue is empty for past exams and the API gives no download link for them
  (exams list: storage paths only; getPatientWithLastExam: 404). Remidio Connect's per-exam **Download** does give them, laid
  out as `<MRN>_<time>/<NAME>_<MRN>_<dd-MM-yyyy>/FOP/<h.mm.ss.SSS_AM|PM>.jpg`; `cli retina-remidio-import` matches each file
  to the exam list by MRN, day and capture time (within 2 s), which gives Remidio's image id, eye, field and quality, and
  keeps it exactly like a queue photograph (a later queue copy is a duplicate). SPD numbers only unless `--all`. Checked on
  shichika 25 Oct with one real download: 2 of 2 photographs matched (right macula, left disc), both linked to Yarago.
  Downloading is done by a person in Remidio Connect (no automation of the dashboard).
- **Still open with Remidio:** what `itemSuccessfullyHandled` expects (Remidio's example sends no body); a bulk way to
  fetch past photographs.

### D-042 · 2026-10-25 · Accepted · Pavin ("doctors give their report and grade in Sudarshan only; only fundus photos from Remidio"); options chosen by Pavin
**Doctors report fundus photographs in Sudarshan, not in Remidio Connect; Remidio only supplies the photographs.**
- **The report:** one per photo session (a Remidio exam: one patient, one day). Per eye: DR grade (no DR / mild / moderate /
  severe NPDR / proliferative / cannot be graded), macular oedema (none / not centre-involving / centre-involving / cannot be
  assessed), other findings (glaucoma suspect, drusen/AMD, hypertensive retinopathy, vein occlusion, other with words); then
  referral (none / routine / urgent) and comments. Signed by the doctor who writes it (`app.fundus_reports`); never removed;
  a correction needs a reason and keeps the signer (the activity log keeps every version). It is a clinical record in
  Sudarshan (Sudarshan never writes to Yarago; D-037 direction).
- **Who:** doctors write and correct (`fundus.report`, doctor role only). **All clinical roles** (`clinical.read`: doctors,
  optometrists, counsellors, managers, admin) read reports and see the photographs; this widens D-041's admin + doctor for
  photographs. The research AI grade stays admin + doctor (`retina_ai.use`) and is never shown on the report screens.
- **AI measurement:** the report's DR grade per eye is the reporting (or correcting) doctor's grade of that eye's
  photographs in `app.dr_doctor_grades`, blinded when that doctor had not been shown the AI grade before; photographs graded
  by the AI after the report get the grade then. No separate grading step for doctors.
- **Screens:** "Fundus reports" (menu, with the doctors' to-report count): sessions to report / reported / all; a session
  opens with large photographs and the report or the form. The patient page's "Fundus photographs" shows the same sessions.
- **Remidio's own reports are not imported** (only one SPD patient has one; the March 2026 batch can be used later to measure
  the AI). Staff stop reporting in Remidio Connect.

### D-043 · 2026-10-25 · Accepted · Pavin ("start step 1: the local evaluation harness ... and the Phase 01 report"); Claude chose the method
**The retina AI is measured on frozen evaluation sets of Sampada's own Remidio photographs, against the doctor's blinded
grade from the Sudarshan fundus report, per model, with patient-level bootstrap intervals.**
- Reference grade copied into the set when it is made (`app.eval_set_items`); frozen sets never change and are never
  removed (trigger), so every model (now Arko007, later RFM and others) is compared on identical images.
- Metrics and method: AI_EVALUATION.md section 2 (referable DR = grade 2 or worse; AUROC from p2+p3+p4; 2000 patient
  resamples, seed 20261025). Cautions shown with every figure when the set is too small.
- Making, freezing and discarding sets: admin (`retina_ai.use` + `settings.manage`); reading results: `retina_ai.use`.
- Export: CSV with set codes (P001-RE-01) and month only; AI grades in it are logged as shown to the exporter.
- Public datasets (IDRiD test, Messidor-2, APTOS) are measured from the console (`cli retina-eval-external`) and never
  stored in the database (not Sampada patients).
- **Phase 01 conclusion (AI_EVALUATION.md section 1):** the existing model's original benchmark cannot be reproduced:
  none was ever published (no metrics, no split, no training code, checkpoint selection unknown).

### D-044 · 2026-10-25 · Accepted · Pavin (instructions for Phase 2)
**Arko007 is unreliable for clinical decision-making; RFM is installed and measured next; no model is promoted on
published figures or on a better score alone.**
- Arko007 stays available for research and comparison, labelled unreliable on the Retina AI page above every result
  (APTOS: referable sensitivity 70%, specificity 63%, 25% of proliferative DR called "No DR"). Its predictions are never
  used for patient advice, screening decisions or anything automated.
- RFM: loaded the safest way (`weights_only=True` where possible; source and checksum verified; no checkpoint or
  repository code executed); if it needed unsafe deserialisation, stop and explain the alternatives first. Code, classifier
  heads, backbone weights and the DINOv3 licence are checked separately for research, internal clinical evaluation and
  commercial use; nothing is assumed from a public repository. Own container; Arko007, Sudarshan and the interface
  untouched.
- Comparison on the same APTOS images, labels, referable-DR definition and metrics, side by side, including confusion
  matrices and false negatives; overlap with each model's training or tuning data stated.
- Local data: patients kept together in every split; a genuinely untouched test set kept for final validation.
- **Replacement rule:** a model becomes the default only after acceptable referable-DR sensitivity, particularly for severe
  NPDR and PDR, is agreed and shown **on Sampada photographs** (frozen evaluation set), not because it scores better.

### D-045 · 2026-10-25 · Accepted · Pavin ("Sampada's main objective for retinal AI")
**The retinal AI is measured and designed for DR screening and referral, not five-class grading.** Primary outcome:
referable DR (moderate NPDR or worse); sensitivity first, no missed severe NPDR or PDR; specificity and referral rate
measured; cut-offs chosen on validation data only; three outcomes (refer / uncertain / routine) with ungradable or
uncertain never cleared automatically; exact grade kept for research; on Sampada photographs sensitivity, specificity,
NPV, false negatives and referral rate; the DR outcome never clears a patient by itself (macular oedema, symptoms, image
quality); research mode until validated on Sampada data and permitted (AI_EVALUATION.md section 0).
First results (AI_EVALUATION.md section 5): Arko007 cannot screen; RFM is the candidate, both heads to be validated in
silent mode on Sampada photographs with cut-offs re-chosen on a Sampada validation set.

### D-046 · 2026-10-25 · Accepted · Pavin ("silent RFM grading of Sampada photos with screening outcomes"; purpose: non-commercial research and doctor assistance only, to see where doctor and AI differ)
**Every Remidio photograph is graded silently by each research model switched on, with a research screening outcome.**
- Models: setting `retina.graders`, at first `arko`, `rfm:aptos`, `rfm:messidor`; one AI grading per photograph per model
  (unique on photograph + model SHA-256). Uploads on the Grade tab still use Arko007 only.
- Outcome per grading: referral score p2+p3+p4 against that model's cut-offs in `retina.screening_cutoffs` (refer / uncertain
  / routine, D-045); Remidio INSUFFICIENT quality or a doctor's "not gradable" is always uncertain. Starting cut-offs are
  the APTOS validation ones (AI_EVALUATION.md section 5), labelled as such wherever shown.
- Silent: outcomes are shown only on the Retina AI page (admin and doctors), never on the fundus report form, the patient
  record, to patients or in messages; nothing is cleared or referred by them. The doctor's report stays the decision.
- The doctor grades a photograph once; the grade is stored against every model's grading of it, blinded per model.
- Evaluation sets have a role (validation / test / other). Cut-offs may be chosen only on a frozen validation set and are
  applied unchanged to another set; a patient already in a set of the other role is left out of a new set, and results
  refuse a validation set that shares a patient. Screening intervals resample whole patients.
- Not commercial: RFM's licence terms (AI_EVALUATION.md 4b) allow this research use; any clinical or commercial use still
  needs the head author's permission and review.

### D-047 · 2026-10-25 · Accepted · Pavin ("Yes, run the converter on shichika"); Claude proposed the plan (was P-7)
**Topcon Maestro2 fundus photographs, OCT and OCTA follow `docs/OCT_PLAN.md`; Topcon's DICOM OCT Export Tool runs on
shichika.**
- **Where the tool runs:** shichika, not the ImageNet PC (192.168.0.152) that drives the Maestro2.
  - The tool's licence key (US / OUS / Research tier) follows the Hardware ID of whichever PC runs it. The device's OCT and
    OCTA licences are separate and stay on the ImageNet PC.
  - So nothing new goes onto the Maestro2's PC, and the exports land where Sudarshan, the AI and the backup already are.
- **The ImageNet PC is read only,** through a read-only share. Sudarshan works only from checksummed copies; each export goes
  to a new, empty folder. The tool's temp files and logs stay in admin-only folders.
- **Order:**
  1. first export and data checks (Gates 1 and 2);
  2. Maestro2 fundus photographs into Retina AI, measured separately from Remidio (own evaluation sets and cut-offs, D-044,
     D-045);
  3. OCT and OCTA as research data;
  4. OCT AI only after a clinical question is chosen.
- **Licence:** Pavin asks Topcon for a Research key for shichika's Hardware ID. Until then exports are the US tier: 5 layers,
  no OCTA vessel density. Maestro2 has no FAZ figures from Topcon at all.
- **Pi NAS (192.168.0.107):** optional, and for de-identified sets only.

### D-048 · 2026-10-26 · Accepted · Pavin ("build Step 3: bring Maestro2 fundus photographs into Sudarshan's Fundus reports and Retina AI, with the off / peek / on switch, matched by SPD number. Test it on the test database first"); Claude chose the design
**Every new Maestro2 exam's colour fundus photograph comes into Sudarshan by itself, like a Remidio photograph (D-041):**
it is kept on shichika, linked by SPD number, reported by doctors (D-042) and graded silently (D-046).
- **How:** every minute the server reads IMAGEnet's exam folder through the read-only share (`\\192.168.0.152\SudarshanOCT$\Data`):
  1. copies a new exam (`<number>.fda` + `.fds`) to an administrators-only work folder;
  2. converts the copy with Topcon's tool (`-dcm`);
  3. turns the colour OP photograph into a JPEG with `scripts\topcon_photo.py` (pydicom + OpenJPEG);
  4. keeps the JPEG, a thumbnail and the OP `.dcm` in `RETINA_PHOTO_DIR`, then empties the work folder.

  The infrared photograph and the OCT/OCTA objects are not kept (Step 4 of OCT_PLAN decides their storage). ImageNet is
  never written to.
- **Which exams:** only those saved from `retina.topcon_since` on. When the import is first switched on, the start point is
  set to that moment (IMAGEnet holds years of exams); an admin can move it earlier. An exam is taken once it has not
  changed for 2 minutes. An exam that fails 5 times is logged and left in IMAGEnet.
- **Patients:** the DICOM patient ID is the SPD number (OCT_PLAN Step 1). It is linked like Remidio's MRN, and the DICOM sex
  is checked against Yarago's. Other IDs are kept unlinked or skipped (`retina.topcon_unmatched`).
- **Switch:** `retina.topcon_mode` off / peek / on, for admins only (Retina AI > System). Peek converts the next exam and
  shows its shape only.
- **Sessions:** a patient's Maestro2 photographs of one day are one fundus report session (session 0 of the day; Remidio
  sessions keep their exam id).
- **Measured apart:** Maestro2 is another camera. Evaluation sets have a camera (Remidio by default, so older sets keep
  their meaning). Cut-offs chosen on one camera's validation set are refused for the other's. D-044's replacement rule
  applies to each camera on its own photographs.
- **The share password** is in `.env` (`scripts\setup-topcon.ps1`): the server runs as SYSTEM, which cannot use a cmdkey
  credential saved in Pavin's sign-in.
- **Testing:** tested on the isolated Docker test database (D-048 adds it to CLAUDE.md). It was also checked once in peek
  mode with the real share, tool and converter on a real exam: nothing was kept and the log line was removed.

### D-049 · 2026-10-26 · Accepted · Pavin ("start step 4, along with Orthanc/OHIF evaluation"; "today's OCT work to Sudarshan ... then after clinic hours ... the whole data"); Claude chose the design
**Maestro2 OCT and OCTA scans are kept in Sudarshan and shown in its own OCT viewer (OCT_PLAN Option C, without Orthanc
for now). IMAGEnet's past exams can be imported outside clinic hours, Jukebox archives included.**
- **Export:** `-dcm -segDcm -enfaceSlabs`, from the `.fda` alone. On 26 Oct a real OCTA exam gave the same 11 objects
  with and without the `.fds`. Kept per exam in `OCT_DIR` (`D:\Sudarshan\data\oct\store`, in the nightly backup's
  `oct\`):
  - the DICOM (B-scans, photographs, Topcon's layer surfaces, OCTA flow volume and en face slabs);
  - viewer files made by `scripts\topcon_photo.py`: B-scan JPEGs, scan lines on the colour photograph, layer heights,
    slab PNGs.

  The binary flow mask and the metadata stub are not kept.
- **Records:** one `app.oct_studies` row per exam, linked to its colour photograph and the Yarago patient, kept for good
  like the photographs.
- **Viewer:** in each fundus report session and on the patient page. It shows the photograph with the scan lines (click
  one to show its B-scan), the B-scans (slider, arrow keys, wheel, depth ×1-4), Topcon's layer lines (US tier, "not
  checked by Sudarshan"), brightness and contrast, and for OCTA the four slabs (click to jump). Clinical roles
  (`clinical.read`). IMAGEnet stays the full viewer.
- **This morning's exams:** the import has a version. Exams done by the photograph-only version are done again: the
  photograph is recognised, the OCT added.
- **Past exams** (saved before today) are converted, and their photographs graded, only in `retina.topcon_backfill_window`
  (20:00-07:00 and Sundays). Today's exams go first.
  - Maestro2 sessions before `retina.topcon_report_from` (26 Oct) stay off the doctors' "To report" list, but remain under
    All and on the patient page.
  - The Jukebox archives are read with their subfolders once shared (`TOPCON_ARCHIVES`). A copy of the same exam in two
    places is recognised by its DICOM UIDs.
- **Orthanc + OHIF (Step 4b) on de-identified copies:**
  - Orthanc stores and returns every object byte for byte.
  - It cannot decode the OCTA flow and slab JPEG 2000 (no preview, transcoding fails) or serve the height-map layers.
  - OHIF lists every series and opens the B-scan stack.
  - It shows neither scan lines on the photograph nor Topcon's layers.

  **Not adopted now.** It would add a 500 MB service without giving what the viewer needs. Look again if ImageNet can send
  DICOM to a receiver (question 5 for Topcon), or if a standard viewer is wanted beside Sudarshan's.
- **Storage:** about 83 MB per OCTA exam and 9 MB per radial exam. IMAGEnet's whole history (about 9,400 live exams plus
  the Jukebox) would be roughly 150-300 GB, more than D: has free (218 GB). Pavin decides where before the full backfill.

### D-050 · 2026-10-26 · Accepted · Pavin ("add A-D to the plan ... start with item 1 ... take any number of scans' CST values from IMAGEnet for the validation"); Claude chose the method
**Sudarshan measures retinal thickness from Topcon's own layer lines, checks it against IMAGEnet before anyone relies on
it, and shows it beside injections and vision (OCT_PLAN Step 7).**
- **What is measured:** central subfield thickness (CST, the central 1 mm) and the 9 ETDRS sectors (1, 3, 6 mm), ILM to BM
  and ILM to OS/RPE (IMAGEnet offers more than one definition). It covers 3D macula cubes (32 or more B-scans) and radial
  macula scans; other scans are not measured.
  - **Centre:** a cube's thinnest point within 1.5 mm of the scan centre (the foveal pit); a radial scan's crossing point.
  - **Direction:** from each scan's lines on the colour photograph. Superior is up. Nasal is the optic disc's side: the
    image's right for a right eye (checked on Maestro2 photographs on 26 Oct).
  - **Gaps:** a sector less than half measured is left empty, never guessed.
- **Where it lives:** `app.oct_thickness`, one row per scan and method version. It is derived data: a new method adds
  rows. Scans are measured after import, and every scan kept earlier is measured too.
- **IMAGEnet's CST is not in the `.fda`** (checked on 26 Oct: its blocks hold contours, not thickness). So the check is
  done by a person:
  - `cli oct-thickness-sheet` writes `D:\Sudarshan\data\oct\work\cst_check.csv` (administrators only, names patients).
  - Staff type IMAGEnet's CST next to Sudarshan's for any number of scans.
  - `cli oct-thickness-compare` prints the agreement only: bias, SD, 95% limits, mean and largest difference, r; by
    definition and by cubes / radial.
  - Pavin decides whether it passes; `--record ILM-BM` then stores the result in `retina.oct_thickness_checked`.
- **Screens:**
  - an ETDRS grid in the OCT viewer;
  - "OCT thickness and injections" on the patient page: CST per eye over time with Yarago's injections and best corrected
    vision.

  Both say "not yet checked against IMAGEnet" until the check is recorded, and give its figures after.
- **Not used for decisions:** nothing is flagged or suggested from thickness until the gate passes (Steps 8-9).

### D-051 · 2026-10-26 · Accepted · Pavin ("first as a group ... after a week we will break that assessment for each login and give points"; "items which are measured at present under EMR completeness, both for new patients and review patients"); Claude chose the method
**EMR daily report at 17:30, for the team first.** A page (`/emr-daily`, clinical roles) lists the day's consultations
by MRD with the EMR completeness items (D-028) not recorded in Yarago. There is one view per screen: optometry for the
optometrists, the doctor screen for the doctor.
- **Rules:** structured checks, no AI. Every item is expected at every consultation, new or review. Injections and
  lasers are left out, as on the monthly page. Visits still "checked in" or "in examination" in Yarago are listed
  separately and not counted.
- **One check:** `clinical.emr_visit_items()` tests each visit. The monthly page now counts from it too; on 26 Oct its
  figures matched the stored ones exactly for the 12 earlier months.
- **17:30:** the server keeps what was missing then (`app.emr_daily_reports`, setting `emr.daily_at`). Items saved later
  show as "added later", so the report can be used for coaching that evening.
- **Who:** week 1 shows no login or person. Yarago records the optometry login that saved a visit in
  `tbl_patient_appointment_history.refuser` (last 30 days: `opto` 797, `spdopto` 13). After a week, with a personal
  Yarago login per optometrist, scores per login follow (not built). Visits saved under the shared logins cannot be split
  afterwards. The doctor screen stays under the doctor's login, one report for the doctor (890 of 891 visits are `sam`).
- **Same-day data:** Yarago saves the optometry and doctor screens into the visit record without changing
  `dtupdated_date`, the sync's change column for that table. On 26 Oct, 1 of 25 completed visits had BCVA in the mirror;
  earlier days had 22-33 of 28-43. So each sync cycle now re-reads today's visit records by appointment id (a few dozen
  rows, only if that column is indexed in Yarago; the log says so once if it is not).
- **Privacy:** MRD, time and new/review only: no name and no phone. Not sent by email or WhatsApp.

### D-052 · 2026-10-28 · Accepted · Pavin (the reconciliation brief; answers 28 Oct: Zoho Books API read-only, "Manager + admin by role", admin self-approval "Yes, with a flag"); Claude chose the rules
**Money reconciliation: Yarago against the Zoho bank, with approved adjustments.** Pages "Reconciliation" and
"Adjustments" (manager and admin). METRICS.md "Reconciliation" has every definition.
- **Zoho access:** Sudarshan reads the Zoho Books REST API with its own Self Client and READ scopes only
  (`scripts/setup-zoho.ps1`, keys in `.env`). The Claude-side Zoho MCP cannot be used by the server: it has no
  bank-transaction tool, and it also exposes create and delete tools. The client refuses every request except a GET and
  the token refresh. A copy of the bank lines is kept in `app.zoho_*`, refreshed every two hours 08:00-22:00 and on demand.
  A changed line keeps its old version; a line that is gone is marked, never deleted.
- **What Zoho holds (checked 28 Oct, read only):**
  - Basith enters one "Patients" invoice per clinic day, about 12 days late, with two lines: "Consultation Fee" (all
    clinic services) and "Sales of Medicines" (pharmacy and optical).
  - Cash is paid into Petty Cash. UPI and card arrive in the current account the next day, as
    `UPI SETTLEMENT -RYX181- dd/mm/yy` and `...TERMINAL 1 CARDS SETTL. dd/mm/yy`, with no fee taken out.
    (Corrected by D-053: that was the bookkeeper's payments; the bank lines show card settled net of the fee.)
  - 1 Sep - 10 Oct: Yarago matched Zoho for card on 32 of 33 days, UPI on 21 and cash on 18. The rest were refunds and
    method mix-ups (for example ₹14,553 entered as cash on 16 Sep, paid by UPI). On 9 Oct the UPI settlement was ₹2,400
    short: a refund Yarago shows as cash had been paid back by UPI.
- **Rules:**
  - Matching is per day and method, because Yarago records no UPI or card reference (0 of 878 UPI bills).
  - A credit counts only through a bank rule or an approved classification. Unrecognised credits are listed and never
    counted.
  - A match is made only when it is the only possibility both ways. Otherwise the day is "Uncertain", with the candidates
    listed.
  - "Waiting for settlement", "Bank data not available" and "Cash not yet deposited" are not differences.
  - Payment methods are shown per source (clinic bill, pharmacy), never split across categories.
- **Adjustments:**
  - A manager or admin sends a request; it counts only once an admin approves it.
  - What it changes (its "effects") is worked out once when it is sent and then fixed. The tally sums the effects of
    approved requests, so nothing is "applied" and nothing can be applied twice.
  - The same form sent twice is one request. The same correction to the same record cannot be pending or approved twice.
  - Of two approvals at once, one wins.
  - An approved request is changed only by an approved reversal, which may carry a replacement.
  - Rejecting needs a reason.
  - The admin may approve their own request with a note, and it is then shown as "self-approved" (Pavin, 28 Oct; there
    is one admin).
  - A trigger refuses edits to what was sent, backward status moves and deletion. Yarago and Zoho are never written.
- **Kinds:**
  - refund by another method (the UPI or card payment stays collected; the refund counts against the method actually
    used);
  - payment method correction;
  - amount correction;
  - date correction;
  - payment missing from Yarago;
  - fee or bank charge;
  - classify a bank credit.

  References are text: Sudarshan stores no attachments.
- **Assistant (optional):** the local model (`ai.recon_model`, Ollama) explains the result shown. It sees no names, MRDs,
  bill numbers, bank wording or typed explanations. Its text is shown only if every number in it is in what it was
  given, and every answer is logged (`app.recon_assistant_log`). It calculates, changes and approves nothing.
- **Categories:** consultation = Consultation & charges. Procedure = investigations, injections, lasers, other
  procedures and other charges. Pharmacy and optical as D-032. The mapping is the setting `recon.category_map`.

### D-053 · 2026-10-28 · Accepted · Pavin (answers 28 Oct: all cash banked, rounded to ₹10/50/100; a manager records each deposit, blind; cash in hand never over ₹4,00,000, in its own colour; finance per login, only Dr Sameera and chosen managers; HDFC POS; use HDFC's published rates until the bank's); Claude chose the rules
**Per-login access, the cash book, and bank fees.** Migration 0029.
- **Access per login:** a login has its role's permissions plus the admin's changes for that login
  (`app.user_permissions`; only differences are stored, audited, applied on the next request). Users > Access lists
  every permission by page. An admin's access is fixed (everything but writing fundus reports, D-042). Finance is no
  longer part of the manager role. Dr Sameera (`sam@sampada`) gets the full finance view and adjustments by name
  (migration); managers are chosen on the Users page.
- **Finance levels:** cash desk (`cash.deposit`: records deposits, sees only its deposits and the limit in words);
  full view (`reconciliation.read`: reconciliation, cash book with checks, bank fees); approve (`adjustments.approve`:
  admin; adjustments, bank rules, fee rates, cash settings, voiding a deposit).
- **Cash book:** the desk records each deposit (day, cash up to which day, amount, slip) without seeing Yarago's cash.
  Yarago cash of the covered days + the drawer's carry - the deposit is carried forward; within ±₹99 (setting
  `cash.limits.carryBand`) it is rounding, beyond it Short or Excess. A deposit is "in the bank" when exactly one
  cash-deposit credit of the same amount is dated within 3 days after it. A recorded deposit never changes; an admin
  voids a wrong one with a reason. Cash in hand: blue (`--cash`) below ₹3,00,000, amber from it, red at ₹4,00,000.
  The book starts with the cash of 11 Oct 2026 (the 17 Oct deposit covered 1-10 Oct); setting `cash.book`.
- **What the first live Zoho read showed (28 Oct, read only):**
  - Zoho lists a bank account's lines from the ledger's side: money in is "debit". 0028 read it the other way;
    0029 turns the stored lines round from Zoho's own field, and the fetch now does.
  - Zoho ignores date filters on bank lines and leaves uncategorised feed lines out of `Status.All` (175 lines, up to
    21 Oct, among them every cash deposit since September). The fetch now reads both lists, newest first, and stops at
    the period.
  - HDFC settles **card net of its commission** (23 Sep: ₹11,458 in Yarago, ₹11,391.74 in the bank; 0-2.6% a day). UPI
    arrives whole but for a few rupees. Cash deposits read "CASH DEPOSIT BY - name - TIRUR" (rule switched on). The
    terminal's service charge is ₹116.82 (₹99 + GST) on the 15th of each month (rule `bank_charge`).
- **Bank fees:** a card or UPI credit matches its day when it equals the day's money or is less by no more than the
  dearest fee the bank could keep on that day's payments (international card rate, GST included; Yarago does not
  record the card type). What was kept is shown as the day's bank fee: "Settled less bank fee", or "Fee higher than
  expected" above the dearest usual card (credit). Uniqueness both ways still applies. Rates are rows in
  `app.bank_fee_rates` in force from a day; seeded from HDFC's published SmartHub schedule (credit 1.85%; debit 0.40%
  up to ₹2,000, 0.90% above, at most ₹1,000; RuPay debit 0; international 3%; UPI free, 0.40% above ₹2,000 at most
  ₹300 from 15 Oct 2026; 18% GST) until the bank sends the POS agreement's rates. Card days not settled within 2 days
  are listed (HDFC's late-batch fee).
- **The clinic's own rates (HDFC to Pavin, 28 Oct, terminal TID 66027444; migration 0030, replacing the placeholders):**
  RuPay domestic debit and UPI zero; other debit cards 0.40% up to ₹2,000, 0.90% above; credit cards 1.60%; business,
  commercial and foreign cards 2.75%; all + tax; service charge ₹116 a month per terminal; rental waived. UPI from a
  RuPay credit card is not in the bank's message: it is taken at the credit-card rate above ₹2,000.
- **Bank data is known up to the last bank line copied**, not Zoho's feed-refresh date (28 Oct: refreshed 28 Oct, lines
  to 21 Oct). Cash days before the cash book's start are "Before the cash book", not cash in hand.
- **Checked on live data with these rates (1 Sep - 21 Oct):** card 30 of 32 days settled (3 whole, 26 net, 1 above
  the credit-card rate: 3 Oct, 2.57%); fees kept 1.1% in September, 1.5% in October. No settlement for 9 Sep
  (₹18,520) and 17 Oct (₹3,200) card money. (26 Sep, ₹1,58,305, settled: its line was uncategorised and missed before
  the fetch fix.) UPI: 17 Oct settled ₹764.32 short of ₹73,649 (1.04%) although the agreement says UPI is free: to ask
  the bank.

### D-054 · 2026-10-28 · Accepted · Pavin (28 Oct: "a page to understand and audit how well Zoho Books is maintained … so I can [have] Basith clean up his work"; Basith gets no login, Pavin or Dr Sameera print his sheet every Friday, he comes once a week, "set all targets accordingly"); Claude chose the checks
- **Books audit page** (permission `books.audit`: the admin, and Dr Sameera by migration 0031). It measures how well
  Zoho Books is kept, from Sudarshan's read-only copy, and prints the audit sheet for Basith.
- **Weekly targets:** work dated more than 7 days ago (`dueDays`) must be done; newer work is "not due yet" and never
  makes a check amber or red. Each check is green (nothing due), amber (a few, usually up to 3) or red. "Not measured"
  when Zoho has not let Sudarshan read that part. Score = 2 points per green check, 1 per amber, of 2 per measured check.
- **Checks:**
  - **Bank statement:** last bank line at most 3 days old; no settlement day missing (a clinic day with UPI or card and
    no bank line on either of the next two days); no line imported twice.
  - **Bank lines categorised:** money in, money out (each with what to book it as: UPI or card settlement = customer
    payment; cash deposit = transfer from Petty Cash; terminal charges = Bank Fees and Charges); clinic money booked as
    the wrong kind.
  - **Daily Patients invoice:** one per clinic day; total within ₹100 of Yarago's collection that day (payments less
    refunds); no unpaid balance; entered within 7 days on average.
  - **Expenses, from 1 Oct 2026 (rules new to Basith):** a narration of his own (not the bank's text, at least 8
    characters); a vendor from ₹1,000; a receipt from ₹2,000; not in a catch-all account; none paid from Petty Cash (all
    clinic cash is banked, D-053).
- **The sheet** lists only what is due, oldest first, at most 150 lines a check, with a box to tick. The score is saved
  after each Zoho read (`books_audit_snapshots`) and shown week by week (Saturday to Friday).
- **More of Zoho, still read only:** invoices and expenses (scopes `ZohoBooks.invoices.READ`, `ZohoBooks.expenses.READ`,
  added by running `setup-zoho.ps1` again). Without them the bank is still copied and those checks are "not measured".
  The first Zoho read of each day goes back to the audit's start (1 Apr 2026), so late categorisation is seen.
- **The HDFC statement imported by PDF (28 Oct; Yodlee's feed broken since 21 Oct):**
  - Its lines spell the UPI merchant id in full (RY9181; the feed masks it as RYX181) and have double spaces. Rules now
    match the description with spaces collapsed, and the UPI rule takes either id.
  - Zoho holds a line twice when a statement is imported over the feed. Such a repeat (same account, day, side, amount
    and wording, with digits and X made equal and the feed's "Ref Num" left off) is counted once by the reconciliation
    and the cash book: the categorised copy is kept, else the older. The audit lists the copies for Basith to exclude.
    On 28 Oct: 8 such pairs since 30 Aug.
  - The terminal charge rule also takes "LOW USAGE CHARGES" and "SETTLEMENT CHARGE", and the masked month ("SEPXX").
- **Found on live data, 28 Oct:**
  - **A second card terminal**, TID 64061321 (merchant EGD494), costs ₹116.82 a month and ₹588.82 a month in
    low-usage charges (since June 2026). A third merchant id, EHD956, had a ₹1.18 settlement charge in August.
  - With the PDF lines, 22-26 Oct card settled net: ₹809.56 kept on ₹59,716. 21 Oct card and 19 and 21 Oct UPI did not
    match: the bank paid more than Yarago shows (₹1,370.60 card, ₹2,800 and ₹569.79 UPI).
  - The daily "Patients" invoices end at 10 Oct, entered 12-15 days late; 26 Sep (₹2,59,074) is unpaid in Zoho.
  - Expenses paid from Petty Cash in Sep-Oct (food, fuel, flowers) although all clinic cash is banked.

### D-055 · 2026-10-28 · Accepted · Pavin (28 Oct: "we have three POS machines but one terminal ID … UPI has Bharat QR and UPI QR, and Bharat QR has charges"; 5 Oct = ₹2,400 from EHD956 + ₹42,048 from RY9181); Claude chose the rules
- **The bank shows three terminals, each with its own merchant id**, not one:
  - TID 66027444, merchant RY9181: almost all card and UPI money; ₹116.82 service charge a month, small settlement
    charges.
  - TID 64061321, merchant EGD494: no money since April 2026 (card to 24 Apr, UPI to 31 Mar), yet ₹116.82 service
    charge + ₹588.82 low-usage charge every month since July 2026 (₹705.64 a month).
  - TID 69348544, merchant EHD956: a little UPI and card (17 and 30 Jul, 5 Oct); ₹1.18-3.54 settlement charges in the
    months it is used.
- **Matching (services/reconcile.ts), in this order after a single credit:**
  - 2-3 credits of one date together equal one day (one settlement per merchant id);
  - one credit for a run of 2-3 days (as before);
  - two consecutive days settled by two credits that together equal them (a payment after the bank's cut-off settles
    with the next day: 2 and 3 Sep, ₹95 moved);
  - Bharat QR: when a day's UPI settlement is MORE than its UPI and the same day's card has one credit on the same date,
    card and UPI are taken together, less no more than both days' dearest fees (3 Oct: ₹829.38 kept, 1.57%, where card
    alone looked like 2.57%). A UPI settlement short of the day is never explained this way.
  Each needs the pairing to be the only possibility; otherwise the day stays a difference or uncertain.
- **Lines the bookkeeper combined:** when several statement lines are matched to one customer payment, Zoho lists that
  payment with no description (7 such lines since 1 Sep). It is recognised by the payment's mode in Zoho ("UPI Payment",
  "Card Swipe").
- **The UPI rule takes any merchant id** (`UPI SETTLEMENT -XXXXXX-`, migration 0032).
- **Live effect, 1 Sep - 27 Oct:** UPI differences 17 → 15 days, uncertain 2 → 0. The UPI days still different are
  Yarago entries to correct (for example 9 Oct, a ₹2,400 refund paid by UPI and recorded as cash).

### D-056 · 2026-10-28 · Accepted · Pavin (28 Oct: "all sections ... only showing the clinic part and not pharmacy; bank deposit is combination of both"; "Yes, build it"); Claude chose the layout
- **Pharmacy money was already counted** (since D-052) but only as part of each total, so the page read as clinic-only.
  Every money figure on the Reconciliation page now shows its two parts: **Clinic** (clinic bills, OPD refunds) and
  **Pharmacy & optical** (pharmacy and optical payments, sales and refunds).
- **The bank side stays combined.** HDFC settles and the cash desk deposits clinic and pharmacy money together, so
  matching, fees, cash deposits and adjustments still work on the day's total per method; the parts are shown beside it
  and always add up to it.
- **Revenue:** consultation and procedure under Clinic; pharmacy and optical under Pharmacy & optical; a subtotal each.
  Methods are still shown per source, never split across categories (D-052).
- **Same day:** pharmacy orders and their lines are copied every cycle like the pharmacy payments (they were nightly,
  so a day's pharmacy payments were missing until the next morning: 32 rows on 28 Oct), and a pharmacy payment counts
  even before its order is copied (its bill number follows).

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
