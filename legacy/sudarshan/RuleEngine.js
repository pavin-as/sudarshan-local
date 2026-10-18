// RuleEngine.gs — Day scheduling rule validation & LLM summary
// Attached to the same GAS project as Code.js

// ============================================================
// SECTION 1: HELPER FUNCTIONS
// ============================================================

/**
 * Parse PlanOfAction JSON string into boolean tags
 * @param {string} planOfAction - JSON string like '["REF", "DIL"]'
 * @returns {Object} {HFA, LASER, ROP, GONIO, AT, OCT, DIL, REF, DIRECT, SQUINT, IVR, IVTA, HOMIDE, YAG}
 */
function parseProcedureTags(planOfAction) {
  var tags = {
    HFA: false, LASER: false, ROP: false, GONIO: false,
    AT: false, OCT: false, DIL: false, REF: false,
    DIRECT: false, SQUINT: false, IVR: false, IVTA: false,
    HOMIDE: false, YAG: false, BYNOCS: false, REVIEW: false
  };
  if (!planOfAction) return tags;
  var plan = String(planOfAction).toUpperCase();
  tags.HFA     = plan.indexOf('HFA') !== -1;
  tags.LASER   = plan.indexOf('LASER') !== -1;
  tags.ROP     = plan.indexOf('ROP') !== -1;
  tags.GONIO   = plan.indexOf('GONIO') !== -1;
  // AT as a whole word (avoid matching "LATE", "RATE", etc.)
  tags.AT      = /\bAT\b/.test(plan) || plan.indexOf('A-SCAN') !== -1;
  tags.OCT     = plan.indexOf('OCT') !== -1;
  tags.DIL     = plan.indexOf('DIL') !== -1;
  tags.REF     = plan.indexOf('REF') !== -1;
  tags.DIRECT  = plan.indexOf('DIRECT') !== -1;
  tags.SQUINT  = plan.indexOf('SQUINT') !== -1;
  tags.IVR     = plan.indexOf('IVR') !== -1 && plan.indexOf('IVTA') === -1;
  tags.IVTA    = plan.indexOf('IVTA') !== -1;
  tags.HOMIDE  = plan.indexOf('HOMIDE') !== -1;
  tags.YAG     = plan.indexOf('YAG') !== -1;
  tags.BYNOCS  = plan.indexOf('BYNOCS') !== -1;
  tags.REVIEW  = plan.indexOf('REVIEW') !== -1;
  return tags;
}

/**
 * Parse Remarks for special case flags
 * @param {string} remarks
 * @returns {Object} {isVIP, isBNI, isWheelchair, isSVV, isSpecial}
 */
function parseRemarksFlags(remarks) {
  var upper = (remarks || '').toUpperCase();
  var isVIP        = upper.indexOf('VIP') !== -1;
  var isBNI        = upper.indexOf('BNI') !== -1;
  var isWheelchair = upper.indexOf('WHEEL CHAIR') !== -1 || upper.indexOf('WHEELCHAIR') !== -1;
  var isSVV        = upper.indexOf('SVV') !== -1;
  return {
    isVIP: isVIP,
    isBNI: isBNI,
    isWheelchair: isWheelchair,
    isSVV: isSVV,
    isSpecial: isVIP || isBNI || isWheelchair || isSVV
  };
}

/**
 * Parse age string to numeric years
 * Handles: "25 years", "6 months", "1 years", "Baby Boy", "Baby Girl"
 * @param {string} ageStr
 * @returns {number|null} years as integer, or null if unparseable
 */
function parseAgeYears(ageStr) {
  if (!ageStr) return null;
  var lower = String(ageStr).toLowerCase();
  if (lower.indexOf('baby') !== -1) return 0;
  if (lower.indexOf('month') !== -1) {
    var m = ageStr.match(/(\d+)/);
    return m ? 0 : null; // months treated as 0 for pediatric check
  }
  var match = ageStr.match(/(\d+)/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Get day of week code from yyyy-MM-dd date string
 * @param {string} dateStr
 * @returns {string} "SUN"|"MON"|"TUE"|"WED"|"THU"|"FRI"|"SAT"
 */
function getDayOfWeek(dateStr) {
  if (!dateStr) return "";
  var parts = String(dateStr).split('-');
  if (parts.length !== 3) return "";
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()];
}

/**
 * Convert "HH:MM" to minutes since midnight
 * @param {string|Date} timeStr
 * @returns {number} minutes, or -1 if invalid
 */
function timeToMin(timeStr) {
  if (timeStr === null || timeStr === undefined) return -1;
  // Handle Date object directly
  if (Object.prototype.toString.call(timeStr) === "[object Date]") {
    if (isNaN(timeStr.getTime())) return -1;
    return timeStr.getHours() * 60 + timeStr.getMinutes();
  }
  var s = String(timeStr).trim();
  if (!s) return -1;
  // Try to extract HH:MM from various formats:
  //   "09:40", "09:40:00", "1899-12-30T09:40:00.000Z", "Sat Dec 30 1899 09:40:00 GMT+0521 (...)"
  // Use a regex that finds HH:MM pattern anywhere in the string
  var match = s.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    var h = parseInt(match[1], 10);
    var m = parseInt(match[2], 10);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return h * 60 + m;
    }
  }
  return -1;
}

/**
 * Format a time value to clean "HH:MM" 24-hour string.
 * Handles:
 *   - "09:40" / "09:40:00" → "09:40"
 *   - Date object → "HH:MM" (extracts time portion)
 *   - ISO string "1899-12-30T09:40:00.000Z" → "09:40"
 *   - Invalid → ""
 */
