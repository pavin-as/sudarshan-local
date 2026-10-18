# Implementation Plan — Day Rules Validation & LLM Summary

## Overview

Add a rule validation system to the Day Overview page that:
1. Detects scheduling rule violations for the selected day's appointments
2. Surfaces violations in a UI warning modal
3. Includes violations as notes in the print/PDF output
4. Uses LLM only for human-readable summary formatting

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Day Overview Page                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Check Rules]  ←─── New button in download-buttons section    │
│        │                                                        │
│        ▼                                                        │
│  google.script.run                                             │
│  .validateDayRules(date, doctor, sessionToken)                 │
│        │                                                        │
│        ▼                                                        │
│  ┌─────────────────┐    ┌──────────────────┐                  │
│  │  Rule Engine    │───▶│  Violations[]    │                  │
│  │  (deterministic)│    │  structured      │                  │
│  └─────────────────┘    └──────────────────┘                  │
│                                │                                │
│                                ▼                                │
│  google.script.run                                             │
│  .formatViolationsWithLLM(violations, date)                    │
│        │                                                        │
│        ▼                                                        │
│  ┌─────────────────┐    ┌──────────────────┐                  │
│  │  LLM API        │───▶│  Formatted text  │                  │
│  │  (OpenAI/Claude)│    │  for print/PDF   │                  │
│  └─────────────────┘    └──────────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Data Preparation (Code.js)

### 1.1 Add Helper: Parse Procedure Tags

**File:** `Code.js`

```javascript
function parseProcedureTags(planOfAction) {
  const tags = {
    HFA: false, LASER: false, ROP: false, GONIO: false,
    AT: false, OCT: false, DIL: false, REF: false,
    DIRECT: false, SQUINT: false, IVR: false, IVTA: false,
    HOMIDE: false, YAG: false
  };
  if (!planOfAction) return tags;
  
  const plan = planOfAction.toUpperCase();
  tags.HFA = plan.includes('HFA');
  tags.LASER = plan.includes('LASER') || plan.includes('FOCAL LASER');
  tags.ROP = plan.includes('ROP');
  tags.GONIO = plan.includes('GONIO');
  tags.AT = /\bAT\b/.test(plan) || plan.includes('A-SCAN');
  tags.OCT = plan.includes('OCT');
  tags.DIL = plan.includes('DIL');
  tags.REF = plan.includes('REF');
  tags.DIRECT = plan.includes('DIRECT');
  tags.SQUINT = plan.includes('SQUINT');
  tags.IVR = plan.includes('IVR');
  tags.IVTA = plan.includes('IVTA');
  tags.HOMIDE = plan.includes('HOMIDE');
  tags.YAG = plan.includes('YAG');
  return tags;
}
```

### 1.2 Add Helper: Parse Remarks for Special Cases

```javascript
function parseRemarksFlags(remarks) {
  const upper = (remarks || '').toUpperCase();
  return {
    isVIP: upper.includes('VIP'),
    isBNI: upper.includes('BNI'),
    isWheelchair: upper.includes('WHEEL CHAIR') || upper.includes('WHEELCHAIR'),
    isSVV: upper.includes('SVV') || upper.includes('SVV TOLD'),
    isSpecial: upper.includes('VIP') || upper.includes('BNI') || 
               upper.includes('WHEEL CHAIR') || upper.includes('SVV')
  };
}
```

### 1.3 Add Helper: Age Parser

```javascript
function parseAgeYears(ageStr) {
  if (!ageStr) return null;
  const lower = ageStr.toLowerCase();
  if (lower.includes('baby') || lower.includes('month')) return 0;
  const match = ageStr.match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}
```

### 1.4 Add Helper: Day of Week

```javascript
function getDayOfWeek(dateStr) {
  // dateStr: "yyyy-MM-dd"
  const parts = dateStr.split('-');
  const date = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
  return ['SUN','MON','TUE','WED','THU','FRI','SAT'][date.getDay()];
}
```

---

## Phase 2: Rule Engine (Code.js)

### 2.1 Main Validation Function

