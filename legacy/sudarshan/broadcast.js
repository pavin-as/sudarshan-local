/**
 * Appointment reminder sender integrated with the Sudarshan webapp.
 *
 * Sheet column mapping:
 *   AppointmentDate, TimeSlot, PatientName, Phone (resolved dynamically)
 *
 * Waiting-list patients have a blank TimeSlot (or "00:00") and are skipped.
 */

var SHEET_NAME = "appointment";

var _waConfigCache_ = null;

function getWAConfigCache_() {
  if (!_waConfigCache_) {
    _waConfigCache_ = getActiveWAConfig();
  }
  return _waConfigCache_;
}

function clearWAConfigCache_() {
  _waConfigCache_ = null;
}

function getWhatsAppApiKey_() {
  var cfg = getWAConfigCache_();
  if (cfg.apiKey) return cfg.apiKey;
  return "***REDACTED-AISENSY-TOKEN***";
}

function getWhatsAppApiUrl_() {
  var cfg = getWAConfigCache_();
  if (cfg.apiUrl) return cfg.apiUrl;
  return "https://backend.aisensy.com/campaign/t1/api/v2";
}

function getWhatsAppCampaignName_() {
  var cfg = getWAConfigCache_();
  if (cfg.campaignId) return cfg.campaignId;
  return "sudarsdhan_appointment";
}

/**
 * Checks if the user associated with the session token has permission to access Broadcast.
 * Limited to Level 1 (Director/Admin) and Level 3 (Manager) only.
 * @param {string} sessionToken
 * @return {boolean}
 */
function canAccessBroadcast(sessionToken) {
  try {
    const session = getUserSession(sessionToken);
    if (!session) return false;
    const level = getUserAccessLevel(session.role);
    return level === 1 || level === 3;
  } catch (e) {
    return false;
  }
}

/**
 * Initializes the Broadcast logging sheet if it does not exist.
 * @return {Sheet}
 */
function initializeBroadcastSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Broadcast");
  if (!sheet) {
    sheet = ss.insertSheet("Broadcast");
    var headers = ["Timestamp", "AppointmentDate", "CampaignName", "SentCount", "SkippedCount", "FailedCount", "SentBy"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange("A1:G1").setFontWeight("bold").setBackground("#e2e8f0");
  }
  return sheet;
}

/**
 * Generates a preview list of targets for a given appointment date.
 * @param {string} sessionToken
 * @param {string} inputDate (yyyy-MM-dd)
 * @return {{date: string, targets: Array, skipped: Array, totalCount: number}}
 */
function getBroadcastPreview(sessionToken, inputDate) {
  if (!canAccessBroadcast(sessionToken)) {
    throw new Error("Access Denied: You do not have permission to preview broadcasts.");
  }

  var targetDate = normalizeDate_(inputDate);
  if (!targetDate) {
    throw new Error("Please provide a valid date.");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var rows = sheet.getDataRange().getValues();
  var targets = [];
  var skipped = [];

  if (rows.length > 1) {
    var headers = rows[0];
    var colDate = headers.indexOf("AppointmentDate");
    if (colDate === -1) colDate = headers.indexOf("Appointment Date");
    if (colDate === -1) colDate = 1; // Fallback to col B

    var colTime = headers.indexOf("TimeSlot");
    if (colTime === -1) colTime = headers.indexOf("Time Slot");
    if (colTime === -1) colTime = 2; // Fallback to col C

    var colName = headers.indexOf("PatientName");
    if (colName === -1) colName = headers.indexOf("Patient Name");
    if (colName === -1) colName = 4; // Fallback to col E

    var colPhone = headers.indexOf("Phone");
    if (colPhone === -1) colPhone = headers.indexOf("Phone Number");
    if (colPhone === -1) colPhone = 7; // Fallback to col H

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var rowDate = normalizeDate_(row[colDate], tz);
      if (rowDate !== targetDate) continue;

      var name = String(row[colName] || "").trim();
      var timeSlot = formatCellTime_(row[colTime], tz);
      var phone = String(row[colPhone] || "").trim();

      if (isWaitingList_(timeSlot)) {
        skipped.push({ name: name, reason: "Waiting list / No slot time" });
        continue;
      }
      if (!phone) {
        skipped.push({ name: name, reason: "No phone number registered" });
        continue;
      }

      var cleanPhone = cleanPhoneNumber_(phone);
      targets.push({
        name: name,
        time: formatTime12_(timeSlot),
        phone: cleanPhone
      });
    }
  }

  return {
    date: formatDisplayDate_(targetDate),
    targets: targets,
    skipped: skipped,
    totalCount: targets.length
  };
}

/**
 * Main entry point called from the front-end to send reminders.
 * @param {string} sessionToken
 * @param {string} inputDate yyyy-MM-dd
 * @return {{date:string, sentCount:number, skippedCount:number,
 *           failedCount:number, sent:Array, skipped:Array, failed:Array}}
 */