function fmtTime(value) {
  if (value === null || value === undefined) return "";
  // If it's a Date object, extract HH:MM directly
  if (Object.prototype.toString.call(value) === "[object Date]") {
    if (isNaN(value.getTime())) return "";
    var hh = value.getHours();
    var mm = value.getMinutes();
    return (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
  }
  var s = String(value).trim();
  if (!s) return "";
  // Pure "HH:MM" or "HH:MM:SS"
  var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    return (m[1].length === 1 ? "0" + m[1] : m[1]) + ":" + m[2];
  }
  // ISO datetime like "1899-12-30T09:40:00.000Z" or "1899-12-30 09:40:00"
  // Extract HH:MM
  var isoMatch = s.match(/(\d{2}):(\d{2})(?::\d{2})?/);
  if (isoMatch) {
    return isoMatch[1] + ":" + isoMatch[2];
  }
  return "";
}

/**
 * Check if patient is "New" based on MRD number.
 * Convention: New patient MRD starts with "N" (e.g., NDC_..., Nxxx)
 *             Old patient MRD starts with "S" (e.g., SPDxxx)
 */
function isNewPatient(appt) {
  var mrd = (appt.MRDNo || appt["MRD No"] || appt["MRD"] || '').toString().trim();
  if (!mrd) {
    // Fallback: also check PatientType if MRD is empty
    var pt = (appt.PatientType || appt["Patient Type"] || '').toString().toLowerCase();
    return pt === 'new' || pt === 'guest' || pt.indexOf('new') !== -1;
  }
  // New if MRD starts with "N" (case-insensitive)
  return /^[Nn]/.test(mrd);
}

/**
 * Check if patient is "Old" based on MRD number (starts with S)
 */
function isOldPatient(appt) {
  var mrd = (appt.MRDNo || appt["MRD No"] || appt["MRD"] || '').toString().trim();
  if (!mrd) return false;
  return /^[Ss]/.test(mrd);
}

/**
 * Get a single rule setting value, with fallback default.
 * Reads from the module cache (populated by getRuleSettingsMap in Code.js).
 * If the setting key is missing and no default is provided, throws an error
 * so the caller gets a clear diagnostic message.
 * @param {string} key   —  e.g. "NEW_MORNING_START"
 * @param {string} defaultValue  —  fallback if key is missing
 * @return {string}
 */
function getRuleSetting(key, defaultValue) {
  var map = getRuleSettingsMap();
  if (map && key in map && map[key] !== "") {
    return map[key];
  }
  if (defaultValue !== undefined) {
    return String(defaultValue);
  }
  throw new Error("Required rule setting '" + key + "' is missing from the RuleSettings sheet. Run initializeRuleSettingsSheet() to restore defaults.");
}

/**
 * Check if patient is pediatric (age < 18)
 */
function isPediatricPatient(appt) {
  var age = parseAgeYears(appt.Age);
  return age !== null && age < 18;
}

/**
 * Group appointments by Family Identifier
 */
function groupByFamily(appointments) {
  var groups = {};
  (appointments || []).forEach(function (appt) {
    var fid = appt["Family Identifier"];
    if (fid && String(fid).trim() !== "" && String(fid).toLowerCase() !== "null") {
      if (!groups[fid]) groups[fid] = [];
      groups[fid].push(appt);
    }
  });
  return groups;
}

/**
 * Get the maximum procedure duration required for an appointment (in minutes)
 */
function getMaxProcedureDuration(planOfAction) {
  var tags = parseProcedureTags(planOfAction);
  var durations = [];
  if (tags.HFA)    durations.push(20);
  if (tags.LASER)  durations.push(20);
  if (tags.GONIO)  durations.push(15);
  if (tags.DIL)    durations.push(15);
  if (tags.ROP)    durations.push(15);
  if (tags.SQUINT) durations.push(15);
  if (tags.IVR)    durations.push(15);
  if (tags.IVTA)   durations.push(15);
  if (tags.OCT)    durations.push(10);
  if (tags.AT)     durations.push(10);
  if (tags.REF)    durations.push(10);
  if (tags.YAG)    durations.push(10);
  if (tags.REVIEW) durations.push(10);
  if (tags.DIRECT) durations.push(5);
  if (tags.HOMIDE) durations.push(5);
  if (tags.BYNOCS) durations.push(10);
  if (durations.length === 0) return 0;
  return Math.max.apply(null, durations);
}


// ============================================================
// SECTION 2: INDIVIDUAL RULE CHECKS
// ============================================================

/** Rule 1: New patients only after NEW_MORNING_START (default 10:00 AM) */
function checkNewPatientTiming(appointments) {
  if (getRuleSetting("RULE_NEW_TIMING", "ON") !== "ON") return [];
  var morningStart = getRuleSetting("NEW_MORNING_START", "10:00");
  var morningMin = timeToMin(morningStart);

  var violations = [];
  (appointments || []).forEach(function (appt) {
    if (!appt.TimeSlot) return;
    if (!isNewPatient(appt)) return;
    var total = timeToMin(appt.TimeSlot);
    if (total >= 0 && total < morningMin) {
      violations.push({
        rule: "NEW_PATIENT_BEFORE_TIME",
        severity: "warning",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(appt.TimeSlot),
        message: 'New patient "' + appt.PatientName + '" scheduled at ' + fmtTime(appt.TimeSlot) + ' (before ' + morningStart + ')',
        suggestion: "Move to " + morningStart + " or later"
      });
    }
  });
  return violations;
}

