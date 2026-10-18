# Architecture Document — Google Apps Script Medical Appointment Scheduling System

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GOOGLE APPS SCRIPT RUNTIME                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌─────────────────┐    ┌──────────────────────────┐   │
│  │   Frontend   │    │    Backend      │    │      Data Layer          │   │
│  │  (HtmlService)◄────┤   (Code.js)     │◄───┤   Google Sheets          │   │
│  │              │    │                 │    │                          │   │
│  │ • 25 HTML    │    │ • ~22K lines    │    │ • 15+ Sheets             │   │
│  │ • Bootstrap 5│    │ • Auth, CRUD    │    │ • SpreadsheetApp API     │   │
│  │ • Chart.js   │    │ • Audit, Reports│    │ • Row 1 = headers        │   │
│  │ • Vanilla JS │    │ • Slot Optimizer│    │ • Column access by name  │   │
│  └──────────────┘    └─────────────────┘    └──────────────────────────┘   │
│         │                    │                         │                    │
│         │ google.script.run  │                         │                    │
│         └────────────────────┴─────────────────────────┘                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Supporting Services                              │   │
│  │  • PropertiesService (sessions)  • ScriptApp (URLs, triggers)      │   │
│  │  • Utilities (dates, encoding)   • Logger (debugging)              │   │
│  │  • HtmlService (templating)      • UrlFetchApp (external APIs)     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Frontend Layer (HTML Templates)

**Entry Point**: `doGet(e)` in `Code.js:2`
- Routes requests based on `e.parameter.page` + `e.parameter.sessionToken`
- Renders templates via `HtmlService.createTemplateFromFile()`
- Injects `sessionToken` and `webAppUrl` into every template

**Template Pattern** (sharedLayout.html):
```html
<?!= include('sharedLayout'); ?>
<!-- Page-specific content -->
```

**Communication**: `google.script.run`
```javascript
google.script.run
  .withSuccessHandler(onSuccess)
  .withFailureHandler(onError)
  .backendFunction(args);
```

**Pages** (25 total):
| Category | Pages |
|----------|-------|
| Core | `Dashboard.html`, `dayOverview.html`, `Login.html` |
| Appointments | `bookAppointment.html`, `rescheduleAppointment.html`, `cancelList.html`, `appointmentList.html`, `archiveList.html` |
| Patients | `patientMaster.html`, `identification.html`, `triageView.html` |
| Follow-ups | `followupAppointment.html` |
| Analytics | `Visualization.html`, `SlotOptimization.html`, `monthOverview.html`, `completedAppointments.html`, `rescheduleAnalytics.html` |
| Admin | `settings.html`, `roleManagement.html`, `auditLog.html`, `AuditActivityView.html` |
| Utilities | `Broadcast.html`, `directCall.html`, `sharedLayout.html` |

### 2. Backend Layer (Code.js + Utilities)

**Main Module**: `Code.js` (~22,000 lines)

**Subsystems**:
```
Code.js
├── Auth & Session Management
│   ├── validateLogin(username, password)          // Line ~56
│   ├── createSession(username)                     // Line ~74
│   ├── getSessionUsername(sessionToken)            // Session validation
│   ├── getUserAccessLevel(username)                // Role hierarchy
│   └── getUserRole(username)                       // Role string
│
├── Appointment Management
│   ├── submitAppointment(data)                     // Create new
│   ├── rescheduleAppointment(id, newData)          // Modify
│   ├── cancelAppointment(id, reason)               // Soft delete
│   ├── archiveAppointment(id)                      // Move to archive
│   └── getAppointmentDetails(id)                   // Read
│
├── Slot Management
│   ├── getAvailableSlotsFromPlanningA(date, doctor) // Free slots
│   ├── getBookedSlots(date, doctor)                // Occupied slots
│   └── getSlotStatus(slotId)                       // Slot state
│
├── Patient Management
│   ├── getPatientDetailsByMRD(mrd)                 // Lookup
│   ├── generateNewMRD()                            // Auto-assign
│   └── syncPatientData()                           // External sync
│
├── Audit & Logging
│   └── logAuditEvent(type, oldVal, newVal, user, id)
│
├── Remarks & Comments
│   ├── addRemarkToHistory(id, remark, user)
│   ├── getRemarksHistory(id)
│   ├── addCommentToHistory(id, comment, user)
│   └── getCommentsHistory(id)
│
├── Tags (Column AF)
│   ├── addTagToAppointment(id, tag)
│   ├── removeTagFromAppointment(id, tag)
│   └── setAppointmentTags(id, tags[])
│
├── Reporting
│   ├── generateMonthlyReportData(month, year)
│   ├── generateMonthlyExcel(month, year)
│   └── generateMonthlyPDF(month, year)
│
└── Settings
    ├── saveGeneralSettings(data)
    ├── loadGeneralSettings()
    ├── saveUserSettings(data)
    └── saveMaintenanceSettings(data)
```

