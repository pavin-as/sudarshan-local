# Assessment - sudarshan

2026-10-18. Source: `legacy/sudarshan` (plain directory in this workspace, snapshot commit 5bae4d8). Read-only analysis.

## Executive Summary

Sudarshan is the clinic's appointment system: a Google Apps Script web app (V8) with 27 HtmlService pages, Google
Sheets as its database (43 named sheets) and integrations with Razorpay, AiSensy WhatsApp, Gemini and MailApp. It
is about **75 KSLOC** (index ≈ 339), concentrated in one 23,158-line `Code.js` with 337 functions, with no tests,
no manifest and no build. Risk is **high**: the deployment is "anyone, even anonymous", login can be bypassed with
one browser-console call, passwords are plaintext, any sheet (including `Login`) can be read anonymously, two live
API keys are in source, and patient names go to Gemini. Recommendation: **Rebuild** (`reimagine`) on the planned
local stack (PostgreSQL + Fastify + React), porting business rules but not the auth, ID or storage model - and,
because the legacy app stays live during the rebuild, rotate the two keys and close the public-function holes now.

## System Inventory

Tool: `scc`/`cloc` not installed, so `find` + `wc -l` (non-blank lines) with complexity ranked by decision keywords
(`if|for|while|case|catch|&&|\|\||?`).

| Kind | Files | Lines | Non-blank |
|---|---|---|---|
| `.js` (server) | 8 | 27,566 | 24,487 |
| `.gs` (server) | 12 | 5,805 | 5,236 |
| `.html` (UI, inline JS/CSS) | 27 | 50,014 | 45,090 |
| `.md` docs | 9 | 4,072 | 3,269 |
| `.pdf` (rule sheet) | 1 | - | - |
| **Code total** | **47** | **83,385** | **74,813** |

Most complex files (decision keywords / non-blank lines): `Code.js` 4,263 / 20,499 · `dayOverview.html` 816 / 5,766 ·
`bookAppointment.html` 418 / 3,975 · `followupAppointment.html` 413 / 3,857 · `directCall.html` 388 / 3,656 ·
`settings.html` 372 / 2,745 · `RuleEngine.js` 316 / 1,110 (densest) · `rescheduleAppointment.html` 271 / 2,220 ·
`PaymentService.gs` 239 / 1,281 · `cancelList.html` 233 / 2,102.

**Technology fingerprint**
- Runtime: Google Apps Script V8 (all 20 server files pass `node --check`). Runtime settings (timezone, OAuth scopes,
  web-app access) live in `appsscript.json`, which is **not** in the snapshot; docs say "Execute as owner / Anyone,
  even anonymous" (`paymentPlan.md:300`, `paymentSetup.md:219`). Deployed through the Apps Script editor (user).
- UI: HtmlService templates, Bootstrap 5.3.0, Popper 2.11.6, Chart.js 4.4.0 **and unpinned** `chart.js`, jQuery 3.6.0,
  select2 4.1.0-rc.0, Font Awesome 6.0.0 - all from CDN, no SRI.
- Data: Google Sheets. 43 named sheets; status is encoded by which sheet a row is on (`appointment`, `cancel`,
  `Archive`, `appointment_archive`, `followup`, `followupArchive`). 16 sheets are read but never created by code
  (`appointment`, `Login`, `patientMaster`, `DoctorAvailability`, `Holidays`, `followupMaster`/`2`, ...). No column
  export; layouts only in prose (`architecture.md` §Data Layer) and as hardcoded indexes in code. Sessions and
  provider secrets in Script Properties.
- Integration points: `doGet` (`Code.js:2`, renders any `?page=`), `doPost` Razorpay webhook (`PaymentWebhook.gs:36`),
  9 time triggers (02:00 x3, 06:00, 20:00, 23:00, hourly, every minute), Razorpay REST, AiSensy, Gemini
  (`generativelanguage.googleapis.com`), MailApp, one external spreadsheet via `openById` (`appointmentTransfer.js:145`),
  Yarago-fed sheets `yaragoPatientMaster` / `followupMaster` / `followupMaster2` (feeder not in repo).
- Tests: none. Four `test*` functions are manual connectivity checks (`RuleEngine.js:1157`, `RazorpayAdapter.gs:477`,
  `Code.js:16159`).

## Architecture at a Glance

Twelve domains; diagram in `ARCHITECTURE.mmd`. `D7 Appointment Lifecycle` is the hub: every write there also
recomputes capacity (D5), logs audit/journey (D3) and touches remarks/tags (D4).