/** Rule 2: Same family before FAMILY_MORNING_CUTOFF (default 11:30 AM, except special cases) */
function checkSameFamilyTiming(appointments) {
  if (getRuleSetting("RULE_FAMILY_TIMING", "ON") !== "ON") return [];
  var cutoff    = getRuleSetting("FAMILY_MORNING_CUTOFF", "11:30");
  var cutoffMin = timeToMin(cutoff);

  var violations = [];
  var groups = groupByFamily(appointments);
  Object.keys(groups).forEach(function (fid) {
    groups[fid].forEach(function (member) {
      if (!member.TimeSlot) return;
      var flags = parseRemarksFlags(member.Remarks);
      if (flags.isSpecial) return;
      var total = timeToMin(member.TimeSlot);
      if (total < 0) return;
      if (total < cutoffMin) {
        violations.push({
          rule: "FAMILY_BEFORE_CUTOFF",
          severity: "info",
          appointmentId: member.AppointmentID,
          patient: member.PatientName,
          familyId: fid,
          time: fmtTime(member.TimeSlot),
          message: 'Family member "' + member.PatientName + '" (Family: ' + fid + ') at ' + fmtTime(member.TimeSlot) + ' (before ' + cutoff + ')',
          suggestion: "Consider " + cutoff + " or later"
        });
      }
    });
  });
  return violations;
}

/** Rule 3: Same family morning if more than FAMILY_MORNING_MAX (default 3) members */
function checkFamilySizeMorning(appointments) {
  if (getRuleSetting("RULE_FAMILY_MORNING", "ON") !== "ON") return [];
  var maxMembers = parseInt(getRuleSetting("FAMILY_MORNING_MAX", "3"), 10);

  var violations = [];
  var groups = groupByFamily(appointments);
  Object.keys(groups).forEach(function (fid) {
    var members = groups[fid];
    if (members.length <= maxMembers) return;
    var morning = members.filter(function (m) {
      if (!m.TimeSlot) return false;
      var h = parseInt(String(m.TimeSlot).split(':')[0], 10);
      return !isNaN(h) && h < 12;
    });
    if (morning.length > maxMembers) {
      morning.forEach(function (m) {
        violations.push({
          rule: "FAMILY_SIZE_MORNING",
          severity: "warning",
          appointmentId: m.AppointmentID,
          patient: m.PatientName,
          familyId: fid,
          familySize: members.length,
          morningCount: morning.length,
          message: 'Family "' + fid + '" has ' + members.length + ' members; ' + morning.length + ' in morning slots (max ' + maxMembers + ')',
          suggestion: "Spread across morning and afternoon"
        });
      });
    }
  });
  return violations;
}

/** Rule 4: Alternate New/Old — no consecutive new within NEW_CONSECUTIVE_GAP (default 30 min) */
function checkNewOldAlternation(appointments) {
  if (getRuleSetting("RULE_NEW_CONSECUTIVE", "ON") !== "ON") return [];
  var maxGap = parseInt(getRuleSetting("NEW_CONSECUTIVE_GAP", "30"), 10);

  var violations = [];
  var scheduled = (appointments || [])
    .filter(function (a) { return a.TimeSlot && String(a.TimeSlot).trim() !== ""; })
    .map(function (a) {
      var cs = a["Consult Start"] || a["ConsultStart"];
      var sortKey = (cs && String(cs).trim() !== "") ? timeToMin(cs) : timeToMin(a.TimeSlot);
      return { appt: a, sortMin: sortKey };
    })
    .filter(function (x) { return x.sortMin >= 0; })
    .sort(function (a, b) { return a.sortMin - b.sortMin; });

  var newPatientsInOrder = [];
  for (var k = 0; k < scheduled.length; k++) {
    if (isNewPatient(scheduled[k].appt)) {
      newPatientsInOrder.push(scheduled[k]);
    }
  }

  for (var i = 0; i < newPatientsInOrder.length - 1; i++) {
    var currWrap = newPatientsInOrder[i];
    var nextWrap = newPatientsInOrder[i + 1];
    var curr = currWrap.appt;
    var next = nextWrap.appt;
    var gap = nextWrap.sortMin - currWrap.sortMin;

    if (gap < maxGap) {
      var sameFamilySameSlot = (curr["Family Identifier"] && next["Family Identifier"] &&
        String(curr["Family Identifier"]).trim() === String(next["Family Identifier"]).trim() &&
        String(curr.TimeSlot).trim() === String(next.TimeSlot).trim());
      if (sameFamilySameSlot) continue;

      var hasOldBetween = false;
      for (var j = 0; j < scheduled.length; j++) {
        var item = scheduled[j];
        if (item.appt === curr || item.appt === next) continue;
        if (item.sortMin > currWrap.sortMin && item.sortMin < nextWrap.sortMin) {
          if (isOldPatient(item.appt)) {
            hasOldBetween = true;
            break;
          }
        }
      }
      if (!hasOldBetween) {
        violations.push({
          rule: "NEW_CONSECUTIVE",
          severity: "info",
          appointmentId: next.AppointmentID,
          patient: next.PatientName,
          time: fmtTime(next.TimeSlot),
          message: 'Consecutive new patients: "' + curr.PatientName + '" (consult ' + fmtTime(curr["Consult Start"]) + ') and "' + next.PatientName + '" (consult ' + fmtTime(next["Consult Start"]) + ') — only ' + gap + ' min between consults',
          suggestion: "Insert an old patient between them"
        });
      }
    }
  }
  return violations;
}

/** Rule 5: No new patients after NEW_EVENING_CUTOFF (default 4:00 PM)
 *  Exceptions: kids, direct OPD, VIP/BNI; dilation beyond cutoff = error */