```javascript
function validateDayRules(date, doctor, sessionToken) {
  // 1. Auth check
  const username = getSessionUsername(sessionToken);
  if (!username) return { success: false, error: "Session expired" };
  
  // 2. Get appointments
  const appointments = getAppointmentsForDay(date, doctor);
  if (!appointments || appointments.length === 0) {
    return { success: true, violations: [], appointmentCount: 0 };
  }
  
  const violations = [];
  const dayOfWeek = getDayOfWeek(date);
  
  // 3. Run each rule
  violations.push(...checkNewPatientTiming(appointments));
  violations.push(...checkSameFamilyTiming(appointments));
  violations.push(...checkFamilySizeMorning(appointments));
  violations.push(...checkNewOldAlternation(appointments));
  violations.push(...checkNewPatientAfter4PM(appointments));
  violations.push(...checkConsultationWindows(appointments));
  violations.push(...checkSameFamilyContinuous(appointments));
  violations.push(...checkGonioATConsecutive(appointments));
  violations.push(...checkHFASlotRule(appointments, date));
  violations.push(...checkROPDayRule(appointments, dayOfWeek));
  violations.push(...checkLaserDayRule(appointments, dayOfWeek));
  violations.push(...checkWheelchairTiming(appointments));
  violations.push(...checkLaserDuration(appointments));
  
  return { success: true, violations, appointmentCount: appointments.length, dayOfWeek };
}
```

### 2.2 Individual Rule Functions

#### Rule 1: New patients only 10 AM onwards

```javascript
function checkNewPatientTiming(appointments) {
  const violations = [];
  appointments.forEach(appt => {
    if (isNewPatient(appt) && appt.TimeSlot) {
      const hour = parseInt(appt.TimeSlot.split(':')[0]);
      if (hour < 10) {
        violations.push({
          rule: "NEW_PATIENT_TIMING",
          severity: "warning",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          message: `New patient "${appt.PatientName}" scheduled at ${appt.TimeSlot} (before 10:00 AM)`,
          suggestion: "Move to 10:00 AM or later"
        });
      }
    }
  });
  return violations;
}

function isNewPatient(appt) {
  return appt.PatientType === "Guest" || 
         appt.PatientType === "New" ||
         (appt.PatientType && appt.PatientType.toLowerCase().includes("new"));
}
```

#### Rule 2: Same family before 11:30 AM (with special case exception)

```javascript
function checkSameFamilyTiming(appointments) {
  const violations = [];
  const familyGroups = groupByFamily(appointments);
  
  Object.entries(familyGroups).forEach(([familyId, members]) => {
    if (!familyId || familyId === "null" || familyId.trim() === "") return;
    
    members.forEach(member => {
      if (!member.TimeSlot) return;
      const hour = parseInt(member.TimeSlot.split(':')[0]);
      const min = parseInt(member.TimeSlot.split(':')[1]);
      const totalMin = hour * 60 + min;
      
      // Skip if special case (VIP/BNI/SVV/Wheelchair)
      const flags = parseRemarksFlags(member.Remarks);
      if (flags.isSpecial) return;
      
      if (totalMin < 11 * 60 + 30) { // Before 11:30 AM
        violations.push({
          rule: "FAMILY_BEFORE_1130",
          severity: "info",
          appointmentId: member.AppointmentID,
          patient: member.PatientName,
          familyId: familyId,
          message: `Family member "${member.PatientName}" (Family: ${familyId}) scheduled at ${member.TimeSlot} (before 11:30 AM)`,
          suggestion: "Consider moving to 11:30 AM or later"
        });
      }
    });
  });
  return violations;
}

function groupByFamily(appointments) {
  return appointments.reduce((groups, appt) => {
    const fid = appt["Family Identifier"];
    if (fid && fid.trim() !== "") {
      if (!groups[fid]) groups[fid] = [];
      groups[fid].push(appt);
    }
    return groups;
  }, {});
}
```

#### Rule 3: Same family morning if >3 members

```javascript
function checkFamilySizeMorning(appointments) {
  const violations = [];
  const familyGroups = groupByFamily(appointments);
  
  Object.entries(familyGroups).forEach(([familyId, members]) => {
    if (members.length > 3) {
      const morningMembers = members.filter(m => {
        if (!m.TimeSlot) return false;
        const hour = parseInt(m.TimeSlot.split(':')[0]);
        return hour < 12;
      });
      
      if (morningMembers.length > 3) {
        morningMembers.forEach(m => {
          violations.push({
            rule: "FAMILY_SIZE_MORNING",
            severity: "warning",
            appointmentId: m.AppointmentID,
            patient: m.PatientName,
            familyId: familyId,
            familySize: members.length,
            message: `Family "${familyId}" has ${members.length} members, with multiple members in morning slots`,
            suggestion: "Consider spreading across morning and afternoon"
          });
        });
      }
    }
  });
  return violations;
}
```