**Utility Modules**:
| File | Purpose | Key Exports |
|------|---------|-------------|
| `Slot_setMay10Heap1948.js` | Heap-based slot optimizer | `optimizeSlots()`, priority queue |
| `appointmentTransfer.js` | Cross-spreadsheet transfer | `transferAppointments()` |
| `archiveOldAppointments.js` | Batch archive old records | `archiveOldAppointments()` |
| `syncPatientData.js` | Patient sync from external | `syncPatientData()` |
| `DailyKPIReport.js` | KPI calculations | `generateDailyKPI()` |
| `AuditActivity.gs` | Audit helpers | `getAuditActivity()` |
| `triage.gs` | Triage logic | `triagePatient()` |
| `broadcast.js` | Broadcast notifications | `sendBroadcast()` |

### 3. Data Layer (Google Sheets)

**Spreadsheet Structure**:
```
Spreadsheet (Active)
├── appointment                 ← Primary transactional table
│   ├── Row 1: Headers (frozen, blue #4a90e2)
│   ├── Row 2+: Data
│   └── Key Columns:
│       ├── A: Appointment ID (yyyyMMdd_HHmmss)
│       ├── B: Date (yyyy-MM-dd)
│       ├── C: Time (HH:MM)
│       ├── D: Doctor
│       ├── E: Patient Name
│       ├── F: MRD Number (text)
│       ├── J: Family ID (F1/F2 prefix)
│       ├── Z: Fixed Slot (boolean)
│       ├── AB: Urgency Level
│       ├── AC: Family Identifier
│       ├── AD: Consult Start
│       ├── AF: Tags (comma-separated)
│       └── AG: SlotStatus
│
├── appointment_archive         ← Archived appointments
├── archive                     ← Legacy archive
├── cancel                      ← Cancelled appointments
├── planningA                   ← Doctor availability matrix
├── planningB                   ← Slot limits, NAA/OAA/TAA counters
├── patientMaster               ← Master patient database
├── tempPatientMaster           ← Staging for sync
├── DoctorAvailability          ← Weekly schedules
├── DoctorAvailabilityExceptions← Override dates
├── DoctorLeaveDays             ← Leave calendar
├── followup                    ← Follow-up appointments
├── AuditLog                    ← Full audit trail
├── AuditLogArchive             ← Archived audit
├── Login                       ← Users + roles
├── SystemSettings              ← System config
├── generalSettings             ← UI defaults
├── Settings                    ← Legacy settings
├── slotOptimization            ← Optimizer output
└── Optimized Schedule          ← Optimizer output
```

**Column Access Pattern**:
```javascript
// Preferred: header-based lookup
function getColumnByName(sheet, headerName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.indexOf(headerName) + 1; // 1-indexed
}

// Extended columns (Z+): fallback to index
// Z=26, AA=27, AB=28, AC=29, AD=30, AE=31, AF=32, AG=33
```

## Data Flow

### Appointment Booking Flow
```
User (bookAppointment.html)
    │
    ▼
google.script.run.submitAppointment(data)
    │
    ▼
Code.js:submitAppointment()
    ├── validate session (getSessionUsername)
    ├── check access level (getUserAccessLevel >= 3)
    ├── get available slots (getAvailableSlotsFromPlanningA)
    ├── validate slot free (getBookedSlots)
    ├── generate appointment ID (yyyyMMdd_HHmmss)
    ├── write to 'appointment' sheet
    ├── logAuditEvent(CREATE_APPOINTMENT, ..., newValues)
    └── return { success: true, appointmentId }
    │
    ▼
Frontend: success handler → redirect to appointmentList
```