function checkNewPatientAfter4PM(appointments) {
  if (getRuleSetting("RULE_NEW_AFTER_4PM", "ON") !== "ON") return [];
  var cutoff    = getRuleSetting("NEW_EVENING_CUTOFF", "16:00");
  var cutoffMin = timeToMin(cutoff);
  var cutoffHr  = parseInt(cutoff.split(':')[0], 10);

  var violations = [];
  (appointments || []).forEach(function (appt) {
    if (!appt.TimeSlot) return;
    if (!isNewPatient(appt)) return;
    var hour = parseInt(String(appt.TimeSlot).split(':')[0], 10);
    if (isNaN(hour) || hour < cutoffHr) return;
    var tags = parseProcedureTags(appt.PlanOfAction);
    var flags = parseRemarksFlags(appt.Remarks);
    var pediatric = isPediatricPatient(appt);
    if (tags.DIL) {
      violations.push({
        rule: "NEW_AFTER_EVENING_DILATION",
        severity: "error",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(appt.TimeSlot),
        message: 'New patient "' + appt.PatientName + '" with DILATION at ' + fmtTime(appt.TimeSlot) + ' (after ' + cutoff + ')',
        suggestion: "Dilation new patients should not be after " + cutoff
      });
    } else if (!pediatric && !tags.DIRECT && !flags.isVIP && !flags.isBNI) {
      violations.push({
        rule: "NEW_AFTER_EVENING",
        severity: "warning",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(appt.TimeSlot),
        message: 'New patient "' + appt.PatientName + '" at ' + fmtTime(appt.TimeSlot) + ' (after ' + cutoff + ')',
        suggestion: "Acceptable only for kids, direct OPD, or special cases"
      });
    }
  });
  return violations;
}

/** Rule 6: Consultation windows
 *  No HFA exemption.  Before start = warning, lunch = info, after end = warning. */
function checkConsultationWindows(appointments) {
  if (getRuleSetting("RULE_CONSULT_WINDOW", "ON") !== "ON") return [];
  var morningStart = getRuleSetting("CONSULT_WINDOW_START", "10:30");
  var lunchStart   = getRuleSetting("CONSULT_WINDOW_LUNCH_START", "13:30");
  var lunchEnd     = getRuleSetting("CONSULT_WINDOW_LUNCH_END", "14:30");
  var eveningEnd   = getRuleSetting("CONSULT_WINDOW_END", "17:30");
  var winStart = timeToMin(morningStart);
  var lStart   = timeToMin(lunchStart);
  var lEnd     = timeToMin(lunchEnd);
  var winEnd   = timeToMin(eveningEnd);

  var violations = [];
  (appointments || []).forEach(function (appt) {
    var cs = appt["Consult Start"] || appt["ConsultStart"];
    if (!cs || String(cs).trim() === "") return;
    var total = timeToMin(cs);
    if (total < 0) return;
    if (total < winStart) {
      violations.push({
        rule: "CONSULT_BEFORE_WINDOW",
        severity: "warning",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(cs),
        message: 'Consultation for "' + appt.PatientName + '" starts at ' + fmtTime(cs) + ' (before ' + morningStart + ')',
        suggestion: "Doctor available from " + morningStart + " only"
      });
      return;
    }
    if (total > lStart && total < lEnd) {
      violations.push({
        rule: "CONSULT_LUNCH_BREAK",
        severity: "info",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(cs),
        message: 'Consultation for "' + appt.PatientName + '" starts at ' + fmtTime(cs) + ' (during lunch break ' + lunchStart + '-' + lunchEnd + ')',
        suggestion: "Verify if intentional"
      });
      return;
    }
    if (total > winEnd) {
      violations.push({
        rule: "CONSULT_AFTER_HOURS",
        severity: "warning",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(cs),
        message: 'Consultation for "' + appt.PatientName + '" starts at ' + fmtTime(cs) + ' (after ' + eveningEnd + ')',
        suggestion: "Verify if intentional"
      });
    }
  });
  return violations;
}

/** Rule 7: Same family not continuously */
function checkSameFamilyContinuous(appointments) {
  if (getRuleSetting("RULE_FAMILY_CONTINUOUS", "ON") !== "ON") return [];
  var violations = [];
  var scheduled = (appointments || [])
    .filter(function (a) { return a.TimeSlot && String(a.TimeSlot).trim() !== ""; })
    .sort(function (a, b) { return timeToMin(a.TimeSlot) - timeToMin(b.TimeSlot); });
  var prevFid = null;
  var streak = [];
  function reportStreak() {
    if (streak.length >= 2) {
      var names = streak.map(function (s) { return s.PatientName + " (" + fmtTime(s.TimeSlot) + ")"; }).join(", ");
      streak.forEach(function (m) {
        violations.push({
          rule: "FAMILY_CONTINUOUS",
          severity: "info",
          appointmentId: m.AppointmentID,
          patient: m.PatientName,
          familyId: prevFid,
          message: 'Family "' + prevFid + '" members consecutive: ' + names,
          suggestion: "Separate with other patients"
        });
      });
    }
  }
  for (var i = 0; i < scheduled.length; i++) {
    var appt = scheduled[i];
    var fid = appt["Family Identifier"];
    var fidStr = (fid && String(fid).trim() !== "" && String(fid).toLowerCase() !== "null") ? String(fid) : null;
    if (fidStr && fidStr === prevFid) {
      streak.push(appt);
    } else {
      reportStreak();
      streak = fidStr ? [appt] : [];
      prevFid = fidStr;
    }
  }
  reportStreak();
  return violations;
}

/** Rule 8: GONIO / AT comprehensive rules
 *  Sub-rule A: Consecutive — no two AT/GONIO back-to-back without a non-taxing old
 *              patient between them in consult order.  Severity: warning.
 *  Sub-rule B: Daily cap — max GONIO_AT_MAX_PER_DAY AT/GONIO per day.  Severity: error.
 *  Sub-rule C: GONIO timing — best in evening (after GONIO_EVENING_START).
 *              Skip VIP/BNI/Wheelchair/SVV.  Severity: info.
 *  Sub-rule D: AT timing — best after AT_EVENING_START.
 *              Skip VIP/BNI/Wheelchair/SVV, or if patient also has GONIO.
 *              Severity: info.
 *
 *  "Non-taxing" break = old patient (SPD MRD) WITHOUT AT, GONIO, HFA, LASER, or OCT.
 */
