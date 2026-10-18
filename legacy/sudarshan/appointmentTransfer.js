// appointmentTransfer.js
// Script to transfer appointment data to another spreadsheet

/**
 * Helper to normalize a doctor name from Column J and derive the sheet suffix.
 * - Strips leading "Dr"/"Dr." (case-insensitive)
 * - Takes the first token of the remaining name
 * - Uses the full first-name alphabetic token, TitleCased (e.g., "Sameera" -> "Sameera")
 * - Falls back to "Unk" if nothing valid is found
 */
function getDoctorSheetSuffix_(rawDoctor) {
  if (!rawDoctor) {
    return "Unk";
  }

  let name = rawDoctor.toString().trim();
  if (!name) {
    return "Unk";
  }

  // Remove leading "Dr" or "Dr." (any case) and following spaces
  name = name.replace(/^(dr\.?\s+)/i, "").trim();
  if (!name) {
    return "Unk";
  }

  // Take the first token (first name / first word)
  var firstToken = name.split(/\s+/)[0];
  if (!firstToken) {
    return "Unk";
  }

  // Keep only alphabetic characters
  var lettersOnly = firstToken.replace(/[^A-Za-z]/g, "");
  if (!lettersOnly) {
    return "Unk";
  }

  var suffix = lettersOnly;
  suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase();
  return suffix;
}

/**
 * Transfers appointment data from the current spreadsheet to the target spreadsheet.
 * Only transfers data for the current date.
 */
