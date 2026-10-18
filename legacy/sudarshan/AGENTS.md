# AGENTS.md — Google Apps Script Medical Appointment Scheduling System

## Project Overview
Google Apps Script (GAS) medical appointment scheduling system for Sampada VR Eye Care clinic.
- **Backend**: GAS (JavaScript, ~22,000 lines in `Code.js`)
- **Data Store**: Google Sheets (15+ sheets)
- **Frontend**: Vanilla JS + HTML served via `HtmlService` (25 HTML files)
- **Frontend Stack**: Bootstrap 5.3, vanilla JS, Chart.js, Font Awesome
- **Deployment**: Via GAS Editor or `clasp` (no build step, no `package.json`)

## Key Files
| File | Purpose |
|------|---------|
| `Code.js` | Main backend (~22K lines): auth, appointments, patients, slots, audit, reporting, settings |
| `Slot_setMay10Heap1948.js` | Heap-based slot optimizer (~49 KB) |
| `appointmentTransfer.js` | Cross-spreadsheet appointment transfer |
| `archiveOldAppointments.js` | Archive past appointments |
| `syncPatientData.js` | Patient data sync from external source |
| `*.html` | 25 HTML templates rendered server-side via `HtmlService` |

## Key Sheets (Data Layer)
| Sheet | Purpose |
|-------|---------|
| `appointment` | Active appointments (32+ cols: Z=Fixed Slot, AB=Urgency, AC=Family ID, AD=Consult Start, AF=Tags, AG=SlotStatus) |
| `appointment_archive` / `archive` / `cancel` | Historical records |
| `planningA` | Doctor availability & slot planning |
| `planningB` | Max slots, NAA/OAA/TAA tracking, edit history |
| `patientMaster` / `tempPatientMaster` | Patient database |
| `DoctorAvailability` / `DoctorAvailabilityExceptions` / `DoctorLeaveDays` | Doctor scheduling |
| `followup` | Follow-up appointments |
| `AuditLog` / `AuditLogArchive` | Full audit trail |
| `Login` | Credentials + roles |
| `SystemSettings` / `generalSettings` / `Settings` | Config |

## Architecture & Conventions

### Authentication & Authorization
- **Session**: UUID token, 24-hr sliding window, stored in `PropertiesService.getUserProperties()`
- **Roles** (access level): `director/admin` (1) > `doctor` (2) > `manager` (3) > `user/staff/receptionist/nurse` (4)
- **Entry**: `validateLogin()` → `createSession()` → session token in URL params
- **Gate every write**: Call `getUserAccessLevel(username)` before any mutation

### Data Conventions
- **Dates**: `yyyy-MM-dd` (ISO). Timestamps: `yyyy-MM-dd HH:mm:ss` with TZ adjustment
- **Times**: `HH:MM` (24hr)
- **MRD Numbers**: Stored as text; use numeric helpers for comparisons
- **Sheet Row 1**: Always frozen header row (blue `#4a90e2`, white text). Data starts at row 2
- **Column Access**: Prefer header-name lookup; fallback to index for extended columns (Z=26, AB=28, AC=29, AD=30, AF=31, AG=32)

### Backend Patterns
- **Error Handling**: Try/catch + `Logger.log()`; return structured error objects to frontend
- **Audit Every Write**: Call `logAuditEvent(eventType, oldValues, newValues, username, appointmentId)` on every mutation
  - Event types: `LOGIN_SUCCESS`, `LOGOUT`, `CREATE_APPOINTMENT`, `UPDATE_APPOINTMENT`, `DELETE_APPOINTMENT`, `ARCHIVE_APPOINTMENT`
- **Appointments**: ID format `yyyyMMdd_HHmmss` (timestamp-based)
- **Slots**: Default 10-min slots via `getAvailableSlotsFromPlanningA()`, `getBookedSlots()`
- **Tags**: Column AF (index 31), case-insensitive, deduped. Use `addTagToAppointment()`, `removeTagFromAppointment()`, `setAppointmentTags()`

### Frontend Patterns
- **Entry**: `doGet(e)` in `Code.js` routes via `e.parameter.page` + `e.parameter.sessionToken`
- **Calls**: `google.script.run.<functionName>(args).withSuccessHandler(...).withFailureHandler(...)`
- **Session Token**: Passed in URL params to every page
- **Templates**: Server-side rendering via `HtmlService.createTemplateFromFile()`