| # | Domain | Main files | Key sheets |
|---|---|---|---|
| D1 | Auth, sessions & roles | `Code.js:51-1036`, `Login.html`, `roleManagement.html`, `sharedLayout.html` | `Login`, Script Properties |
| D2 | Settings & configuration | `Code.js:1037-1496`, `:21590-22168`, `:22863-23158`, `API_setting.gs`, `settings.html` | `SystemSettings`, `generalSettings`, `Settings`, `RuleSettings`, `API_setting` |
| D3 | Audit & appointment journey | `Code.js:1497-2046`, `:15855-16189`, `AuditActivity.gs`, `auditLog.html`, `AuditActivityView.html` | `AuditLog`, `AuditLogArchive` |
| D4 | Remarks, comments & tags | `Code.js:2047-3579` | `RemarksHistory`, `CommentsHistory`, tag column AF |
| D5 | Capacity planning & slot availability | `Code.js:3580-4387`, `:6302-8249`, `:22169-22456` | `planningA`, `planningB`, `DoctorAvailability*`, `DoctorLeaveDays`, `Holidays` |
| D6 | Patient master | `Code.js:4977-5500`, `:10591-11014`, `syncPatientData.js`, `patientMaster.html` | `patientMaster`, `tempPatientMaster`, `yaragoPatientMaster` |
| D7 | Appointment lifecycle (core) | `Code.js:4388-4976`, `:5501-5968`, `:8250-14803`, `:16190-16860`, `archiveOldAppointments.js`, booking/day/month/list pages | `appointment`, `cancel`, `Archive`, `appointment_archive` |
| D8 | Follow-up & direct-call intake | `Code.js:5969-6301`, `:16861-19942`, `followupAppointment.html`, `directCall.html` | `followup`, `followupArchive`, `followupMaster`/`2`, `directCall` |
| D9 | Triage / urgency | `Code.js:19943-20114`, `triage.gs`, `identification.html`, `triageView.html` | `urgencyIdentification` |
| D10 | Rule checks + LLM notes, slot optimizer | `RuleEngine.js`, `Slot_setMay10Heap1948.js`, `Code.js:12873-13709`, `SlotOptimization.html` | `RuleSettings`, `slotOptimization`, optimizer output sheets |
| D11 | Reporting, analytics, email digests | `Code.js:9055-9970`, `:11083-11500`, `:14804-15854`, `:20273-21589`, `:22457-22862`, `DailyKPIReport.js`, `Dashboard.html`, `Visualization.html`, `rescheduleAnalytics.html` | `monthlyReport`, `DailyKPIReport`, `EmailAudit` |
| D12 | Payments / WhatsApp / transfer | `Payment*.gs`, `RazorpayAdapter.gs`, `broadcast.js`, `Broadcast.html`, `appointmentTransfer.js` | `payment`, `refund`, `paymentLog`, `Broadcast` |

Dangling references: `generateDayExcel` (`monthOverview.html:2181`) has no server function; `?page=viewAppointment`
(`monthOverview.html:2139`) has no page; `optimized-frontend.html` is orphaned and calls two missing functions;
`deleteAppointment` first looks for a non-existent `Appointments` sheet (`Code.js:12496`).

## Production Runtime Profile

