/**
 * PaymentSheets.gs — Sheet schema and creation for the payment module.
 *
 * Three sheets, all keyed off AppointmentID so that nothing lives in the
 * `appointment` row itself. That matters: cancelAppointment() (Code.js:10629)
 * copies rows BY NUMERIC INDEX into the `cancel` sheet and then deletes the
 * original, so any payment column added to `appointment` would be shredded
 * on cancellation. See paymentPlan.md §1 and §3.
 *
 * All three initializers are idempotent and migration-safe: they append any
 * header that is missing rather than rewriting the sheet.
 */

var PAYMENT_SHEET = "payment";
var REFUND_SHEET = "refund";
var PAYMENT_LOG_SHEET = "paymentLog";

// ---------------------------------------------------------------------------
// Schemas — order matters only for new sheets; lookups are always by header.
// ---------------------------------------------------------------------------

var PAYMENT_SHEET_HEADERS = [
  "PaymentRef",          // SAMP-APT-YYYYMMDD-NNNNNN — primary key
  "AppointmentID",       // join key to appointment / cancel / archive
  "AppointmentSheet",    // where the appointment row currently lives
  "MRDNo",
  "PatientName",
  "Mobile",              // confirmed by reception before the link is sent (§1)
  "AppointmentDate",
  "AppointmentTime",
  "AppointmentType",
  "AmountPaise",         // integer paise — the only monetary source of truth
  "Currency",
  "Provider",
  "ProviderLinkId",
  "PaymentUrl",
  "PaymentStatus",
  "ProviderPaymentId",   // never overwritten once set (§23)
  "PaidAmountPaise",
  "PaidAt",
  "LinkCreatedAt",
  "HoldExpiresAt",       // internal hold deadline — authoritative for release
  "LinkExpiresAt",       // what we told Razorpay
  "AppointmentStatus",
  "RefundStatus",
  "RefundedAmountPaise",
  "ConfirmationEmailSent",
  "CreatedBy",
  "LastEventAt",
  "Remarks",
];

var REFUND_SHEET_HEADERS = [
  "RefundRef",
  "PaymentRef",
  "AppointmentID",
  "ProviderPaymentId",
  "ProviderRefundId",
  "RefundAmountPaise",
  "RefundType",          // FULL | PARTIAL
  "RefundStatus",
  "RefundReason",        // structured value from §24
  "RefundRemarks",
  "RequestedAt",
  "RequestedBy",
  "CompletedAt",
  "ProviderArn",         // bank / UPI reference where Razorpay supplies one
  "LastError",
];

var PAYMENT_LOG_HEADERS = [
  "Timestamp",
  "EventType",
  "AppointmentID",
  "PaymentRef",
  "ProviderLinkId",
  "ProviderPaymentId",
  "ProviderRefundId",
  "AmountPaise",
  "Actor",               // username, SYSTEM, or WEBHOOK
  "Result",              // OK | FAIL | IGNORED
  "ProviderEventId",
  "Detail",              // JSON
  "Error",
];

// Event vocabulary (§30). Kept as a frozen-ish map so typos fail loudly.
var PAYMENT_EVENTS = {
  PAYMENT_LINK_CREATED: "PAYMENT_LINK_CREATED",
  PAYMENT_LINK_SENT: "PAYMENT_LINK_SENT",
  PAYMENT_LINK_CANCELLED: "PAYMENT_LINK_CANCELLED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_EXPIRED: "PAYMENT_EXPIRED",
  LATE_PAYMENT_RECEIVED: "LATE_PAYMENT_RECEIVED",
  SLOT_RELEASED: "SLOT_RELEASED",
  MANUAL_CHECK: "MANUAL_CHECK",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  RESCHEDULE_LINKED: "RESCHEDULE_LINKED",
  APPOINTMENT_CANCELLED: "APPOINTMENT_CANCELLED",
  REFUND_REQUESTED: "REFUND_REQUESTED",
  REFUND_INITIATED: "REFUND_INITIATED",
  REFUND_COMPLETED: "REFUND_COMPLETED",
  REFUND_FAILED: "REFUND_FAILED",
  WEBHOOK_RECEIVED: "WEBHOOK_RECEIVED",
  WEBHOOK_DUPLICATE: "WEBHOOK_DUPLICATE",
  WEBHOOK_REJECTED: "WEBHOOK_REJECTED",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Create (or migrate) every payment sheet plus the config rows.
 * Safe to re-run. This is the WP1 entry point — run it once from the editor.
 * @return {Object}
 */
function initializePaymentSheets() {
  try {
    var results = {
      payment: ensurePaymentSheet_(PAYMENT_SHEET, PAYMENT_SHEET_HEADERS),
      refund: ensurePaymentSheet_(REFUND_SHEET, REFUND_SHEET_HEADERS),
      paymentLog: ensurePaymentSheet_(PAYMENT_LOG_SHEET, PAYMENT_LOG_HEADERS),
      config: initializePaymentConfig(),
    };
    Logger.log("initializePaymentSheets: " + JSON.stringify(results));
    return { success: true, results: results };
  } catch (e) {
    Logger.log("initializePaymentSheets failed: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

/**
 * Create the sheet if absent; otherwise append any missing headers.
 * @param {string} name
 * @param {Array<string>} headers
 * @return {Object} { created, addedColumns }
 */
function ensurePaymentSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    stylePaymentHeaderRow_(sheet, headers.length);
    sheet.setColumnWidth(1, 220);
    return { created: true, addedColumns: [] };
  }

  // Migration path: add headers that do not exist yet, at the end.
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h || "").trim();
  });

  var missing = [];
  for (var i = 0; i < headers.length; i++) {
    if (existing.indexOf(headers[i]) === -1) missing.push(headers[i]);
  }

  if (missing.length) {
    var startCol = existing.filter(String).length + 1;
    var needed = startCol + missing.length - 1;
    if (sheet.getMaxColumns() < needed) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
    }
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    stylePaymentHeaderRow_(sheet, needed);
  }

  return { created: false, addedColumns: missing };
}