#### Rule 4: Alternate New/Old (no consecutive new)

```javascript
function checkNewOldAlternation(appointments) {
  const violations = [];
  const scheduled = appointments
    .filter(a => a.TimeSlot && a.TimeSlot.trim() !== "")
    .sort((a, b) => timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot));
  
  for (let i = 0; i < scheduled.length - 1; i++) {
    const curr = scheduled[i];
    const next = scheduled[i + 1];
    
    if (isNewPatient(curr) && isNewPatient(next)) {
      // Check if they're close in time (within 30 min)
      if (timeToMin(next.TimeSlot) - timeToMin(curr.TimeSlot) <= 30) {
        violations.push({
          rule: "NEW_CONSECUTIVE",
          severity: "info",
          appointmentId: next.AppointmentID,
          patient: next.PatientName,
          message: `Consecutive new patients: "${curr.PatientName}" (${curr.TimeSlot}) and "${next.PatientName}" (${next.TimeSlot})`,
          suggestion: "Consider inserting an old patient between them"
        });
      }
    }
  }
  return violations;
}

function timeToMin(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}
```

#### Rule 5: No new patients after 4 PM (with non-dilation exception)

```javascript
function checkNewPatientAfter4PM(appointments) {
  const violations = [];
  appointments.forEach(appt => {
    if (!appt.TimeSlot || !isNewPatient(appt)) return;
    
    const hour = parseInt(appt.TimeSlot.split(':')[0]);
    if (hour >= 16) {
      const tags = parseProcedureTags(appt.PlanOfAction);
      const flags = parseRemarksFlags(appt.Remarks);
      const isPediatric = isPediatricPatient(appt);
      
      // Exceptions: non-dilation, kids, direct OPD, special cases
      if (tags.DIL) {
        violations.push({
          rule: "NEW_AFTER_4PM_DILATION",
          severity: "error",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          message: `New patient "${appt.PatientName}" with DILATION at ${appt.TimeSlot} (after 4:00 PM)`,
          suggestion: "New dilation patients should not be scheduled after 4:00 PM"
        });
      } else if (!isPediatric && !tags.DIRECT && !flags.isSpecial) {
        violations.push({
          rule: "NEW_AFTER_4PM",
          severity: "warning",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          message: `New patient "${appt.PatientName}" scheduled at ${appt.TimeSlot} (after 4:00 PM)`,
          suggestion: "Acceptable only for kids, direct OPD, or special cases"
        });
      }
    }
  });
  return violations;
}

function isPediatricPatient(appt) {
  const age = parseAgeYears(appt.Age);
  return age !== null && age < 18;
}
```

#### Rule 6: Consultation windows (10:30-1:30 PM, 2:30-5:30 PM)

```javascript
function checkConsultationWindows(appointments) {
  const violations = [];
  appointments.forEach(appt => {
    if (!appt["Consult Start"] || appt["Consult Start"].trim() === "") return;
    
    const timeStr = appt["Consult Start"];
    const totalMin = timeToMin(timeStr);
    
    // Window 1: 10:30-13:30 (630-810 min)
    // Window 2: 14:30-17:30 (870-1050 min)
    const inWindow1 = totalMin >= 630 && totalMin <= 810;
    const inWindow2 = totalMin >= 870 && totalMin <= 1050;
    
    if (!inWindow1 && !inWindow2) {
      // Outside consultation windows (lunch break 1:30-2:30, after 5:30)
      if (totalMin > 810 && totalMin < 870) {
        // Lunch break - just info
        violations.push({
          rule: "CONSULT_LUNCH_BREAK",
          severity: "info",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          message: `Consultation for "${appt.PatientName}" starts at ${timeStr} (during lunch break 1:30-2:30 PM)`,
          suggestion: "Verify if intentional"
        });
      } else {
        violations.push({
          rule: "CONSULT_OUTSIDE_WINDOW",
          severity: "warning",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          message: `Consultation for "${appt.PatientName}" starts at ${timeStr} (outside standard hours 10:30-1:30, 2:30-5:30)`,
          suggestion: "Verify if intentional"
        });
      }
    }
  });
  return violations;
}
```

