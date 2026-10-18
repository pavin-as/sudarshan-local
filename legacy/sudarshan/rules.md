# Rules.md — Behavioral Guardrails

## Mandatory Rules (Enforced by Convention)

### 1. Audit Every Mutation
- **ALWAYS** call `logAuditEvent(eventType, oldValues, newValues, username, appointmentId)` after:
  - Creating/updating/deleting appointments
  - Modifying patient records
  - Changing settings
  - Any write to `appointment`, `patientMaster`, `planningA`, `planningB`, `followup`, `Login` sheets
- Event types: `CREATE_APPOINTMENT`, `UPDATE_APPOINTMENT`, `DELETE_APPOINTMENT`, `ARCHIVE_APPOINTMENT`, `LOGIN_SUCCESS`, `LOGOUT`, `CREATE_PATIENT`, `UPDATE_PATIENT`, `DELETE_PATIENT`, `UPDATE_SETTINGS`

### 2. Gate Every Write with Access Check
- **BEFORE** any mutation, call `getUserAccessLevel(username)` and verify permission
- Access levels: 1=director/admin, 2=doctor, 3=manager, 4=user/staff/receptionist/nurse
- Lower number = higher privilege
- Example: `if (getUserAccessLevel(username) > 3) throw new Error("Insufficient permissions");`

### 3. Validate Session on Every Entry Point
- **ALWAYS** call `getUserSessionUsername(sessionToken)` at start of every backend function
- Return `{ success: false, error: "Session expired" }` if null
- Never trust frontend-provided usernames — derive from session token only

### 4. Use Header-Based Column Access
- **PREFER** `getColumnByName(sheet, "Column Name")` over hardcoded indices
- Extended columns (Z+): Z=26, AA=27, AB=28, AC=29, AD=30, AE=31, AF=32, AG=33
- If you must use index, add comment: `// Column AF (index 31): Tags`

### 5. Date/Time Formatting Standards
- **Dates**: `Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd")`
- **Timestamps**: `Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")`
- **Times**: `HH:MM` (24-hour) — never use 12-hour format
- **Never** use `new Date().toISOString()` or locale-dependent formats

### 6. MRD Numbers Are Text
- **ALWAYS** treat MRD as string: `String(mrd).trim()`
- For numeric comparison: `parseInt(mrd, 10)` or `Number(mrd)`
- Never rely on sheet cell type — Sheets may coerce to number

### 7. Return Structured Error Objects
- **Backend**: Always return `{ success: boolean, data?: any, error?: string }`
- **Never** throw to frontend — catch and return error object
- **Frontend**: Handle via `.withFailureHandler()` AND check `response.success`

### 8. Session Token in Every URL
- **ALWAYS** pass `sessionToken` in all links, forms, and `google.script.run` calls
- Generate links: `webAppUrl + "?page=xxx&sessionToken=" + sessionToken`
- Never store session in localStorage/cookies — URL only

---

## Prohibited Patterns

| ❌ Don't Do This | ✅ Do This Instead |
|-----------------|-------------------|
| `sheet.getRange(row, col).setValue(x)` in a loop | Batch: `sheet.getRange(r, c, rows, cols).setValues(arr)` |
| `new Date()` without timezone | `Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "...")` |
| Hardcode column index > 26 (Z) | `getColumnByName(sheet, "Header")` or documented constant |
| Skip `logAuditEvent()` on write | Call it with old/new values |
| Skip `getUserAccessLevel()` on write | Check before mutation |
| Throw errors from backend functions | Return `{ success: false, error: "msg" }` |
| Use `PropertiesService.getScriptProperties()` for sessions | Use `PropertiesService.getUserProperties()` |
| Assume `e.parameter.username` is valid | Call `getSessionUsername(e.parameter.sessionToken)` |
| Use 12-hour time format (AM/PM) | Use `HH:MM` 24-hour format |
| Commit without `clasp push` | Deploy via `clasp push` or GAS Editor |

---

## Code Style Rules

### Backend (Code.js, *.gs)
- **Indentation**: 2 spaces (existing convention)
- **Variables**: `const` by default, `let` if reassigned, no `var`
- **Functions**: `camelCase`, descriptive names
- **Error handling**: Try/catch at top level of every exported function
- **Logging**: `Logger.log("PREFIX: " + message)` — use consistent prefixes

### Frontend (HTML/JS)
- **Script tags**: `<script>` at bottom of body, or in `<head>` with `defer`
- **Event handlers**: `addEventListener`, not `onclick=""`
- **API calls**: Always chain `.withSuccessHandler().withFailureHandler()`
- **DOM queries**: Cache selectors, avoid repeated `document.getElementById()`
- **Bootstrap**: Use 5.3 classes, no custom CSS for layout

### Sheet Operations
- **Read**: `getDataRange().getValues()` once, process in memory
- **Write**: Build 2D array, single `setValues()` call
- **Append**: `sheet.appendRow()` only for single rows; batch for multiples
- **Delete**: Hide rows or move to archive sheet — never `deleteRow()` in loops

---

## Workflow Rules

### Before Pushing
1. Search for similar patterns in `Code.js` (`grep` first)
2. Verify access check + audit log on any new write function
3. Test manually in deployed Web App (no local test env)
4. Check `Logger.log()` output in GAS Executions

### Adding New Features
1. Backend function in `Code.js` (or new `.gs` file)
2. Frontend page (`NewPage.html`) + `sharedLayout.html` include
3. Route in `doGet(e)` if new top-level page
4. Update this `rules.md` if new convention introduced

### Sheet Changes
1. Add header to row 1 (blue `#4a90e2`, white text, frozen)
2. Use `getColumnByName()` in code
3. Update hardcoded indices if inserting before column Z
4. Document new column in `AGENTS.md` sheet registry

---

## Emergency Procedures

### Broken Deployment
1. Open GAS Editor → Deployments → Manage Deployments
2. Click "⋮" on working version → "Redeploy" → Select previous version
3. Or: `clasp deploy --versionNumber <previous>`

### Stuck Execution (6 min timeout)
- Add `Utilities.sleep(100)` in long loops
- Batch operations: process 100 rows, flush, continue
- Use trigger-based chunking for >5 min jobs

### Session Issues
- Clear browser cache/cookies for script.google.com
- Verify `PropertiesService.getUserProperties()` quota (9MB)
- Check token format: UUID v4, stored as `session_<token>`

---

## Reference: Key Function Signatures

```javascript
// Auth
validateLogin(username, password) → boolean
createSession(username) → sessionToken
getSessionUsername(sessionToken) → username | null
getUserAccessLevel(username) → 1|2|3|4

// Audit
logAuditEvent(eventType, oldValues, newValues, username, appointmentId)

// Appointments
submitAppointment(data) → { success, appointmentId }
rescheduleAppointment(id, newData) → { success }
cancelAppointment(id, reason) → { success }
archiveAppointment(id) → { success }

// Slots
getAvailableSlotsFromPlanningA(date, doctor) → string[]
getBookedSlots(date, doctor) → string[]

// Patients
getPatientDetailsByMRD(mrd) → patientObj | null
generateNewMRD() → string
syncPatientData() → { success, count }

// Tags (Column AF)
addTagToAppointment(id, tag) → { success }
removeTagFromAppointment(id, tag) → { success }
setAppointmentTags(id, tags[]) → { success }
```

---

**Remember**: No local testing. No lint. No types. Deploy to verify. Audit everything. Check access always.