function checkGonioATConsecutive(appointments) {
  var violations = [];

  // ---------- Sub-rule A: Consecutive ----------
  if (getRuleSetting("RULE_GONIO_AT_CONSECUTIVE", "ON") === "ON") {
    var scheduled = (appointments || [])
      .filter(function (a) { return a.TimeSlot && String(a.TimeSlot).trim() !== ""; })
      .map(function (a) {
        var cs = a["Consult Start"] || a["ConsultStart"];
        var sortKey = (cs && String(cs).trim() !== "") ? timeToMin(cs) : timeToMin(a.TimeSlot);
        return { appt: a, sortMin: sortKey };
      })
      .filter(function (x) { return x.sortMin >= 0; })
      .sort(function (a, b) { return a.sortMin - b.sortMin; });

    for (var i = 0; i < scheduled.length - 1; i++) {
      var currWrap = scheduled[i];
      var nextWrap = scheduled[i + 1];
      var curr = currWrap.appt;
      var next = nextWrap.appt;
      var currT = parseProcedureTags(curr.PlanOfAction);
      var nextT = parseProcedureTags(next.PlanOfAction);
      if ((currT.AT || currT.GONIO) && (nextT.AT || nextT.GONIO)) {
        var hasBreakBetween = false;
        for (var j = 0; j < scheduled.length; j++) {
          var item = scheduled[j];
          if (item.appt === curr || item.appt === next) continue;
          if (item.sortMin > currWrap.sortMin && item.sortMin < nextWrap.sortMin) {
            var itemT = parseProcedureTags(item.appt.PlanOfAction);
            // Non-taxing = old patient without AT, GONIO, HFA, LASER, OCT
            if (isOldPatient(item.appt) && !itemT.AT && !itemT.GONIO && !itemT.HFA && !itemT.LASER && !itemT.OCT) {
              hasBreakBetween = true;
              break;
            }
          }
        }
        if (!hasBreakBetween) {
          violations.push({
            rule: "GONIO_AT_CONSECUTIVE",
            severity: "warning",
            appointmentId: next.AppointmentID,
            patient: next.PatientName,
            time: fmtTime(next["Consult Start"] || next.TimeSlot),
            message: 'AT/Gonio consecutive: "' + curr.PatientName + '" (consult ' + fmtTime(curr["Consult Start"]) + ') and "' + next.PatientName + '" (consult ' + fmtTime(next["Consult Start"]) + ') — no non-taxing old patient between',
            suggestion: "Insert a non-taxing old patient between them"
          });
        }
      }
    }
  }

  // ---------- Sub-rule B: Daily cap ----------
  if (getRuleSetting("RULE_GONIO_AT_CAP", "ON") === "ON") {
    var maxCap = parseInt(getRuleSetting("GONIO_AT_MAX_PER_DAY", "3"), 10);
    var atGonioToday = 0;
    (appointments || []).forEach(function (a) {
      var t = parseProcedureTags(a.PlanOfAction);
      if (t.AT || t.GONIO) atGonioToday++;
    });
    if (atGonioToday > maxCap) {
      violations.push({
        rule: "GONIO_AT_DAILY_CAP",
        severity: "error",
        appointmentId: "",
        patient: "",
        message: atGonioToday + ' AT/Gonio appointments today — maximum ' + maxCap + ' allowed',
        suggestion: "Reduce AT/Gonio appointments to " + maxCap + " or fewer"
      });
    }
  }

  // ---------- Sub-rule C: GONIO timing ----------
  if (getRuleSetting("RULE_GONIO_TIMING", "ON") === "ON") {
    var gonioBestAfter = getRuleSetting("GONIO_EVENING_START", "14:30");
    var gonioBestMin  = timeToMin(gonioBestAfter);
    (appointments || []).forEach(function (appt) {
      var tags = parseProcedureTags(appt.PlanOfAction);
      if (!tags.GONIO) return;
      var flags = parseRemarksFlags(appt.Remarks);
      if (flags.isVIP || flags.isBNI || flags.isWheelchair || flags.isSVV) return; // Skip special
      var cs = appt["Consult Start"] || appt["ConsultStart"];
      if (!cs) return;
      var total = timeToMin(cs);
      if (total < 0) return;
      if (total < gonioBestMin) {
        violations.push({
          rule: "GONIO_MORNING",
          severity: "info",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          time: fmtTime(cs),
          message: 'GONIO for "' + appt.PatientName + '" at ' + fmtTime(cs) + ' — best scheduled after ' + gonioBestAfter,
          suggestion: "Consider moving to evening slot (after " + gonioBestAfter + ")"
        });
      }
    });
  }

  // ---------- Sub-rule D: AT timing ----------
  if (getRuleSetting("RULE_AT_TIMING", "ON") === "ON") {
    var atBestAfter = getRuleSetting("AT_EVENING_START", "14:30");
    var atBestMin   = timeToMin(atBestAfter);
    (appointments || []).forEach(function (appt) {
      var tags = parseProcedureTags(appt.PlanOfAction);
      if (!tags.AT) return;
      if (tags.GONIO) return; // Patient also has GONIO — GONIO timing rule covers it
      var flags = parseRemarksFlags(appt.Remarks);
      if (flags.isVIP || flags.isBNI || flags.isWheelchair || flags.isSVV) return;
      var cs = appt["Consult Start"] || appt["ConsultStart"];
      if (!cs) return;
      var total = timeToMin(cs);
      if (total < 0) return;
      if (total < atBestMin) {
        violations.push({
          rule: "AT_MORNING",
          severity: "info",
          appointmentId: appt.AppointmentID,
          patient: appt.PatientName,
          time: fmtTime(cs),
          message: 'AT for "' + appt.PatientName + '" at ' + fmtTime(cs) + ' — best scheduled after ' + atBestAfter,
          suggestion: "Consider moving to afternoon/evening slot (after " + atBestAfter + ")"
        });
      }
    });
  }

  return violations;
}