No telemetry available: no APM, no Apps Script execution-log export. (The clinic-flow baselines in `docs/STATUS.md`
come from Yarago, not from Sudarshan's runtime.) An execution-log export from the Apps Script dashboard would show
trigger durations and the slowest server calls.

## Technical Debt (top 10)

| # | Debt | Evidence | Remediation |
|---|---|---|---|
| 1 | Appointment ID = `yyyyMMdd_HHmmss` timestamp, no lock; duplicates later rewritten as `ID_####`, breaking remark/audit/journey links | `Code.js:5754-5758` (+8 more sites), `archiveOldAppointments.js:60-69`; only locks `Code.js:17043`, `PaymentService.gs:69` | Database-generated permanent IDs in a transaction; never rewrite an ID |
| 2 | Status = which sheet the row is on; moves are append-then-`deleteRow(n)` with no lock (18 sites) | `Code.js:10530`, `12639-12642`, `12104`, `18796`, `19461`, `archiveOldAppointments.js:39` | One `app.appointment` table with a `status` column and audited updates |
| 3 | Same-named functions in the shared global scope silently override each other (e.g. `getNextDayWithAppointments` - inferred to always fall back to tomorrow) | `Code.js:4517` vs `:9145`; `timeStringToMinutes` `Code.js:7318` vs `Slot_setMay10Heap1948.js:479`; `formatTime` x4 | Port each once, with a test, choosing the correct behaviour deliberately |
| 4 | Column positions hardcoded: `TAG_COLUMN_INDEX = 31` declared 12 times, ~388 `row[n]` reads, header fallbacks to fixed columns | `Code.js:2836` ... `18383`, `5833-5862`, `16970-17019` | Columns defined once in DDL; import maps by header name and fails loudly |
| 5 | Credentials and access: hardcoded key, plaintext passwords, keys in a sheet, ~193 public functions with no session parameter | `RuleEngine.js:1146` (`AQ.A****`), `Code.js:66`, `API_setting.gs:109`, `Code.js:5246` | Rotate; secrets in `.env`; argon2/bcrypt; auth middleware on every route |
| 6 | 47 empty `catch {}`; post-booking capacity/planning updates fail silently; daily transfer gives up without a log | `Code.js:5879-5909`, `6229-6255`, `appointmentTransfer.js:150-152` | Derived state in the same transaction or a job table with alerts; lint-ban empty catch |
| 7 | A report deletes data: daily KPI job deletes `cancel` rows sharing an MRD | `DailyKPIReport.js:87`, `:471-539` | Reports read-only; any merge becomes an explicit, audited, tested rule |
| 8 | God file + booking copied three ways, each with own ID/row/column handling; headers inserted mid-request; `showAlert` defined in 23 pages | `Code.js:5616`, `5969`, `19636`, `5669-5710` | One booking service used by every entry point |
| 9 | Timezone: 172 calls depend on an unseen script timezone; 10 client sites take dates from `toISOString()` (UTC; inferred off-by-one before 05:30 IST) | `appointmentTransfer.js:54`; `dayOverview.html:1754`, `monthOverview.html:2160` | `date`/`time` + `timestamptz`, Asia/Kolkata fixed in one place |
| 10 | Dead / broken code reachable via `doGet` (`optimized-frontend.html`), unused functions, `showReschedulePage` uses email as session token | `Code.js:8-10`, `:11016`, `:19880`, `:2258`, `:10329` | Don't port; whitelist routes |

Note: `Slot_setMay10Heap1948.js` is live (called from `Code.js:12918`); the docs' `optimizeSlots()` entry point does not exist.

## Security Findings

Credential inventory in `SECRETS.local.md` (gitignored; not for sharing). Two live keys (Gemini, AiSensy) are in
source and in this repo's git history: rotate both now.

| ID | Sev | CWE | Finding | Evidence |
|---|---|---|---|---|
| SEC-001 | Critical | CWE-288 | Login bypass: `createSession(username)` is public and never checks the password; client calls it after `validateLogin` | `Code.js:74`, `Login.html:324-360` |
| SEC-002 | Critical | CWE-306 | Public admin/setup functions: `setupRazorpayCredentials` (redirect payments), `generateWebhookToken` (returns token), `purgeAllSessions` (wipes all Script Properties incl. secrets), triggers, archive, settings writers | `PaymentConfig.gs:193,233`, `Code.js:294,1705,1725,13709,21643`, `PaymentTriggers.gs:34,49,491` |
| SEC-003 | Critical | CWE-200/522 | `getActiveLLMConfig`/`getActiveWAConfig` return API keys without a session; `loadApiSettings` returns all keys to any logged-in user | `API_setting.gs:243,291,135-160` |
| SEC-004 | Critical | CWE-798 | Hardcoded Gemini key and AiSensy JWT | `RuleEngine.js:1146`, `broadcast.js:28` |
| SEC-005 | High | CWE-862 | Anonymous PHI reads: `getSheetData(sheetName)` returns any sheet incl. `Login`; ~13 patient/appointment search functions need no session | `Code.js:12923`, `:5246`, `:10591`, `:4388`, `:10233` |
| SEC-006 | High | CWE-862 | Anonymous writes: `cancelAppointment` accepts a bad token; restore, remarks delete, planning updates unchecked | `Code.js:10415-10465`, `:11907`, `:2181`, `:13575` |
| SEC-007 | High | CWE-256/916 | Plaintext passwords in `Login` column B, compared with `===` | `Code.js:66,670,759,923` |
| SEC-010 | High | CWE-79 | Stored XSS: patient names/remarks into `innerHTML` across ~15 pages (token in `window.sessionToken` is stealable) | `appointmentList.html:921`, `dayOverview.html:5460`, `directCall.html:2203`, ... |
| SEC-012 | High | CWE-359 | PHI to cloud LLM: Gemini prompt carries patient full name, date/time, procedures, wheelchair status, family names; violations array is client-supplied; key in URL | `RuleEngine.js:981-1107`, caller `dayOverview.html:5211` |
| SEC-008 | Medium | CWE-307 | No brute-force protection on `validateLogin` | `Code.js:56` |
| SEC-009 | Medium | CWE-598 | Session token in URL, 10 h sliding window, no absolute cap | `Code.js:4-11`, `Login.html:342` |
| SEC-011 | Medium | CWE-1236 | Formula injection: ~197 sheet writes of client text unneutralised; CSV export unescaped | `Code.js:5616`, `rescheduleAnalytics.html:1197` |
| SEC-014 | Medium | CWE-345 | Webhook has no HMAC (GAS cannot read headers); only `?wh=` token, rotatable via SEC-002 | `PaymentWebhook.gs:36-63` |
| SEC-016 | Medium | CWE-829/353 | CDN scripts without SRI; `chart.js` unpinned; select2 pre-release | `Dashboard.html:8`, `patientMaster.html:451-453` |
| SEC-013 | Low | CWE-359 | AiSensy receives phone, name, date/time (expected; record as data processor) | `broadcast.js:360-391` |
| SEC-015 | Low | CWE-918 | Admin-set provider URL / unvalidated Gemini `modelId` in URL | `API_setting.gs:219`, `RuleEngine.js:1027` |
| SEC-017 | Low | CWE-620 | Password change without current password, no complexity rule | `Code.js:874-923` |
| SEC-018 | Low | CWE-209 | `error.toString()` returned and rendered via innerHTML | `Login.html:388`, `Dashboard.html:1728` |
| SEC-019 | Low | CWE-532 | Patient names/MRDs in execution logs | `Slot_setMay10Heap1948.js:226,310` |

## Documentation Gaps (top 5)

1. **Security model as deployed.** Docs describe role levels, but not that the web app is anonymous-access and every
   un-suffixed server function is callable from the Login page; `CLAUDE.md` says sessions are 24 h in user
   properties, code uses 10 h in script properties (`Code.js:146,159`).
2. **Sheet schemas and the status-by-sheet lifecycle.** No column layout for any of the 43 sheets; which sheet is
   the source of truth for slots (`planningA` vs `planningB` + `getAllowedSlots`), and the three overlapping settings
   sheets (`SystemSettings`, `generalSettings`, `Settings`).
3. **Yarago feeds.** Nothing says who or what populates `yaragoPatientMaster`, `followupMaster`, `followupMaster2`,
   or who maintains `DoctorAvailability*`, `DoctorLeaveDays`, `Holidays`, `PlanOfActionMaster`.
4. **Scheduled jobs.** Which of the 9 trigger installers are live (two competing 20:00 report installers), that three
   jobs share 02:00, and that the daily KPI job deletes duplicate cancel rows.
5. **Rule engine and optimizer.** The docs' `optimizeSlots()` does not exist (real entry `generateOptimizedSchedules`
   via `runSlotOptimizationForDate`); how `RuleSettings` maps to `rules.md`, `checks.md` and
   `Day_Scheduling_Rule_Checks.pdf`; and what the Gemini step adds.

