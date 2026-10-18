/**
 * Returns all unique users and all unique action types from the entire AuditLog sheet.
 * Used to populate filter dropdowns on the AuditActivity page.
 *
 * @param {string} sessionToken
 * @return {Object} { success, users: [{username, fullName}], actionTypes: [string] }
 */
function getAuditFilterOptions(sessionToken) {
  try {
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session. Please login again." };
    }
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required." };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");
    if (!auditSheet) {
      return { success: true, users: [], actionTypes: [] };
    }

    const data = auditSheet.getDataRange().getValues();
    const userMap = {};   // username -> fullName
    const actionTypeSet = new Set();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue;
      const user = String(row[1] || "").trim();
      const fullName = String(row[2] || "").trim();
      const actionType = String(row[4] || "").trim();
      if (user && !userMap[user]) userMap[user] = fullName || user;
      if (actionType) actionTypeSet.add(actionType);
    }

    const users = Object.keys(userMap).sort().map(function(u) {
      return { username: u, fullName: userMap[u] };
    });
    const actionTypes = Array.from(actionTypeSet).sort();

    return { success: true, users: users, actionTypes: actionTypes };
  } catch (error) {
    Logger.log("Error in getAuditFilterOptions: " + error.toString());
    return { success: false, message: "Error loading filter options: " + error.toString() };
  }
}

/**
 * Returns per-user action counts for a date range, excluding LOGIN_SUCCESS and LOGOUT.
 * Used to power the stacked column chart on the AuditActivity page.
 *
 * @param {string} dateFrom - Start date in yyyy-MM-dd format
 * @param {string} dateTo   - End date in yyyy-MM-dd format (inclusive)
 * @param {string} sessionToken
 * @return {Object} { success, users, actionTypes, data }
 */
function getAuditActivitySummary(dateFrom, dateTo, sessionToken) {
  try {
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session. Please login again." };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required." };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      return { success: false, message: "AuditLog sheet not found." };
    }

    const data = auditSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { success: true, users: [], actionTypes: [], data: {} };
    }

    const EXCLUDED_ACTIONS = new Set(["LOGIN_SUCCESS", "LOGOUT"]);

    // Parse date boundaries once
    let fromDate = null;
    let toDate = null;
    if (dateFrom) {
      fromDate = new Date(dateFrom);
      fromDate.setHours(0, 0, 0, 0);
    }
    if (dateTo) {
      toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
    }

    // userMap: username -> { fullName, counts: { actionType: n } }
    const userMap = {};
    const actionTypeSet = new Set();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue;

      const ts = new Date(row[0]);
      if (fromDate && ts < fromDate) continue;
      if (toDate && ts > toDate) continue;

      const actionType = row[4];
      if (!actionType || EXCLUDED_ACTIONS.has(actionType)) continue;

      const user = row[1] || "unknown";
      const fullName = row[2] || user;

      if (!userMap[user]) {
        userMap[user] = { fullName: fullName, counts: {} };
      }
      userMap[user].counts[actionType] = (userMap[user].counts[actionType] || 0) + 1;
      actionTypeSet.add(actionType);
    }

    const users = Object.keys(userMap).sort();
    const actionTypes = Array.from(actionTypeSet).sort();

    return {
      success: true,
      users: users,
      actionTypes: actionTypes,
      data: userMap,
    };
  } catch (error) {
    Logger.log("Error in getAuditActivitySummary: " + error.toString());
    return { success: false, message: "Error retrieving activity summary: " + error.toString() };
  }
}

/**
 * Returns credit / API usage summary for a date range.
 * Tracks SEND_REMINDERS (WhatsApp/AiSensy) and API_LLM_CALL (Gemini) events.
 *
 * @param {string} dateFrom - Start date in yyyy-MM-dd format
 * @param {string} dateTo   - End date in yyyy-MM-dd format (inclusive)
 * @param {string} sessionToken
 * @return {Object} { success, whatsappCount, llmCount, totalCount, entries }
 */
function getCreditUsageSummary(dateFrom, dateTo, sessionToken) {
  try {
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session. Please login again." };
    }
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required." };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");
    if (!auditSheet) {
      return { success: true, whatsappCount: 0, llmCount: 0, totalCount: 0, entries: [] };
    }

    const data = auditSheet.getDataRange().getValues();

    let fromDate = null;
    let toDate = null;
    if (dateFrom) {
      fromDate = new Date(dateFrom);
      fromDate.setHours(0, 0, 0, 0);
    }
    if (dateTo) {
      toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
    }

    const CREDIT_ACTIONS = ["SEND_REMINDERS", "API_LLM_CALL"];
    let whatsappCount = 0;
    let llmCount = 0;
    let entries = [];

    for (let i = data.length - 1; i >= 1; i--) {
      const row = data[i];
      if (!row[0]) continue;
      const actionType = String(row[4] || "").trim();
      if (CREDIT_ACTIONS.indexOf(actionType) === -1) continue;

      const ts = new Date(row[0]);
      if (fromDate && ts < fromDate) continue;
      if (toDate && ts > toDate) continue;

      if (actionType === "SEND_REMINDERS") whatsappCount++;
      if (actionType === "API_LLM_CALL") llmCount++;

      if (entries.length < 20) {
        let parsedDetails = row[7];
        try {
          if (parsedDetails && typeof parsedDetails === "string") parsedDetails = JSON.parse(parsedDetails);
        } catch (e) {}
        entries.push({
          timestamp: String(row[0]),
          username: String(row[1] || ""),
          fullName: String(row[2] || ""),
          actionType: actionType,
          details: parsedDetails
        });
      }
    }

    return {
      success: true,
      whatsappCount: whatsappCount,
      llmCount: llmCount,
      totalCount: whatsappCount + llmCount,
      entries: entries
    };
  } catch (error) {
    Logger.log("Error in getCreditUsageSummary: " + error.toString());
    return { success: false, message: "Error: " + error.toString() };
  }
}
