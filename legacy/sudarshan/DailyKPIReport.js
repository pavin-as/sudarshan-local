/**
 * Daily KPI Report Automation for Sampada VR Eye Care
 * This script runs daily to capture a snapshot of system metrics and appends them to "DailyKPIReport".
 */

/**
 * Ensures the "DailyKPIReport" sheet exists with the correct columns and headers.
 * Renders headers in Row 1, frozen, blue background (#4a90e2), white bold text.
 * @return {Sheet} The DailyKPIReport sheet object.
 */
function initializeDailyKPIReportSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("DailyKPIReport");
  if (!sheet) {
    sheet = ss.insertSheet("DailyKPIReport");
  }

  const headers = [
    "Timestamp",
    "Date",
    "Total Pending Cancel Patients",
    "Oldest Booking Date in Cancel",
    "Cancel to Appointment Today",
    "Followups Next 7 Days",
    "Followup to Appointment Today",
    "Pending Action (Triage)",
    "Direct Call to Appointment Today",
    "Direct Call to Cancel Today",
    "Direct Call to Archive Today",
    "Direct Bookings Today",
    "Reschedules Today",
    "4-Day Confirm Pending (3 days out)",
    "1-Day Confirm Pending (tomorrow)",
    "Total New Appointments Today",
    "Source: bookappointment.html",
    "Source: directCall",
    "Source: cancel",
    "Source: followup",
    "Duplicate MRD Count (Appointment)"
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Format the header row
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight("bold");
  headerRange.setBackground("#4a90e2");
  headerRange.setFontColor("#ffffff");
  headerRange.setFontSize(11);
  headerRange.setHorizontalAlignment("center");
  
  sheet.setFrozenRows(1);
  
  return sheet;
}

/**
 * Core function that computes all required snapshot metrics for a given date
 * and appends a summary row to the "DailyKPIReport" sheet.
 * @param {string} [optDateStr] Optional target date in YYYY-MM-DD format (defaults to current date).
 * @return {Object} Result summary.
 */
