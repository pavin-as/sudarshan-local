# SCHEMA.md - Sudarshan database

PostgreSQL 16, database `sudarshan`, owner `sudarshan_app`, on shichika (localhost only).
This file describes what exists today. **The migrations are the source of truth.** When you change the
schema, update this file in the same commit (Testing.md, "Definition of done").

## Schemas

| Schema | What it holds | Who writes it |
|---|---|---|
| `yarago` | Raw mirror of every non-empty Yarago MySQL table (about 550 tables, 11.4M rows). Table and column names are Yarago's, lower-cased. | `sync/yarago_sync.py` only |
| `yarago_staging` | Target of the nightly full copy; swapped into `yarago` when complete. Empty between runs. | sync only |
| `clinical` | Decoded, readable **views** over the mirror (vision as text, coded lists as words, Malayalam repaired). The app and the AI read these, never raw codes. | `db/views/*.sql` |
| `app` | Sudarshan's own data (bookings, calendar, users, audit). | the API server, the importer |
| `analytics` | Reporting tables, rebuilt nightly from scratch (patients only as a random key). The only schema the reporting login `sudarshan_bi` can read. | `analytics.refresh()` (sync service, 02:30) |

`yarago.sync_state` records, per mirrored table: last id, last modified date, last run, row count, status, column hash.

## Rules for changing the schema

1. **New migration, never edit an applied one.** `db/migrations/NNNN_name.sql`, numbered, and **idempotent**
   (`CREATE ... IF NOT EXISTS`, `ON CONFLICT`), because `scripts/migrate.py` runs on every update.
2. **Views live in `db/views/`** and are re-applied after every migrate and after every nightly full copy (the full copy
   can drop and recreate mirror tables). `CREATE OR REPLACE VIEW` can only **add columns at the end**; to rename or
   reorder, `DROP VIEW` first in the same file.
3. **Never add objects to `yarago`.** Indexes there are created by the sync (on each table's appointment and patient
   columns). A full copy that sees a changed Yarago table rebuilds it, which would lose anything added by hand.
4. **Every new `app` table** gets the `audit` and `touch` triggers: add its name to the list at the end of
   `0003_app_core.sql`'s DO block **in a new migration** (repeat the DO loop for the new table), and add friendly names
   to `app.field_labels`.
5. **Times:** `timestamptz` for moments, `date` + `time` for appointment slots (clinic time, Asia/Kolkata).
   The server's connections run with `TimeZone=Asia/Kolkata`.
6. **No secrets in tables.** `app.settings` holds no keys; secrets are in `.env`.

