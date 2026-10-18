# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Google Apps Script (GAS) medical appointment scheduling system** for Sampada VR Eye Care clinic. It runs entirely on Google infrastructure — no local build step exists. The backend is GAS (JavaScript), the data store is Google Sheets, and the frontend is vanilla JS + HTML served via GAS's `HtmlService`.

## Deployment

There is no `package.json`, `Makefile`, or build toolchain. Code is deployed directly through the **Google Apps Script editor** or via [clasp](https://github.com/google/clasp) (requires separate local setup). No linting or test runners are configured.

To use clasp locally:
```bash
npm install -g @google/clasp
clasp login
clasp pull   # pull latest from GAS
clasp push   # push local changes to GAS
```

## Architecture

### Data Layer — Google Sheets

All persistence is Google Sheets via `SpreadsheetApp`. Key sheets:

| Sheet | Purpose |
|---|---|
| `appointment` | Active appointments (32+ columns) |
| `appointment_archive` / `archive` / `cancel` | Historical records |
| `planningA` | Doctor availability and slot planning |
| `planningB` | Max slots, NAA/OAA/TAA tracking, edit history |
| `patientMaster` / `tempPatientMaster` | Patient database |
| `DoctorAvailability` / `DoctorAvailabilityExceptions` / `DoctorLeaveDays` | Doctor scheduling |
| `followup` | Followup appointment records |
| `AuditLog` / `AuditLogArchive` | Full audit trail |
| `Login` | User credentials and role assignment |
| `SystemSettings` / `generalSettings` / `Settings` | Configuration |
| `slotOptimization` / `Optimized Schedule` | Algorithm output |

Columns are identified by **header name** where possible; index-based fallback is used for extended columns (Z=Fixed Slot, AB=Urgency Level, AC=Family Identifier, AD=Consult Start, AF=Tags, AG=SlotStatus).

### Backend — `Code.js`

The monolithic backend (~21,900 lines). Key subsystems:

- **Auth**: Session tokens (UUID, 24-hour sliding window, stored in user properties). Role hierarchy: `director/admin` (level 1) > `doctor` (2) > `manager` (3) > `user/staff/receptionist/nurse` (4). Entry point: `validateLogin()` → `createSession()`.
- **Appointments**: `submitAppointment()`, `rescheduleAppointment()`, `cancelAppointment()`, `archiveAppointment()`. IDs are timestamp-based: `yyyyMMdd_HHmmss`.
- **Slot availability**: `getAvailableSlotsFromPlanningA()`, `getBookedSlots()`. Default slot = 10 minutes.
- **Patient**: `getPatientDetailsByMRD()`, `generateNewMRD()`, `syncPatientData()`. One-way sync from `yaragoPatientMaster` → `patientMaster`.
- **Audit**: `logAuditEvent()` — call for every significant action. Event types include `LOGIN_SUCCESS`, `LOGOUT`, `CREATE_APPOINTMENT`, `UPDATE_APPOINTMENT`, `DELETE_APPOINTMENT`, `ARCHIVE_APPOINTMENT`.
- **Remarks/Comments**: `addRemarkToHistory()` / `getRemarksHistory()` for appointments; `addCommentToHistory()` / `getCommentsHistory()` for followups.
- **Tags**: Stored in column AF (index 31). `addTagToAppointment()`, `removeTagFromAppointment()`, `setAppointmentTags()` — case-insensitive, deduplicated.
- **Reporting**: `generateMonthlyReportData()`, `generateMonthlyExcel()`, `generateMonthlyPDF()`.
- **Settings**: `saveGeneralSettings()` / `loadGeneralSettings()`, user settings, maintenance settings.

### Slot Optimization — `Slot_setMay10Heap1948.js`

A heap-based priority queue slot optimizer (~49 KB). Handles New/Old/Third-party patient allocation, family grouping (F1/F2 prefixes in column J), and fixed slots (±60 min window).

### Utility Scripts

- `appointmentTransfer.js` — transfers appointment data between spreadsheets
- `archiveOldAppointments.js` — archives past appointments, handles duplicates
- `syncPatientData.js` — patient data sync

### Frontend — HTML files

All pages are GAS HTML templates rendered server-side. Frontend calls backend via `google.script.run.<functionName>(args)`. Session token is passed in URL parameters to every page.

UI stack: Bootstrap 5.3, vanilla JS, Chart.js, Font Awesome.

Key pages: `Dashboard.html`, `bookAppointment.html`, `rescheduleAppointment.html`, `cancelList.html`, `appointmentList.html`, `patientMaster.html`, `followupAppointment.html`, `auditLog.html`, `settings.html`, `Visualization.html`, `SlotOptimization.html`.

## Key Conventions

- **Date format**: `yyyy-MM-dd` (ISO). Timestamps: `yyyy-MM-dd HH:mm:ss` with timezone adjustment.
- **Time format**: `HH:MM` (24-hour).
- **MRD numbers**: Text fields; use numeric extraction helpers for comparisons.
- **Sheet row 1** is always the header row (frozen, blue background `#4a90e2`, white text). Data starts at row 2.
- **Backend errors** use try/catch with `Logger.log()` for debugging; user-facing errors return structured objects.
- **Access gating**: Check `getUserAccessLevel(username)` before exposing sensitive operations. Do not skip this for any write path.
- **Audit every write**: Call `logAuditEvent()` with old/new values for any appointment or patient mutation.
