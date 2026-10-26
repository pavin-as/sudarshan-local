# TESTING.md - how changes are checked

Nothing reaches shichika's live services without passing these. The clinic's real database is never used for tests that
write; it is only read by the read-only check.

## 1. Test environments

| Where | What | Writes allowed |
|---|---|---|
| **Test database** (developer machine / cloud workspace): PostgreSQL 16 with the same migrations and views and an *empty* Yarago mirror built from `yarago_schema.json`, plus synthetic rows | API test, demo data, screenshots | Yes |
| **Test database on shichika** (Pavin, 26 Oct): PostgreSQL 16 in Docker, 127.0.0.1:55432, built by `scripts\testdb.ps1 up` from `yarago_stub.sql`, every migration and view; `reset` empties it, `down` stops it | All database tests below; browser checks with a test server on 127.0.0.1:8585 (`D:\Sudarshan\.claude\launch.json`, web built into `D:\Sudarshan\testdb\web-dist`) | Yes (synthetic data only) |
| **shichika real database** | `server/test/real-data.ts` (read-only screen check), `scripts/check_views.py` | No (the check adds a temporary `zz_check` login and removes it) |

Point tests at a test database with an env file: `SUDARSHAN_ENV=<path to test .env>`.
Without shichika's `yarago_schema.json` (a cloud workspace), build the empty mirror from `server/test/yarago_stub.sql`
(the tables and columns the views read), then run every file in `db/migrations` and `db/views` in name order.
`server/test/api.test.ts` and `seed-demo.ts` refuse to run without it.

## 2. The checks