function sendAppointmentReminders(sessionToken, inputDate) {
  clearWAConfigCache_();
  if (!canAccessBroadcast(sessionToken)) {
    throw new Error("Access Denied: You do not have permission to send broadcasts.");
  }

  var targetDate = normalizeDate_(inputDate);
  if (!targetDate) {
    throw new Error("Please provide a valid date.");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var rows = sheet.getDataRange().getValues();

  var sent = [];
  var skipped = [];
  var failed = [];

  if (rows.length > 1) {
    var headers = rows[0];
    var colDate = headers.indexOf("AppointmentDate");
    if (colDate === -1) colDate = headers.indexOf("Appointment Date");
    if (colDate === -1) colDate = 1; 

    var colTime = headers.indexOf("TimeSlot");
    if (colTime === -1) colTime = headers.indexOf("Time Slot");
    if (colTime === -1) colTime = 2; 

    var colName = headers.indexOf("PatientName");
    if (colName === -1) colName = headers.indexOf("Patient Name");
    if (colName === -1) colName = 4; 

    var colPhone = headers.indexOf("Phone");
    if (colPhone === -1) colPhone = headers.indexOf("Phone Number");
    if (colPhone === -1) colPhone = 7; 

    // Start at 1 to skip the header row.
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];

      var rowDate = normalizeDate_(row[colDate], tz);
      if (rowDate !== targetDate) continue;

      var name = String(row[colName] || "").trim();
      var timeSlot = formatCellTime_(row[colTime], tz);
      var phone = String(row[colPhone] || "").trim();

      if (isWaitingList_(timeSlot)) {
        skipped.push({ name: name, reason: "Waiting list / No slot time" });
        continue;
      }
      if (!phone) {
        skipped.push({ name: name, reason: "No phone number registered" });
        continue;
      }

      var cleanPhone = cleanPhoneNumber_(phone);

      var params = [
        name,
        formatDisplayDate_(targetDate),
        formatTime12_(timeSlot)
      ];

      var result = sendAppointmentWhatsApp_(cleanPhone, name, params);
      if (result.success) {
        sent.push({ name: name, phone: cleanPhone, time: timeSlot });
      } else {
        failed.push({ name: name, phone: cleanPhone, reason: result.message });
      }
    }
  }

  var session = getUserSession(sessionToken);
  var sentBy = session ? session.username : "UNKNOWN";

  // Append history entry to Broadcast logging sheet
  var bSheet = initializeBroadcastSheet();
  var timestamp = new Date();
  bSheet.appendRow([
    timestamp,
    targetDate, 
    getWhatsAppCampaignName_(),
    sent.length,
    skipped.length,
    failed.length,
    sentBy
  ]);

  // Log audit activity event
  try {
    logAuditEvent(sessionToken, "SEND_REMINDERS", "APPOINTMENT", targetDate, {
      campaignName: getWhatsAppCampaignName_(),
      sentCount: sent.length,
      skippedCount: skipped.length,
      failedCount: failed.length
    });
  } catch (auditError) {
    Logger.log("Audit logging failed for reminders: " + auditError.toString());
  }

  return {
    date: formatDisplayDate_(targetDate),
    sentCount: sent.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    sent: sent,
    skipped: skipped,
    failed: failed
  };
}

/**
 * Returns a list of all rows from the Broadcast log sheet from today into the future.
 * @param {string} sessionToken
 * @return {Array<Object>}
 */