#### Rule 7: Same family not continuously

```javascript
function checkSameFamilyContinuous(appointments) {
  const violations = [];
  const scheduled = appointments
    .filter(a => a.TimeSlot && a.TimeSlot.trim() !== "")
    .sort((a, b) => timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot));
  
  // Group consecutive same-family members
  let prevFamily = null;
  let streak = [];
  
  for (const appt of scheduled) {
    const fid = appt["Family Identifier"];
    if (fid && fid === prevFamily && fid.trim() !== "") {
      streak.push(appt);
    } else {
      if (streak.length >= 2) {
        // Report violation for the streak
        streak.forEach(m => {
          violations.push({
            rule: "FAMILY_CONTINUOUS",
            severity: "info",
            appointmentId: m.AppointmentID,
            patient: m.PatientName,
            familyId: prevFamily,
            message: `Family "${prevFamily}" members scheduled consecutively: ${streak.map(s => s.PatientName + " (" + s.TimeSlot + ")").join(", ")}`,
            suggestion: "Separate family members with other patients"
          });
        });
      }
      streak = fid ? [appt] : [];
      prevFamily = fid || null;
    }
  }
  // Check last streak
  if (streak.length >= 2) {
    streak.forEach(m => {
      violations.push({
        rule: "FAMILY_CONTINUOUS",
        severity: "info",
        appointmentId: m.AppointmentID,
        patient: m.PatientName,
        familyId: prevFamily,
        message: `Family "${prevFamily}" members scheduled consecutively`,
        suggestion: "Separate family members with other patients"
      });
    });
  }
  return violations;
}
```

#### Rule 8: Gonio+AT or AT not consecutively

```javascript
function checkGonioATConsecutive(appointments) {
  const violations = [];
  const scheduled = appointments
    .filter(a => a.TimeSlot && a.TimeSlot.trim() !== "")
    .sort((a, b) => timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot));
  
  for (let i = 0; i < scheduled.length - 1; i++) {
    const curr = scheduled[i];
    const next = scheduled[i + 1];
    const currTags = parseProcedureTags(curr.PlanOfAction);
    const nextTags = parseProcedureTags(next.PlanOfAction);
    
    const currIsAT = currTags.AT || currTags.GONIO;
    const nextIsAT = nextTags.AT || nextTags.GONIO;
    
    if (currIsAT && nextIsAT) {
      violations.push({
        rule: "GONIO_AT_CONSECUTIVE",
        severity: "warning",
        appointmentId: next.AppointmentID,
        patient: next.PatientName,
        message: `AT/Gonio patients scheduled consecutively: "${curr.PatientName}" (${curr.TimeSlot}) and "${next.PatientName}" (${next.TimeSlot})`,
        suggestion: "Separate AT/Gonio procedures with other appointment types"
      });
    }
  }
  return violations;
}
```

#### Rule 9: HFA slot rule (9:20 & 9:40 only for HFA)

```javascript
function checkHFASlotRule(appointments, date) {
  const violations = [];
  const today = new Date();
  const apptDate = new Date(date);
  const daysDiff = Math.floor((apptDate - today) / (1000 * 60 * 60 * 24));
  
  appointments.forEach(appt => {
    if (!appt.TimeSlot) return;
    const time = appt.TimeSlot;
    const isHFASlot = (time === "09:20" || time === "09:40");
    
    if (isHFASlot) {
      const tags = parseProcedureTags(appt.PlanOfAction);
      if (!tags.HFA) {
        violations.push({
          rule: "HFA_SLOT_NON_HFA",
          severity: "warning",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          time: time,
          message: `Non-HFA patient "${appt.PatientName}" occupies HFA slot at ${time}`,
          suggestion: "HFA slots (9:20, 9:40 AM) should be reserved for HFA patients"
        });
      }
    } else {
      // Non-HFA slot, but patient has HFA
      const tags = parseProcedureTags(appt.PlanOfAction);
      if (tags.HFA && daysDiff > 1) {
        // HFA patient in non-HFA slot, more than 1 day before
        violations.push({
          rule: "HFA_IN_NON_HFA_SLOT",
          severity: "info",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          time: time,
          message: `HFA patient "${appt.PatientName}" scheduled at ${time} instead of 9:20/9:40 HFA slot`,
          suggestion: "Consider moving to 9:20 or 9:40 AM HFA slot if available"
        });
      }
    }
  });
  return violations;
}
```

