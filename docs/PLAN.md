<!-- PLAN.md: the implementation plan. Exported from the Claude Docs "Sudarshan Local Migration Plan"
     (https://claude.ai/artifact/Bs7PvmeVtvysVNUGiMvbSZ) on 19 Oct 2026. From now on THIS file is the copy agents follow;
     the Claude Docs version is for reading and commenting (Dr. Sameera's summary review). Where the build has
     deliberately differed from the plan, DECISIONS.md says so and wins. Progress is tracked in STATUS.md. -->

# Sudarshan Local Migration Plan

2026-10-18 · Pavin Pankajan

Sudarshan moves from Google Apps Script and Sheets to a local app on shichika, reading a near-live mirror of the full Yarago database. The Google app keeps running until the new one is ready. Read-only AI features for doctors and the team ship first; the booking engine moves last.

## Scope

Sudarshan stays clinic-only, for 6 staff today and up to 10, plus doctors reading AI summaries. Nothing is exposed to the internet.

- **Moves to shichika:** appointments, follow-ups, direct calls, triage, scheduling rules, slot planning, confirmations, WhatsApp broadcast, Razorpay payments, audit log, reports.
- **Replaced by the Yarago mirror:** patientMaster, yaragoPatientMaster, followup, followupMaster, followupMaster2, emrBilling, optPharBillingMaster, and the nightly 23:00 sync script.
- **Dropped:** Sheet42, old_AuditLlog, empty Settings, tempPatientMaster, _ChartData tabs, optimizer scratch tabs.
- **New:** doctor summaries, follow-up leakage board, automatic attended/no-show, patient-flow timings, injection tracking, daily huddle brief, ask-the-data for Pavin.
- **Direction (D-037), not yet scheduled:** Sudarshan eventually replaces Yarago (registration, MRD issue, EMR, billing)
  and takes over **queue management** (check-in, stations, token and waiting display, which today run on Yarago's station
  timer). See "Later: replace Yarago and queue management" below.
- **Out of scope for now:** OCT and fundus images, the diabetic retinopathy model, patient-facing booking.

Shichika has the capacity: 32 GB RAM (about 16 GB free today) and an RTX 4070 with 12 GB.

## Architecture

(diagram in the Claude Docs version)

Yarago is only ever read; the app reads and writes PostgreSQL alone, so a Yarago outage or upgrade never stops booking.

## Stack

One language for the app (TypeScript), Python only for the Yarago sync, and every part runs as a Windows service that starts on boot.

| Layer | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16 + pgvector, native Windows service | Safe concurrent writes, real roles, JSON, AI search. Schemas: `yarago` (raw mirror), `clinical` (decoded views), `app` (Sudarshan data) |
| Yarago sync | Python 3.13 worker (pymysql, psycopg) | Extends the existing script; MySQL 5.6 quirks handled in one place |
| Backend | Node.js 24 LTS + TypeScript + Fastify | Scheduling-rule logic (RuleEngine, slot optimizer) ports from existing JS; types catch runtime errors |
| Frontend | React + Vite + TypeScript, Tailwind | Rebuilt screen by screen; most reliable for Claude-assisted development |
| Jobs | node-cron inside the backend | Replaces the 8 Apps Script triggers |
| Email | nodemailer via the clinic Workspace account | Replaces MailApp |
| Web front door | Caddy, `https://sudarshan.local`, internal TLS | HTTPS on the LAN; firewall allows clinic subnet only |
| Services | NSSM (Postgres has its own service) | Auto-start, auto-restart, logs to D: |
| Local AI | Ollama, 12-14B model at 4-bit (Qwen 2.5 14B or Gemma 3 12B, about 9 GB VRAM) | Patient-identifiable summaries never leave shichika |
| Cloud AI | Claude or Gemini, de-identified or aggregate data only | Better reasoning for non-PHI tasks |
| Code | Git repo in `D:\Sudarshan\app`, private GitHub remote | History, rollback, Claude Code workflow |
| Backups | Nightly `pg_dump` to QNAP + weekly copy to Google Drive, monthly restore test | Replaces Google's free durability |

## Yarago mirror

All 337 non-empty Yarago tables (11.4 million rows, 1.2 GB, MySQL 5.6.47) are copied into the `yarago` schema; about 40 hot tables refresh every 2-3 minutes, the rest nightly.

| Group | Key Yarago tables | Rows | Refresh |
|---|---|---|---|
| Patients | tblpatientregistration, tblprofiledetails, tbllinkpatientcurrentappointment | 13k | 2-3 min |
| Visits | tblappointments, tbl_patient_appointment_history, tbl_opto_patient_appointment_history | 51k each | 2-3 min |
| Diagnosis | tbldiagnosis, tblfinaldiagnosis, tbldiagnosis_history | 222k | per changed visit |
| Vision and IOP | tblbcva_values, tblucva, tbloptometryexamination, tblvisionsubtable | 222k-889k | per changed visit |
| Examination | tbleyeparts_examination_details_for_patient, tblcomplaints, tblophthalmic_history_details_for_examination, tblsysillness | 265k-1.1M | per changed visit |
| Treatment | tblpatientinjectionopdinvestigationdetials, tblpatientlaseropdinvestigationdetials, tblpatientissurgery, tbladvice, tblnewprescription, tbldrugallergy | 1k-381k | per changed visit |
| Follow-ups | tblfollowuppatientdetails, tblpatient_followup_smsdetails | 41k-45k | 2-3 min |
| Clinic flow | tbltimerpatientwaiting, tbldilatationpatientslist | 45k-631k | 2-3 min |
| Billing | tblpatientsappointmentbillingdetails, tbl_patient_payment_duedetails, tbl_payment_receptionist_new, tblopticalpatientpayment, tbl_payment_injectionorlaser_procedure_for_billing | 5k-56k | 2-3 min |
| Masters | tbldoctor, tbl_user, tbl_mst_* (diagnosis, sphere, plan of action, instructions) | under 3k | nightly |
| Everything else | the remaining ~290 tables | varies | nightly |

**How changes are detected**

1. **Tables with a modified date (267 of 337):** copy rows where the ID is new or the modified date is later than the last sync.
2. **Clinical child tables without a modified date (about 70):** when a visit changes in `tblappointments` or `tbl_patient_appointment_history`, re-copy every child row with that appointment ID.
3. **Nightly at 01:00:** full copy of all 337 tables into a staging schema, swapped in when complete (about 10 minutes). Catches deletes and anything the first two rules miss.
4. **Schema watch:** every run compares Yarago's columns to the last known list; a change is logged and alerted, never silently dropped.

**Conversion rules:** MySQL `0000-00-00` dates become NULL; codes such as `sph_R_Id` and `DVA_R_Id` are decoded once into readable values in the `clinical` views, so neither the app nor the AI ever reads raw codes.

**Access:** a new MySQL user `sudarshan_ro` with SELECT only replaces the root login. Confirm MySQL listens only on 127.0.0.1.

## Sudarshan data model

The 49 sheet tabs collapse to about 15 tables in the `app` schema; every record gets a permanent ID instead of a sheet row number.

| New table | Replaces | Notes |
|---|---|---|
| appointments | appointment, cancel, old_cancel, Archive, appointment_archive | One row per booking; `status` = booked, confirmed, arrived, completed, cancelled, no_show, waitlist. Unique rule on (date, doctor, slot) blocks double booking |
| appointment_events | RescheduleHistory, AppointmentJourney, RemarksHistory, Tag changes | Every change with who, when, old and new value |
| followup_actions | followup, followupArchive, CommentsHistory | Staff actions on Yarago follow-ups; the follow-up itself stays in the mirror |
| direct_calls | directCall | Linked to the resulting appointment |
| triage | urgencyIdentification | Scores and decision kept |
| doctor_schedule | DoctorAvailability, DoctorAvailabilityExceptions, DoctorLeaveDays, Holidays | One calendar model |
| capacity_overrides | planningB maxSlots edits | planningA and planningB counts become calculated views |
| rules | RuleSettings, generalSettings, PlanOfActionMaster | Versioned, editable in settings |
| broadcasts, messages | Broadcast, EmailAudit | Every WhatsApp and email sent |
| payments | Payment sheets | Razorpay links and status |
| users, sessions | Login, SystemSettings | bcrypt passwords, cookie sessions |
| audit_log | AuditLog, AuditLogArchive | Append-only; 16k existing rows imported |
| kpi_daily | DailyKPIReport, monthlyReport | Calculated nightly |
| ai_summaries | (new) | Summary text, source record links, model, prompt version, who viewed it |

The Sheets data is imported by a repeatable script reading the live spreadsheet through the existing service account, so every rehearsal uses fresh data and the final cut-over is one more run.

## AI features

The doctor summary ships first because the data for it already exists in Yarago; every fact in it comes from the database, and the model only writes the two-line overview.

**Doctor summary (draft layout for Dr. Sameera to review)**

1. **Overview** (AI, 2 lines, labelled "AI-generated - verify"): e.g. treatment course, trend, what is due today.
2. **Diagnosis by eye** (data): current diagnoses RE / LE with first-recorded date.
3. **Vision trend** (data): last 5 visits, BCVA RE / LE, with direction arrows.
4. **IOP trend** (data): last 5 readings RE / LE.
5. **Treatment history** (data): injections (drug, eye, date, number in course), laser, surgery; next injection due.
6. **Alerts** (data): drug allergies, systemic illness (diabetes, hypertension), missed follow-ups, unpaid dues.
7. **Last visit** (data): complaints, advice, plan.

Every line links to the Yarago visit it came from. Summaries for the day's booked patients are generated from 07:00 and refreshed when new Yarago data arrives; a doctor never waits for the model.

(diagram in the Claude Docs version)

Dr. Sameera: comment directly on any box to reorder, rename, add or drop items. Once the layout is agreed, the same screen is built from 2-3 real patients for a final check.

**Team features, in build order**

| # | Feature | Who uses it | Data |
|---|---|---|---|
| 1 | Doctor summary | Doctors | Visit history, diagnosis, VA, IOP, injections |
| 2 | Follow-up leakage board: overdue patients ranked by clinical risk (overdue injections first) with call script | Front desk | Follow-ups, injections, appointments |
| 3 | Automatic attended / no-show from Yarago arrivals | Front desk, Pavin | tblappointments token and status |
| 4 | Patient-flow timings: wait per station and hour | Pavin | tbltimerpatientwaiting, dilatation list |
| 5 | Daily huddle brief: tomorrow's load, rule violations, confirmations pending, likely no-shows | Whole team | Appointments, rules, no-show model |
| 6 | No-show risk score (statistical model, not an LLM) | Front desk | 19k past appointments + arrivals |
| 7 | Ask-the-data: plain-English questions over read-only views, also as a connector for Claude | Pavin | `clinical` views |

## Analytics and business intelligence

Decided 19 Oct 2026 (D-020). Three layers, nothing patient-identifiable in any cloud tool.

**1. `analytics` schema in PostgreSQL: one source for every number**

Rebuilt nightly at about 02:30 (after the 01:00 Yarago full copy and the 02:00 backup) by a job in the sync service;
everything reads from here.

| Table | One row per | Main fields |
|---|---|---|
| `analytics.dim_date` | calendar day | weekday, week, month, financial year (Apr-Mar), clinic holiday, open for booking, max slots |
| `analytics.dim_doctor` | doctor | name, active |
| `analytics.dim_patient` | patient (pseudonymous) | patient key, age band, sex, first visit date, new/returning; **no name, phone or MRD** (Yarago holds no PIN/area, 19 Oct) |
| `analytics.fact_visit` | Yarago visit | date, doctor, visit type, new/old, diagnosis category per eye, dilated, minutes per station, total time |
| `analytics.fact_appointment` | Sudarshan booking | booked date, appointment date, lead days, source, status, attended / did not come, rescheduled count, cancel reason, confirmation calls done |
| `analytics.fact_followup` | Yarago follow-up | due date, came back, days late, last call outcome |
| `analytics.fact_treatment` | injection / laser / surgery | advised date, done date, drug, eye, dose number, days since previous dose, on time |
| `analytics.fact_billing` | bill / payment | date, service group, amount, collected, due, age of due |
| `analytics.metric_definitions` | KPI | name, plain definition, formula (SQL), owner, target |

- Patients appear only as a key and an age band. A read-only login `sudarshan_bi` can read `analytics` and nothing else.
- **Diagnosis categories:** Yarago diagnosis is free text. A mapping table (`analytics.diagnosis_map`) turns spellings
  into categories (diabetic retinopathy, AMD, RVO, glaucoma, cataract, ...). The local AI proposes mappings;
  Dr. Sameera approves them; unmapped text shows as "Unclassified" and is counted.
- **Metric definitions are written once** (`metric_definitions` and `docs/METRICS.md`); every screen uses the same SQL.

**2. Two audiences**

| Who | What | Where |
|---|---|---|
| Front desk, doctors | Tomorrow's load, confirmations due, follow-up leakage, live waits, morning huddle sheet | Inside Sudarshan (figures lead to an action; logins and roles already exist) |
| Pavin, management | Trends, comparisons, revenue, capacity, free exploration, weekly email, alerts | **Metabase** (open source), Windows service on shichika, LAN only, `sudarshan_bi` login, about 1-1.5 GB RAM |

Metabase's own settings live in its own PostgreSQL database (`metabase`), included in the nightly backup.
Power BI only, if ever, on de-identified tables on Pavin's laptop; never Power BI Service with clinic data.

**3. Ask-the-data (later):** plain-English questions over `analytics` answered by the local model, showing the SQL
it ran; optionally a read-only connector for Claude over the de-identified tables.

**First KPIs (build and check against known figures, e.g. last month's injections)**

| Area | KPI | Definition (short) |
|---|---|---|
| Volume | Visits per day / week / month | Completed Yarago visits, by new vs returning, doctor, visit type |
| Volume | Slot utilisation | Timed bookings / max slots per open day |
| Leakage | Follow-up overdue rate | Follow-ups due in the period not returned within 14 days of due |
| Leakage | Injection adherence | Next dose given within planned interval + 7 days; missed and late doses |
| Leakage | Advised not done | Surgery / laser advised with no procedure within 60 days |
| Leakage | Did-not-come rate | Past bookings without a Yarago visit, by lead days and weekday |
| Flow | Time per station | Median and 90th percentile minutes check-in > optometry > doctor > check-out, by hour of day |
| Front desk | Confirmation calls done | 4-day and 1-day calls made / due |
| Front desk | Reschedules and cancellations | Count and reasons, by days before the appointment |
| Money | Revenue per visit and per service | From Yarago billing, by service group |
| Money | Collections and dues ageing | Due amounts by age band (0-30, 31-90, over 90 days) |
| Later | Profit by service | Zoho Books costs alongside clinic activity |
| Later | Patient geography | Visits and new patients by PIN area (marketing) |

**First Metabase dashboards:** Clinic week (volume, utilisation, did-not-come, waits), Retina care (injection
adherence, follow-up leakage, advised-not-done by diagnosis), Money (revenue, collections, dues), Front desk
(confirmations, reschedules). Weekly email of "Clinic week" to Pavin on Monday 07:00, sent from admin@gs.sampadavr.com
(Google Workspace, `smtp.gmail.com`, app password; replies go back to admin@gs.sampadavr.com) to admin@gs.sampadavr.com. Zoho Mail is
on the free plan, which does not allow SMTP. Credentials in `.env` (`METABASE_SMTP_USER`, `METABASE_SMTP_PASSWORD`,
optional `METABASE_SMTP_HOST`/`PORT`); check with `scripts/check_smtp.py`.

**When:** the `analytics` schema, KPIs and Metabase are built right after the scheduling rules (one session,
read-only, low risk), so the numbers are available during the trial. In-app staff dashboards come with the screens
they belong to.

## Privacy and security

Patient-identifiable data stays on shichika; this follows the DPDP Act 2023 and closes gaps the current setup has.

- Identifiable patient data goes only to the local model. Cloud models get de-identified or aggregate data. This also changes the current Gemini rule check, which sends patient names to Google today.
- AI never writes to clinical records or sends messages by itself; it drafts, a person acts.
- Passwords hashed with bcrypt; sessions in an HTTP-only cookie, not the URL; roles enforced on every server call.
- MySQL access via the read-only `sudarshan_ro` user; root password removed from scripts.
- Secrets (Razorpay, AiSensy, SMTP) in a `.env` file outside git, readable only by the service account.
- Razorpay without a webhook: the app polls payment-link status every minute, so nothing on shichika is reachable from the internet.
- The exported `sudershanWebsite.xlsx` (14 plaintext passwords, full patient data) is deleted after the first import.
- Audit log records every write and every AI summary viewed.

## Code discovery before building

In weeks 1-2, alongside the mirror, Anthropic's code-modernization plugin turns the 49,000 lines of Apps Script into cited rules and tests that the new booking engine must pass.

| Command | What it gives Sudarshan | When |
|---|---|---|
| `/modernize-preflight` | Readiness check; asks five scope questions the code can't answer | Week 1 |
| `/modernize-assess` | Inventory, tech debt and security posture of Code.js and the 25 pages | Week 1 |
| `/modernize-map` | Interactive map of the 338 functions: which page calls what, which sheet feeds which function | Week 1 |
| `/modernize-extract-rules` | Scheduling rules (HFA, ROP and laser days, dilatation, family groups, max and fixed slots) as Given/When/Then cards citing file and line; Pavin and Dr. Sameera confirm or correct each | Week 2 |
| `/modernize-harden` | Security findings on the live Google app, with fixes that help while it stays in use | Week 2 |
| `/modernize-brief` | Approval gate; checked against this plan, differences settled here | End of week 2 |
| `/modernize-reimagine` | Builds the new booking engine with acceptance tests from the rule cards | Phase C |

- **Reimagine, not transform:** the data model changes from sheet rows to tables, so a module-by-module translation would carry row-number logic across.
- **Workspace:** `D:\Sudarshan\app` with `legacy/sudarshan` (a copy of `E:\sudarshanOngoingOld` without the `._*` files, `.opencode` and `.swarm`), `analysis/` and `modernized/`. Copy rather than symlink on Windows. Settings deny any edit to `legacy/`.
- **Where it runs:** Claude Code on shichika, next to the code and the mirror; install `scc` for metrics.
- **Proof of equal behaviour:** Apps Script can't run locally, so tests are built from recorded behaviour (19,000 past appointments, the audit log, the rule cards). The Phase C shadow run is the final proof.

## Phases

(diagram in the Claude Docs version)

Each phase ends at a gate that must pass before the next starts. Phases A and B change nothing staff use, so the clinic carries no risk until Phase C's shadow run.

**Phase A first steps**

- Yarago is owned by the clinic: direct database reads confirmed
- Create MySQL user `sudarshan_ro` (SELECT only), verified 18 Oct; MySQL is open to the LAN, firewall rule pending
- Install PostgreSQL 16 (pgvector later) and Node.js 24 LTS on shichika; create `D:\Sudarshan\app` git repo
- Build the sync worker; first full copy done 18 Oct (553 tables, 11.4M rows, 2.4 min; hot-table row counts match)
- Build the Sheets import script and the first decoded `clinical` views

## Risks

| Risk | Effect | Fallback |
|---|---|---|
| Shichika fails (disk, power, Windows update) | Clinic loses appointments | UPS; Windows updates set to off-hours; nightly backup on QNAP; restore drill monthly; Google app kept read-only for 3 months after cut-over |
| Yarago vendor upgrade changes tables | Sync breaks for affected tables | Schema watch alerts; app keeps serving last good mirror |
| Heavy sync slows the EMR | Front desk notices lag | Incremental queries are small; full copy at 01:00 only |
| AI summary states something wrong | Clinical error | Facts from data only, every line sourced, AI part labelled; Dr. Sameera signs off the format |
| GPU shared with experiments | Summaries late | Summaries run 07:00-08:00; experiments outside clinic hours |
| Old pages and new app diverge during the build | Rework | Note every change made to the Google app from now on |
| Shichika is the whole clinic's server: Yarago (MySQL56, Tomcat7), its backup (Tomcat9_AutoDB), BarTender labels, Mantra attendance, and soon Sudarshan | One failure stops EMR, labels, attendance and booking together; new load could slow the EMR | PostgreSQL capped at about 4 GB; AI summaries before clinic hours, experiments after hours; nightly backup of all four databases to QNAP; updates and restarts only at night; one-page recovery runbook; consider a standby machine later |

## Later: replace Yarago and queue management (D-037)

Pavin's direction (21 Oct): Sudarshan becomes the whole system; Yarago is retired. Nothing here is built; it fixes the
order of work so today's choices do not block it.

- **Patient identity.** Today the MRD (SPD number) comes from Yarago when the patient is first registered; a booking for
  a new patient carries a temporary `NDC_` ID until then (D-036). Once Sudarshan owns registration it issues the SPD
  number itself, **only when the new patient has actually arrived and is registered**, never at booking. A patient's
  history starts from that SPD number; the temporary ID is dropped when the real MRD is set (the audit log keeps the
  old value, as it does for every change).
- **Queue management in Sudarshan:** check-in at the desk, a live queue per station (registration, optometry,
  dilatation, doctor, billing), token or name board for the waiting area, time-in-stage alerts, doctor's next-patient
  view, and check-out. It reuses the station stages already shown on Today (`StageTrack`) but writes them itself instead
  of reading Yarago's `tbltimerpatientwaiting`. AI may suggest ordering; a person decides.
- **Replacing Yarago (EMR) later, in slices:** registration and MRD issue first, then the queue, then visit records
  (vision, pressure, diagnosis, plan), prescriptions, billing and pharmacy. Each slice runs beside Yarago until its
  figures match, then Yarago's slice is switched off. Needs its own plan, clinical-safety review (COMPLIANCE) and
  data migration of the Yarago history (the `yarago` / `clinical` mirror is the starting point).
- **Why the queue first:** it needs only check-in and stage times, is the part staff touch all day, and removes the
  dependency on Yarago's timers for Today, waits and the board.

## Open questions

- Yarago access: owned by the clinic, direct read access confirmed.
- Does Yarago store OCT or fundus images, or only file paths? (Out of scope now; affects later image AI.)
- Dr. Sameera: 30 minutes to review the summary layout on 2-3 anonymised patients.
- Which `nmoduletimerid` values map to which station (registration, optometry, dilatation, doctor)?
- Is a UPS already on shichika, and is QNAP space available for nightly backups?

## Where the build differs from this plan (see DECISIONS.md)

- No database unique rule on (date, doctor, slot): one-patient-per-slot and day capacity are enforced in the booking
  service under a per-day lock, because families and overrides need controlled exceptions (D-009).
- The old Google AuditLog is **not** imported; the new audit log starts clean (D-007).
- Frontend uses hand-written CSS with design tokens, not Tailwind (D-014).
- Served on `http://shichika:8484` for now; Caddy and `https://sudarshan.local` come before go-live (D-012).
- Analytics and BI added 19 Oct (section above, D-020).
- Order changed: the booking screens were built before the doctor summary, on Pavin's direction to put full effort
  into the local system (D-015). The doctor summary is the next big feature after the scheduling rules.
