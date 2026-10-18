// Triage Queue backend functions

function getTriageRecords(sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, message: "Invalid session. Please login again." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("urgencyIdentification");
    if (!sheet) return { success: true, data: [] };

    var allValues = sheet.getDataRange().getValues();
    if (allValues.length <= 1) return { success: true, data: [] };

    var headers = allValues[0];
    var requiredCols = ["DecisionStatus", "DecisionRemarks", "DecisionBy", "DecisionDate"];
    var missing = requiredCols.filter(function(c) { return headers.indexOf(c) === -1; });

    if (missing.length > 0) {
      var newHeaders = headers.concat(missing);
      sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
      allValues = sheet.getDataRange().getValues();
      headers = allValues[0];
    }

    var tz = Session.getScriptTimeZone();
    var records = [];

    for (var i = 1; i < allValues.length; i++) {
      var row = allValues[i];
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var val = row[j] !== undefined ? row[j] : "";
        if (val instanceof Date) {
          val = Utilities.formatDate(val, tz, "yyyy-MM-dd HH:mm:ss");
        }
        obj[headers[j]] = val;
      }
      if (!obj.DecisionStatus || obj.DecisionStatus === "") {
        obj.DecisionStatus = "Pending Action";
      }
      records.push(obj);
    }

    return { success: true, data: records };
  } catch (e) {
    Logger.log("getTriageRecords error: " + e.toString());
    return { success: false, message: "Error loading records: " + e.toString() };
  }
}

function updateTriageDecision(triageId, decision, remarks, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, message: "Invalid session. Please login again." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("urgencyIdentification");
    if (!sheet) return { success: false, message: "Triage sheet not found." };

    var allValues = sheet.getDataRange().getValues();
    if (allValues.length <= 1) return { success: false, message: "No records found." };

    var headers = allValues[0];
    var idIdx        = headers.indexOf("TriageID");
    var statusIdx    = headers.indexOf("DecisionStatus");
    var remarksIdx   = headers.indexOf("DecisionRemarks");
    var byIdx        = headers.indexOf("DecisionBy");
    var dateIdx      = headers.indexOf("DecisionDate");

    if (idIdx === -1 || statusIdx === -1 || remarksIdx === -1 || byIdx === -1 || dateIdx === -1) {
      return { success: false, message: "Decision columns missing. Reload the page and try again." };
    }

    var targetRow = -1;
    for (var i = 1; i < allValues.length; i++) {
      if (allValues[i][idIdx].toString().trim() === triageId.toString().trim()) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) return { success: false, message: "Record not found: " + triageId };

    var tz = Session.getScriptTimeZone();
    var now = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss");

    sheet.getRange(targetRow, statusIdx + 1).setValue(decision);
    sheet.getRange(targetRow, remarksIdx + 1).setValue(remarks || "");
    sheet.getRange(targetRow, byIdx + 1).setValue(username);
    sheet.getRange(targetRow, dateIdx + 1).setValue(now);

    logAuditEvent(sessionToken, "UPDATE_TRIAGE_DECISION", "TRIAGE", triageId, {
      decision: decision,
      remarks: remarks || "",
      updatedBy: username,
      updatedAt: now
    });

    return { success: true, message: "Decision saved successfully." };
  } catch (e) {
    Logger.log("updateTriageDecision error: " + e.toString());
    return { success: false, message: "Error saving decision: " + e.toString() };
  }
}