#### Rule 10: ROP on Wednesday only

```javascript
function checkROPDayRule(appointments, dayOfWeek) {
  const violations = [];
  if (dayOfWeek === 'WED') return violations;
  
  appointments.forEach(appt => {
    const tags = parseProcedureTags(appt.PlanOfAction);
    if (tags.ROP) {
      violations.push({
        rule: "ROP_WRONG_DAY",
        severity: "error",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        message: `ROP patient "${appt.PatientName}" scheduled on ${dayOfWeek} (should be Wednesday)`,
        suggestion: "Reschedule to Wednesday"
      });
    }
  });
  return violations;
}
```

#### Rule 11: Laser on Tuesday/Friday only

```javascript
function checkLaserDayRule(appointments, dayOfWeek) {
  const violations = [];
  if (dayOfWeek === 'TUE' || dayOfWeek === 'FRI') return violations;
  
  appointments.forEach(appt => {
    const tags = parseProcedureTags(appt.PlanOfAction);
    const flags = parseRemarksFlags(appt.Remarks);
    if (tags.LASER && !flags.isSVV) {
      violations.push({
        rule: "LASER_WRONG_DAY",
        severity: "error",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        message: `Laser patient "${appt.PatientName}" scheduled on ${dayOfWeek} (should be Tue/Fri unless SVV advised)`,
        suggestion: "Reschedule to Tuesday or Friday"
      });
    }
  });
  return violations;
}
```

#### Rule 12: Wheelchair → evening or early morning

```javascript
function checkWheelchairTiming(appointments) {
  const violations = [];
  
  appointments.forEach(appt => {
    if (!appt.TimeSlot) return;
    const flags = parseRemarksFlags(appt.Remarks);
    if (!flags.isWheelchair) return;
    
    const hour = parseInt(appt.TimeSlot.split(':')[0]);
    const isEarlyMorning = hour < 10;
    const isEvening = hour >= 16;
    
    if (!isEarlyMorning && !isEvening) {
      violations.push({
        rule: "WHEELCHAIR_TIMING",
        severity: "info",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        message: `Wheelchair patient "${appt.PatientName}" scheduled at ${appt.TimeSlot} (mid-day)`,
        suggestion: "Consider moving to early morning (before 10 AM) or evening (after 4 PM)"
      });
    }
  });
  return violations;
}
```

#### Rule 13: Laser 20-min duration

```javascript
function checkLaserDuration(appointments) {
  const violations = [];
  const scheduled = appointments
    .filter(a => a.TimeSlot && a.TimeSlot.trim() !== "")
    .sort((a, b) => timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot));
  
  for (let i = 0; i < scheduled.length - 1; i++) {
    const curr = scheduled[i];
    const next = scheduled[i + 1];
    const currTags = parseProcedureTags(curr.PlanOfAction);
    const nextTags = parseProcedureTags(next.PlanOfAction);
    
    if (currTags.LASER) {
      const gap = timeToMin(next.TimeSlot) - timeToMin(curr.TimeSlot);
      if (gap < 20) {
        violations.push({
          rule: "LASER_DURATION",
          severity: "warning",
          appointmentId: next.AppointmentID,
          patient: next.PatientName,
          message: `Laser patient "${curr.PatientName}" has only ${gap} min before "${next.PatientName}" (needs 20 min)`,
          suggestion: "Provide at least 20 minutes for laser procedures"
        });
      }
    }
  }
  return violations;
}
```

---

## Phase 3: LLM Summary (Code.js)

### 3.1 LLM API Call

```javascript
function formatViolationsWithLLM(violations, date, dayOfWeek) {
  // 1. Get API key from PropertiesService
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) {
    return fallbackSummary(violations); // No LLM, return plain text
  }
  
  // 2. Build prompt
  const prompt = buildLLMPrompt(violations, date, dayOfWeek);
  
  // 3. Call OpenAI API
  const url = 'https://api.openai.com/v1/chat/completions';
  const payload = {
    model: 'gpt-4o-mini', // Cost-effective
    messages: [
      {
        role: 'system',
        content: 'You are a medical clinic scheduling assistant. Format rule violations into a concise, professional notes section for a printed appointment list. Use clear bullet points. Group by severity (errors first, then warnings, then info). Be specific with times and patient names.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.3,
    max_tokens: 800
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    return {
      success: true,
      summary: result.choices[0].message.content
    };
  } catch (e) {
    Logger.log('LLM API error: ' + e.message);
    return fallbackSummary(violations);
  }
}
```