/** Rule 9: HFA slots reserved for HFA patients (until day before appointment) */
function checkHFASlotRule(appointments, dateStr) {
  if (getRuleSetting("RULE_HFA_SLOT", "ON") !== "ON") return [];
  var hfa1 = fmtTime(getRuleSetting("HFA_SLOT_1", "09:20"));
  var hfa2 = fmtTime(getRuleSetting("HFA_SLOT_2", "09:40"));

  var violations = [];
  var today = new Date();
  today.setHours(0,0,0,0);
  var apptDate = null;
  if (dateStr) {
    var p = String(dateStr).split('-');
    apptDate = new Date(parseInt(p[0],10), parseInt(p[1],10)-1, parseInt(p[2],10));
  }
  var daysDiff = apptDate ? Math.floor((apptDate - today) / 86400000) : 99;
  (appointments || []).forEach(function (appt) {
    if (!appt.TimeSlot) return;
    var time = String(appt.TimeSlot);
    var isHFASlot = (fmtTime(time) === hfa1 || fmtTime(time) === hfa2);
    var tags = parseProcedureTags(appt.PlanOfAction);
    if (isHFASlot && !tags.HFA) {
      violations.push({
        rule: "HFA_SLOT_NON_HFA",
        severity: "warning",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(time),
        message: 'Non-HFA patient "' + appt.PatientName + '" occupies HFA slot at ' + fmtTime(time),
        suggestion: "HFA slots (" + hfa1 + ", " + hfa2 + ") should be reserved for HFA patients"
      });
    } else if (!isHFASlot && tags.HFA && daysDiff > 1) {
      violations.push({
        rule: "HFA_IN_NON_HFA_SLOT",
        severity: "info",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(time),
        daysUntil: daysDiff,
        message: 'HFA patient "' + appt.PatientName + '" at ' + fmtTime(time) + ' (not ' + hfa1 + '/' + hfa2 + ' HFA slot, ' + daysDiff + ' days before)',
        suggestion: "Consider moving to " + hfa1 + " or " + hfa2 + " HFA slot if available"
      });
    }
  });
  return violations;
}

/** Rule 10: ROP on ROP_DAY only (default Wednesday) */
function checkROPDayRule(appointments, dayOfWeek) {
  if (getRuleSetting("RULE_ROP_DAY", "ON") !== "ON") return [];
  var ropDay = getRuleSetting("ROP_DAY", "WED");
  if (dayOfWeek === ropDay) return [];
  var violations = [];
  (appointments || []).forEach(function (appt) {
    var tags = parseProcedureTags(appt.PlanOfAction);
    if (tags.ROP) {
      violations.push({
        rule: "ROP_WRONG_DAY",
        severity: "error",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        message: 'ROP patient "' + appt.PatientName + '" on ' + dayOfWeek + ' (should be ' + ropDay + ')',
        suggestion: "Reschedule to " + ropDay
      });
    }
  });
  return violations;
}

/** Rule 11: Laser on LASER_DAYS only (default Tue,Fri, except SVV advised) */
function checkLaserDayRule(appointments, dayOfWeek) {
  if (getRuleSetting("RULE_LASER_DAY", "ON") !== "ON") return [];
  var laserDays = getRuleSetting("LASER_DAYS", "TUE,FRI").split(",").map(function(d) { return d.trim(); });
  if (laserDays.indexOf(dayOfWeek) !== -1) return [];
  var violations = [];
  (appointments || []).forEach(function (appt) {
    var tags = parseProcedureTags(appt.PlanOfAction);
    var flags = parseRemarksFlags(appt.Remarks);
    if (tags.LASER && !flags.isSVV) {
      violations.push({
        rule: "LASER_WRONG_DAY",
        severity: "error",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        message: 'Laser patient "' + appt.PatientName + '" on ' + dayOfWeek + ' (should be ' + getRuleSetting("LASER_DAYS", "TUE,FRI") + ' unless SVV advised)',
        suggestion: "Reschedule to " + getRuleSetting("LASER_DAYS", "TUE,FRI")
      });
    }
  });
  return violations;
}

/** Rule 12: Wheelchair → evening or early morning */
function checkWheelchairTiming(appointments) {
  if (getRuleSetting("RULE_WHEELCHAIR", "ON") !== "ON") return [];
  var morningEnd = getRuleSetting("WHEELCHAIR_MORNING_END", "10:00");
  var eveningStart = getRuleSetting("WHEELCHAIR_EVENING_START", "16:00");
  var morningEndHr = parseInt(morningEnd.split(':')[0], 10);
  var eveningStartHr = parseInt(eveningStart.split(':')[0], 10);

  var violations = [];
  (appointments || []).forEach(function (appt) {
    if (!appt.TimeSlot) return;
    var flags = parseRemarksFlags(appt.Remarks);
    if (!flags.isWheelchair) return;
    var hour = parseInt(String(appt.TimeSlot).split(':')[0], 10);
    if (isNaN(hour)) return;
    var isEarlyMorning = hour < morningEndHr;
    var isEvening = hour >= eveningStartHr;
    if (!isEarlyMorning && !isEvening) {
      violations.push({
        rule: "WHEELCHAIR_TIMING",
        severity: "info",
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: fmtTime(appt.TimeSlot),
        message: 'Wheelchair patient "' + appt.PatientName + '" at ' + fmtTime(appt.TimeSlot) + ' (mid-day)',
        suggestion: "Move to early morning (before " + morningEnd + ") or evening (after " + eveningStart + ")"
      });
    }
  });
  return violations;
}

