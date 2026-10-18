# Rule Checks — Detection Logic & Data Sources

Complete breakdown of every rule, how it will be identified, what data is needed, and edge cases handled.

---

## Quick Reference Table

| # | Rule | Data Source | Severity | Detection Method |
|---|------|-------------|----------|------------------|
| 1 | New patients only 10 AM onwards | `PatientType` + `TimeSlot` | Warning | Time comparison |
| 2 | Same family before 11:30 AM (except special) | `Family Identifier` + `TimeSlot` + `Remarks` | Info | Group + time check |
| 3 | Same family morning if >3 members | `Family Identifier` + count + `TimeSlot` | Warning | Group size + time |
| 4 | Alternate New/Old (no consecutive new) | `PatientType` + sorted `TimeSlot` | Info | Sequence check |
| 5 | No new patients after 4 PM (non-dilation OK) | `PatientType` + `TimeSlot` + `PlanOfAction` + `Age` | Error/Warning | Time + procedure check |
| 6 | Consultation windows (10:30-1:30, 2:30-5:30) | `Consult Start` | Info | Time window check |
| 7 | Same family not continuously | `Family Identifier` + sorted `TimeSlot` | Info | Consecutive check |
| 8 | Gonio+AT or AT not consecutively | `PlanOfAction` + sorted `TimeSlot` | Warning | Sequence + procedure |
| 9 | HFA slot 9:20/9:40 only for HFA | `TimeSlot` + `PlanOfAction` + date diff | Warning | Slot + procedure |
| 10 | ROP on Wednesday only | `PlanOfAction` + day-of-week | Error | Day check |
| 11 | Laser on Tuesday/Friday only | `PlanOfAction` + day-of-week + `Remarks` | Error | Day check + SVV exception |
| 12 | Wheelchair → evening/early morning | `Remarks` + `TimeSlot` | Info | Keyword + time check |
| 13 | Laser 20-min duration | `PlanOfAction` + sorted `TimeSlot` | Warning | Gap calculation |
| 14 | Fix appointment time per plan of action | `PlanOfAction` + `TimeSlot` + `Consult Start` | Warning | Duration vs gap |
| 15 | Special cases in appointment list | `Remarks` | Info (no violation) | Keyword detection |
| 16 | HFA alternative slots after 9:20/9:40 filled | `PlanOfAction` + `TimeSlot` + `AppointmentDate` | Info | HFA detection |

---

## Detailed Breakdown

### Rule 1: New Patients Appointment Start Only at 10 AM Onwards

**What it means:** Patients marked as "New" (first visit) should not be scheduled before 10:00 AM.

**How to identify:**
```
1. Check if appointment is a "New" patient
2. Check if TimeSlot is before 10:00 AM
3. Both true → violation
```

**Data sources:**
- `PatientType` field → contains: "Guest", "New", "Old", etc.
- `TimeSlot` field → format "HH:MM" (e.g., "09:20", "14:30")

**Detection logic:**
```javascript
const isNew = appt.PatientType === "Guest" || 
              appt.PatientType === "New" ||
              appt.PatientType.toLowerCase().includes("new");

if (isNew && appt.TimeSlot) {
  const hour = parseInt(appt.TimeSlot.split(':')[0]);
  if (hour < 10) {
    // VIOLATION
  }
}
```

