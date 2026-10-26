# COMPLIANCE.md - privacy, security and clinical safety rules

Sudarshan holds patient identity and health information for Sampada VR Specialty Eye Care LLP. These rules apply to
every person and every agent working on it. They are **not optional and not traded for speed**. If a task would break
one, stop and ask Pavin.

> This is a working guide, not legal advice. For anything formal (privacy notice wording, consent forms, a breach that
> has happened), get it checked by a lawyer.

## 1. What data Sudarshan holds

| Data | Where it comes from | Sensitivity |
|---|---|---|
| Patient name, MRD, phone, age/DOB, sex, language | Yarago mirror (`yarago`, `clinical.patient`); bookings in `app.appointments` | Personal data |
| Diagnosis, vision, IOP, findings, injections, lasers, medicines, allergies | Yarago mirror (`clinical.*`) | Health data: treat as the most sensitive |
| Dues and payments | Yarago mirror; `app.payments` | Financial |
| Staff names, usernames, roles, login times | `app.users`, `app.sessions` | Personal data |
| Activity log | `app.audit_log` | Contains patient names in sentences; same protection as patient data |
| Research DR grades (D-040): AI grade and scores, doctors' grades, photograph file name and hash | `app.dr_gradings`, `app.dr_doctor_grades` | Health data; research use only |
| Fundus photographs from the Remidio FOP (D-041) with the MRN, eye and Remidio's patient details | files in `D:\Sudarshan\data\fundus` (administrators and SYSTEM only; backup `fundus\`), `app.fundus_photos`, `app.remidio_queue_log` | Health data (clinical images); clinical roles (D-042) |
| The doctor's fundus report (D-042) | `app.fundus_reports` | Health data; clinical record in Sudarshan; written by doctors, read by clinical roles |
| Fundus photographs from the Topcon Maestro2 (D-048), with the DICOM patient ID (SPD number), sex, eye, scan protocol and the OP `.dcm` (which also holds name and birth date) | files in `D:\Sudarshan\data\fundus` (as above; backup `fundus\`), `app.fundus_photos`; exam copies only for the minutes of their conversion in `D:\Sudarshan\data\oct\work\import` (administrators and SYSTEM only) | Health data (clinical images); clinical roles |

Sudarshan never changes Yarago. Corrections to patient details are made in Yarago and flow in through the mirror.

## 2. Legal frame (India)

- **Digital Personal Data Protection Act, 2023** and the **DPDP Rules, 2025** (notified 13 Nov 2025). Most operative
  duties, including security safeguards (Rule 6) and breach notification, apply 18 months after notification (around
  May 2027; confirm the exact date). Build to them now; it costs little and the clinic is the Data Fiduciary.
  - Reasonable security safeguards: encryption or masking, access control, logging and monitoring, backups, and
    keeping logs for at least one year.
  - Breach: tell the Data Protection Board and each affected person without delay, and send the Board a detailed report
    within 72 hours of becoming aware.
  - Use personal data only for the purpose it was given (care and appointments), and only the data needed.
- **Medical records retention:** keep clinical records for at least the period medical regulations require (the
  Indian Medical Council regulations set 3 years for patient records; check current NMC rules). Clinical records live in
  Yarago; Sudarshan does not delete them.

## 3. Rules every change must follow

**Patient data and AI**
1. Patient-identifiable data never leaves shichika. No cloud API, no cloud AI, no pasting patient rows into chats or
   tickets. Cloud models get only de-identified or aggregate data.
2. AI drafts, a person acts. AI never writes to clinical records, never books or cancels, never sends a message by
   itself. Every AI-written sentence is labelled "AI-generated - verify" and every fact beside it shows its Yarago source.
3. Every AI grade from the research DR model shown to anyone is logged in `app.dr_grading_views` (D-040); the model's
   grade never leaves the Retina AI page.
   Every AI summary shown to a doctor is logged in `app.ai_summary_views` (built 19 Oct, D-026; a user who has viewed
   summaries is deactivated, never deleted, so the log stays whole). The doctor summary's overview is written by the
   local model only, from facts without name, MRD or ids, and is shown only when every number in it is in the facts.

**Access**
4. Every API route checks a permission (`need(req, "...")`; table in `server/src/lib/permissions.ts`). Front-desk
   roles do not see clinical detail. Add a permission rather than widening an existing one.
5. Personal logins only. No shared accounts. Leavers are deactivated the same day (Users screen).
6. Passwords: bcrypt only, never logged, never stored in plain text, never imported. Temporary passwords are shown once
   and must be changed at first login.

**Recording**
7. Every write to `app.*` is audited by trigger. Never bypass it (no writes outside `withTx()`); `app.skip_audit` is
   only for the bulk importer.
8. The activity log is never edited or deleted by the app. Keep it at least one year (planned: indefinitely while small).

**Secrets and code**
9. Secrets live only in `D:\Sudarshan\app\.env` (administrators only, git-ignored). Never print, log or commit them.
10. History cleaned 19 Oct 2026 before the first push to the private GitHub repo: the Gemini API key
    (`legacy/sudarshan/RuleEngine.js`) and the AiSensy token (`legacy/sudarshan/broadcast.js`) were replaced by
    `***REDACTED-...***` in every commit (git-filter-repo), and one real patient MRD mentioned in the changelog was removed.
    Both keys stay valid until rotated: **rotate them now** (they were in this history and are live in the Google app).
    A backup of the history as it was is kept offline at `D:\Sudarshan\backups\app-before-redaction-2026-10-19.bundle`
    (it still holds the keys; never upload it; delete it once the keys are rotated). Nightly code bundles on the QNAP
    from before 19 Oct also hold them. Never commit secrets (`.env` only) or patient data (names, MRDs with a story).
11. No patient data in git: exports (`*.xlsx`, `*.csv`, dumps) are git-ignored. Test data is synthetic and named
    `ZZ Test ...` or `TEST ...`.

**Analytics**
14. Reporting tools (Metabase, any BI) connect only as `sudarshan_bi`, which can read only the `analytics` schema.
    That schema never holds names, phone numbers or MRDs. Exports from Metabase stay on clinic computers.

**Messages and payments**
15. Messages and payment links to patients are sent only when a person presses send (D-034); test mode until cut-over.
    Never send clinical detail (plan, diagnosis, notes) in a WhatsApp template or to Razorpay. Phone numbers are not
    written to the server log (message ids only).

**Network**
12. Clinic LAN only. The server port is open to the local subnet only. Nothing on shichika is reachable from the internet
    (Razorpay is polled, not called back).
13. Logs (`logs/`) must not contain cookies, passwords or request bodies (the server redacts them). Do not add logging of
    patient details beyond ids.

## 4. Control status

| Control | Status |
|---|---|
| Read-only Yarago user `sudarshan_ro` | Done |
| App never queries MySQL; mirror in Postgres | Done |
| PostgreSQL listens on localhost only | Done |
| Personal logins, bcrypt, sessions, lockout, forced password change | Done |
| Role permissions on every route | Done |
| Trigger audit log with readable feed | Done |
| Web security headers (CSP, no framing, nosniff) | Done |
| Server port limited to LAN subnet (firewall rule) | Done |
| Nightly backup of Sudarshan to QNAP, 14 daily + 12 monthly, restore test every 4 weeks | Done 19 Oct (scripts/backup.ps1); Yarago has its own backup to `F:\EMR_AUTO_BACKUP` |
| Off-site copy of backups (fire/theft at the clinic) | Not yet: decide where (encrypted cloud or a drive taken home weekly) |
| HTTPS on the LAN (Caddy, `https://sudarshan.local`), `COOKIE_SECURE=true` | Not yet (before go-live) |
| MySQL 3306 closed to the LAN; root password rotated | Not yet (check no LAN client uses 3306 first) |
| Delete `D:\Sudarshan\sudershanWebsite.xlsx` (plaintext passwords, patient data) | Done 19 Oct |
| Git history cleaned of legacy keys; keys rotated | History cleaned 19 Oct (Gemini key, AiSensy token). Keys **not yet rotated** |
| Google app's Gemini rule check sends patient names to Google | Ends when the Google app is retired |
| Privacy notice for patients covering appointment messages (WhatsApp/SMS) | To check with the clinic; needed before WhatsApp or payments go live (P-6) |
| WhatsApp (AiSensy) and payment links (Razorpay), D-034 | Built 20 Oct in **test mode** (TEST bookings, test numbers, Razorpay test keys only); live refused before cut-over and only by an admin. AiSensy receives phone, name, date and time; Razorpay receives name, phone and "<clinic> appointment <date>" (no plan, no notes): record both as processors. Outbound HTTPS only (`backend.aisensy.com`, `api.razorpay.com`), nothing inbound. Keys in `.env` only, never shown on screens or logged; the activity log check in `test/outreach.test.ts` looks for them. **Rotate the AiSensy key before Sudarshan uses it** (the old one is in git history) |
| Monthly access review (who has which role) | To start at go-live |
| `sudarshan_bi` read-only login limited to `analytics`; Metabase LAN only | Done 19 Oct: access checked by `install-metabase.ps1` (no `app`, `yarago`, `clinical`); read-only transactions, 120 s limit; firewall port 3000 local subnet only |
| Analytics free of identity | Done 19 Oct: random patient key (mapping in `app`), age band only; staff-typed text (cancel reasons, remarks, diagnosis notes) not copied |
| Weekly email content | Aggregate dashboard figures only, to admin@gs.sampadavr.com via Gmail (Google Workspace) |
| Remidio photo receiver (D-041) | Built 25 Oct, **off** until an admin switches it on. Outbound HTTPS only, to `remidio-backend-india.appspot.com` (queue) and `storage.googleapis.com` (signed photo links, nothing else accepted); nothing about patients is sent to Remidio (the queue calls carry no patient data). Tokens only in `.env` (`setup-remidio.ps1`, never shown or logged). Photographs kept for good (no delete by trigger), in the nightly backup; logs and the System tab show item ids, outcomes and field names, never names or MRNs. Remidio is the clinic's processor for these images (record it with AiSensy and Razorpay) |
| Remidio Host Gateway API trial (D-040 Phase 2 groundwork) | `scripts/remidio-api-trial.ps1`, run by Pavin with the client auth token generated in Remidio Connect (Integration Settings > Generate Token; pasted at a hidden prompt, never stored; treat as a password; for Phase 2 it goes in `.env` only), or else his dashboard login. Remidio's Cloud Data Queue, gateway and webhook settings stay off (webhooks would need shichika reachable from the internet). Read only, outbound HTTPS to `remidio-backend-india.appspot.com`: our own patients' exams come in, nothing about patients goes out (the optional `-Mrn` puts one MRN in an address). Never touches the queue. Full answers kept in `D:\classification\sampada-retinal-ai\_remidio_trial` (administrators only, tokens and link signatures removed) until deleted after the trial; only the name-free summary is shared. Remidio is already the clinic's processor for these images. **Incident, 25 Oct 14:34:** a script bug (PowerShell variable names ignore case, so the MRN tally overwrote the `-Mrn` setting) made the optional step 5 run unasked and send the 91 MRNs of the exams just received, space-separated in one HTTPS address, to Remidio's `getPatientWithLastExam` (answer 404). Only MRNs, only to Remidio, which had sent those same MRNs seconds before; nothing else about the patients; may remain in Remidio's server logs. Fixed the same day (renamed tally; step 5 now needs `-Mrn` given and one SPD number). For Pavin to judge; not a disclosure to a new party |
| Topcon Maestro2 photo import (D-048) | Built 26 Oct, **off** until an admin switches it on. Everything stays on the clinic LAN: shichika reads the ImageNet PC's share `SudarshanOCT$` (read only, account `sudarshan_ro`, which is denied on the PC's other shares; a Kaspersky rule lets only 192.168.0.49 reach port 445). Nothing is written to ImageNet. The share password is only in `.env` (`setup-topcon.ps1`), never shown or logged (net use's error text is not passed on). Exam copies are removed after each conversion. Photographs are kept for good, like Remidio's. Logs and the System tab show IMAGEnet file numbers, outcomes and shapes, never names or IDs. Topcon's tool and the converter run on shichika only; nothing goes to Topcon or any cloud. Found 26 Oct, for Pavin and Topcon: the ImageNet PC's own shares `D`, `IMAGEnet6` and `Users` give Everyone Full, and SQL Server 1433 and RDP 3389 answer from the LAN (OCT_PLAN section 2) |
| Isolated test database (26 Oct, Pavin) | PostgreSQL 16 in Docker on shichika (`scripts\testdb.ps1`), 127.0.0.1:55432 only, 1 GB, synthetic data only, never the clinic database. Its passwords and env file are in `D:\Sudarshan\testdb` (outside git). Test web builds go to `D:\Sudarshan\testdb\web-dist`, never `web\dist`, which is live |
| Research DR grader (D-040) | Built 25 Oct. Runs on shichika only (Docker, 127.0.0.1:7860, LAN firewall rule removed by `setup-retina-ai.ps1`); gets the photograph and file name, no patient detail; shared key in both `.env` files (grader's `docker\.env` limited to administrators). Admin and doctor role only (`retina_ai.use`). Not a medical device: grade never written to clinical records, summaries, follow-ups or messages; every shown grade logged in `app.dr_grading_views`. Grader log now holds MRD only. The grader's September test data (4 random photographs with made-up MRDs, typed names and phones in `records.db`, the pre-production database and log lines) is removed: migration 0019 in Sudarshan, `scripts/remove-retina-test-data.ps1` on the grader's disk (Pavin, 25 Oct) |

## 5. If something goes wrong (possible breach)

Examples: a laptop or backup drive with data is lost; someone outside the clinic reaches the server; patient data was
sent to the wrong place; a password is known to someone who should not have it.

1. **Contain:** deactivate the affected logins (Users screen), stop the service if needed
   (`Stop-Service SudarshanServer`), unplug the affected device from the network. Do not delete logs.
2. **Record:** what happened, when it was noticed, what data and how many patients, from `app.audit_log` and `logs/`.
3. **Tell Pavin immediately.** Pavin decides on notifying the Data Protection Board and affected patients (without
   delay; detailed report within 72 hours) and gets legal advice.
4. **Fix and note:** the cause is fixed, the change goes in CHANGELOG.md, and a DECISIONS.md entry if a rule changes.

## 6. Checklist for every change (agents and people)

- [ ] No patient data sent off shichika, printed in logs, committed, or put in test fixtures.
- [ ] New route has a permission check; new table has audit triggers and field labels.
- [ ] No secrets in code or output.
- [ ] AI output, if any, is labelled and sourced, and a person approves any action.
- [ ] TESTING.md checks pass; CHANGELOG.md updated.