/** Rule 13: Laser minimum duration check */
function checkProcedureDurationGaps(appointments) {
  if (getRuleSetting("RULE_LASER_DURATION", "ON") !== "ON") return [];
  var laserDuration = parseInt(getRuleSetting("LASER_DURATION", "20"), 10);
  var violations = [];
  var scheduled = (appointments || [])
    .filter(function (a) {
      return a["Consult Start"] && String(a["Consult Start"]).trim() !== "";
    })
    .map(function (a) {
      return {
        appt: a,
        consultMin: timeToMin(a["Consult Start"])
      };
    })
    .filter(function (x) { return x.consultMin >= 0; })
    .sort(function (a, b) { return a.consultMin - b.consultMin; });

  for (var i = 0; i < scheduled.length - 1; i++) {
    var curr = scheduled[i].appt;
    var next = scheduled[i + 1].appt;
    var currConsult = scheduled[i].consultMin;
    var nextConsult = scheduled[i + 1].consultMin;
    var tags = parseProcedureTags(curr.PlanOfAction);
    // Only check LASER (which requires 20 min)
    if (!tags.LASER) continue;
    var gap = nextConsult - currConsult;
    if (gap < 0) continue;
    if (gap < laserDuration) {
      violations.push({
        rule: "LASER_DURATION",
        severity: "warning",
        appointmentId: next.AppointmentID,
        patient: next.PatientName,
        time: fmtTime(curr["Consult Start"]) + " → " + fmtTime(next["Consult Start"]),
        message: 'Laser consultation "' + curr.PatientName + '" needs ' + laserDuration + ' min but only ' + gap + ' min before "' + next.PatientName + '"',
        suggestion: "Provide at least " + laserDuration + " minutes gap for laser procedures"
      });
    }
  }
  return violations;
}

/** Rule 15: Special case detection (informational) */
function detectSpecialCases(appointments) {
  var special = [];
  (appointments || []).forEach(function (appt) {
    var flags = parseRemarksFlags(appt.Remarks);
    var types = [];
    if (flags.isVIP) types.push("VIP");
    if (flags.isBNI) types.push("BNI");
    if (flags.isWheelchair) types.push("Wheelchair");
    if (flags.isSVV) types.push("SVV");
    if (types.length > 0) {
      special.push({
        appointmentId: appt.AppointmentID,
        patient: appt.PatientName,
        time: appt.TimeSlot || "",
        types: types
      });
    }
  });
  return special;
}


// ============================================================
// SECTION 3: MAIN ORCHESTRATOR
// ============================================================

/**
 * Validate all rules for a given day/doctor
 * @param {string} date - yyyy-MM-dd
 * @param {string} doctor - doctor name
 * @param {string} sessionToken
 * @returns {Object} {success, violations[], specialCases[], appointmentCount, dayOfWeek}
 */
function validateDayRules(date, doctor, sessionToken) {
  try {
    // Clear the rule settings cache so we get fresh values each run
    clearRuleSettingsCache();

    // Auth check
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired" };

    // Get appointments
    var appointments = getAppointmentsForDay(date, doctor);
    if (!appointments || appointments.length === 0) {
      return {
        success: true,
        violations: [],
        specialCases: [],
        appointmentCount: 0,
        dayOfWeek: getDayOfWeek(date),
        date: date,
        doctor: doctor
      };
    }

    var violations = [];
    var dayOfWeek = getDayOfWeek(date);

    // Run all rule checks
    violations = violations.concat(checkNewPatientTiming(appointments));
    violations = violations.concat(checkSameFamilyTiming(appointments));
    violations = violations.concat(checkFamilySizeMorning(appointments));
    violations = violations.concat(checkNewOldAlternation(appointments));
    violations = violations.concat(checkNewPatientAfter4PM(appointments));
    violations = violations.concat(checkConsultationWindows(appointments));
    violations = violations.concat(checkSameFamilyContinuous(appointments));
    violations = violations.concat(checkGonioATConsecutive(appointments));
    violations = violations.concat(checkHFASlotRule(appointments, date));
    violations = violations.concat(checkROPDayRule(appointments, dayOfWeek));
    violations = violations.concat(checkLaserDayRule(appointments, dayOfWeek));
    violations = violations.concat(checkWheelchairTiming(appointments));
    violations = violations.concat(checkProcedureDurationGaps(appointments));

    // Special case detection (informational, not a violation)
    var specialCases = detectSpecialCases(appointments);

    // Sort violations by severity
    var severityOrder = { error: 0, warning: 1, info: 2 };
    violations.sort(function (a, b) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    // Audit log
    try {
      logAuditEvent(
        sessionToken,
        'RULE_CHECK',
        'SCHEDULE',
        date,
        { sheetName: 'N/A', date: date, doctor: doctor, violationCount: violations.length, dayOfWeek: dayOfWeek }
      );
    } catch (e) {
      // Audit failure should not break the response
    }

    return {
      success: true,
      violations: violations,
      specialCases: specialCases,
      appointmentCount: appointments.length,
      dayOfWeek: dayOfWeek,
      date: date,
      doctor: doctor
    };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}


// ============================================================
// SECTION 4: LLM INTEGRATION (Gemini API)
// ============================================================

/**
 * Format violations as a human-readable summary using Gemini API
 * Falls back to plain text if API fails or key is missing
 * @param {Array} violations
 * @param {string} date - yyyy-MM-dd
 * @param {string} dayOfWeek
 * @param {string} sessionToken
 * @returns {Object} {success, summary}
 */
function formatViolationsWithLLM(violations, date, dayOfWeek, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired" };

    if (!violations || violations.length === 0) {
      return { success: true, summary: "" };
    }

    var llmConfig = getActiveLLMConfig();
    var apiKey = llmConfig.apiKey || '';
    if (!apiKey) {
      try {
        apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
      } catch (e) {}
    }
    var model = llmConfig.modelId || 'gemini-2.5-flash';

    if (!apiKey) {
      return { success: true, summary: fallbackSummary_(violations), isLLM: false };
    }

    var prompt = buildLLMPrompt_(violations, date, dayOfWeek);
    var payload = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 800,
        topP: 0.8,
        topK: 40
      }
    };

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    // Try v1 first (newer models like gemini-2.5-flash), fall back to v1beta
    var urls = [
      'https://generativelanguage.googleapis.com/v1/models/' + model + ':generateContent?key=' + apiKey,
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey
    ];

    var result = null;
    var lastError = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var response = UrlFetchApp.fetch(urls[i], options);
        result = JSON.parse(response.getContentText());
        if (result.candidates && result.candidates[0] && result.candidates[0].content) {
          var summary = result.candidates[0].content.parts[0].text;
          try {
            logAuditEvent(
              sessionToken,
              'API_LLM_CALL',
              'SCHEDULE',
              date,
              { sheetName: 'N/A', date: date, model: model, purpose: 'Rules summary for ' + date }
            );
          } catch (e) {}
          return { success: true, summary: summary, isLLM: true };
        } else if (result.error) {
          lastError = result.error.message;
          Logger.log('Gemini API attempt ' + (i+1) + ' error: ' + result.error.message);
        }
      } catch (e) {
        lastError = e.message;
        Logger.log('Gemini API attempt ' + (i+1) + ' failed: ' + e.message);
      }
    }

    // All attempts failed
    Logger.log('All Gemini API attempts failed. Last error: ' + lastError);
    return { success: true, summary: fallbackSummary_(violations), isLLM: false };
  } catch (e) {
    Logger.log('LLM call failed: ' + e.message);
    return { success: true, summary: fallbackSummary_(violations), isLLM: false };
  }
}