Applied so far: `0001_schemas`, `0002_sync_runs`, `0003_app_core`, `0004_server`, `0005_backup_runs`, `0006_analytics`, `0013_pharmacy_analytics` (pharmacy facts and dimensions in `analytics`, D-032), `0012_print_log` (who printed which day list, D-029), `0011_emr_completeness` (`analytics.emr_completeness` + nightly function, D-028), `0010_doctor_summary` (audit on `ai_summaries`, `facts_hash`, `checked`, AI settings, D-026), `0009_trial_google_master` (setting `trial.google_master`, D-025), `0008_import_no_time` (imported bookings at 00:00 had no time: time cleared, upcoming ones waitlist), `0007_front_desk_lists` (direct-call close reason and doctor; cancelled bookings' call-back date and cancel-list status; imported archived and old_cancel rows taken off the list).
Views: `10_clinical.sql`, `20_clinical_flow_followup.sql`, `30_app_audit.sql`.

## Yarago facts the views depend on

- Visit record = `tbl_patient_appointment_history` (one row per appointment, joined to `tblappointments`).
- Vision, IOP and refraction are stored as display text ("6/9", "N6", "14") despite `_id` column names.
  BCVA = `visionvadv_*`, pinhole = `ph_*`, unaided = `dva_*`, IOP = `oeiop_*` (fallback: latest `tbloptometryexamination`).
- Coded lists are an id list plus aligned right/left flag lists (`'1,3,'`, `'1,0,'`, `'0,1,'`) -> `clinical.list_items()`.
- Diagnosis is mostly free text (`final_diagnosis`).
- Clinical child tables are append-only (each save inserts new rows; latest per appointment is current) and have no
  modified date; the sync re-copies them by visit id. Six of them have no index on the visit column in Yarago, so edits to
  old visits in those arrive with the nightly copy.
- `tblpatientissurgery.LstmodifiedDate` is unreliable; sync uses new ids only (UNRELIABLE_MOD guard).
- Malayalam is UTF-8 stored in latin1 columns; the sync's `fix_mojibake()` repairs it.
- Station timer (`tbltimerpatientwaiting.nmoduletimerid`): 1 Check in, 2 optometry, 3 Room in, 4 exam before dilatation,
  6 exam after dilatation, 8 Check out.
- Appointment status (`tblappointments.nstatus_id`), confirmed from data: 0 booked/not arrived, 1 checked in,
  2 in examination, 3 completed, 4 cancelled.
- Dues: `tbl_patient_payment_mainduedetails.dueAmtTowardsHospital` = patient owes the clinic.

## clinical views

| View | One row per | Notes |
|---|---|---|
| `clinical.patient` | Yarago patient | `mrd` = apatientcode; name, dob, age, sex, mobile, language, VIP category |
| `clinical.visit` | Yarago appointment | type, status label, doctor, vision/IOP/CCT per eye, diagnosis, complaints, history, medicines, advice, follow-up |
| `clinical.visit_exam_finding` | finding per eye part per visit | decoded examination |
| `clinical.va_iop_trend` | visit | BCVA (text and logMAR), unaided VA, IOP per eye |
| `clinical.injection` | injection advised/given | drug, eye, `injection_number_for_eye` |
| `clinical.laser` | laser advised/done | |
| `clinical.followup` | Yarago follow-up | `came_back`, `days_overdue` |
| `clinical.followup_current` | patient | latest follow-up and `followup_state` bucket (returned, upcoming, overdue up to 30 / 31-90 / 91-365 / over 1 year) |
| `clinical.patient_flow` | station timer row | |
| `clinical.visit_timeline` | visit | check-in, optometry, room-in, exam, check-out times and minutes between (NULL if negative or over 10 h) |
| `clinical.patient_due` | patient | `due_total` (patient owes clinic), `clinic_owes_patient` |
| `app.audit_feed` | audit entry | readable activity log: when, who, what, summary, field-by-field details |

Helper functions: `clinical.clean`, `id_list`, `list_items`, `num`, `eye`, `va_logmar`, `to_date_safe`,
`minutes_between`; `app.audit_value_text`, `audit_field_text`, `audit_changes_text`.

Full column lists: `\d+ clinical.<view>` in psql, or the `CREATE VIEW` in `db/views/`.

## analytics (0006, D-020)

Rebuilt by `analytics.refresh()` (TRUNCATE + INSERT in one transaction, about 7 s), called nightly at 02:30 by the
sync service and on demand: `python sync\yarago_sync.py analytics`. Each run is in `app.sync_runs` (mode `analytics`)
and `analytics.refresh_log`. Never edit these tables: change `refresh()` in a new migration. Definitions: METRICS.md.

| Table | One row per | Notes |
|---|---|---|
| `dim_date` | day, 2015 to today + 180 | weekday, week, month, financial year (Apr-Mar), holiday, max slots, open for booking |
| `dim_doctor` | doctor name | in Yarago / in Sudarshan |
| `dim_patient` | patient key | age band, sex, first visit, completed visits, injections; no name, phone, MRD, address |
| `fact_visit` | Yarago visit | completed, new patient, dilated, clinical group, visit purpose, check-in hour, minutes per station, billed |
| `fact_appointment` | Sudarshan booking | lead days, timed, source, status, attended, did not come, cancel reason group (not the text), reschedules, confirmation calls; TEST / ZZ Test bookings left out |
| `fact_followup` | Yarago follow-up | due, came back, days late / overdue, back within 14 days, state, calls made, last call outcome |
| `fact_treatment` | injection or laser (per eye) | advised, scheduled, treated, done, item, dose number, next planned follow-up and whether the patient came by then + 7 days, advised not done |
| `fact_bill` / `fact_billing` | bill / bill line (+ optical order) | totals, paid by mode, due after bill / service group, item, amount |
| `fact_due` | patient owing now | amount, age band |
| `category_rule` | rule | kind `diagnosis` (over coded exam findings) or `purpose` (over the plan note); regex, priority, `approved` |
| `metric_definitions`, `refresh_log` | KPI / rebuild | |

Outside the schema: `app.analytics_patient_key` (patient id -> random key; not readable by `sudarshan_bi`) and the view
`app.analytics_unmatched` (findings and plan notes no rule groups, for Dr. Sameera).
Logins: `sudarshan_bi` (read-only, `analytics` only, 120 s statement limit), `metabase` (owns database `metabase`,
Metabase's own settings). Both created by `scripts/install-metabase.ps1`.

## The audit log (how it works)

An `AFTER INSERT OR UPDATE OR DELETE` trigger on every audited `app` table writes `app.audit_log`. The server sets,
per transaction (`withTx()` in `server/src/db.ts`):

```
set_config('app.user_id', '<users.id>', true)        -- who
set_config('app.audit_summary', '<sentence>', true)  -- e.g. "Rescheduled Ayisha (SPD10231): 21 Oct 10:20 -> 23 Oct 09:40"
set_config('app.source', 'web' | 'job' | 'cli' | 'import', true)
set_config('app.request_id', '<uuid>', true)
```

Updates store only changed fields (`{"field": {"from": .., "to": ..}}`, ignoring `updated_at`); unchanged saves write
nothing. `password_hash` is stored as `"(changed)"`. Bulk imports set `app.skip_audit = 'on'` and record one
`app.import_runs` row instead. Never write to `app` tables outside `withTx()` (or an equivalent that sets these).

## app tables (generated from the test database, 19 Oct 2026)

### app.backup_runs (0005)
Each backup and restore test (scripts/backup.ps1, restore-test.ps1). Not audited.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | identity |
| kind | text (backup / restore_test) | no | |
| started_at | timestamp with time zone | no | now() |
| finished_at | timestamp with time zone | yes | |
| status | text (ok / failed) | no | |
| file | text | yes | |
| bytes | bigint | yes | |
| details | jsonb (entries, counts of main tables) | yes | |
| message | text (failure reason) | yes | |


### app.ai_summaries
Doctor summaries: facts (jsonb, each with its Yarago source), the AI overview, model, prompt version.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| patient_id | integer | no |  |
| for_date | date | no |  |
| kind | text | no | 'doctor_summary'::text |
| facts | jsonb | no |  |
| overview | text | yes |  |
| model | text | yes |  |
| prompt_version | text | yes |  |
| status | text | no | 'ready'::text |
| error | text | yes |  |
| generated_at | timestamp with time zone | no | now() |

### app.ai_summary_views
Who looked at which summary, when.

| Column | Type | Null | Default |
|---|---|---|---|
| summary_id | bigint | no |  |
| user_id | integer | no |  |
| at | timestamp with time zone | no | now() |

### app.appointment_events
The booking's story: every booking, reschedule, confirmation, cancellation, remark, tag change, plus the imported Google history.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| appointment_id | bigint | no |  |
| at | timestamp with time zone | no | now() |
| actor_id | integer | yes |  |
| actor_name | text | yes |  |
| event_type | text | no |  |
| from_value | jsonb | yes |  |
| to_value | jsonb | yes |  |
| note | text | yes |  |

### app.appointments
One row per booking for its whole life; status column replaces the appointment/cancel/archive sheets. patient_id = Yarago aPatient_ID (NULL for a new patient until linked). No unique slot constraint: capacity and one-patient-per-slot are enforced by services/booking.ts under a per-day advisory lock.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| appointment_date | date | no |  |
| slot_time | time without time zone | yes |  |
| duration_min | integer | no | 10 |
| doctor_id | integer | yes |  |
| patient_id | integer | yes |  |
| mrd | text | yes |  |
| patient_name | text | no |  |
| phone | text | yes |  |
| age_years | integer | yes |  |
| gender | text | yes |  |
| patient_type | text | yes |  |
| appointment_type | text | yes |  |
| plan_of_action | text | yes |  |
| urgency | text | yes |  |
| family_group | text | yes |  |
| fixed_slot | boolean | no | false |
| consult_start | time without time zone | yes |  |
| tags | ARRAY | no | '{}'::text[] |
| remarks | text | yes |  |
| status | text | no | 'booked'::text |
| source | text | no | 'booking'::text |
| source_ref | text | yes |  |
| yarago_visit_id | integer | yes |  |
| confirmed_4day_at | timestamp with time zone | yes |  |
| confirmed_4day_by | integer | yes |  |
| confirmed_1day_at | timestamp with time zone | yes |  |
| confirmed_1day_by | integer | yes |  |
| cancelled_at | timestamp with time zone | yes |  |
| cancelled_by | integer | yes |  |
| cancel_reason | text | yes |  |
| booked_by | integer | yes |  |
| booked_at | timestamp with time zone | no | now() |
| legacy_id | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.audit_log
Every insert/update/delete on audited app tables, written by trigger: actor, plain summary, field changes. Passwords stored only as "(changed)".

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| at | timestamp with time zone | no | now() |
| actor_id | integer | yes |  |
| action | text | no |  |
| entity_type | text | no |  |
| entity_id | text | yes |  |
| patient_id | integer | yes |  |
| summary | text | yes |  |
| changes | jsonb | yes |  |
| source | text | no | 'app'::text |
| request_id | text | yes |  |

### app.code_labels
Labels for Yarago codes Yarago does not name (appointment_status confirmed in 0004; followup_status still inferred).

| Column | Type | Null | Default |
|---|---|---|---|
| kind | text | no |  |
| code | integer | no |  |
| label | text | no |  |
| confirmed | boolean | no | false |

### app.day_capacity
Maximum timed bookings per day (planningB maxSlots). No row or 0 = day not open for booking.

| Column | Type | Null | Default |
|---|---|---|---|
| on_date | date | no |  |
| max_slots | integer | no |  |
| notes | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.direct_calls
directCall sheet; linked to the appointment it became.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| patient_id | integer | yes |  |
| mrd | text | yes |  |
| patient_name | text | yes |  |
| phone | text | yes |  |
| age_years | integer | yes |  |
| gender | text | yes |  |
| patient_type | text | yes |  |
| call_type | text | yes |  |
| case_type | text | yes |  |
| urgency | text | yes |  |
| remarks | text | yes |  |
| status | text | no | 'open'::text |
| appointment_id | bigint | yes |  |
| created_by | integer | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
| legacy_id | text | yes |  |

### app.doctor_exceptions
Leave, partial day or extra session on one date.

| Column | Type | Null | Default |
|---|---|---|---|
| id | integer | no | nextval('app.doctor_exceptions_id_seq... |
| doctor_id | integer | no |  |
| on_date | date | no |  |
| kind | text | no |  |
| start_time | time without time zone | yes |  |
| end_time | time without time zone | yes |  |
| reason | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.doctor_schedule
Regular weekly sessions (weekday 1 = Monday). Changing hours closes old rows (valid_to) so history stays.

| Column | Type | Null | Default |
|---|---|---|---|
| id | integer | no | nextval('app.doctor_schedule_id_seq':... |
| doctor_id | integer | no |  |
| weekday | smallint | no |  |
| start_time | time without time zone | no |  |
| end_time | time without time zone | no |  |
| valid_from | date | yes |  |
| valid_to | date | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.doctors
Doctors who take appointments; yarago_doctor_id links to yarago.tbldoctor.

| Column | Type | Null | Default |
|---|---|---|---|
| id | integer | no | nextval('app.doctors_id_seq'::regclass) |
| name | text | no |  |
| short_name | text | yes |  |
| yarago_doctor_id | integer | yes |  |
| user_id | integer | yes |  |
| is_active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.field_labels
Friendly field names for the activity log; hidden=true never shows values.

| Column | Type | Null | Default |
|---|---|---|---|
| entity_type | text | no |  |
| field | text | no |  |
| label | text | no |  |
| hidden | boolean | no | false |

### app.followup_actions
Staff actions on Yarago follow-ups (calls, outcomes, next call date). The follow-up itself stays in the mirror.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| yarago_followup_id | integer | yes |  |
| patient_id | integer | yes |  |
| action | text | no |  |
| note | text | yes |  |
| next_call_on | date | yes |  |
| appointment_id | bigint | yes |  |
| actor_id | integer | yes |  |
| actor_name | text | yes |  |
| at | timestamp with time zone | no | now() |
| legacy_ref | text | yes |  |

### app.holidays
Clinic closed; booking refused.

| Column | Type | Null | Default |
|---|---|---|---|
| on_date | date | no |  |
| reason | text | no |  |
| remarks | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.import_runs
Each Sheets import: counts and warnings.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| source | text | no |  |
| started_at | timestamp with time zone | no | now() |
| finished_at | timestamp with time zone | yes |  |
| status | text | no | 'running'::text |
| counts | jsonb | yes |  |
| message | text | yes |  |

### app.kpi_daily
Daily figures (jsonb); legacy DailyKPIReport imported.

| Column | Type | Null | Default |
|---|---|---|---|
| on_date | date | no |  |
| metrics | jsonb | no |  |
| computed_at | timestamp with time zone | no | now() |

### app.messages
WhatsApp / email / SMS sent or queued (Broadcast, EmailAudit).

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| channel | text | no |  |
| template | text | yes |  |
| recipient | text | no |  |
| patient_id | integer | yes |  |
| appointment_id | bigint | yes |  |
| payload | jsonb | no | '{}'::jsonb |
| status | text | no | 'queued'::text |
| provider_ref | text | yes |  |
| error | text | yes |  |
| created_by | integer | yes |  |
| created_at | timestamp with time zone | no | now() |
| sent_at | timestamp with time zone | yes |  |
| legacy_ref | text | yes |  |

### app.payments
Razorpay payment links; status by polling (no webhook).

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| appointment_id | bigint | yes |  |
| patient_id | integer | yes |  |
| amount | numeric | no |  |
| purpose | text | yes |  |
| provider | text | no | 'razorpay'::text |
| link_id | text | yes |  |
| link_url | text | yes |  |
| status | text | no | 'created'::text |
| provider_payment_id | text | yes |  |
| paid_at | timestamp with time zone | yes |  |
| refunded_amount | numeric | no | 0 |
| created_by | integer | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.plan_of_action
PlanOfActionMaster list.

| Column | Type | Null | Default |
|---|---|---|---|
| name | text | no |  |
| eye | text | yes |  |
| prep_min | integer | yes |  |
| consult_min | integer | yes |  |
| priority | integer | yes |  |
| is_active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.schema_migrations
Applied migration files.

| Column | Type | Null | Default |
|---|---|---|---|
| version | text | no |  |
| applied_at | timestamp with time zone | no | now() |

### app.sessions
One row per login. Random uuid in an HTTP-only cookie; 12 h sliding expiry; revoked on logout, password change, deactivation.

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| user_id | integer | no |  |
| created_at | timestamp with time zone | no | now() |
| last_seen_at | timestamp with time zone | no | now() |
| expires_at | timestamp with time zone | no |  |
| ip | inet | yes |  |
| user_agent | text | yes |  |
| revoked_at | timestamp with time zone | yes |  |

### app.settings
Key/value (jsonb): general.* lists, rule.*, system.*, booking.* (slot length, day start/end). No secrets.

| Column | Type | Null | Default |
|---|---|---|---|
| key | text | no |  |
| value | jsonb | no |  |
| description | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

### app.sync_runs
Each Yarago sync run (mode, rows, status).

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('app.sync_runs_id_seq'::regcl... |
| mode | text | no |  |
| started_at | timestamp with time zone | no | now() |
| finished_at | timestamp with time zone | yes |  |
| status | text | no | 'running'::text |
| tables_done | integer | yes |  |
| rows_copied | bigint | yes |  |
| message | text | yes |  |

### app.triage
urgencyIdentification; answers jsonb, score, decision.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| patient_id | integer | yes |  |
| mrd | text | yes |  |
| patient_name | text | yes |  |
| phone | text | yes |  |
| age_years | integer | yes |  |
| gender | text | yes |  |
| patient_type | text | yes |  |
| assessed_at | timestamp with time zone | no | now() |
| answers | jsonb | no | '{}'::jsonb |
| max_score | integer | yes |  |
| category | text | yes |  |
| decision_status | text | yes |  |
| decision_remarks | text | yes |  |
| decision_by | integer | yes |  |
| decision_at | timestamp with time zone | yes |  |
| created_by | integer | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
| legacy_id | text | yes |  |

### app.users
Staff logins. Passwords bcrypt; NULL hash = must be given a temporary password. Imported from Login (passwords never imported).

| Column | Type | Null | Default |
|---|---|---|---|
| id | integer | no | nextval('app.users_id_seq'::regclass) |
| username | USER-DEFINED | no |  |
| full_name | text | no |  |
| role | text | no |  |
| email | USER-DEFINED | yes |  |
| password_hash | text | yes |  |
| must_change_password | boolean | no | true |
| is_active | boolean | no | true |
| yarago_user_id | integer | yes |  |
| legacy_username | text | yes |  |
| last_login_at | timestamp with time zone | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
