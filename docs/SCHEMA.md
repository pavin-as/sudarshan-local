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

Applied so far: `0001_schemas`, `0002_sync_runs`, `0003_app_core`, `0004_server`, `0005_backup_runs`, `0006_analytics`, `0015_whatsapp_payments` (WhatsApp broadcasts and outbox, payment link fields, refunds, off/test/live settings, D-034), `0014_wholesaler_balance` (live wholesaler balance views, purchases at invoice value, D-033), `0013_pharmacy_analytics` (pharmacy facts and dimensions in `analytics`, D-032), `0012_print_log` (who printed which day list, D-029), `0011_emr_completeness` (`analytics.emr_completeness` + nightly function, D-028), `0010_doctor_summary` (audit on `ai_summaries`, `facts_hash`, `checked`, AI settings, D-026), `0009_trial_google_master` (setting `trial.google_master`, D-025), `0008_import_no_time` (imported bookings at 00:00 had no time: time cleared, upcoming ones waitlist), `0007_front_desk_lists` (direct-call close reason and doctor; cancelled bookings' call-back date and cancel-list status; imported archived and old_cancel rows taken off the list).
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

`clinical.emr_visit_items(p_from date, p_to date)` (migration 0027, D-051): one row per EMR completeness item per
consultation (status 1-3, injections and lasers left out; `p_to` NULL = no limit). Columns: visit_id, patient_id,
visit_at, status_id, is_new, screen, item, label, item_position, ok. Used by the EMR daily report and by
`analytics.refresh_emr_completeness()`. It is plpgsql, so a full copy that rebuilds mirror tables does not drop it.

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

### app.dr_gradings (0018, D-040)
One row per fundus photograph sent to the research DR grader, kept for good: trigger `dr_gradings_guard` refuses DELETE and any
UPDATE except `remarks`. Audited; `ai_grade`, `probs` and `raw_outputs` are hidden in the activity feed. The photograph is never stored.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | bigserial | no | |
| created_at, created_by | timestamptz, integer | no, yes | NULL `created_by` for the console imports |
| patient_id, mrd | bigint, text | yes | Yarago patient; NULL only for folder imports whose MRD is not in Yarago |
| eye | text | yes | `RE` / `LE`; NULL = not given in metadata.csv |
| source, batch_id | text | no, yes | `upload` / `batch` / `remidio` (0020) / `topcon` (0024); 0019 removed `legacy_import`, the test copy of the old grader's records |
| status, error | text | no, yes | `ok` / `rejected` (photograph unreadable, grader's words in `error`) / `error` |
| ai_grade | smallint | yes | 0-4, required when `ok` |
| probs, raw_outputs | double precision[] | yes | five scores (grade 0..4); raw model outputs |
| calibration | text | yes | `native_probabilities` / `softmax_applied` |
| image_filename, image_sha256, image_width, image_height | | yes | |
| preprocess_ms, inference_ms | numeric | yes | |
| model_repo, model_commit, model_sha256, grader_version | text | yes | which model graded it |
| remarks | text | no | '' |

### app.dr_doctor_grades (0018)
A person's own DR grade of a graded photograph, one per person per photograph (saving again replaces it). Audited; `grade` and
`ungradable` hidden in the activity feed.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, grading_id, patient_id | bigserial, bigint, bigint | no, no, yes | `patient_id` copied so the activity log finds the patient |
| graded_by | integer | no | unique with `grading_id` |
| grade / ungradable | smallint / boolean | | exactly one: a grade 0-4, or not gradable |
| note | text | no | '' |
| blinded | boolean | no | true = saved before this person was shown the AI grade (from `dr_grading_views`, worked out on every save) |
| created_at, updated_at | timestamptz | no | |

### app.fundus_photos (0020, D-041)
One row per photograph received from Remidio's queue; the image and Remidio's thumbnail are files under `RETINA_PHOTO_DIR`.
Kept for good: trigger `fundus_photos_guard` refuses DELETE and every UPDATE except setting `patient_id` (and `sex_check`)
on a photograph that has none. Audited.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, received_at, source | bigserial, timestamptz, text | no | source `remidio` |
| remidio_image_id | bigint | yes | unique; Remidio's image id (duplicates are recognised by it) |
| remidio_exam_id, remidio_patient_id | bigint | yes | |
| mrn | text | yes | as typed on the FOP |
| patient_id | bigint | yes | Yarago patient with that SPD number; NULL = not found when received |
| sex_check | text | yes | `same` / `different` (Remidio's sex against Yarago's) |
| eye, field, quality, quality_score | text, text, text, numeric | yes | `RE`/`LE`; MACULA/DISC/OTHER; SUFFICIENT/INSUFFICIENT |
| captured_at, width, height | timestamptz, integer, integer | yes | |
| bytes, sha256, file_path | integer, text, text | no | file path relative to `RETINA_PHOTO_DIR` |
| thumb_path | text | yes | Remidio's thumbnail |
| meta | jsonb | yes | the queue item without its links |
| dicom_study_uid, dicom_sop_uid | text | yes | Maestro2 (0024, D-048): the OP object's UIDs; the instance UID is unique (a re-saved exam is a duplicate) |
| device, protocol | text | yes | Maestro2: `Maestro2`; scan protocol, e.g. `3D H/Macula/320/320/6x6mm/Angio` |
| topcon_file, dicom_path | text | yes | Maestro2: IMAGEnet's exam file (a number, e.g. `40742.fda`); the OP `.dcm` as exported, relative to `RETINA_PHOTO_DIR` |

Since 0024 `source` is `remidio` or `topcon`. A Maestro2 row has no Remidio ids or quality; `mrn` holds the DICOM patient ID
(the SPD number), `sex_check` compares the DICOM sex with Yarago's, `meta` holds pixel spacing and the `.fda` size.

### app.oct_studies (0025, D-049)
One row per Maestro2 exam's tomography (the OPT object). Files under `OCT_DIR\<dir_path>`: `dicom\` (the exported
DICOM) and `view\` (`b001.jpg`... B-scans, `oct.json`, `layers.bin`, `slab<n>.png`). Kept for good: trigger
`oct_studies_guard` refuses DELETE and every UPDATE except setting `patient_id` on a scan that has none. Audited.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, received_at, source | bigserial, timestamptz, text | no | source `topcon` |
| photo_id | bigint | yes | the exam's colour photograph (scan lines are drawn on it) |
| mrn, patient_id | text, bigint | yes | DICOM patient ID; the Yarago patient with that SPD number |
| eye, captured_at, device, protocol | text, timestamptz, text, text | yes | |
| kind | text | no | `oct` / `octa` (OCTA: has slabs or a flow volume) |
| frames, rows, cols | integer | no | B-scans; pixels deep; pixels across |
| spacing | jsonb | yes | axialMm, lateralMm, betweenMm |
| layers, slabs | text[] | yes | Topcon's layer surfaces; OCTA slab names |
| dicom_study_uid, opt_sop_uid | text | yes, no | the instance UID is unique (a re-saved exam is a duplicate) |
| topcon_file, dir_path, bytes | text, text, bigint | yes, no, no | |

### app.emr_daily_reports (0027, D-051)
What was missing in each consultation when the day's EMR daily report was taken (17:30, setting `emr.daily_at`). One row
per day, written once by the server's job; audited. Ids and item keys only, no MRD or name.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | bigint identity | no | |
| report_date | date | no | unique |
| taken_at | timestamptz | no | when the job took it (later than 17:30 if the server was down then) |
| visits | jsonb | no | `[{"visitId", "statusId", "missing": [item keys]}]`, every visit of the day then |

### app.oct_thickness (0026, D-050)
Retinal thickness of an OCT scan, computed by Sudarshan from Topcon's layer lines (`services/octThickness.ts`). One row per
scan and method version (unique). Audited.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, study_id, version, computed_at | bigserial, bigint, integer, timestamptz | no | study_id references `oct_studies` |
| kind | text | no | `cube` / `radial` |
| centre | jsonb | no | uMm, vMm from the scan centre (u right, v down on the photograph), method |
| cst_ilm_bm_um, cst_ilm_rpe_um | integer | yes | central subfield thickness, ILM to BM and ILM to OS/RPE |
| results | jsonb | no | per definition: cstUm, sectorsUm (C, S1, N1, I1, T1, S2, N2, I2, T2), cover |

Setting `retina.oct_thickness_checked`: null until the check against IMAGEnet is recorded (definition, n, bias, limits).

### app.topcon_import_log (0024, D-048)
What the Topcon import did with each IMAGEnet exam file (a log: no audit trigger). An exam is done once a row for its
file name and file time has a final outcome. Messages and `meta` hold shapes (protocol, eye, patient-ID format, size),
never names or IDs.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, at | bigserial, timestamptz | no | |
| file_name, file_bytes, file_mtime | text, bigint, timestamptz | no, yes, yes | the `.fda`; name and time identify the version |
| outcome | text | no | stored / duplicate / skipped / no_photo / peeked / error / gave_up (final: all but peeked and error) |
| photo_id | bigint | yes | the photograph kept or recognised |
| message, meta | text, jsonb | yes | |
| version | integer | no | the import that did it (0025): 1 photograph only, 2 photograph and OCT; older versions are done again |

### app.fundus_reports (0021, D-042)
The doctor's report of one photo session (patient, day, Remidio exam). Unique on (patient_id, exam_date,
coalesce(remidio_exam_id, 0)). Trigger `fundus_reports_guard`: no DELETE; patient, session, `reported_by`, `reported_at`
never change; any other change needs a new `amended_at`, `amended_by` and a non-empty `amendment_reason`. Audited.

| Column | Type | Null | Notes |
|---|---|---|---|
| id, patient_id, exam_date, remidio_exam_id | bigserial, bigint, date, bigint | no, no, no, yes | |
| photo_ids | bigint[] | no | the photographs reported on |
| re_dr, le_dr | text | yes | none / mild / moderate / severe / pdr / ungradable; at least one eye |
| re_dme, le_dme | text | yes | none / non_centre / centre / ungradable |
| re_findings, le_findings | text[] | no | glaucoma_suspect, drusen_amd, hypertensive, vein_occlusion, other |
| re_other, le_other | text | no | words for "other" |
| referral | text | no | none / routine / urgent |
| comments | text | no | |
| reported_by, reported_at | integer, timestamptz | no | the signing doctor |
| amended_by, amended_at, amendment_reason | integer, timestamptz, text | yes | the latest correction |

### app.eval_sets, app.eval_set_items (0022, D-043)
`eval_sets`: `id`, `name` (unique), `notes`, `criteria` (jsonb: dates, blindedOnly, excludePoor, maculaOnly, what the
rules left out), `created_by/at`, `frozen_by/at` (NULL = draft). Audited.
`eval_set_items`: (`set_id`, `photo_id`) key; `patient_id`, `patient_code` (P001 within the set), `image_code`
(P001-RE-01, unique in the set), `eye`, `reference_grade` 0-4 or `reference_ungradable`, `reference_blinded`,
`reference_report_id`, `reference_by` (the doctor). Trigger `eval_frozen_guard`: no insert, change or delete of a frozen
set's items; a frozen set cannot be renamed, unfrozen or removed. Items are not audited one by one (the set is).
`eval_sets.purpose` (0023, D-046): `validation` (cut-offs may be chosen on it) / `test` / `other`; fixed once frozen.
Settings (0023): `retina.graders` (jsonb list, e.g. `["arko", "rfm:aptos", "rfm:messidor"]`) and
`retina.screening_cutoffs` (jsonb keyed by model SHA-256: `name`, `refer`, `clear`, `source`).

### app.remidio_queue_log (0020)
What the receiver did with each queue item (a log: no audit trigger): `at`, `item_type`, `remidio_id`, `outcome`
(`stored` / `duplicate` / `kept` / `peeked` / `error` / `gave_up` / `skipped`), `photo_id`, `message`, and `payload` (the
item without links) for peeks, give-ups and items that are not photographs.

`app.dr_gradings.photo_id` (0020): the photograph a `remidio` grading was made from; from 0023 (D-046) unique per photograph
**and model** (`dr_gradings_photo_model_idx` on `photo_id`, `model_sha256`), so each research model grades a photograph once.

### app.dr_grading_views (0018)
Who was shown which AI grade, when (a log: no audit trigger). Columns `grading_id`, `user_id`, `viewed_at`.

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

### app.broadcasts
One row per "send the day's reminders" a person started (0015, D-034): template, AiSensy campaign, the day, mode, how many were
queued and how many on the preview were not sent. Its messages point to it (`messages.broadcast_id`). Audited.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| template | text | no |  |
| campaign | text | no |  |
| for_date | date | no |  |
| mode | text | no |  |
| queued | integer | no | 0 |
| skipped | integer | no | 0 |
| created_by | integer | yes |  |
| created_at | timestamp with time zone | no | now() |
| finished_at | timestamp with time zone | yes |  |

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
WhatsApp / email / SMS sent or queued (Broadcast, EmailAudit). Sudarshan's WhatsApp messages (0015, D-034): `status` queued -> sent / failed /
skipped; `mode` test or live; `attempts` is set to 1 before the AiSensy call, so a message interrupted by a restart is marked
failed, never sent twice; `payload` holds the campaign, the filled-in values and the appointment day. Rows with `legacy_ref`
are the Google app's broadcast summaries (importer).

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
| broadcast_id | bigint | yes |  |
| payment_id | bigint | yes |  |
| mode | text | yes |  |
| attempts | integer | no | 0 |
### app.payments
Razorpay payment links; status by polling (no webhook, D-017). 0015: `reference` (SUD-<id>, sent as reference_id), `phone` the
link is for (confirmed by staff), `mode`, `expires_at`, `paid_amount`, `needs_review` (amount paid differs), `error` (link not
made), cancel fields. Status created -> sent -> paid -> partially_refunded / refunded, or expired / cancelled / failed.

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
| reference | text | yes |  |
| phone | text | yes |  |
| currency | text | no | 'INR'::text |
| mode | text | yes |  |
| expires_at | timestamp with time zone | yes |  |
| paid_amount | numeric | yes |  |
| sent_at | timestamp with time zone | yes |  |
| sent_via | text | yes |  |
| needs_review | text | yes |  |
| error | text | yes |  |
| cancelled_at | timestamp with time zone | yes |  |
| cancelled_by | integer | yes |  |
| cancel_reason | text | yes |  |

### app.payment_refunds
One row per refund asked for (admins only, 0015). `idempotency_key` (SUDR-<payment>-<n>) goes to Razorpay so a retried request
never refunds twice; status requested -> pending -> processed / failed, by polling. Audited.

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no |  |
| payment_id | bigint | no |  |
| patient_id | integer | yes |  |
| amount | numeric | no |  |
| reason | text | no |  |
| note | text | yes |  |
| status | text | no | 'requested'::text |
| provider_refund_id | text | yes |  |
| idempotency_key | text | no |  |
| error | text | yes |  |
| requested_by | integer | yes |  |
| requested_at | timestamp with time zone | no | now() |
| processed_at | timestamp with time zone | yes |  |
| updated_at | timestamp with time zone | no | now() |
### app.patient_group (0017)
Patients by group for the Patients page cards (D-039). One row per patient and group; **rebuilt in full every night** by
`app.refresh_patient_groups()` (the sync worker calls it after the analytics rebuild at 02:30). Derived data: no audit
trigger, not readable by the Metabase role. Groups: rop, injection, laser, dr, glaucoma, squint, myopia, lowvision, retina.

| Column | Type | Null | Default |
|---|---|---|---|
| patient_id | bigint | no |  |
| group_key | text | no |  |
| status | text | yes |  |
| detail | jsonb | yes |  |
| last_event | date | yes |  |
| last_visit | date | yes |  |
| bcva_re, bcva_le | text | yes |  |
| bcva_date | date | yes |  |
| iop_re, iop_le | numeric | yes |  |
| iop_date | date | yes |  |
| built_at | timestamp with time zone | no | now() |

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