### 3.2 Prompt Builder

```javascript
function buildLLMPrompt(violations, date, dayOfWeek) {
  if (violations.length === 0) {
    return `Date: ${date} (${dayOfWeek})\n\nNo rule violations found. All appointments follow scheduling guidelines.`;
  }
  
  const grouped = {
    error: violations.filter(v => v.severity === 'error'),
    warning: violations.filter(v => v.severity === 'warning'),
    info: violations.filter(v => v.severity === 'info')
  };
  
  let prompt = `Date: ${date} (${dayOfWeek})\n\n`;
  prompt += `Found ${violations.length} rule violations. Format these into a concise notes section:\n\n`;
  
  if (grouped.error.length > 0) {
    prompt += `## ERRORS (${grouped.error.length})\n`;
    grouped.error.forEach((v, i) => {
      prompt += `${i+1}. [${v.rule}] ${v.message}\n`;
    });
    prompt += '\n';
  }
  
  if (grouped.warning.length > 0) {
    prompt += `## WARNINGS (${grouped.warning.length})\n`;
    grouped.warning.forEach((v, i) => {
      prompt += `${i+1}. [${v.rule}] ${v.message}\n`;
    });
    prompt += '\n';
  }
  
  if (grouped.info.length > 0) {
    prompt += `## INFO (${grouped.info.length})\n`;
    grouped.info.forEach((v, i) => {
      prompt += `${i+1}. [${v.rule}] ${v.message}\n`;
    });
  }
  
  prompt += `\nFormat as: A "Notes & Observations" section with clear bullet points, grouped by severity. Include a one-line summary at the top. Use professional medical scheduling language.`;
  return prompt;
}
```

### 3.3 Fallback (No LLM)

```javascript
function fallbackSummary(violations) {
  if (violations.length === 0) {
    return { success: true, summary: "✓ No rule violations found." };
  }
  
  let text = `⚠ ${violations.length} rule violations found:\n\n`;
  violations.forEach((v, i) => {
    const icon = v.severity === 'error' ? '🔴' : v.severity === 'warning' ? '🟡' : 'ℹ️';
    text += `${icon} ${v.message}\n`;
  });
  return { success: true, summary: text };
}
```

---

## Phase 4: Frontend Integration (dayOverview.html)

### 4.1 Add "Check Rules" Button

**Location:** In `.download-buttons` section, before existing buttons

```html
<button class="btn btn-outline-warning" onclick="checkDayRules()">
  <i class="fas fa-exclamation-triangle"></i> Check Rules
</button>
```

### 4.2 JavaScript Function

```javascript
function checkDayRules() {
  const date = document.getElementById('selectedDate').value;
  const doctor = document.getElementById('doctorSelect').value;
  
  if (!date || !doctor) {
    showAlert('Please select date and doctor first.', 'warning');
    return;
  }
  
  showAlert('Checking rules...', 'info');
  
  google.script.run
    .withSuccessHandler(displayRuleResults)
    .withFailureHandler(err => showAlert('Error: ' + err, 'error'))
    .validateDayRules(date, doctor, sessionToken);
}

function displayRuleResults(result) {
  if (!result.success) {
    showAlert(result.error || 'Rule check failed', 'error');
    return;
  }
  
  if (result.violations.length === 0) {
    showAlert(`✓ All ${result.appointmentCount} appointments follow the rules.`, 'success');
    return;
  }
  
  // Show in modal
  showRuleViolationsModal(result.violations, result.appointmentCount);
}