function captureDailyKPIReport(optDateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = Session.getScriptTimeZone();
    
    // 1. Determine target date and parse it
    const now = new Date();
    const targetDateStr = (typeof optDateStr === 'string') ? optDateStr : Utilities.formatDate(now, tz, "yyyy-MM-dd");
    
    const dateParts = targetDateStr.split('-');
    const targetDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    targetDate.setHours(0, 0, 0, 0);

    // Initialize/Ensure KPI sheet exists
    const kpiSheet = initializeDailyKPIReportSheet();

    // ==========================================
    // METRIC 1 & 2: Cancel Sheet Metrics
    // ==========================================
    let totalPendingCancel = 0;
    let oldestBookingDateCancel = "-";

    // Deduplicate the cancel sheet by deleting older duplicate MRD entries
    try {
      removeDuplicateCancelledAppointments();
    } catch (dedupError) {
      Logger.log("Error during cancel sheet deduplication: " + dedupError.toString());
    }

    const cancelSheet = ss.getSheetByName("cancel");
    
    if (cancelSheet) {
      const cancelValues = cancelSheet.getDataRange().getValues();
      if (cancelValues.length > 1) {
        totalPendingCancel = cancelValues.length - 1;
        let minDate = null;
        // Column N (index 13) is BookingDate in cancel sheet
        for (let i = 1; i < cancelValues.length; i++) {
          const bookDateVal = cancelValues[i][13];
          if (bookDateVal) {
            const d = new Date(bookDateVal);
            if (!isNaN(d.getTime())) {
              if (!minDate || d < minDate) {
                minDate = d;
              }
            }
          }
        }
        if (minDate) {
          oldestBookingDateCancel = Utilities.formatDate(minDate, tz, "yyyy-MM-dd");
        }
      }
    }

    // ==========================================
    // METRIC 6: Followups in Next 7 Days
    // ==========================================
    let followupsNext7Days = 0;
    const followupSheet = ss.getSheetByName("followup");
    
    if (followupSheet) {
      const followupValues = followupSheet.getDataRange().getValues();
      if (followupValues.length > 1) {
        const headers = followupValues[0];
        const followUpDateIdx = headers.indexOf("follow_up_date");
        
        if (followUpDateIdx !== -1) {
          // Window: [targetDate + 1, targetDate + 7]
          const rangeStart = new Date(targetDate);
          rangeStart.setDate(targetDate.getDate() + 1);
          rangeStart.setHours(0, 0, 0, 0);
          
          const rangeEnd = new Date(targetDate);
          rangeEnd.setDate(targetDate.getDate() + 7);
          rangeEnd.setHours(23, 59, 59, 999);
          
          for (let i = 1; i < followupValues.length; i++) {
            const dateVal = followupValues[i][followUpDateIdx];
            if (dateVal) {
              const d = new Date(dateVal);
              if (!isNaN(d.getTime())) {
                d.setHours(12, 0, 0, 0); // Avoid timezone shift bugs
                if (d >= rangeStart && d <= rangeEnd) {
                  followupsNext7Days++;
                }
              }
            }
          }
        }
      }
    }

    // ==========================================
    // METRIC 8: Pending Action (Triage / urgencyIdentification)
    // ==========================================
    let triagePendingCount = 0;
    const triageSheet = ss.getSheetByName("urgencyIdentification");
    
    if (triageSheet) {
      const triageValues = triageSheet.getDataRange().getValues();
      if (triageValues.length > 1) {
        const headers = triageValues[0];
        const statusIdx = headers.indexOf("DecisionStatus");
        
        if (statusIdx !== -1) {
          for (let i = 1; i < triageValues.length; i++) {
            const statusVal = triageValues[i][statusIdx];
            // By default, blank/empty is treated as "Pending Action"
            if (!statusVal || statusVal.toString().trim() === "" || statusVal.toString().trim() === "Pending Action") {
              triagePendingCount++;
            }
          }
        }
      }
    }

    // ==========================================
    // METRIC 14 & 15: Confirmation Pending Metrics
    // ==========================================
    let fourDayConfirmPending = 0;
    let oneDayConfirmPending = 0;
    let duplicateMrdApptCount = 0;
    const appointmentSheet = ss.getSheetByName("appointment");
    
    if (appointmentSheet) {
      const apptValues = appointmentSheet.getDataRange().getValues();
      if (apptValues.length > 1) {
        const headers = apptValues[0];
        const apptDateIdx = headers.indexOf("AppointmentDate");
        const typeIdx = headers.indexOf("AppointmentType");
        const confirm4Idx = headers.indexOf("FourDayConfirmDate");
        const confirm1Idx = headers.indexOf("OneDayConfirmDate");
        const mrdIdx = headers.indexOf("MRDNo");
        
        // Count duplicate MRDs in appointment sheet
        const mrdColumnIndex = mrdIdx !== -1 ? mrdIdx : 3;
        const mrdCounts = {};
        for (let i = 1; i < apptValues.length; i++) {
          const mrdVal = apptValues[i][mrdColumnIndex] ? apptValues[i][mrdColumnIndex].toString().trim().toUpperCase() : "";
          if (mrdVal && mrdVal !== "") {
            mrdCounts[mrdVal] = (mrdCounts[mrdVal] || 0) + 1;
          }
        }
        for (const mrd in mrdCounts) {
          if (mrdCounts[mrd] > 1) {
            duplicateMrdApptCount++;
          }
        }
        
        // Calculate 4-day confirmation target (T + 3, shift to Monday if Sunday)
        const date4DayTarget = new Date(targetDate);
        date4DayTarget.setDate(targetDate.getDate() + 3);
        date4DayTarget.setHours(0, 0, 0, 0);
        if (date4DayTarget.getDay() === 0) {
          date4DayTarget.setDate(date4DayTarget.getDate() + 1); // Sunday -> Monday
        }
        const date4DayTargetTime = date4DayTarget.getTime();

        // Calculate 1-day confirmation target (T + 1, shift to Monday if Sunday)
        const date1DayTarget = new Date(targetDate);
        date1DayTarget.setDate(targetDate.getDate() + 1);
        date1DayTarget.setHours(0, 0, 0, 0);
        if (date1DayTarget.getDay() === 0) {
          date1DayTarget.setDate(date1DayTarget.getDate() + 1); // Sunday -> Monday
        }
        const date1DayTargetTime = date1DayTarget.getTime();
        
        for (let i = 1; i < apptValues.length; i++) {
          const row = apptValues[i];
          const apptDateVal = row[apptDateIdx];
          
          if (apptDateVal) {
            const d = new Date(apptDateVal);
            d.setHours(0, 0, 0, 0);
            const apptDateTime = d.getTime();
            const apptType = row[typeIdx] ? row[typeIdx].toString().trim().toUpperCase() : "";
            
            // Skip waiting list appointments
            if (apptType !== "WAITING LIST") {
              // Check 4-Day Confirmation
              if (apptDateTime === date4DayTargetTime) {
                const confirm4Val = row[confirm4Idx];
                if (!confirm4Val || confirm4Val.toString().trim() === "") {
                  fourDayConfirmPending++;
                }
              }
              
              // Check 1-Day Confirmation
              if (apptDateTime === date1DayTargetTime) {
                const confirm1Val = row[confirm1Idx];
                if (!confirm1Val || confirm1Val.toString().trim() === "") {
                  oneDayConfirmPending++;
                }
              }
            }
          }
        }
      }
    }

    // ==========================================
    // METRICS 5, 7, 9, 10, 11, 12, 13: Audit Log Event Metrics
    // ==========================================
    let cancelToAppointment = 0; // RESTORE_CANCELLED_APPOINTMENT
    let followupToAppointment = 0; // BOOK_APPOINTMENT_FROM_FOLLOWUP
    let directCallToAppointment = 0; // BOOK_APPOINTMENT_FROM_DIRECT_CALL
    let directCallToCancel = 0; // CANCEL_DIRECT_CALL
    let directCallToArchive = 0; // ARCHIVE_DIRECT_CALL
    let directBookings = 0; // BOOK_APPOINTMENT (bookappointment.html)
    let reschedulesToday = 0; // RESCHEDULE_APPOINTMENT (active only)
    
    const auditSheet = ss.getSheetByName("AuditLog");
    if (auditSheet) {
      const auditValues = auditSheet.getDataRange().getValues();
      if (auditValues.length > 1) {
        for (let i = 1; i < auditValues.length; i++) {
          const timestampVal = auditValues[i][0]; // Column A
          if (timestampVal) {
            const logDate = new Date(timestampVal);
            if (!isNaN(logDate.getTime())) {
              const logDateStr = Utilities.formatDate(logDate, tz, "yyyy-MM-dd");
              
              // Match target snapshot date
              if (logDateStr === targetDateStr) {
                const actionType = auditValues[i][4]; // Column E - ActionType
                
                switch (actionType) {
                  case "RESTORE_CANCELLED_APPOINTMENT":
                    cancelToAppointment++;
                    break;
                  case "BOOK_APPOINTMENT_FROM_FOLLOWUP":
                    followupToAppointment++;
                    break;
                  case "BOOK_APPOINTMENT_FROM_DIRECT_CALL":
                    directCallToAppointment++;
                    break;
                  case "CANCEL_DIRECT_CALL":
                    directCallToCancel++;
                    break;
                  case "ARCHIVE_DIRECT_CALL":
                    directCallToArchive++;
                    break;
                  case "BOOK_APPOINTMENT":
                    directBookings++;
                    break;
                  case "RESCHEDULE_APPOINTMENT":
                    reschedulesToday++;
                    break;
                }
              }
            }
          }
        }
      }
    }

    // ==========================================
    // METRICS 16, 17, 18, 19, 20: New Appointments & Sources
    // ==========================================
    // Total new appointments added today in the appointment sheet is the sum of:
    // Direct book + Direct Call to Appointment + Restored Cancel to Appointment + Followup to Appointment
    const totalNewAppointments = directBookings + directCallToAppointment + cancelToAppointment + followupToAppointment;

    // ==========================================
    // 3. Assemble and Append the Log Row
    // ==========================================
    const kpiRow = [
      Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm:ss"), // Timestamp (generation time)
      targetDateStr, // Date of target snapshot
      totalPendingCancel,
      oldestBookingDateCancel,
      cancelToAppointment,
      followupsNext7Days,
      followupToAppointment,
      triagePendingCount,
      directCallToAppointment,
      directCallToCancel,
      directCallToArchive,
      directBookings,
      reschedulesToday,
      fourDayConfirmPending,
      oneDayConfirmPending,
      totalNewAppointments,
      directBookings, // Source: bookappointment.html
      directCallToAppointment, // Source: directCall
      cancelToAppointment, // Source: cancel
      followupToAppointment, // Source: followup
      duplicateMrdApptCount // Duplicate MRD Count (Appointment)
    ];

    // Check if a row for this date already exists to prevent duplication on manual rerun
    const kpiValues = kpiSheet.getDataRange().getValues();
    let existingRowIdx = -1;
    for (let i = 1; i < kpiValues.length; i++) {
      const existingDateStr = kpiValues[i][1] ? Utilities.formatDate(new Date(kpiValues[i][1]), tz, "yyyy-MM-dd") : "";
      if (existingDateStr === targetDateStr) {
        existingRowIdx = i + 1; // 1-indexed row number
        break;
      }
    }

    if (existingRowIdx !== -1) {
      // Overwrite existing row
      kpiSheet.getRange(existingRowIdx, 1, 1, kpiRow.length).setValues([kpiRow]);
    } else {
      // Append new row
      kpiSheet.appendRow(kpiRow);
    }

    // Format new row cells to center align
    const lastRow = existingRowIdx !== -1 ? existingRowIdx : kpiSheet.getLastRow();
    kpiSheet.getRange(lastRow, 1, 1, kpiRow.length).setHorizontalAlignment("center");
    
    // Auto-fit columns
    for (let i = 1; i <= kpiRow.length; i++) {
      kpiSheet.autoResizeColumn(i);
    }

    return {
      success: true,
      message: "Daily KPI Report captured successfully for date: " + targetDateStr,
      data: kpiRow
    };
  } catch (error) {
    Logger.log("Error in captureDailyKPIReport: " + error.toString());
    return {
      success: false,
      message: "Failed to capture Daily KPI Report: " + error.toString()
    };
  }
}