/**
 * Build the prompt for Gemini
 * @private
 */
function buildLLMPrompt_(violations, date, dayOfWeek) {
  var grouped = {
    error: violations.filter(function (v) { return v.severity === 'error'; }),
    warning: violations.filter(function (v) { return v.severity === 'warning'; }),
    info: violations.filter(function (v) { return v.severity === 'info'; })
  };

  var prompt = 'Date: ' + date + ' (' + dayOfWeek + ')\n\n';
  prompt += 'Found ' + violations.length + ' scheduling rule violations for this day. ';
  prompt += 'Format these into a concise "Notes & Observations" section for a printed appointment list.\n\n';

  function appendGroup(label, items) {
    if (items.length === 0) return;
    prompt += label + ' (' + items.length + '):\n';
    items.slice(0, 20).forEach(function (v, i) {
      prompt += (i + 1) + '. ' + v.message + '\n';
    });
    if (items.length > 20) {
      prompt += '... and ' + (items.length - 20) + ' more\n';
    }
    prompt += '\n';
  }

  appendGroup('ERRORS (must fix)', grouped.error);
  appendGroup('WARNINGS (should review)', grouped.warning);
  appendGroup('INFO (notable observations)', grouped.info);

  prompt += 'Format requirements:\n';
  prompt += '- Start with a one-line summary (e.g., "X errors, Y warnings, Z observations")\n';
  prompt += '- Group by severity (Errors → Warnings → Info)\n';
  prompt += '- Use clear bullet points with patient name, time, and issue\n';
  prompt += '- Keep it professional and concise for a clinical printout\n';
  prompt += '- Do NOT include rule codes or technical labels\n';
  prompt += '- Use plain English that staff can quickly scan';
  return prompt;
}

/**
 * Fallback plain-text summary if LLM fails
 * @private
 */
function fallbackSummary_(violations) {
  if (!violations || violations.length === 0) return "";
  var lines = [];
  lines.push('Scheduling Notes (' + violations.length + ' items):');
  lines.push('');
  var grouped = {
    error: violations.filter(function (v) { return v.severity === 'error'; }),
    warning: violations.filter(function (v) { return v.severity === 'warning'; }),
    info: violations.filter(function (v) { return v.severity === 'info'; })
  };
  function addGroup(label, items, icon) {
    if (items.length === 0) return;
    lines.push(label + ':');
    items.forEach(function (v) {
      lines.push('  ' + icon + ' ' + v.message);
    });
    lines.push('');
  }
  addGroup('Errors', grouped.error, '[!]');
  addGroup('Warnings', grouped.warning, '[*]');
  addGroup('Info', grouped.info, '[i]');
  return lines.join('\n');
}


// ============================================================
// SECTION 5: SETUP FUNCTIONS
// ============================================================

/**
 * Setup Gemini API key (run once manually)
 */
function setupGeminiApiKey() {
  var apiKey = '***REDACTED-GEMINI-KEY***';
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', apiKey);
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-2.5-flash');
  Logger.log('Gemini API key configured in ScriptProperties. Model: gemini-2.5-flash');
  Logger.log('Note: API keys are now managed via Settings page > System Configuration > API Configuration.');
  Logger.log('  Values saved in the settings page will override ScriptProperties.');
}

/**
 * Test Gemini API connection
 */
function testGeminiConnection() {
  var llmConfig = getActiveLLMConfig();
  var apiKey = llmConfig.apiKey || '';
  if (!apiKey) {
    try {
      apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    } catch (e) {}
  }
  if (!apiKey) {
    Logger.log('ERROR: API key not found. Set it via Settings page > API Configuration or run setupGeminiApiKey() first.');
    return;
  }
  var url = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: [{ text: "Say 'Connection successful' in 3 words." }] }]
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());
    if (result.candidates && result.candidates[0]) {
      Logger.log('SUCCESS: ' + result.candidates[0].content.parts[0].text);
    } else if (result.error) {
      Logger.log('API ERROR: ' + result.error.message);
    }
  } catch (e) {
    Logger.log('EXCEPTION: ' + e.message);
  }
}
