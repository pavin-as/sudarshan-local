# TESTING.md - how changes are checked

Nothing reaches shichika's live services without passing these. The clinic's real database is never used for tests that
write; it is only read by the read-only check.

## 1. Test environments

| Where | What | Writes allowed |
|---|---|---|
| **Test database** (developer machine / cloud workspace): PostgreSQL 16 with the same migrations and views and an *empty* Yarago mirror built from `yarago_schema.json`, plus synthetic rows | API test, demo data, screenshots | Yes |
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