function showRuleViolationsModal(violations, count) {
  const modalHtml = `
    <div class="modal fade" id="ruleViolationsModal" tabindex="-1">
      <div class="modal-dialog modal-lg modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header bg-warning text-dark">
            <h5 class="modal-title">
              <i class="fas fa-exclamation-triangle"></i> 
              Rule Violations (${violations.length} of ${count} appointments)
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
            ${renderViolationsList(violations)}
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Remove existing modal if any
  const existing = document.getElementById('ruleViolationsModal');
  if (existing) existing.remove();
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modal = new bootstrap.Modal(document.getElementById('ruleViolationsModal'));
  modal.show();
}

function renderViolationsList(violations) {
  const grouped = {
    error: violations.filter(v => v.severity === 'error'),
    warning: violations.filter(v => v.severity === 'warning'),
    info: violations.filter(v => v.severity === 'info')
  };
  
  let html = '';
  
  ['error', 'warning', 'info'].forEach(severity => {
    if (grouped[severity].length === 0) return;
    const label = severity === 'error' ? '🔴 Errors' : 
                  severity === 'warning' ? '🟡 Warnings' : 'ℹ️ Info';
    html += `<h6 class="mt-3">${label} (${grouped[severity].length})</h6>`;
    html += '<ul class="list-group mb-3">';
    grouped[severity].forEach(v => {
      html += `
        <li class="list-group-item">
          <div class="d-flex justify-content-between">
            <div>
              <strong>${escapeHtml(v.patient)}</strong>
              <span class="badge bg-secondary ms-2">${v.rule}</span>
            </div>
          </div>
          <div class="text-muted small mt-1">${escapeHtml(v.message)}</div>
          ${v.suggestion ? `<div class="text-info small mt-1"><i>💡 ${escapeHtml(v.suggestion)}</i></div>` : ''}
        </li>
      `;
    });
    html += '</ul>';
  });
  
  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

### 4.3 Modify Print Flow

**Modify existing `confirmPrintWithSort()` function** to add violations section.

```javascript
function confirmPrintWithSort() {
  const sortOption = document.querySelector('input[name="printSortOption"]:checked').value;
  const date = document.getElementById('selectedDate').value;
  const doctor = document.getElementById('doctorSelect').value;
  
  // Show loading
  showAlert('Generating report with rule analysis...', 'info');
  
  // First get rules violations
  google.script.run
    .withSuccessHandler(function(ruleResult) {
      // Get LLM-formatted summary
      google.script.run
        .withSuccessHandler(function(llmResult) {
          // Now generate the PDF with the summary appended
          generatePrintWithRules(sortOption, date, doctor, llmResult.summary || '', ruleResult.violations);
        })
        .withFailureHandler(err => {
          // Fallback: generate without LLM summary
          generatePrintWithRules(sortOption, date, doctor, '', ruleResult.violations);
        })
        .formatViolationsWithLLM(ruleResult.violations, date, getDayOfWeek(date));
    })
    .withFailureHandler(err => {
      showAlert('Rule check failed: ' + err, 'error');
      // Still proceed with print
      generatePrintWithRules(sortOption, date, doctor, '', []);
    })
    .validateDayRules(date, doctor, sessionToken);
}

function getDayOfWeek(dateStr) {
  const d = new Date(dateStr);
  return ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()];
}