function transferAppointmentData() {
  try {
    // Get current date in format that matches the appointment sheet
    const today = new Date();
    const formattedDate = Utilities.formatDate(
      today,
      "Asia/Kolkata",
      "dd/MM/yyyy",
    );

    // Source spreadsheet (current spreadsheet)
    const sourceSpreadsheet = SpreadsheetApp.getActive();
    const appointmentSheet = sourceSpreadsheet.getSheetByName("appointment");

    if (!appointmentSheet) {
      return;
    }

    // Get all data from appointment sheet
    const appointmentData = appointmentSheet.getDataRange().getValues();

    // Determine which column has the date (assuming it's column B, index 1)
    const dateColumnIndex = 1;

    // Find column indices for required data
    const mrdColumnIndex = 3; // Column D
    const nameColumnIndex = 4; // Column E
    const apptTimeColumnIndex = 2; // Column C
    const ageColumnIndex = 5; // Column F
    const mobileColumnIndex = 7; // Column H
    const planColumnIndex = 10; // Column K
    const remarksColumnIndex = 11; // Column L
    const doctorColumnIndex = 9; // Column J
    const familyIdColumnIndex = 28; // Column AC

    // Filter data for today's date
    const todayAppointments = appointmentData.filter((row, index) => {
      // Skip header row
      if (index === 0) return false;

      // Check if date matches today
      const rowDate = row[dateColumnIndex];
      let formattedRowDate = "";

      if (rowDate instanceof Date) {
        formattedRowDate = Utilities.formatDate(
          rowDate,
          "Asia/Kolkata",
          "dd/MM/yyyy",
        );
      } else if (typeof rowDate === "string") {
        formattedRowDate = rowDate;
      }

      return formattedRowDate === formattedDate;
    });

    if (todayAppointments.length === 0) {
      return;
    }

    // --- Key Fix: Handle TimeSlot Format Variations ---
    const timeToMinutes = (timeValue) => {
      if (!timeValue) return 0; // Empty/undefined

      let timeStr;
      // Case 1: Already a string (e.g., "9:00 AM")
      if (typeof timeValue === "string") {
        timeStr = timeValue.trim();
      }
      // Case 2: Date object (e.g., column contains datetime)
      else if (timeValue instanceof Date) {
        timeStr = Utilities.formatDate(timeValue, "Asia/Kolkata", "h:mm a");
      }
      // Case 3: Excel-style serial number (e.g., 0.375 for 9:00 AM)
      else if (typeof timeValue === "number") {
        const date = new Date(Math.round((timeValue - 25569) * 86400 * 1000)); // Convert Excel serial to JS Date
        timeStr = Utilities.formatDate(date, "Asia/Kolkata", "h:mm a");
      } else {
        return 0; // Unsupported type
      }

      // Parse the time string (e.g., "9:00 AM")
      const timeParts = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!timeParts) return 0;

      let hours = parseInt(timeParts[1]);
      const minutes = parseInt(timeParts[2]);
      const period = timeParts[3].toUpperCase();

      if (period === "PM" && hours < 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;

      return hours * 60 + minutes;
    };

    // Target spreadsheet
    const targetSpreadsheetId = "1WqagoClnvijcv4gd5fO3c1eeARGSZ4bACdfg5FhFNY8";
    let targetSpreadsheet;

    try {
      targetSpreadsheet = SpreadsheetApp.openById(targetSpreadsheetId);
    } catch (e) {
      return;
    }

    if (!targetSpreadsheet) {
      return;
    }

    // Group today's appointments by doctor sheet name (list_ABC)
    var doctorBuckets = {};

    todayAppointments.forEach(function (row) {
      var doctorRaw = row[doctorColumnIndex];
      if (!doctorRaw) {
        return; // Skip rows without doctor
      }
      var suffix = getDoctorSheetSuffix_(doctorRaw);
      if (!suffix) {
        return;
      }
      var sheetName = "list_" + suffix;
      if (!doctorBuckets[sheetName]) {
        doctorBuckets[sheetName] = [];
      }
      doctorBuckets[sheetName].push(row);
    });

    // Helper to map a source row into target row structure
    var mapRowToTarget = function (row) {
      return [
        row[mrdColumnIndex], // A: MRD
        "", // B: (empty)
        row[nameColumnIndex], // C: Name
        row[ageColumnIndex], // D: Age
        row[apptTimeColumnIndex], // E: TimeSlot (raw value)
        "", // F: (empty)
        "", // G: (empty)
        "", // H: (empty)
        row[remarksColumnIndex], // I: Remarks
        "", // J: (empty)
        row[0], // K: AppointmentID
        row[mobileColumnIndex], // L: Mobile
        row[planColumnIndex], // M: Plan of action
        "", // N: (empty)
        "", // O: (empty)
        "", // P: (empty)
        "", // Q: (empty)
        "", // R: (empty)
        "", // S: (empty)
        row[familyIdColumnIndex], // T: FamilyID
      ];
    };

    // Process each doctor bucket and write to its own sheet
    Object.keys(doctorBuckets).forEach(function (sheetName) {
      var rowsForDoctor = doctorBuckets[sheetName];
      if (!rowsForDoctor || rowsForDoctor.length === 0) {
        return;
      }

      // Get or create target sheet
      var targetSheet = targetSpreadsheet.getSheetByName(sheetName);
      if (!targetSheet) {
        targetSheet = targetSpreadsheet.insertSheet(sheetName);
        // Create header row
        targetSheet.getRange(1, 1, 1, 20).setValues([
          [
            "MRD", // A
            "", // B
            "Name", // C
            "Age", // D
            "Time", // E
            "", // F
            "", // G
            "", // H
            "Remarks", // I
            "", // J
            "AppointmentID", // K
            "Mobile", // L
            "Plan", // M
            "", // N
            "", // O
            "", // P
            "", // Q
            "", // R
            "", // S
            "FamilyID", // T
          ],
        ]);
      }

      // Clear existing data from row 2 down (keep header)
      var lastRow = Math.max(1, targetSheet.getLastRow());
      if (lastRow > 1) {
        targetSheet
          .getRange(2, 1, lastRow - 1, targetSheet.getLastColumn())
          .clearContent();
      }

      // Map and sort data by time
      var targetData = rowsForDoctor.map(mapRowToTarget);
      targetData.sort(function (a, b) {
        return timeToMinutes(a[4]) - timeToMinutes(b[4]);
      });

      // Write data starting at row 2
      var startRow = 2;
      targetSheet
        .getRange(startRow, 1, targetData.length, targetData[0].length)
        .setValues(targetData);

      // Apply time format to Column E (Time Slot)
      var timeRange = targetSheet.getRange(startRow, 5, targetData.length, 1); // Column E
      timeRange.setNumberFormat("HH:mm"); // Force "09:00" format
    });
  } catch (error) {}
}

/**
 * Creates a time-based trigger to run the transfer function at 6 AM daily.
 * This function needs to be run manually once to set up the trigger.
 */
function createDailyTrigger() {
  // Delete any existing triggers with the same function name
  const existingTriggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existingTriggers.length; i++) {
    if (
      existingTriggers[i].getHandlerFunction() === "transferAppointmentData"
    ) {
      ScriptApp.deleteTrigger(existingTriggers[i]);
    }
  }

  // Create a new trigger to run at 6 AM daily
  ScriptApp.newTrigger("transferAppointmentData")
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();
}

/**
 * Manual function to run the transfer immediately for testing.
 */
function manualRun() {
  transferAppointmentData();
}