### Key Backend Functions (Code.js)
| Area | Functions |
|------|-----------|
| Auth | `validateLogin()`, `createSession()`, `getSessionUsername()`, `getUserAccessLevel()` |
| Appointments | `submitAppointment()`, `rescheduleAppointment()`, `cancelAppointment()`, `archiveAppointment()` |
| Slots | `getAvailableSlotsFromPlanningA()`, `getBookedSlots()` |
| Patients | `getPatientDetailsByMRD()`, `generateNewMRD()`, `syncPatientData()` |
| Audit | `logAuditEvent()` |
| Remarks | `addRemarkToHistory()`, `getRemarksHistory()` |
| Followups | `addCommentToHistory()`, `getCommentsHistory()` |
| Tags | `addTagToAppointment()`, `removeTagFromAppointment()`, `setAppointmentTags()` |
| Reports | `generateMonthlyReportData()`, `generateMonthlyExcel()`, `generateMonthlyPDF()` |
| Settings | `saveGeneralSettings()`, `loadGeneralSettings()`, `saveUserSettings()`, `saveMaintenanceSettings()` |

## Development Workflow

### Local Development (clasp)
```bash
npm install -g @google/clasp
clasp login
clasp pull    # Pull from GAS
clasp push    # Push to GAS
```

### No Local Build/Lint/Test
- No `package.json`, no build tools, no linters, no test runner configured
- Deploy directly via GAS Editor or `clasp push`
- Test manually in deployed Web App

### Key Conventions to Follow
1. **Always audit writes**: Call `logAuditEvent()` on every appointment/patient mutation
2. **Check access level**: Call `getUserAccessLevel(username)` before any write operation
3. **Use header-based column access**: Prefer `getColumnByName(sheet, "Column Name")` over hardcoded indices
4. **Date handling**: Use `Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd")`
5. **Session tokens**: Always pass `sessionToken` in URL params; validate via `getSessionUsername()`
6. **Error handling**: Return `{ success: false, error: "message" }` from backend; handle in frontend `.withFailureHandler()`

## Frontend File Overview
| Page | Purpose |
|------|---------|
| `Dashboard.html` / `dayOverview.html` | Main dashboard / day view |
| `bookAppointment.html` | New appointment booking |
| `rescheduleAppointment.html` / `cancelList.html` | Reschedule / cancel |
| `appointmentList.html` / `archiveList.html` | Active / archived appointments |
| `patientMaster.html` | Patient database |
| `followupAppointment.html` | Follow-up scheduling |
| `auditLog.html` | Audit trail viewer |
| `settings.html` / `roleManagement.html` | Settings & roles |
| `Visualization.html` / `SlotOptimization.html` | Analytics & slot optimizer |
| `monthOverview.html` / `completedAppointments.html` | Monthly views |
| `identification.html` / `triageView.html` | Patient triage/identification |
| `Login.html` | Login page |
| `sharedLayout.html` | Shared layout partial |

## Deployment Notes
- **Web App URL**: `ScriptApp.getService().getUrl()` (used in `doGet()`)
- **Deployment**: GAS UI → Deploy → New Deployment → Web App
- **Permissions**: Runs as deploying user; needs `SpreadsheetApp`, `ScriptApp`, `HtmlService`, `PropertiesService`, `Utilities`, `Logger`
- **No local test environment**: Deploy to test (use test deployments)

## Common Tasks

### Adding a New Backend Function
1. Add function to `Code.js`
2. Call from frontend: `google.script.run.newFunction(args).withSuccessHandler(cb).withFailureHandler(errCb)`
3. Add audit logging if it mutates data
4. Add access check if it mutates data

### Adding a New Frontend Page
1. Create `NewPage.html`
2. Include `sharedLayout.html` via `<?!= include('sharedLayout'); ?>`
3. Add route handling in `doGet(e)` if needed (or link from existing page)
4. Pass `sessionToken` in all links/forms

### Adding a New Sheet Column
1. Add header to row 1 of target sheet
2. Use `getColumnByName(sheet, "New Column")` in code (search `Code.js` for this helper)
3. Update any hardcoded indices if extended columns (Z+) are affected

### Running the Slot Optimizer
- Backend: `Slot_setMay10Heap1948.js` → call `optimizeSlots()` or similar
- Frontend: `SlotOptimization.html` → calls optimizer via `google.script.run`

## Debugging Tips
- **Logs**: `Logger.log()` → View → Stackdriver Logging in GAS UI
- **Executions**: View → Executions in GAS UI (shows errors, execution time)
- **Frontend Errors**: Browser DevTools Console + `google.script.run.withFailureHandler()`
- **Execution Timeout**: GAS limit 6 min; use batching for large operations