function generatePrintWithRules(sortOption, date, doctor, rulesSummary, violations) {
  // Call existing print generation with extra parameter
  google.script.run
    .withSuccessHandler(function(pdfUrl) {
      window.open(pdfUrl, '_blank');
    })
    .withFailureHandler(err => showAlert('Print failed: ' + err, 'error'))
    .generateDailyPDFWithRules(date, doctor, sortOption, rulesSummary, sessionToken);
}
```

---

## Phase 5: PDF Generation (Code.js)

### 5.1 Modified PDF Function

```javascript
function generateDailyPDFWithRules(date, doctor, sortOption, rulesSummary, sessionToken) {
  // 1. Auth check
  const username = getSessionUsername(sessionToken);
  if (!username) throw new Error("Session expired");
  
  // 2. Get appointments
  const appointments = getAppointmentsForDay(date, doctor);
  if (!appointments) return { success: false, error: "No data" };
  
  // 3. Sort
  const sorted = sortAppointments(appointments, sortOption);
  
  // 4. Build HTML for PDF
  let html = buildDailyPrintHTML(date, doctor, sorted);
  
  // 5. Append rules notes section
  if (rulesSummary) {
    html += `
      <div class="rules-notes" style="margin-top: 30px; padding: 15px; 
                                       border-top: 2px solid #e53e3e; 
                                       background: #fff5f5;">
        <h3 style="color: #c53030; margin-top: 0;">
          ⚠ Scheduling Rule Notes
        </h3>
        <div style="white-space: pre-wrap; font-size: 11px; line-height: 1.5;">
          ${rulesSummary}
        </div>
      </div>
    `;
  }
  
  // 6. Convert to PDF
  const blob = Utilities.newBlob(html, 'text/html', 'temp.html');
  const pdf = blob.getAs('application/pdf');
  pdf.setName(`Appointments_${date}_${doctor}.pdf`);
  
  // 7. Save to Drive and return URL
  const file = DriveApp.createFile(pdf);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  return { success: true, url: file.getUrl() };
}
```

---

## Phase 6: Configuration & Security

### 6.1 Store LLM API Key

```javascript
function setupLLMApiKey() {
  // Run once manually from GAS editor
  PropertiesService.getScriptProperties().setProperty('OPENAI_API_KEY', 'sk-...');
}
```

### 6.2 Add Settings UI (Optional)

In `settings.html`, add a section to configure LLM provider and API key.

### 6.3 Audit Logging

```javascript
function logRuleCheck(username, date, doctor, violationCount) {
  logAuditEvent(
    'RULE_CHECK',
    null,
    { date, doctor, violationCount },
    username,
    null
  );
}
```

---

## Phase 7: Testing

### 7.1 Unit Tests (Manual via GAS)

```javascript
function testRuleEngine() {
  // Test data
  const testAppointments = [
    { AppointmentID: '1', TimeSlot: '09:20', PatientName: 'A', 
      PlanOfAction: '["REF"]', PatientType: 'Guest' },
    { AppointmentID: '2', TimeSlot: '09:40', PatientName: 'B', 
      PlanOfAction: '["HFA (BE)"]', PatientType: 'Old' }
  ];
  
  const violations = checkHFASlotRule(testAppointments, '2026-08-13');
  Logger.log(violations); // Should flag Appointment 1
}
```

### 7.2 Test Cases

| Test | Input | Expected |
|------|-------|----------|
| HFA slot with non-HFA patient | 9:20, REF | Violation: HFA_SLOT_NON_HFA |
| New patient before 10 AM | 9:00, Guest | Violation: NEW_PATIENT_TIMING |
| Wheelchair mid-day | 12:00, Remarks: "WHEEL CHAIR" | Violation: WHEELCHAIR_TIMING |
| VIP family before 11:30 | 10:00, Remarks: "VIP", Family: F1 | No violation (special case) |
| ROP on Wednesday | ROP, Wednesday | No violation |
| ROP on Monday | ROP, Monday | Violation: ROP_WRONG_DAY |

---

## Implementation Order

| Step | Task | Est. Time |
|------|------|-----------|
| 1 | Add helper functions (parse tags, remarks, age) | 1 hour |
| 2 | Implement 13 rule functions | 4 hours |
| 3 | Add `validateDayRules()` orchestrator | 30 min |
| 4 | Add LLM API integration | 2 hours |
| 5 | Add "Check Rules" button + modal | 1 hour |
| 6 | Modify print flow to include rules | 2 hours |
| 7 | Add PDF generation with rules section | 1 hour |
| 8 | Manual testing with real data | 2 hours |
| 9 | Documentation in AGENTS.md | 30 min |
| **Total** | | **~14 hours** |

---

## Files to Modify

| File | Changes |
|------|---------|
| `Code.js` | Add 13 rule functions + orchestrator + LLM call + PDF generator |
| `dayOverview.html` | Add button + modal + print flow integration |
| `AGENTS.md` | Document new `validateDayRules()` and LLM functions |
| `rules.md` | Add note about rule engine + LLM dependency |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| LLM API down | Use fallback plain-text summary |
| LLM costs accumulate | Cache results per day/doctor for 1 hour |
| Slow performance (6-min timeout) | Rule engine is <1 sec; LLM is 2-5 sec; total <10 sec |
| False positives in rule detection | Use `severity: "info"` for soft rules, "warning" for likely issues, "error" for definite violations |
| API key exposure | Store in `PropertiesService` (server-side only) |
| User overload from violations | Group by severity, show count in button, allow dismiss |

---

## Future Enhancements (Out of Scope)

- Rule customization per doctor
- Historical violation tracking
- Auto-suggest time slots
- WhatsApp/email notifications for violations
- Multi-day rule checking
- Predictive capacity warnings
EOF
</content>