| Check | Command | When |
|---|---|---|
| Type check server | `cd server && npx tsc --noEmit -p .` | Every change |
| Type check + build web | `cd web && npm run build` | Every web change |
| **Scheduling rules and triage scoring** (30 + 7 checks, no database) | `cd server && npm run test:rules` | Every change to `services/rules.ts` or rule settings |
| **WhatsApp and payments** (18 checks, test mode end to end with AiSensy and Razorpay faked: who may, preview reasons, queue and outbox, no double send, restart safety, off and live switches, links, paid by polling, refunds, cancel, amount check, log sentences without keys); 7 more without a database in `test:rules` | `cd server && SUDARSHAN_ENV=<test env> npx tsx test/outreach.test.ts` (also run by `npm test`) | Every change to messaging or payments |
| **Retina AI** (D-040): 10 checks without a database in `test:rules` (who may, kappa against the grader's Python formula, agreement figures, grader answers and outages, metadata.csv, eye words, MRD as SPD number); 16 API checks with a fake grader (who may not, blinded grading, to-grade list hides the AI grade, rejected and offline photographs, file type / size / cross-site refusals, views logged, append-only trigger, patient fixed and no old-store copies, no grades in the activity log, agreement) | `cd server && SUDARSHAN_ENV=<test env> npx tsx test/retina.test.ts` (also run by `npm test`) | Every change to the Retina AI |
| **Remidio photographs** (D-041): 5 more checks without a database in `test:rules` (queue item shape from Remidio's example, links and tokens stripped, download host allowlist, JPEG/PNG check, Remidio Connect download paths and matching to the exam list); 12 checks with Remidio (the 12th: downloads imported, SPD only, dry run, second run adds nothing, later queue copy is a duplicate), downloads and grader faked (off touches nothing, who may switch, peek takes nothing and logs fields only, store then acknowledge, SPD link and sex check, duplicate, unmatched keep/skip, non-photo items kept without links, failing downloads retried then given up after 10, grading once per model (D-046: three graders, one to-grade row per photograph, screening outcome per model, doctor's grade on every model's grading, graders in status), photo served to admin/doctor only, kept for good with link-once) | `cd server && SUDARSHAN_ENV=<test env> npx tsx test/remidio.test.ts` (also run by `npm test`) | Every change to the receiver |
| **Topcon Maestro2 photographs** (D-048), `test/topcon.test.ts`, 12 checks:<br>- waiting-exam rules (no database);<br>- off reads nothing; only admins switch it; the start point is "now" when first switched on and can be set earlier, never in the future;<br>- peek converts, logs the shape only and keeps nothing;<br>- on keeps the colour photograph but not the infrared one, linked by SPD number with the sex checked, its files on disk and the work folder emptied;<br>- a done exam is not converted again; a re-saved one is a duplicate;<br>- an unmatched ID is kept or skipped; an exam without a photograph is logged;<br>- a failing export gives up after 5 tries without blocking later exams;<br>- grading as source `topcon`; the day's session and the doctor's report;<br>- photographs per camera; evaluation sets per camera.<br>The share is a temporary folder, the tool is faked by `test/fixtures/make_topcon_export.py` (synthetic DICOM), and the converter is the real one in `tools\oct-venv` | `cd server && SUDARSHAN_ENV=<test env> npx tsx test/topcon.test.ts` (also run by `npm test`) | Every change to the Topcon import |
| **Fundus reports** (D-042): 2 more checks without a database in `test:rules` (DR choice to grade, summary line, who writes / reads); 7 API checks (to-report list and who sees photographs, only doctors write and the form's rules, report signed and its grades blinded, grades added when the AI grades later, correction with reason and two names, kept for good, activity log) | `cd server && SUDARSHAN_ENV=<test env> npx tsx test/fundus.test.ts` (also run by `npm test`) | Every change to fundus reports |
| **Retina AI evaluation** (D-043, D-045, D-046): 11 checks without a database (`test/evaluation.unit.test.ts`, in `test:rules`: every metric against hand-worked values, AUROC with ties, bootstrap reproducible and patient-level, cautions, report and CSV, public-dataset label headers, paired differences, screening cut-offs and outcomes, live screening outcome per model with ungradable as uncertain, patient-level screening intervals); 3 API checks in `test/fundus.test.ts` (set preview / admin only / codes / reference copied; results, DRAFT report, CSV without names and logged; frozen set never changes) | `npm run test:rules`; `SUDARSHAN_ENV=<test env> npx tsx test/fundus.test.ts` | Every change to evaluation |
| **RFM grader** (D-044): start-up guard (pinned SHA-256 + pickle opcode check, then `weights_only=True`) shown in `docker logs sampada-rfm`; reproduction of RFM's published APTOS test AUROC with `D:\models\rfm\check_published.py`; paired-difference check in `test/evaluation.unit.test.ts` | `docker compose up -d --build` in `graders/rfm`; `python -I D:\models\rfm\check_published.py <per-image csv>` | Every change to the RFM grader |
| **API test** (38+ checks: logins, lockout, password change, permissions, cross-site refusal, users, calendar, booking refusals and overrides, reschedule, confirm, cancel/restore, story, board order, search, audit sentences, passwords never in the log) | `cd server && SUDARSHAN_ENV=<test env> npm test` | Every server change |
| Browser flow (log in, board, book a new patient, refuse a taken slot, cancel) with screenshots | Playwright script against the test server with demo data (`test/seed-demo.ts`) | Every screen change |
| Real-data read check: each screen's query, time and row count, no patient details printed | `cd server && npx tsx test/real-data.ts` (also step 7 of `install-server.ps1`) | After deploying to shichika |
| View sanity on real data | `scripts\check_views.py` (step 4 of `update.ps1`) | After every update |
| Importer | `scripts\import_sheets.py --dry-run` | Before any real import |
| Backup and restore | `scripts\backup.ps1` then `scripts\restore-test.ps1` (restore counts must match the backup) | After changes to the schema or backup scripts; automatically every 4 weeks |
| PowerShell scripts parse | PowerShell `Parser.ParseFile` | Every script change |

## 3. Rules for writing tests

- Test data is synthetic, named `ZZ Test ...` (API test) or `TEST ...` (manual trials). Never copy real patients into
  fixtures or screenshots.
- Tests clean up after themselves (the API test deletes its `zz_test` users, doctor, days and bookings, even on failure).
- Every bug fixed gets a test that would have caught it (e.g. "fields not sent must stay as they were" after an edit
  wiped phone numbers).
- Every permission gets a "who may not" check, not only "who may".
- Booking rules (the 16 scheduling rules, `test/rules.test.ts`) get one test per rule, built from the rule cards in
  `analysis/` and from recorded behaviour of the Google app (past appointments), because Apps Script cannot run locally.
- Performance: on shichika a single-day board should answer in under 300 ms and any screen under 1.5 s
  (`real-data.ts` prints times).

## 4. Definition of done (every change)

- [ ] Type checks and builds pass; API test passes on the test database.
- [ ] New behaviour has tests; screens checked in a browser (screenshot reviewed) at desktop and phone width.
- [ ] Screenshots of real data on shichika (they reach a cloud model): blur every element that can hold a patient's
      name or number, including headings and dialog titles, and open no dialog that is not blurred as a whole. On
      19 Oct a call dialog's title showed one patient's name in a check; the files were deleted at once.
- [ ] COMPLIANCE.md checklist (section 6) passes.
- [ ] SCHEMA.md updated if the schema changed; DESIGN.md if a pattern changed; DECISIONS.md if a decision changed.
- [ ] CHANGELOG.md entry under "Unreleased"; STATUS.md updated.
- [ ] Deployed with `update.ps1` outside clinic hours if it has migrations; `real-data.ts` and `check_views.py` reviewed.

## 5. Before go-live (acceptance)

- Shadow run: an agreed period where bookings are made in both systems and compared daily.
- Restore test from backup passes.
- Each scheduling rule confirmed by Pavin and Dr. Sameera, with its test passing.
- Staff walkthrough of: booking, rescheduling, cancelling, confirmation calls, follow-up calls, new patient linking.