/**
 * Creates/re-creates the time-driven trigger to run captureDailyKPIReport.
 * Configured to run every day between 11 PM and 12 AM.
 * @return {Object} Status message object.
 */
function setupDailyKPIReportTrigger() {
  try {
    // Delete existing triggers for this function to avoid duplicate runs
    const triggers = ScriptApp.getProjectTriggers();
    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === "captureDailyKPIReport") {
        ScriptApp.deleteTrigger(trigger);
      }
    }

    // Create a new trigger executing daily between 11 PM and 12 AM
    ScriptApp.newTrigger("captureDailyKPIReport")
      .timeBased()
      .atHour(23)
      .everyDays(1)
      .create();

    return {
      success: true,
      message: "Daily KPI trigger created successfully. Runs daily between 11 PM and 12 AM."
    };
  } catch (e) {
    return {
      success: false,
      message: "Error setting up Daily KPI trigger: " + e.toString()
    };
  }
}

/**
 * Removes the daily trigger for captureDailyKPIReport.
 * @return {Object} Status message object.
 */
function removeDailyKPIReportTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;
    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === "captureDailyKPIReport") {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }
    return {
      success: true,
      message: "Successfully removed " + deletedCount + " trigger(s) for captureDailyKPIReport."
    };
  } catch (e) {
    return {
      success: false,
      message: "Error removing trigger: " + e.toString()
    };
  }
}