function getBroadcastHistory(sessionToken) {
  if (!canAccessBroadcast(sessionToken)) {
    throw new Error("Access Denied: You do not have permission to view broadcast history.");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Broadcast");
  if (!sheet) {
    return [];
  }

  var rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) {
    return [];
  }

  var history = [];
  var headers = rows[0];
  var colTimestamp = headers.indexOf("Timestamp");
  var colApptDate = headers.indexOf("AppointmentDate");
  var colCampaign = headers.indexOf("CampaignName");
  var colSent = headers.indexOf("SentCount");
  var colSkipped = headers.indexOf("SkippedCount");
  var colFailed = headers.indexOf("FailedCount");
  var colSentBy = headers.indexOf("SentBy");

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // Read logs from bottom-up for chronological order or filter
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[colApptDate]) continue;

    var apptDateStr = String(row[colApptDate]).trim();
    var apptDate = new Date(apptDateStr);
    apptDate.setHours(0, 0, 0, 0);

    // Filter appointments from today and into the future
    if (!isNaN(apptDate.getTime()) && apptDate >= today) {
      var ts = row[colTimestamp];
      var formattedTimestamp = "";
      if (ts instanceof Date) {
        formattedTimestamp = Utilities.formatDate(ts, ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
      } else {
        formattedTimestamp = String(ts);
      }

      history.push({
        timestamp: formattedTimestamp,
        appointmentDate: normalizeDate_(apptDateStr), // store as yyyy-MM-dd
        displayDate: formatDisplayDate_(normalizeDate_(apptDateStr)),
        campaignName: String(row[colCampaign] || ""),
        sentCount: Number(row[colSent]) || 0,
        skippedCount: Number(row[colSkipped]) || 0,
        failedCount: Number(row[colFailed]) || 0,
        sentBy: String(row[colSentBy] || "")
      });
    }
  }

  // Sort descending by timestamp so latest runs show first
  history.sort(function(a, b) {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return history;
}

/**
 * Sends a single appointment reminder via AiSensy.
 * templateParams = [ patientName, displayDate, displayTime ]
 * @return {{success:boolean, messageId?:string, message?:string}}
 */
function sendAppointmentWhatsApp_(phone, userName, templateParams) {
  if (!phone) {
    return { success: false, message: "No WhatsApp number for patient: " + userName };
  }

  var payload = {
    apiKey: getWhatsAppApiKey_(),
    campaignName: getWhatsAppCampaignName_(),
    destination: phone,
    userName: String(userName),
    templateParams: templateParams
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(getWhatsAppApiUrl_(), options);
    var code = response.getResponseCode();
    var raw = response.getContentText();
    var parsed = {};
    try { parsed = JSON.parse(raw); } catch (e) { parsed = {}; }

    if (code === 200) {
      return { success: true, messageId: parsed.messageId || parsed.id || "", rawResponse: raw };
    }
    return { success: false, message: "AiSensy API error (HTTP " + code + "): " + raw };
  } catch (e) {
    return { success: false, message: "Request failed: " + e.message };
  }
}

/**
 * Cleans phone number to format '91XXXXXXXXXX'.
 * @param {string} phone
 * @return {string}
 */
function cleanPhoneNumber_(phone) {
  var destination = String(phone).replace(/\D/g, "");
  // If length is 10, prepend India country code 91
  if (destination.length === 10) {
    destination = "91" + destination;
  }
  return destination;
}

/**
 * True when the time slot is blank or the invalid "00:00" placeholder —
 * i.e. a waiting-list / unscheduled patient who must be excluded.
 */
function isWaitingList_(timeSlot) {
  var t = String(timeSlot || "").trim();
  if (!t) return true;
  if (t === "00:00" || t === "00:00:00") return true;
  return false;
}

/**
 * Normalizes a date cell (JS Date or string) to a "yyyy-MM-dd" string.
 * @param {*} value
 * @param {string=} tz  spreadsheet time zone (for Date values)
 * @return {string}  "" when not parseable
 */
function normalizeDate_(value, tz) {
  if (value === null || value === undefined || value === "") return "";

  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Utilities.formatDate(value, tz || Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];

  // Also check standard Indian dd/MM/yyyy date formats
  var mDMY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mDMY) {
    var day = mDMY[1].padStart(2, '0');
    var month = mDMY[2].padStart(2, '0');
    var year = mDMY[3];
    return year + "-" + month + "-" + day;
  }

  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, tz || Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return "";
}

/**
 * Reads a TimeSlot cell as "HH:mm". Handles plain text ("11:50") and
 * Date/time values that Sheets sometimes stores for time cells.
 */
function formatCellTime_(value, tz) {
  if (value === null || value === undefined || value === "") return "";

  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Utilities.formatDate(value, tz || Session.getScriptTimeZone(), "HH:mm");
  }
  return String(value).trim();
}

/**
 * "2026-06-17" -> "17-June-2026".
 */
function formatDisplayDate_(yyyymmdd) {
  var parts = String(yyyymmdd).split("-");
  if (parts.length !== 3) return String(yyyymmdd);

  var months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
  var year = parts[0];
  var monthIdx = parseInt(parts[1], 10) - 1;
  var day = parseInt(parts[2], 10);
  var monthName = months[monthIdx] || parts[1];
  return day + "-" + monthName + "-" + year;
}

/**
 * "11:50" -> "11:50 AM", "16:10" -> "4:10 PM".
 */
function formatTime12_(t) {
  var s = String(t || "").trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;

  var hour = parseInt(m[1], 10);
  var minute = m[2];
  var period = hour >= 12 ? "PM" : "AM";
  var hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  return hour12 + ":" + minute + " " + period;
}

/**
 * Run this function ONCE manually from the Apps Script editor (script.google.com)
 * to trigger the Google Authorization prompt for external network requests.
 */
function triggerAuthorizationPrompt() {
  try {
    UrlFetchApp.fetch("https://backend.aisensy.com/", { muteHttpExceptions: true });
    Logger.log("Authorization prompt run complete! Make sure you clicked 'Allow'.");
  } catch (e) {
    Logger.log("Authorization trigger run: " + e.message);
  }
}
