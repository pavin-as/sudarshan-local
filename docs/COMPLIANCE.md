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
3. Every AI summary shown to a doctor is logged in `app.ai_summary_views`.

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
10. Do not push this repository to GitHub or any remote until the history is cleaned: commit `5bae4d8` (legacy
    snapshot) contains keys found by the assessment. Rotate those keys when the Google app is retired.
11. No patient data in git: exports (`*.xlsx`, `*.csv`, dumps) are git-ignored. Test data is synthetic and named
    `ZZ Test ...` or `TEST ...`.

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
| **Nightly backup of PostgreSQL (and Yarago MySQL) to QNAP, monthly restore test** | **Not yet. Highest priority before go-live** |
| HTTPS on the LAN (Caddy, `https://sudarshan.local`), `COOKIE_SECURE=true` | Not yet (before go-live) |
| MySQL 3306 closed to the LAN; root password rotated | Not yet (check no LAN client uses 3306 first) |
| Delete `D:\Sudarshan\sudershanWebsite.xlsx` (plaintext passwords, patient data) | Pavin to confirm |
| Git history cleaned of legacy keys; keys rotated | Not yet (before any remote push) |
| Google app's Gemini rule check sends patient names to Google | Ends when the Google app is retired |
| Privacy notice for patients covering appointment messages (WhatsApp/SMS) | To check with the clinic |
| Monthly access review (who has which role) | To start at go-live |

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