/** House style: bold white on #4a90e2, frozen row 1. */
function stylePaymentHeaderRow_(sheet, columnCount) {
  var range = sheet.getRange(1, 1, 1, columnCount);
  range.setFontWeight("bold");
  range.setBackground("#4a90e2");
  range.setFontColor("#ffffff");
  sheet.setFrozenRows(1);
}

// ---------------------------------------------------------------------------
// Generic header-indexed row access
// ---------------------------------------------------------------------------

/**
 * Read a whole sheet as { headers, index, rows } where index maps a header
 * name to its 0-based column position.
 * @param {string} sheetName
 * @return {{sheet: Sheet, headers: Array, index: Object, rows: Array}}
 */
function readPaymentTable_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      "Sheet '" + sheetName + "' not found. Run initializePaymentSheets() first."
    );
  }
  var values = sheet.getDataRange().getValues();
  var headers = values.length ? values[0] : [];
  var index = {};
  for (var i = 0; i < headers.length; i++) {
    index[String(headers[i]).trim()] = i;
  }
  return { sheet: sheet, headers: headers, index: index, rows: values.slice(1) };
}

/** Turn a raw row array into a header-keyed object. */
function rowToObject_(row, index) {
  var obj = {};
  for (var key in index) {
    obj[key] = row[index[key]];
  }
  return obj;
}

/**
 * Write named fields into one row. `sheetRow` is the 1-based sheet row number.
 * Writes each field individually — these sheets are small and the clarity is
 * worth more here than the batching would save.
 */
function writePaymentFields_(sheet, index, sheetRow, fields) {
  for (var key in fields) {
    if (!(key in index)) continue;
    sheet.getRange(sheetRow, index[key] + 1).setValue(fields[key]);
  }
}

// ---------------------------------------------------------------------------
// Event log (§30)
// ---------------------------------------------------------------------------

/**
 * Append one row to paymentLog. Never throws — logging must not be able to
 * break a payment operation.
 *
 * @param {Object} event
 * @param {string} event.eventType   One of PAYMENT_EVENTS
 * @param {string} [event.appointmentId]
 * @param {string} [event.paymentRef]
 * @param {string} [event.providerLinkId]
 * @param {string} [event.providerPaymentId]
 * @param {string} [event.providerRefundId]
 * @param {number} [event.amountPaise]
 * @param {string} [event.actor]     username | SYSTEM | WEBHOOK
 * @param {string} [event.result]    OK | FAIL | IGNORED
 * @param {string} [event.providerEventId]
 * @param {Object} [event.detail]
 * @param {string} [event.error]
 */
function logPaymentEvent(event) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(PAYMENT_LOG_SHEET);
    if (!sheet) {
      ensurePaymentSheet_(PAYMENT_LOG_SHEET, PAYMENT_LOG_HEADERS);
      sheet = ss.getSheetByName(PAYMENT_LOG_SHEET);
    }

    var detail = "";
    if (event.detail) {
      try {
        detail = JSON.stringify(scrubSecrets_(event.detail));
      } catch (e) {
        detail = "[unserializable]";
      }
    }

    sheet.appendRow([
      new Date(),
      event.eventType || "UNKNOWN",
      event.appointmentId || "",
      event.paymentRef || "",
      event.providerLinkId || "",
      event.providerPaymentId || "",
      event.providerRefundId || "",
      event.amountPaise === undefined || event.amountPaise === null
        ? ""
        : event.amountPaise,
      event.actor || "SYSTEM",
      event.result || "OK",
      event.providerEventId || "",
      detail,
      event.error ? String(event.error).slice(0, 900) : "",
    ]);
  } catch (e) {
    Logger.log("logPaymentEvent failed (" + event.eventType + "): " + e.toString());
  }
}

/**
 * Defence in depth for §33: strip anything that looks like a credential
 * before it can reach the log sheet.
 */
function scrubSecrets_(obj) {
  var out = {};
  for (var key in obj) {
    var lower = String(key).toLowerCase();
    if (
      lower.indexOf("secret") !== -1 ||
      lower.indexOf("password") !== -1 ||
      lower.indexOf("token") !== -1 ||
      lower === "authorization" ||
      lower === "key_secret"
    ) {
      out[key] = "[REDACTED]";
      continue;
    }
    var value = obj[key];
    if (typeof value === "string" && /rzp_(test|live)_/.test(value)) {
      out[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !(value instanceof Date)) {
      out[key] = scrubSecrets_(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