### Slot Optimization Flow
```
SlotOptimization.html
    │
    ▼
google.script.run.optimizeSlots(params)
    │
    ▼
Slot_setMay10Heap1948.js:optimizeSlots()
    ├── Read planningA, planningB, appointment
    ├── Build priority queues (heap)
    │   ├── New patients (NAA)
    │   ├── Old patients (OAA)
    │   ├── Third-party (TAA)
    │   └── Family groups (F1/F2)
    ├── Apply constraints:
    │   ├── Doctor availability
    │   ├── Fixed slots (±60 min window)
    │   ├── Max slots per doctor
    │   └── Slot duration (10 min default)
    ├── Output to 'slotOptimization' / 'Optimized Schedule'
    └── Return optimized schedule
    │
    ▼
Frontend: render results
```

### Session & Auth Flow
```
Login.html (username/password)
    │
    ▼
google.script.run.validateLogin(user, pass)
    │
    ▼
Code.js:validateLogin() → check 'Login' sheet
    │
    ▼
Code.js:createSession(username)
    ├── Generate UUID token
    ├── Store in PropertiesService.getUserProperties()
    │   └── Key: session_<token>, Value: {username, fullName, role, expiry}
    ├── logAuditEvent(LOGIN_SUCCESS)
    └── Return token
    │
    ▼
Frontend: redirect to ?page=dayOverview&sessionToken=<token>
    │
    ▼
Every subsequent request:
    doGet(e) → getSessionUsername(e.parameter.sessionToken)
    ├── Validate token exists & not expired (24hr sliding)
    ├── Return username or null
    └── If null → render Login.html
```

## Security Model

### Role Hierarchy (Access Levels)
| Level | Roles | Permissions |
|-------|-------|-------------|
| 1 | `director`, `admin` | Full access, user management, settings, audit |
| 2 | `doctor` | Own appointments, patient view, follow-ups |
| 3 | `manager` | All appointments, reports, slot management |
| 4 | `user`, `staff`, `receptionist`, `nurse` | Book/cancel, patient lookup, limited views |

### Enforcement Points
```javascript
// Every write endpoint MUST check:
function someWriteOperation(data, sessionToken) {
  const username = getSessionUsername(sessionToken);
  if (!username) throw new Error("Session expired");
  
  const accessLevel = getUserAccessLevel(username);
  if (accessLevel > REQUIRED_LEVEL) {  // Lower number = higher privilege
    throw new Error("Insufficient permissions");
  }
  
  // ... perform operation
  logAuditEvent(...);
}
```

### Session Security
- **Token**: UUID v4, 24-hour sliding expiration
- **Storage**: `PropertiesService.getUserProperties()` (per-user, isolated)
- **Transmission**: URL parameter (HTTPS enforced by GAS)
- **Validation**: Every `doGet` and every `google.script.run` call

## Integration Points

### External Sync (syncPatientData.js)
```
External Source (yaragoPatientMaster)
    │
    ▼
syncPatientData.js: syncPatientData()
    ├── Fetch from external spreadsheet/URL
    ├── Transform / normalize
    ├── Write to 'tempPatientMaster'
    ├── Validate / dedupe
    └── Merge into 'patientMaster'
```

### Cross-Spreadsheet Transfer (appointmentTransfer.js)
```
Source Spreadsheet          Target Spreadsheet
     │                            │
     ▼                            ▼
appointmentTransfer.js: transferAppointments()
    ├── Read from source 'appointment'
    ├── Transform IDs (avoid collisions)
    ├── Write to target 'appointment'
    └── Log audit in both
```

## Deployment Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Developer     │     │  Google Apps    │     │   End Users     │
│   (Local)       │     │    Script       │     │   (Browser)     │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ clasp pull      │────►│                 │     │                 │
│ clasp push      │     │  Code.js        │     │ Web App URL     │
│                 │     │  *.html         │◄────│ ?sessionToken=  │
│ No build step   │     │  *.gs           │     │                 │
│ No lint/test    │     │                 │     │ google.script.  │
└─────────────────┘     │  Spreadsheet    │     │   run.<fn>()    │
                        │  (Data)         │     └─────────────────┘
                        └─────────────────┘