**Edge cases:**
- Waiting List patients (no TimeSlot) → skip check
- New patients with VIP/BNI flag → still flag (special case doesn't exempt)
- "Direct OPD" new patients → still flag

**Severity:** Warning (soft rule, clinic may have exceptions)

**Example violation:**
- Patient: "John Doe" (New/Guest)
- Time: 09:20
- Message: "New patient 'John Doe' scheduled at 09:20 (before 10:00 AM)"

---

### Rule 2: Don't Give Same Family Appointment Before 11:30 AM (Except Special Cases)

**What it means:** Family members (same Family ID) should not be scheduled before 11:30 AM, unless they have special case flags.

**How to identify:**
```
1. Group all appointments by Family Identifier
2. For each family group, check if any member is before 11:30 AM
3. Check if that member has special case flag (VIP/BNI/SVV/Wheelchair)
4. Special case → skip, else → violation
```

**Data sources:**
- `Family Identifier` field → contains: "F1-001", "F2-abc", etc. (or empty)
- `TimeSlot` field → for time check
- `Remarks` field → for special case detection

**Detection logic:**
```javascript
const familyGroups = groupByFamily(appointments);
Object.entries(familyGroups).forEach(([familyId, members]) => {
  if (!familyId) return; // Skip appointments without family ID
  
  members.forEach(member => {
    if (!member.TimeSlot) return;
    const flags = parseRemarksFlags(member.Remarks);
    if (flags.isVIP || flags.isBNI || flags.isSVV || flags.isWheelchair) return; // Exception
    
    const totalMin = timeToMin(member.TimeSlot);
    if (totalMin < 11 * 60 + 30) { // Before 11:30 AM
      // VIOLATION
    }
  });
});
```

**Edge cases:**
- Empty Family Identifier → skip
- Family with only 1 member → still check timing
- Special case patients → exempt
- Waiting list → skip (no TimeSlot)

**Severity:** Info (soft rule)

**Example violation:**
- Family: F1-001
- Patient: "Mary" at 10:30, Patient: "John" at 11:00
- Message: "Family member 'Mary' (Family: F1-001) scheduled at 10:30 (before 11:30 AM)"

---

### Rule 3: Don't Give Same Family Appointment at Morning if More Than 3 Members

**What it means:** If a family has more than 3 members scheduled on the same day, don't put all of them in the morning.

**How to identify:**
```
1. Group all appointments by Family Identifier
2. Count members per family
3. If count > 3, check how many are in morning (before 12:00 PM)
4. If morning count > 3 → violation
```

**Data sources:**
- `Family Identifier` field
- `TimeSlot` field
- Family size (computed from group count)

**Detection logic:**
```javascript
Object.entries(familyGroups).forEach(([familyId, members]) => {
  if (members.length > 3) {
    const morningMembers = members.filter(m => {
      if (!m.TimeSlot) return false;
      const hour = parseInt(m.TimeSlot.split(':')[0]);
      return hour < 12; // Before noon
    });
    
    if (morningMembers.length > 3) {
      morningMembers.forEach(m => {
        // VIOLATION for each morning member
      });
    }
  }
});
```

**Edge cases:**
- Family with exactly 3 members → no violation
- Family with 4+ members but all in afternoon → no violation
- Family with 4+ members, 3 morning + 2 afternoon → no violation
- Family with 5+ members, 4 morning + 1 afternoon → violation

**Severity:** Warning

**Example violation:**
- Family: F1-001 (5 members)
- Morning: 10:00, 10:30, 11:00, 11:30 (4 members)
- Afternoon: 14:00 (1 member)
- Message: "Family 'F1-001' has 5 members, with 4 members in morning slots"

---

### Rule 4: Don't Give New Patients Appointment Continuously — Give New and Old Alternatively

**What it means:** Avoid scheduling new patients back-to-back. Insert old patients between them.

**How to identify:**
```
1. Sort all appointments by TimeSlot
2. Iterate through pairs of consecutive appointments
3. If both are "New" patients → violation
4. Check if they're within 30 minutes of each other (to avoid false positives)
```

**Data sources:**
- `PatientType` field
- `TimeSlot` field (sorted)

**Detection logic:**
```javascript
const scheduled = appointments
  .filter(a => a.TimeSlot)
  .sort((a, b) => timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot));

for (let i = 0; i < scheduled.length - 1; i++) {
  const curr = scheduled[i];
  const next = scheduled[i + 1];
  
  if (isNewPatient(curr) && isNewPatient(next)) {
    const gap = timeToMin(next.TimeSlot) - timeToMin(curr.TimeSlot);
    if (gap <= 30) { // Within 30 minutes
      // VIOLATION
    }
  }
}
```

**Edge cases:**
- Two new patients 1 hour apart → no violation (acceptable gap)
- New patient followed by old patient → no violation
- Three new patients in a row → 2 violations
- Waiting list patients → excluded

**Severity:** Info (soft rule, clinic may have busy days)

**Example violation:**
- 10:00 - "John" (New)
- 10:20 - "Jane" (New)
- Message: "Consecutive new patients: 'John' (10:00) and 'Jane' (10:20)"

---

### Rule 5: Don't Give New Patient Appointment After 4:00 PM (Can Give Non-Dilation Like Kids, Direct OPD)

**What it means:** New patients should not be scheduled after 4:00 PM, with exceptions for:
- Kids (pediatric patients)
- Direct OPD cases
- Special cases (VIP/BNI)
- Non-dilation procedures

**How to identify:**
```
1. Check if appointment is a "New" patient
2. Check if TimeSlot is after 4:00 PM (16:00)
3. If yes, check exceptions:
   - Has dilation in PlanOfAction? → ERROR (dilation is not allowed)
   - Is pediatric (age < 18)? → OK
   - Has "Direct" in PlanOfAction? → OK
   - Has special case flag (VIP/BNI)? → OK
   - Otherwise → WARNING
```

**Data sources:**
- `PatientType` field
- `TimeSlot` field
- `PlanOfAction` field (check for DIL, DIRECT)
- `Age` field (parse years/months/baby)
- `Remarks` field (check for VIP/BNI)

**Detection logic:**
```javascript
appointments.forEach(appt => {
  if (!appt.TimeSlot || !isNewPatient(appt)) return;
  
  const hour = parseInt(appt.TimeSlot.split(':')[0]);
  if (hour >= 16) {
    const tags = parseProcedureTags(appt.PlanOfAction);
    const flags = parseRemarksFlags(appt.Remarks);
    const isPediatric = isPediatricPatient(appt);
    
    if (tags.DIL) {
      // ERROR: New patient with dilation after 4 PM
    } else if (isPediatric || tags.DIRECT || flags.isVIP || flags.isBNI) {
      // OK: Exception applies
    } else {
      // WARNING: New patient after 4 PM without clear exception
    }
  }
});
```

**Edge cases:**
- New patient at 15:50 → no violation (before 4 PM)
- New patient at 16:00 → check starts
- New patient with REF+DIL at 16:30 → ERROR
- New patient (age 10) at 16:30 → OK (pediatric)
- New patient with "Direct OPD" at 16:30 → OK
- New patient with VIP flag at 16:30 → OK
- New patient with REF only at 16:30 → WARNING (no clear exception)

**Severity:** 
- Error if has DIL
- Warning otherwise

**Example violations:**
- Error: "New patient 'John' with DILATION at 16:30 (after 4:00 PM)"
- Warning: "New patient 'Jane' scheduled at 16:30 (after 4:00 PM) — acceptable only for kids, direct OPD, or special cases"

---

### Rule 6: Morning Consultation 10:30-1:30 PM & Afternoon Consultation 2:30-5:30 PM

**What it means:** Doctor consultations should happen within standard hours: 10:30-13:30 and 14:30-17:30. Lunch break is 13:30-14:30.

**How to identify:**
```
1. Check Consult Start time
2. Determine which window it falls in:
   - Window 1: 10:30-13:30 (630-810 minutes)
   - Lunch break: 13:30-14:30 (810-870 minutes)
   - Window 2: 14:30-17:30 (870-1050 minutes)
   - After hours: 17:30+ (1050+ minutes)
3. Flag if outside windows
```

**Data sources:**
- `Consult Start` field (format: "HH:MM:SS" or "HH:MM")

**Detection logic:**
```javascript
appointments.forEach(appt => {
  if (!appt["Consult Start"] || appt["Consult Start"].trim() === "") return;
  
  const totalMin = timeToMin(appt["Consult Start"]);
  const inWindow1 = totalMin >= 630 && totalMin <= 810;
  const inWindow2 = totalMin >= 870 && totalMin <= 1050;
  
  if (!inWindow1 && !inWindow2) {
    if (totalMin > 810 && totalMin < 870) {
      // INFO: During lunch break
    } else {
      // WARNING: Outside standard hours
    }
  }
});
```

**Edge cases:**
- Consult Start empty → skip
- Consult Start at 10:30 → OK
- Consult Start at 13:30 → INFO (lunch break)
- Consult Start at 14:30 → OK
- Consult Start at 17:30 → OK
- Consult Start at 17:31 → WARNING
- Consult Start at 09:00 → WARNING

**Severity:** Info (lunch break) / Warning (outside hours)

**Example violations:**
- Info: "Consultation for 'John' starts at 13:45 (during lunch break 1:30-2:30 PM)"
- Warning: "Consultation for 'Jane' starts at 09:15 (outside standard hours 10:30-1:30, 2:30-5:30)"

---

### Rule 7: Don't Give Appointment for Same Families Continuously

**What it means:** Don't schedule family members back-to-back. Separate them with other patients.

**How to identify:**
```
1. Sort all appointments by TimeSlot
2. Iterate through and track current family streak
3. If 2+ consecutive appointments have same Family ID → violation
```

**Data sources:**
- `Family Identifier` field
- `TimeSlot` field (sorted)

**Detection logic:**
```javascript
let prevFamily = null;
let streak = [];

for (const appt of scheduled) {
  const fid = appt["Family Identifier"];
  if (fid && fid === prevFamily && fid.trim() !== "") {
    streak.push(appt);
  } else {
    if (streak.length >= 2) {
      // VIOLATION: Report the streak
    }
    streak = fid ? [appt] : [];
    prevFamily = fid || null;
  }
}
```

**Edge cases:**
- Family A, Family A, Family B → violation for Family A streak (2)
- Family A, Family B, Family A → no violation (not continuous)
- Family A, Family A, Family A → violation (3 members continuous)
- Appointment without Family ID → breaks streak

**Severity:** Info (soft rule)

**Example violation:**
- 10:00 - "John" (F1-001)
- 10:30 - "Mary" (F1-001)
- 11:00 - "Sarah" (Old)
- 11:30 - "Bob" (F1-001)
- Message: "Family 'F1-001' members scheduled consecutively: John (10:00), Mary (10:30)"

---

### Rule 8: Don't Give Gonio+AT Cases or AT Cases Continuously

**What it means:** Avoid scheduling Gonio (gonioscopy) and AT (A-scan) procedures back-to-back.

**How to identify:**
```
1. Sort all appointments by TimeSlot
2. Check if appointment has AT or Gonio in PlanOfAction
3. If two consecutive appointments both have AT/Gonio → violation
```

**Data sources:**
- `PlanOfAction` field (JSON array)
- `TimeSlot` field (sorted)

**Detection logic:**
```javascript
for (let i = 0; i < scheduled.length - 1; i++) {
  const curr = scheduled[i];
  const next = scheduled[i + 1];
  const currTags = parseProcedureTags(curr.PlanOfAction);
  const nextTags = parseProcedureTags(next.PlanOfAction);
  
  const currIsAT = currTags.AT || currTags.GONIO;
  const nextIsAT = nextTags.AT || nextTags.GONIO;
  
  if (currIsAT && nextIsAT) {
    // VIOLATION
  }
}
```

**Edge cases:**
- AT followed by AT → violation
- Gonio followed by AT → violation
- AT followed by REF → no violation
- AT followed by OCT → no violation
- Two appointments with both AT and Gonio → violation

**Severity:** Warning

**Example violation:**
- 14:00 - "John" (AT (BE))
- 14:20 - "Jane" (GONIO (BE), AT (BE))
- Message: "AT/Gonio patients scheduled consecutively: 'John' (14:00) and 'Jane' (14:20)"

---

### Rule 9: 9:20 & 9:40 Slots Only for HFA (If Not Filled, Then R+D Cases)

**What it means:** 
- HFA (Humphrey Field Analyzer) patients get priority for 9:20 AM and 9:40 AM slots
- HFA slots can be filled by HFA patients only
- If HFA slot is filled with non-HFA patient → mark out (violation)
- Last day before appointment: any patient can take the slot if still empty

**How to identify:**
```
1. Check if appointment is at 9:20 or 9:40
2. Check if patient has HFA in PlanOfAction
3. If non-HFA patient in HFA slot → violation
4. Also check: HFA patients in non-HFA slots (soft warning if >1 day before)
```

**Data sources:**
- `TimeSlot` field
- `PlanOfAction` field (check for HFA)
- `AppointmentDate` field (for day calculation)

**Detection logic:**
```javascript
const today = new Date();
const apptDate = new Date(date);
const daysDiff = Math.floor((apptDate - today) / (1000 * 60 * 60 * 24));

appointments.forEach(appt => {
  if (!appt.TimeSlot) return;
  const time = appt.TimeSlot;
  const isHFASlot = (time === "09:20" || time === "09:40");
  const tags = parseProcedureTags(appt.PlanOfAction);
  
  if (isHFASlot && !tags.HFA) {
    // VIOLATION: Non-HFA in HFA slot
  } else if (!isHFASlot && tags.HFA && daysDiff > 1) {
    // INFO: HFA in non-HFA slot, >1 day before (suggest moving)
  }
});
```

**Edge cases:**
- HFA patient at 9:20 → OK
- Non-HFA patient at 9:20 → violation
- HFA patient at 10:00 (1 day before) → OK
- HFA patient at 10:00 (3 days before) → info (suggest 9:20/9:40)
- Waiting list (no TimeSlot) → skip

**Severity:** Warning (non-HFA in HFA slot) / Info (HFA in non-HFA slot)

**Example violations:**
- Warning: "Non-HFA patient 'John' occupies HFA slot at 09:20"
- Info: "HFA patient 'Jane' scheduled at 10:00 instead of 9:20/9:40 HFA slot (3 days before appointment)"

---

### Rule 10: Put ROP Appointment on Wednesday

**What it means:** ROP (Retinopathy of Prematurity) appointments should only be scheduled on Wednesdays.

**How to identify:**
```
1. Check if appointment has ROP in PlanOfAction
2. Get day-of-week of AppointmentDate
3. If day-of-week ≠ Wednesday → violation
```

**Data sources:**
- `PlanOfAction` field (check for "ROP")
- `AppointmentDate` field (compute day-of-week)

**Detection logic:**
```javascript
if (dayOfWeek === 'WED') return []; // ROP on Wednesday is correct

appointments.forEach(appt => {
  const tags = parseProcedureTags(appt.PlanOfAction);
  if (tags.ROP) {
    // VIOLATION
  }
});
```

**Edge cases:**
- ROP on Wednesday → no violation
- ROP on any other day → violation
- Appointment without PlanOfAction → skip

**Severity:** Error (strict rule, ROP requires special equipment/staff)

**Example violation:**
- "ROP patient 'Baby John' scheduled on Monday (should be Wednesday)"

---

### Rule 11: Laser Appointment on Tuesday and Friday (Except SVV Advised Special Cases)

**What it means:** Laser procedures should be on Tuesday or Friday, unless SVV (doctor) advised otherwise.

**How to identify:**
```
1. Check if appointment has LASER in PlanOfAction
2. Get day-of-week of AppointmentDate
3. If day-of-week ≠ Tuesday AND ≠ Friday → check SVV exception
4. If SVV flag in Remarks → OK, else → violation
```

**Data sources:**
- `PlanOfAction` field (check for "LASER" or "FOCAL LASER")
- `AppointmentDate` field
- `Remarks` field (check for "SVV")

**Detection logic:**
```javascript
if (dayOfWeek === 'TUE' || dayOfWeek === 'FRI') return []; // Correct days

appointments.forEach(appt => {
  const tags = parseProcedureTags(appt.PlanOfAction);
  const flags = parseRemarksFlags(appt.Remarks);
  
  if (tags.LASER && !flags.isSVV) {
    // VIOLATION
  }
});
```

**Edge cases:**
- Laser on Tuesday → OK
- Laser on Friday → OK
- Laser on Monday → violation
- Laser on Monday with "SVV TOLD TO GIVE" in remarks → OK
- FOCAL LASER → also checked (Rule 13)

**Severity:** Error (strict rule unless SVV exception)

**Example violations:**
- Error: "Laser patient 'John' scheduled on Thursday (should be Tue/Fri unless SVV advised)"

---

### Rule 12: Wheelchair Appointment Give Only at Evening or Early Morning

**What it means:** Wheelchair patients should be scheduled early morning (before 10 AM) or evening (after 4 PM) to avoid waiting in crowded areas.

**How to identify:**
```
1. Check if Remarks contains "WHEEL CHAIR" or "WHEELCHAIR"
2. Check TimeSlot
3. If mid-day (10 AM - 4 PM) → violation
```

**Data sources:**
- `Remarks` field (keyword search)
- `TimeSlot` field

**Detection logic:**
```javascript
appointments.forEach(appt => {
  if (!appt.TimeSlot) return;
  const flags = parseRemarksFlags(appt.Remarks);
  if (!flags.isWheelchair) return;
  
  const hour = parseInt(appt.TimeSlot.split(':')[0]);
  const isEarlyMorning = hour < 10;
  const isEvening = hour >= 16;
  
  if (!isEarlyMorning && !isEvening) {
    // VIOLATION
  }
});
```

**Edge cases:**
- Wheelchair at 09:00 → OK (early morning)
- Wheelchair at 09:30 → OK
- Wheelchair at 10:00 → violation
- Wheelchair at 12:00 → violation
- Wheelchair at 16:00 → OK (evening)
- Wheelchair at 15:30 → violation (not yet evening)
- Remarks: "wheel chair" (lowercase) → also detected (case-insensitive)

**Severity:** Info (soft rule, patient comfort)

**Example violation:**
- "Wheelchair patient 'Mary' scheduled at 12:00 (mid-day) — consider moving to early morning or evening"

---

### Rule 13: Put 20 Minutes for Laser Appointment

**What it means:** Laser procedures require 20 minutes minimum between appointments.

**How to identify:**
```
1. Sort all appointments by TimeSlot
2. Check if current appointment has LASER
3. Check gap to next appointment
4. If gap < 20 minutes → violation
```

**Data sources:**
- `PlanOfAction` field (check for LASER)
- `TimeSlot` field (sorted, for gap calculation)

**Detection logic:**
```javascript
for (let i = 0; i < scheduled.length - 1; i++) {
  const curr = scheduled[i];
  const next = scheduled[i + 1];
  const currTags = parseProcedureTags(curr.PlanOfAction);
  
  if (currTags.LASER) {
    const gap = timeToMin(next.TimeSlot) - timeToMin(curr.TimeSlot);
    if (gap < 20) {
      // VIOLATION
    }
  }
}
```

**Edge cases:**
- Laser at 14:00, next at 14:20 → OK
- Laser at 14:00, next at 14:10 → violation
- Laser at 14:00, next at 15:00 → OK
- Two lasers back-to-back → violation for second one

**Severity:** Warning (equipment/procedure requirement)

**Example violation:**
- "Laser patient 'John' has only 10 min before 'Jane' (needs 20 min)"

---

### Rule 14: Fix Appointment Time According to Their Plan of Action

**What it means:** Each procedure type requires a minimum duration. The gap between appointments should accommodate the procedure.

**How to identify:**
```
1. Define procedure duration mapping:
   - REF: 10 min
   - DIL: 15 min (includes dilation time)
   - OCT: 10 min
   - AT: 10 min
   - GONIO: 15 min
   - HFA: 20 min
   - LASER: 20 min
   - ROP: 15 min
   - SQUINT: 15 min
   - IVR/IVTA: 15 min
   - YAG: 10 min
   - DIRECT: 5 min
2. Sort appointments by TimeSlot
3. For each appointment, check if gap to next is < procedure duration
4. If yes → violation
```

**Data sources:**
- `PlanOfAction` field
- `TimeSlot` field
- Procedure duration mapping (hardcoded)

**Detection logic:**
```javascript
const PROCEDURE_DURATIONS = {
  'REF': 10, 'DIL': 15, 'OCT': 10, 'AT': 10, 'GONIO': 15,
  'HFA': 20, 'LASER': 20, 'ROP': 15, 'SQUINT': 15,
  'IVR': 15, 'IVTA': 15, 'YAG': 10, 'DIRECT': 5
};

for (let i = 0; i < scheduled.length - 1; i++) {
  const curr = scheduled[i];
  const next = scheduled[i + 1];
  const requiredDuration = getMaxProcedureDuration(curr.PlanOfAction);
  
  if (requiredDuration > 0) {
    const gap = timeToMin(next.TimeSlot) - timeToMin(curr.TimeSlot);
    if (gap < requiredDuration) {
      // VIOLATION
    }
  }
}

function getMaxProcedureDuration(planOfAction) {
  const tags = parseProcedureTags(planOfAction);
  let maxDuration = 0;
  
  if (tags.HFA) maxDuration = Math.max(maxDuration, 20);
  if (tags.LASER) maxDuration = Math.max(maxDuration, 20);
  if (tags.GONIO) maxDuration = Math.max(maxDuration, 15);
  if (tags.DIL) maxDuration = Math.max(maxDuration, 15);
  if (tags.ROP) maxDuration = Math.max(maxDuration, 15);
  if (tags.SQUINT) maxDuration = Math.max(maxDuration, 15);
  if (tags.IVR || tags.IVTA) maxDuration = Math.max(maxDuration, 15);
  if (tags.OCT) maxDuration = Math.max(maxDuration, 10);
  if (tags.AT) maxDuration = Math.max(maxDuration, 10);
  if (tags.REF) maxDuration = Math.max(maxDuration, 10);
  if (tags.YAG) maxDuration = Math.max(maxDuration, 10);
  if (tags.DIRECT) maxDuration = Math.max(maxDuration, 5);
  
  return maxDuration;
}
```

**Edge cases:**
- REF (10 min) at 10:00, next at 10:10 → OK
- DIL (15 min) at 10:00, next at 10:10 → violation
- HFA (20 min) at 09:20, next at 09:40 → OK (20 min)
- HFA at 09:20, next at 09:30 → violation
- Multiple procedures (REF+DIL+AT) → use max duration (15 min)

**Severity:** Warning

**Example violation:**
- "Appointment 'John' (REF+DIL) has only 10 min before 'Jane' (needs 15 min for dilation)"

---

### Rule 15: Special Cases Should Mention in Appointment List (VIP, BNI, Wheelchair)

**What it means:** This is not a violation rule — it's a detection rule to identify special case patients for highlighting in the UI.

**How to identify:**
```
1. Check Remarks for special case keywords:
   - VIP
   - BNI
   - WHEEL CHAIR
2. Return list of special case appointments (for UI highlighting)
```

**Data sources:**
- `Remarks` field

**Detection logic:**
```javascript
const specialCases = [];
appointments.forEach(appt => {
  const flags = parseRemarksFlags(appt.Remarks);
  if (flags.isVIP || flags.isBNI || flags.isWheelchair) {
    specialCases.push({
      appointmentId: appt.AppointmentID,
      patient: appt.PatientName,
      type: flags.isVIP ? 'VIP' : flags.isBNI ? 'BNI' : 'Wheelchair',
      time: appt.TimeSlot
    });
  }
});
```

**Purpose:** 
- Highlight in UI (e.g., badge, color)
- Print in special section of PDF
- Used as exception for other rules

**No violation** — this is informational only.

---

### Rule 16: HFA Alternative Slots After 9:20/9:40 Filled (Direct OPD or AT)

**What it means:** If both HFA slots (9:20, 9:40) are filled on the day before, remaining HFA patients should be given alternative slots like Direct OPD or AT.

**How to identify:**
```
1. Check if appointment date is within 1 day (day before or same day)
2. Check if patient has HFA in PlanOfAction
3. Check if TimeSlot is 9:20 or 9:40
4. If HFA patient in non-HFA slot AND day is within 1 day → OK (alternative slot)
5. If non-HFA patient in HFA slot → violation
```

**Data sources:**
- `PlanOfAction` field
- `TimeSlot` field
- `AppointmentDate` field (for day calculation)

**Detection logic:**
```javascript
const today = new Date();
const apptDate = new Date(date);
const daysDiff = Math.floor((apptDate - today) / (1000 * 60 * 60 * 24));

appointments.forEach(appt => {
  if (!appt.TimeSlot) return;
  const tags = parseProcedureTags(appt.PlanOfAction);
  const isHFASlot = (appt.TimeSlot === "09:20" || appt.TimeSlot === "09:40");
  
  // HFA patient in alternative slot (within 1 day) → OK, just note it
  if (tags.HFA && !isHFASlot && daysDiff <= 1) {
    // INFO: HFA patient in alternative slot (acceptable)
  }
  
  // Non-HFA in HFA slot → violation
  if (isHFASlot && !tags.HFA) {
    // VIOLATION
  }
});
```

**Edge cases:**
- HFA patient at 10:00, 1 day before → OK (alternative slot)
- HFA patient at 10:00, 3 days before → INFO (suggest HFA slot)
- Non-HFA patient at 9:20 → violation (regardless of date)

**Severity:** Info / Warning (combined with Rule 9)

---

## Data Field Mapping

| Field | Type | Used By Rules |
|-------|------|---------------|
| `AppointmentID` | String | All (identifier) |
| `AppointmentDate` | Date (yyyy-MM-dd) | 10, 11, 16 |
| `TimeSlot` | String (HH:MM) | 1, 2, 3, 5, 9, 12, 14, 16 |
| `Consult Start` | String (HH:MM:SS) | 6 |
| `PatientName` | String | All (display) |
| `MRDNo` | String | All (identifier) |
| `Age` | String | 5 (pediatric check) |
| `PatientType` | String | 1, 4, 5 |
| `PlanOfAction` | JSON String | 5, 8, 9, 10, 11, 13, 14, 16 |
| `Remarks` | String | 2, 5, 11, 12, 15 |
| `Family Identifier` | String | 2, 3, 7 |
| `Doctor` | String | All (filter) |

---

## Procedure Tag Detection

**Mapping from `PlanOfAction` JSON to boolean tags:**

| Tag | PlanOfAction Contains |
|-----|----------------------|
| `HFA` | `"HFA"` or `"HFA (BE)"` |
| `LASER` | `"LASER"` or `"FOCAL LASER"` |
| `ROP` | `"ROP"` |
| `GONIO` | `"GONIO"` |
| `AT` | `"AT"` or `"A-SCAN"` (word boundary for AT) |
| `OCT` | `"OCT"` |
| `DIL` | `"DIL"` |
| `REF` | `"REF"` |
| `DIRECT` | `"DIRECT"` |
| `SQUINT` | `"SQUINT"` |
| `IVR` | `"IVR"` |
| `IVTA` | `"IVTA"` |
| `HOMIDE` | `"HOMIDE"` |
| `YAG` | `"YAG"` |
| `REVIEW` | `"REVIEW"` |
| `BYNOCS` | `"BYNOCS"` |

---

## Special Case Detection (from Remarks)

| Flag | Remarks Contains (case-insensitive) |
|------|-------------------------------------|
| `isVIP` | `"VIP"` |
| `isBNI` | `"BNI"` |
| `isWheelchair` | `"WHEEL CHAIR"` or `"WHEELCHAIR"` |
| `isSVV` | `"SVV"` or `"SVV TOLD"` |

---

## Summary: All 16 Rules Covered

✅ All rules from your requirement list are covered with:
- Exact detection logic
- Data sources identified
- Edge cases handled
- Severity levels assigned
- Exception rules documented

**Ready to implement once you confirm the approach.**
</content>
