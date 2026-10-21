# CLAUDE.md - Sudarshan (local)

Sampada VR's appointment system for a retina clinic in Tirur, Kerala. Clinic-LAN only, 6-10 staff plus doctors.
Being rebuilt from Google Apps Script (snapshot in `legacy/sudarshan/`) as a local app on the Windows server **shichika**.

## Read first (in this order)
1. `docs/STATUS.md` - where the project is and what is next.
2. `docs/DECISIONS.md` - what has been decided and why. Do not work around a decision; ask Pavin.
3. `docs/COMPLIANCE.md` - privacy, security and clinical-safety rules (binding).
4. The document for your task: `docs/PLAN.md` (the plan), `docs/SCHEMA.md` (database), `docs/DESIGN.md`
   (code structure and interface), `docs/TESTING.md` (checks and definition of done), `docs/RUNBOOK.md` (running shichika).
After a change: add a `docs/CHANGELOG.md` entry, tick `docs/STATUS.md`, and update SCHEMA/DESIGN/DECISIONS if affected.

## Hard rules
- `legacy/` is read-only reference. Never edit it.
- Yarago (MySQL 5.6, db `yghealthcarecombined`) is the clinic EMR on the same machine. Read it ONLY with `sudarshan_ro`, ONLY from `sync/`. Never write to it, never run heavy queries against it during clinic hours.
- The app reads Yarago data from PostgreSQL schemas `yarago` / `clinical`, never from MySQL directly.
- Patient-identifiable data never goes to a cloud model. Local model (Ollama) only; cloud models get de-identified or aggregate data.
- AI never writes clinical records or sends messages by itself: it drafts, a person acts.
- Every write to `app.*` is audited (who, when, old, new). Every AI summary shown is logged.
- Secrets come from `.env`; never print, log or commit them. Pushing is allowed only to the private GitHub repo
  `pavin-as/sudarshan-local` (`origin`); history was cleaned of old keys first (COMPLIANCE.md). No other remote.
- Every app write goes through `withTx()` (server/src/db.ts) and every route starts with `need(req, "<permission>")`.
- Tests that write use a TEST database only (`SUDARSHAN_ENV`); on shichika only read-only checks run.
- shichika also runs Yarago (Tomcat7), its backup (Tomcat9_AutoDB) and other services: keep resource use modest (PostgreSQL ~4 GB, GPU work outside clinic hours).

## Stack
PostgreSQL 16 (+ pgvector later) - Python 3.13 sync worker - Node.js 24 LTS + TypeScript + Fastify (`server/`) - React + Vite + TypeScript with hand-written CSS tokens (`web/`) - NSSM services. Served at http://shichika:8484 (LAN); Caddy + https://sudarshan.local before go-live.

## Database schemas
`yarago` raw mirror - `yarago_staging` nightly copy - `clinical` decoded views - `app` Sudarshan data. Migrations in `db/migrations/`, numbered, idempotent.

## Conventions
- Dates `YYYY-MM-DD`, times `HH:MM` 24h, timezone Asia/Kolkata.
- Permanent IDs for every record (no sheet row numbers). Status fields, not separate archive tables.
- MySQL `0000-00-00` dates become NULL in the mirror; Yarago code IDs (e.g. `sph_R_Id`, `DVA_R_Id`) are decoded in `clinical` views.
- Booking rules come from the extracted rule cards in `analysis/`; each rule has a test.
