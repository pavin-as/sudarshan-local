// Helper: get number inside an "SPDxxxx" string
function extractNumeric(id) {
  const text = id ? id.toString() : "";
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

// Helper: safely format date without throwing native Java IllegalArgumentException on invalid dates
function safeFormatDate(val, timeZone, formatStr) {
  if (!val) return "";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    try {
      return Utilities.formatDate(val, timeZone, formatStr);
    } catch (e) {
      return "";
    }
  }
  const strVal = val.toString().trim();
  if (!strVal) return "";
  const d = new Date(strVal);
  if (isNaN(d.getTime())) return "";
  try {
    return Utilities.formatDate(d, timeZone, formatStr);
  } catch (e) {
    return "";
  }
}

function syncPatientData() {
  Logger.log("==========================================");
  Logger.log("[STEP 1] Starting syncPatientData execution...");
  
  try {
    Logger.log("[STEP 2] Getting active spreadsheet...");
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    Logger.log("[STEP 3] Fetching sheets 'yaragoPatientMaster' and 'patientMaster'...");
    const sourceSheet = ss.getSheetByName("yaragoPatientMaster");
    const targetSheet = ss.getSheetByName("patientMaster");

    if (!sourceSheet) {
      Logger.log("[STEP 3 ERROR] Source sheet 'yaragoPatientMaster' not found.");
      return { success: false, error: "Source sheet 'yaragoPatientMaster' not found." };
    }
    if (!targetSheet) {
      Logger.log("[STEP 3 ERROR] Target sheet 'patientMaster' not found.");
      return { success: false, error: "Target sheet 'patientMaster' not found." };
    }
    Logger.log("[STEP 3 SUCCESS] Both sheets found.");

    Logger.log("[STEP 4] Reading sheet dimensions and timeZone...");
    const timeZone = Session.getScriptTimeZone();
    const sourceLastRow = sourceSheet.getLastRow();
    const sourceLastCol = sourceSheet.getLastColumn();
    const targetLastRow = targetSheet.getLastRow();

    Logger.log("[STEP 4 INFO] Source lastRow=" + sourceLastRow + ", source lastCol=" + sourceLastCol + ", target lastRow=" + targetLastRow);

    if (sourceLastRow <= 1) {
      Logger.log("[STEP 4 INFO] Source sheet has no data rows (lastRow <= 1). Exiting early.");
      return { success: true, count: 0 };
    }

    const isFirstSync = targetLastRow <= 1;
    Logger.log("[STEP 4 INFO] isFirstSync = " + isFirstSync);

    const fetchCols = Math.min(sourceLastCol, 43);
    Logger.log("[STEP 4 INFO] fetchCols = " + fetchCols);

    if (fetchCols < 1) {
      Logger.log("[STEP 4 ERROR] Source sheet has 0 columns. Exiting.");
      return { success: true, count: 0 };
    }

    Logger.log("[STEP 5] Calling getLastSyncedNumericMRD(targetSheet)...");
    let lastSyncedNum = 0;
    try {
      lastSyncedNum = getLastSyncedNumericMRD(targetSheet);
      Logger.log("[STEP 5 SUCCESS] Last synced numeric MRD = " + lastSyncedNum);
    } catch (e) {
      Logger.log("[STEP 5 ERROR] Error in getLastSyncedNumericMRD: " + e.message + "\nStack: " + e.stack);
      throw e;
    }

    Logger.log("[STEP 6] Reading data from sourceSheet (Rows 2 to " + sourceLastRow + ", Cols 1 to " + fetchCols + ")...");
    let sourceData = [];
    try {
      const startTime = new Date().getTime();
      sourceData = sourceSheet
        .getRange(2, 1, sourceLastRow - 1, fetchCols)
        .getValues();
      const endTime = new Date().getTime();
      Logger.log("[STEP 6 SUCCESS] Successfully read " + sourceData.length + " source rows in " + (endTime - startTime) + "ms");
    } catch (e) {
      Logger.log("[STEP 6 ERROR] Failed to getValues() from sourceSheet: " + e.message + "\nStack: " + e.stack);
      throw e;
    }

    Logger.log("[STEP 7] Filtering source data for new rows (MRD > " + lastSyncedNum + ")...");
    let filteredRows = [];
    try {
      filteredRows = sourceData.filter((row, idx) => {
        if (!row || row.length <= 28 || !row[28]) return isFirstSync;
        const mrdNum = extractNumeric(row[28]);
        return isFirstSync ? true : mrdNum > lastSyncedNum;
      });
      Logger.log("[STEP 7 SUCCESS] Filtered " + sourceData.length + " rows down to " + filteredRows.length + " candidate rows.");
    } catch (e) {
      Logger.log("[STEP 7 ERROR] Failed during array filter: " + e.message + "\nStack: " + e.stack);
      throw e;
    }

    Logger.log("[STEP 8] Mapping " + filteredRows.length + " candidate rows to target format...");
    let newData = [];
    try {
      newData = filteredRows
        .map((row, idx) => {
          if (idx > 0 && idx % 2000 === 0) {
            Logger.log("[STEP 8 PROGRESS] Mapped " + idx + " / " + filteredRows.length + " rows...");
          }
          try {
            const dobDate = safeFormatDate(row[4], timeZone, "yyyy-MM-dd");
            const regDate = safeFormatDate(row[42], timeZone, "yyyy-MM-dd HH:mm:ss");

            const mrdNo = row[28] ? row[28].toString().trim() : "";
            const firstName = row[1] ? row[1].toString().trim() : "";
            const middleName = row[2] ? row[2].toString().trim() : "";
            const lastName = row[3] ? row[3].toString().trim() : "";
            const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");

            return [
              mrdNo, // A: MRD No
              fullName, // B: Full Name
              dobDate, // C: DOB
              row[5] != null ? row[5] : "", // D: Gender
              row[11] != null ? row[11] : "", // E: Phone
              row[7] != null ? row[7] : "", // F: Address
              row[12] != null ? row[12] : "", // G: Home No
              row[13] != null ? row[13] : "", // H: Work No
              regDate, // I: Registration Date
              "", // J: Type
              "", // K: Additional Info
              "", // L: Status
            ];
          } catch (e) {
            Logger.log("[STEP 8 ROW ERROR] Exception mapping row index " + idx + ": " + e.message);
            return null;
          }
        })
        .filter(Boolean);
      Logger.log("[STEP 8 SUCCESS] Mapping complete. Total valid rows to append: " + newData.length);
    } catch (e) {
      Logger.log("[STEP 8 ERROR] Failed during mapping: " + e.message + "\nStack: " + e.stack);
      throw e;
    }

    Logger.log("[STEP 9] Appending new data to targetSheet...");
    if (newData.length) {
      const startRow = isFirstSync ? 2 : targetSheet.getLastRow() + 1;
      Logger.log("[STEP 9 INFO] Target startRow = " + startRow + ", row count = " + newData.length + ", col count = " + newData[0].length);

      // Write in batches of 1000 to prevent payload timeouts
      const BATCH_SIZE = 1000;
      for (let i = 0; i < newData.length; i += BATCH_SIZE) {
        const chunk = newData.slice(i, i + BATCH_SIZE);
        const currentRow = startRow + i;
        Logger.log("[STEP 9 PROGRESS] Writing batch " + Math.floor(i / BATCH_SIZE + 1) + " (rows " + currentRow + " to " + (currentRow + chunk.length - 1) + ")...");
        try {
          targetSheet
            .getRange(currentRow, 1, chunk.length, chunk[0].length)
            .setValues(chunk);
        } catch (e) {
          Logger.log("[STEP 9 ERROR] Failed writing batch at row " + currentRow + ": " + e.message + "\nStack: " + e.stack);
          throw e;
        }
      }
      Logger.log("[STEP 9 SUCCESS] Successfully appended " + newData.length + " rows.");
    } else {
      Logger.log("[STEP 9 INFO] No new rows to sync.");
    }

    Logger.log("==========================================");
    Logger.log("[SYNC FINISHED SUCCESSFULLY] Processed " + newData.length + " rows.");
    return { success: true, count: newData.length };
  } catch (e) {
    Logger.log("==========================================");
    Logger.log("[SYNC FATAL ERROR CATCH] Exception caught in top-level try/catch:");
    Logger.log("  Message: " + e.message);
    Logger.log("  Stack: " + e.stack);
    return { success: false, error: e.message };
  }
}