## Common Pitfalls
- **Forgetting audit log** on writes → audit trail gaps
- **Skipping access check** on write endpoints → privilege escalation
- **Hardcoded column indices** beyond column Z → breaks when columns inserted
- **Date/TZ issues**: Always use `Session.getScriptTimeZone()` with `Utilities.formatDate()`
- **Session expiry**: Token expires after 24hr inactivity; handle `getSessionUsername()` returning null
- **No local testing**: Must deploy to test; use test deployments

## File Size Notes
- `Code.js`: ~22,000 lines — search with `grep`/`rg` before reading
- HTML files: 5KB–170KB each — use `grep` for specific functions/patterns
- `RuleEngine.js`: ~1,200 lines — 16 rule check functions + LLM integration

## Rule Engine (RuleEngine.js)

### Day Scheduling Rule Checks
All 13 rules are driven by settings from the `RuleSettings` sheet via `getRuleSetting(key, default)`.

| Rule | Function | Toggle Setting |
|------|----------|---------------|
| New patients before cutoff | `checkNewPatientTiming` | `RULE_NEW_TIMING` |
| Family before cutoff | `checkSameFamilyTiming` | `RULE_FAMILY_TIMING` |
| Family morning size | `checkFamilySizeMorning` | `RULE_FAMILY_MORNING` |
| Consecutive new patients | `checkNewOldAlternation` | `RULE_NEW_CONSECUTIVE` |
| New patient after evening | `checkNewPatientAfter4PM` | `RULE_NEW_AFTER_4PM` |
| Consultation windows | `checkConsultationWindows` | `RULE_CONSULT_WINDOW` |
| Family continuous | `checkSameFamilyContinuous` | `RULE_FAMILY_CONTINUOUS` |
| AT/Gonio (4 sub-rules) | `checkGonioATConsecutive` | `RULE_GONIO_AT_CONSECUTIVE`, `_CAP`, `_TIMING`, `RULE_AT_TIMING` |
| HFA slot reservation | `checkHFASlotRule` | `RULE_HFA_SLOT` |
| ROP day-of-week | `checkROPDayRule` | `RULE_ROP_DAY` |
| Laser day-of-week | `checkLaserDayRule` | `RULE_LASER_DAY` |
| Wheelchair timing | `checkWheelchairTiming` | `RULE_WHEELCHAIR` |
| Laser duration gap | `checkProcedureDurationGaps` | `RULE_LASER_DURATION` |

### Entry Point
`validateDayRules(date, doctor, sessionToken)` — returns `{success, violations[], specialCases[], appointmentCount, dayOfWeek}`.

### Settings System
- **Sheet:** `RuleSettings` (35 settings: key/value/name/description columns)
- **Cache:** Module-level `ruleSettingsCache_` in Code.js — cleared each `validateDayRules()` call
- **Helper:** `getRuleSetting(key, default)` in RuleEngine.js
- **Initialize:** Run `initializeRuleSettingsSheet()` once to create the sheet with defaults

### Rule Settings Backend (Code.js)
| Function | Purpose |
|----------|---------|
| `initializeRuleSettingsSheet()` | Create sheet with 35 defaults (safe to re-run) |
| `loadRuleSettings(sessionToken)` | Admin (Level 1) only — returns all settings |
| `saveRuleSettings(data, sessionToken)` | Admin (Level 1) only — audit-logged save |
| `getRuleSettingsMap()` | Module-cached key-value map |
| `clearRuleSettingsCache()` | Reset cache (called at start of each validation) |

### Settings UI (settings.html)
- New "Check Rules Configuration" card with 6 sections, 35 fields
- `loadCheckRulesSettings()` — auto-loads on page open (admin only)
- `saveCheckRulesSettings()` — validates time (HH:MM), numbers, day codes
- `resetCheckRulesSettings()` — reverts form to defaults (requires Save to persist)

### LLM Integration
- Gemini API call in `formatViolationsWithLLM()` with `v1`/`v1beta` fallback
- Model: `gemini-2.5-flash` (configurable via `GEMINI_MODEL` script property)
- Fallback: plain-text summary if API key missing or call fails

### Time Handling
- `timeToMin()` now handles Date objects, ISO strings, and verbose Date formats from Sheets
- `fmtTime()` extracts clean `HH:MM` from any time format
- All violation messages now show clean `HH:MM` times (no epoch dates)
