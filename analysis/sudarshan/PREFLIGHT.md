# Preflight - sudarshan

Run 2026-10-18 on shichika (Windows 11 Pro, Git Bash + PowerShell).
`legacy/sudarshan` is a plain directory in this workspace (not a symlink), committed read-only in 5bae4d8.

## Answers

1. **Scope** - Is this code the complete system, or one slice of a larger codebase? If a slice: what outside it depends on code inside it, and is breaking those consumers acceptable?
   > Complete system

2. **Build & test locally** - Can this environment restore, build, and run the tests? Roughly how long does the full CI pipeline take?
   > No local build/tests

3. **Bespoke build infrastructure** - Is there organization-specific build or dependency machinery a newcomer would not guess? Where is it documented?
   > the app is deployed through the Apps Script editor, with no separate build step (CLAUDE.md in the old code mentions clasp as optional)

   (First answered "Don't know" in the pop-up; corrected by the user in chat the same day.)

4. **Prior attempts** - Has anyone tried to modernize this before? What went wrong?
   > No, this is the first

5. **Off limits** - Is anything in this code not allowed to change in this pass?
   > Nothing off limits

## Scope boundary (Check 6)

Standalone. `legacy/sudarshan` is a self-contained Google Apps Script project; nothing in it imports code from
elsewhere in this repo and nothing in `sync/`, `db/` or `scripts/` references it. Its real outside couplings are
**runtime data/services, not code**: Google Sheets (43 named sheets, plus one cross-spreadsheet transfer via
`openById` in `appointmentTransfer.js:149`), Razorpay, AiSensy (WhatsApp), Gemini, MailApp, and a Yarago patient
sync (`syncPatientData.js`). No inbound code consumers - no blast-radius decisions needed.

## Checks

| # | Check | Status | Found | Fix |
|---|---|---|---|---|
| 0 | Human answers | ✅ | All 5 answered | - |
| 1 | Stack | ✅ | Google Apps Script (V8), 57 files: 27 `.html` (HtmlService UI, ~2.0 MB), 8 `.js` + 12 `.gs` server code (`Code.js` alone 23,158 lines / 726 KB), 9 `.md` docs, 1 `.pdf` rule sheet. No manifest, no package.json | - |
| 2 | Analysis tooling | ⚠️ | `python` / `py -3` = Python 3.13.2 ✅ (`python3` is the Microsoft Store stub - use `python`); `scc`, `cloc`, `lizard` missing | `winget install benboyter.scc` ; `python -m pip install lizard` |
| 3a | Build definition | ⚠️ | No CI, no build. Deployed through the Apps Script editor (confirmed by the user; the old CLAUDE.md lists clasp only as an optional alternative); `.clasp.json` and `appsscript.json` (manifest: OAuth scopes, web-app access, timezone, runtime) are **missing from the snapshot** | Pull `appsscript.json` from the live project (Project settings -> show manifest) into the snapshot's source of truth |
| 3b | Smoke test | ✅ L1 / n/a L2 | Level 1: all 20 `.js`/`.gs` files pass `node --check` (Node 24.19). Level 2 impossible: GAS services (`SpreadsheetApp` 204 refs, `Session` 251, `Utilities` 188, `ScriptApp`, `PropertiesService`, `UrlFetchApp`, `LockService`, `MailApp`, `ContentService`) exist only in Google's runtime | Equivalence falls back to recorded traces / sheet snapshots |
| 3t | Target toolchain | ✅ | Node 24.19 + npm 11.17, Python 3.13.2, PostgreSQL 16.15 already running the sync worker in `app/` | - |
| 4 | Source completeness | ⚠️ | Includes: 6 template references, all resolve. Entry points: `doGet` (Code.js:2), `doPost` (PaymentWebhook.gs:36), 9 time triggers created in code. **Data definitions missing**: 43 sheets used as tables (`appointment` 63 refs, `cancel`, `Login`, `AuditLog`, `followup`, `patientMaster` ...) but no header/column export; only prose in `architecture.md` §Data Layer. Manifest missing (see 3a). No binaries; one PDF (`Day_Scheduling_Rule_Checks.pdf`) is rule documentation | Export header row (+ a few sample rows, de-identified) of every sheet; this is also needed for the Sheets import open item |
| 5 | Optional context | ⚠️ | No APM; no runtime logs/exports. Git: one snapshot commit, no change history | Optional: GAS execution log export; the live project's version history |
| 6 | Scope boundary | ✅ | Standalone system (see above) | - |
| 7 | Source protected | ✅ | `.claude/settings.json` `permissions.deny`: `Edit(legacy/**)`, `Write(legacy/**)` | - |

Check 7 note: a permission rule covers Claude's file tools and the shell commands it recognizes (`sed`, `tee`,
`> file`), not a script that opens the files itself. The hard guarantee is the OS: make `legacy\sudarshan`
read-only (`attrib +R /S /D legacy\sudarshan\*`) or an ACL deny-write.

Observed while checking (for assess / harden, not a preflight verdict): `generativelanguage.googleapis.com`
(Gemini, key in `GEMINI_API_KEY` script property) is called from the legacy code - check what patient data it
sent, given the project rule that patient-identifiable data never goes to a cloud model.

## Verdict per command

| Command | Verdict | Why |
|---|---|---|
| assess | Ready-with-gaps | LOC/complexity via `find`+`wc` until `scc`/`lizard` are installed |
| map | Ready-with-gaps | Python OK; sheet column layouts absent, so code-to-storage joins are by sheet name only |
| extract-rules | Ready-with-gaps | Code complete; column semantics inferred from code |
| brief | Ready | Needs only discovery artifacts |
| transform / reimagine | Ready-with-gaps | Target stack green; legacy cannot run locally, so equivalence uses recorded traces |
| harden | Ready-with-gaps | No JS SAST tool installed (optional: `npx eslint-plugin-security`, `semgrep`) |
| uplift | n/a | Not a same-stack version bump |

**Most important fix:** export the sheet headers (and pull `appsscript.json`) from the live project - without
them the data model and OAuth/web-app surface are inferred, not read.

Next: `/code-modernization:modernize-assess sudarshan`