## Relative Scale

| KSLOC (code, non-blank) | Files | Index (`2.94 × KSLOC^1.10`) |
|---|---|---|
| 74.8 | 47 | ≈ 339 |

The index is a relative size measure for ranking this system against others. It is **not** a timeline or a cost.
Note that ~60% of the KSLOC is UI HTML with heavy duplication, so the logic to carry over is smaller than the raw size.

## Recommended Modernization Pattern

**Rebuild → `/code-modernization:modernize-reimagine sudarshan`.** The target is already chosen and partly built
(PostgreSQL 16 with a Yarago mirror, Node 24 + Fastify, React, local-only on shichika), and almost nothing structural
in the legacy is worth keeping: the storage model (status by sheet, row-number and timestamp IDs, positional
columns), the auth model (anonymous deployment, public functions, plaintext passwords, URL tokens) and the Gemini
path all conflict with the project's hard rules. What *is* valuable is the domain behaviour - booking and capacity
rules, follow-up intake, rule checks, slot optimization, payments flow - so the route is extract-then-rebuild
(`map`, then `extract-rules` into `analysis/` rule cards with tests, then `brief`, then `reimagine`), not a
module-by-module `transform` of `Code.js`. Because the legacy stays live until cut-over and is internet-reachable,
run `/code-modernization:modernize-harden sudarshan` in parallel for an interim patch to the live Apps Script project
(rotate keys; suffix admin/setup functions with `_`; merge `validateLogin`+`createSession`; session guard on readers;
remove `getSheetData`), applied by a person through the Apps Script editor, never to `legacy/`.