/**
 * Helper execution function to initialize and trigger manually from the editor.
 */
function manualRunDailyKPIReport() {
  const init = initializeDailyKPIReportSheet();
  const capture = captureDailyKPIReport();
  Logger.log(JSON.stringify(capture));
  return capture;
}

/**
 * Scans the "cancel" sheet for duplicate MRD numbers (Column D)
 * and deletes the older entries (based on Column B - AppointmentDate).
 * If dates are equal, deletes the one with a lower row index.
 * @return {number} Count of deleted duplicate rows.
 */
function removeDuplicateCancelledAppointments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cancelSheet = ss.getSheetByName("cancel");
  if (!cancelSheet) return 0;

  const data = cancelSheet.getDataRange().getValues();
  if (data.length <= 2) return 0; // Header + 0 or 1 row

  const headers = data[0];
  const mrdIdx = headers.indexOf("MRDNo");
  const dateIdx = headers.indexOf("AppointmentDate");

  // Fallback indices if header names differ
  const mrdColumnIndex = mrdIdx !== -1 ? mrdIdx : 3; // Col D
  const dateColumnIndex = dateIdx !== -1 ? dateIdx : 1; // Col B

  // Map to group row indices and appointment dates by normalized MRDNo
  const mrdMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const mrd = row[mrdColumnIndex] ? row[mrdColumnIndex].toString().trim().toUpperCase() : "";
    if (mrd) {
      if (!mrdMap[mrd]) {
        mrdMap[mrd] = [];
      }
      
      let apptDate = null;
      if (row[dateColumnIndex]) {
        apptDate = new Date(row[dateColumnIndex]);
      }
      
      mrdMap[mrd].push({
        rowIndex: i + 1, // 1-based row number
        apptDateTime: apptDate && !isNaN(apptDate.getTime()) ? apptDate.getTime() : 0
      });
    }
  }

  const rowsToDelete = [];

  for (const mrd in mrdMap) {
    const group = mrdMap[mrd];
    if (group.length > 1) {
      // Sort descending by apptDateTime, then descending by rowIndex (so we keep the newest date/latest created)
      group.sort((a, b) => {
        if (b.apptDateTime !== a.apptDateTime) {
          return b.apptDateTime - a.apptDateTime;
        }
        return b.rowIndex - a.rowIndex;
      });

      // Keep the first item (newest) and mark the rest for deletion
      for (let k = 1; k < group.length; k++) {
        rowsToDelete.push(group[k].rowIndex);
      }
    }
  }

  if (rowsToDelete.length > 0) {
    // Sort in descending order to delete from bottom up (prevent row index shifting issues)
    rowsToDelete.sort((a, b) => b - a);
    for (const rowIndex of rowsToDelete) {
      cancelSheet.deleteRow(rowIndex);
    }
  }

  return rowsToDelete.length;
}