```

**Deployment Commands**:
```bash
# Initial setup
npm install -g @google/clasp
clasp login
clasp clone <SCRIPT_ID>  # or clasp create

# Daily workflow
clasp pull    # Get latest from GAS
# edit files
clasp push    # Push to GAS

# Deploy
# Via GAS UI: Deploy → New Deployment → Web App
# Or: clasp deploy --versionNumber <n> --description "msg"
```

## Performance Considerations

### Execution Limits
- **Max execution time**: 6 minutes
- **Max trigger runtime**: 90 minutes
- **PropertiesService quota**: 9MB per script
- **SpreadsheetApp calls**: Batch reads/writes

### Optimization Patterns Used
```javascript
// Batch read (single API call)
const data = sheet.getDataRange().getValues();

// Batch write (single API call)
sheet.getRange(startRow, startCol, rows, cols).setValues(values);

// Avoid in loops:
❌ sheet.getRange(i, j).getValue()
✅ const all = sheet.getDataRange().getValues(); all[i][j]
```

### Large Dataset Handling
- **Pagination**: `appointmentList.html` loads in chunks
- **Archiving**: `archiveOldAppointments.js` moves old data to archive sheets
- **Indexing**: Header row frozen, column lookup cached

## Error Handling Strategy

### Backend (Code.js)
```javascript
function backendFunction(args) {
  try {
    // Validate session & access
    // Perform operation
    return { success: true, data: result };
  } catch (e) {
    Logger.log("ERROR in backendFunction: " + e.stack);
    return { success: false, error: e.message };
  }
}
```

### Frontend
```javascript
google.script.run
  .withSuccessHandler(response => {
    if (response.success) { /* handle data */ }
    else { showError(response.error); }
  })
  .withFailureHandler(err => {
    showError("Server error: " + err.message);
  })
  .backendFunction(args);
```

## Monitoring & Debugging

### GAS Built-in Tools
| Tool | Access | Purpose |
|------|--------|---------|
| **Executions** | GAS UI → Executions | View all runs, errors, duration |
| **Logs** | GAS UI → Logger / Stackdriver | `Logger.log()` output |
| **Triggers** | GAS UI → Triggers | Manage time-driven triggers |

### Key Log Points
- `logAuditEvent()` → AuditLog sheet (persistent)
- `Logger.log()` → Stackdriver (transient, 7-day retention)
- Frontend console → Browser DevTools

## Extensibility Points

### Adding New Features
1. **Backend**: Add function to `Code.js` (or new `.gs` file)
2. **Frontend**: Create `NewFeature.html` + call via `google.script.run`
3. **Data**: Add columns to relevant sheet (row 1 header)
4. **Auth**: Add access check in new function
5. **Audit**: Call `logAuditEvent()` for mutations

### Adding New Sheets
1. Create sheet in Spreadsheet with header row
2. Use `getColumnByName()` for column access
3. Add to `architecture.md` sheet registry

### Custom Reports
Extend `generateMonthlyReportData()` pattern:
```javascript
function generateCustomReport(params) {
  // 1. Read from sheets (batch)
  // 2. Compute aggregations
  // 3. Return structured data
  // 4. Frontend renders via Chart.js / tables
}
```

## Known Technical Debt

| Area | Issue | Impact |
|------|-------|--------|
| `Code.js` size | 22K lines, monolithic | Hard to navigate, merge conflicts |
| Column indices | Hardcoded Z, AB, AC, AD, AF, AG | Breaks if columns inserted before |
| No tests | Zero automated testing | Regression risk on changes |
| Session in URL | Token visible in browser history | Low (HTTPS, short expiry) |
| No TypeScript | Plain JS, no type safety | Runtime errors in production |
| Single spreadsheet | All data in one file | Contention, size limits |

## Future Architecture Improvements

1. **Modularize Code.js**: Split into `auth.gs`, `appointments.gs`, `patients.gs`, etc.
2. **Add clasp + TypeScript**: Enable type checking, better IDE support
3. **Implement CI/CD**: GitHub Actions → clasp push on merge
4. **Add integration tests**: Headless browser tests against test deployment
5. **Separate read/write spreadsheets**: Reduce contention
6. **Add caching layer**: `CacheService` for frequent reads (slot availability)
7. **Event-driven audit**: Trigger-based instead of inline calls