// Reads column A up to actual lastRow, extracts numbers, returns the max (or 0) safely
function getLastSyncedNumericMRD(targetSheet) {
  Logger.log("  [getLastSyncedNumericMRD] Reading target lastRow...");
  const lastRow = targetSheet.getLastRow();
  Logger.log("  [getLastSyncedNumericMRD] target lastRow = " + lastRow);
  if (lastRow <= 1) {
    Logger.log("  [getLastSyncedNumericMRD] target lastRow <= 1. Returning 0.");
    return 0;
  }

  Logger.log("  [getLastSyncedNumericMRD] Reading column A range (Row 2 to " + lastRow + ")...");
  let ids = [];
  try {
    ids = targetSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    Logger.log("  [getLastSyncedNumericMRD] Successfully read " + ids.length + " MRD IDs from target sheet.");
  } catch (e) {
    Logger.log("  [getLastSyncedNumericMRD ERROR] Failed getting column A values: " + e.message);
    throw e;
  }

  Logger.log("  [getLastSyncedNumericMRD] Looping to find max numeric MRD...");
  let maxNum = 0;
  for (let i = 0; i < ids.length; i++) {
    const num = extractNumeric(ids[i]);
    if (num > maxNum) {
      maxNum = num;
    }
  }
  Logger.log("  [getLastSyncedNumericMRD SUCCESS] Max numeric MRD found = " + maxNum);
  return maxNum;
}
