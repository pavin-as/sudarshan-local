/**
 * PaymentConfig.gs — Credentials and configuration for the payment module.
 *
 * SECRETS live in Script Properties ONLY (handoff doc §12, §33).
 * They are never written to a sheet, never returned to the browser,
 * never logged, and never emailed.
 *
 * NON-SECRET config lives in the existing `API_setting` sheet under
 * category "payment", so it is editable from settings.html with the
 * plumbing that already exists in API_setting.gs.
 *
 * Part of the payment module — see paymentPlan.md §5.
 */

// ---------------------------------------------------------------------------
// Script Property keys (secrets)
// ---------------------------------------------------------------------------

var RZP_PROP_KEY_ID = "RZP_KEY_ID";
var RZP_PROP_KEY_SECRET = "RZP_KEY_SECRET";
var RZP_PROP_WEBHOOK_TOKEN = "RZP_WEBHOOK_TOKEN";
var RZP_PROP_MODE = "RZP_MODE"; // "test" | "live"

// Sequence counter prefix for payment references (see PaymentService.gs)
var PAYMENT_SEQ_PROP_PREFIX = "PAY_SEQ_";

// ---------------------------------------------------------------------------
// Non-secret configuration defaults (API_setting sheet, category "payment")
// ---------------------------------------------------------------------------

var PAYMENT_CONFIG_CATEGORY = "payment";

function getPaymentConfigDefaults() {
  return {
    enabled: false, // master kill switch — ships OFF
    default_amount_paise: 50000, // Rs 500.00
    allow_amount_override: true,
    min_amount_paise: 10000, // Rs 100.00
    max_amount_paise: 500000, // Rs 5000.00
    hold_minutes: 15, // URGENT_PAYMENT_HOLD_MINUTES (§8)
    link_expiry_buffer_minutes: 5, // Razorpay rejects expire_by < 15 min out
    payment_required_types: ["EMERGENCY", "SAME DAY", "NEXT DAY"],
    clinic_notify_emails: ["admin@gs.sampadavr.com"],
    refund_min_role_level: 1, // Level 1 = director / admin only
    currency: "INR",
    clinic_display_name: "Sampada Specialty Eye Care",
  };
}

/**
 * Seed the API_setting sheet with the payment configuration rows.
 * Idempotent — existing rows are left untouched.
 * @return {Object} { success, created, skipped }
 */
function initializePaymentConfig() {
  try {
    initializeApiSettingSheet(); // no-op if the sheet already exists

    var existing = {};
    var rows = getApiSettingRows_();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].category === PAYMENT_CONFIG_CATEGORY) {
        existing[rows[i].key] = true;
      }
    }

    var defaults = getPaymentConfigDefaults();
    var created = [];
    var skipped = [];

    for (var key in defaults) {
      if (existing[key]) {
        skipped.push(key);
        continue;
      }
      updateApiSettingRow_(
        PAYMENT_CONFIG_CATEGORY,
        key,
        JSON.stringify(defaults[key]),
        true,
        "SYSTEM"
      );
      created.push(key);
    }

    Logger.log(
      "Payment config: created " + created.length + ", skipped " + skipped.length
    );
    return { success: true, created: created, skipped: skipped };
  } catch (e) {
    Logger.log("initializePaymentConfig failed: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

/**
 * Read the payment configuration, merged over the defaults.
 * Safe to call from anywhere — contains no secrets.
 * @return {Object}
 */
function getPaymentConfig() {
  var config = getPaymentConfigDefaults();
  try {
    var rows = getApiSettingRows_();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.category !== PAYMENT_CONFIG_CATEGORY) continue;
      if (!(row.key in config)) continue;
      // getApiSettingRows_ already JSON.parses the value column, and returns {}
      // when the cell contains something unparseable. Settings are hand-edited
      // in a sheet, so only accept a value whose type matches the default.
      var parsed = row.value;
      if (parsed === null || parsed === undefined) continue;
      var expected = Array.isArray(config[row.key]) ? "array" : typeof config[row.key];
      var actual = Array.isArray(parsed) ? "array" : typeof parsed;
      if (expected !== actual) {
        Logger.log(
          "Payment config '" + row.key + "' ignored: expected " + expected +
            ", got " + actual + ". Using the default."
        );
        continue;
      }
      config[row.key] = parsed;
    }
  } catch (e) {
    Logger.log("getPaymentConfig fell back to defaults: " + e.toString());
  }
  return config;
}

/**
 * Update one payment configuration key. Admin only.
 * @param {string} key
 * @param {*} value  Plain JS value; stored as JSON.
 * @param {string} sessionToken
 */
function setPaymentConfigValue(key, value, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };
    if (getUserAccessLevel(session.role) !== 1) {
      return { success: false, message: "Admin access required." };
    }
    if (!(key in getPaymentConfigDefaults())) {
      return { success: false, message: "Unknown payment setting: " + key };
    }
    updateApiSettingRow_(
      PAYMENT_CONFIG_CATEGORY,
      key,
      JSON.stringify(value),
      true,
      session.username || "UNKNOWN"
    );
    logAuditEvent(sessionToken, "UPDATE_PAYMENT_SETTING", "SETTING", key, {
      newValue: value,
      sheetName: "API_setting",
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Store Razorpay credentials programmatically.
 *
 * NOTE: the Apps Script editor's Run button cannot pass arguments, so running
 * this function directly from the editor always fails. Use one of these instead:
 *
 *   PREFERRED — enter them by hand, so the secret never touches a code file:
 *     Project Settings (gear icon) -> Script Properties -> Add script property
 *       RZP_KEY_ID      rzp_test_xxxxxxxx
 *       RZP_KEY_SECRET  your_secret
 *       RZP_MODE        test
 *     then run validateRazorpayCredentials() to check them.
 *
 *   OR — run setupRazorpayCredentialsFromPrompt() and type them into the
 *     dialog that opens in the spreadsheet.
 *
 *   OR — call this from your own code / another function that supplies the
 *     three arguments.
 *
 * Nothing here is echoed back; the log only confirms that values were stored.
 *
 * @param {string} keyId      Razorpay Key ID
 * @param {string} keySecret  Razorpay Key Secret
 * @param {string} mode       "test" or "live"
 */
function setupRazorpayCredentials(keyId, keySecret, mode) {
  if (!keyId || !keySecret) {
    throw new Error(
      "Both keyId and keySecret are required. The editor's Run button cannot " +
        "pass arguments — set RZP_KEY_ID / RZP_KEY_SECRET / RZP_MODE under " +
        "Project Settings > Script Properties and run validateRazorpayCredentials(), " +
        "or run setupRazorpayCredentialsFromPrompt() instead."
    );
  }
  mode = String(mode || "test").toLowerCase();
  if (mode !== "test" && mode !== "live") {
    throw new Error('mode must be "test" or "live".');
  }
  if (mode === "test" && String(keyId).indexOf("rzp_test") !== 0) {
    throw new Error('Mode is "test" but the Key ID does not start with rzp_test.');
  }
  if (mode === "live" && String(keyId).indexOf("rzp_live") !== 0) {
    throw new Error('Mode is "live" but the Key ID does not start with rzp_live.');
  }

  var props = PropertiesService.getScriptProperties();
  props.setProperty(RZP_PROP_KEY_ID, String(keyId).trim());
  props.setProperty(RZP_PROP_KEY_SECRET, String(keySecret).trim());
  props.setProperty(RZP_PROP_MODE, mode);

  Logger.log("Razorpay credentials stored (mode: " + mode + ").");
  return "Stored. Now run generateWebhookToken() if you have not already.";
}

/**
 * Generate (or rotate) the webhook URL token.
 *
 * Because Apps Script cannot read HTTP request headers, Razorpay's
 * X-Razorpay-Signature cannot be verified. This token in the webhook URL
 * is defence #1; re-fetching authoritative state from the Razorpay API is
 * defence #2 and is what actually makes forgery useless. See paymentPlan.md §6.1.
 *
 * Run from the editor and read the token from the execution log, then paste
 * the full URL into the Razorpay dashboard.
 */
function generateWebhookToken() {
  var token = Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty(
    RZP_PROP_WEBHOOK_TOKEN,
    token
  );
  var url = ScriptApp.getService().getUrl();
  Logger.log("Webhook token rotated. Configure this URL in Razorpay:");
  Logger.log(url + "?wh=" + token);
  return url + "?wh=" + token;
}

/**
 * Editor-runnable setup: opens dialogs in the spreadsheet and stores what you
 * type. Works because this project is container-bound. If it reports that the
 * UI is unavailable (the spreadsheet is not open, or the script is run headless),
 * use the Script Properties route in setupRazorpayCredentials()'s comment.
 *
 * The secret is typed into a dialog, never into a file, and is not logged.
 */
function setupRazorpayCredentialsFromPrompt() {
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    throw new Error(
      "No spreadsheet UI available here. Open the spreadsheet and retry, or set " +
        "RZP_KEY_ID / RZP_KEY_SECRET / RZP_MODE under Project Settings > Script Properties."
    );
  }

  var ask = function (title, prompt) {
    var response = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return null;
    return response.getResponseText().trim();
  };

  var keyId = ask("Razorpay setup (1 of 3)", "Paste the Key ID (rzp_test_... or rzp_live_...):");
  if (!keyId) return "Cancelled.";

  var keySecret = ask("Razorpay setup (2 of 3)", "Paste the Key Secret:");
  if (!keySecret) return "Cancelled.";

  var mode = ask("Razorpay setup (3 of 3)", 'Mode — type "test" or "live":');
  if (!mode) return "Cancelled.";

  setupRazorpayCredentials(keyId, keySecret, mode);
  ui.alert("Stored. Now run validateRazorpayCredentials() and testRazorpayConnection().");
  return "Stored.";
}

/**
 * Check whatever is currently in Script Properties, however it got there.
 * Run this after entering the properties by hand.
 *
 * Reports only shape and consistency — never the values themselves.
 * @return {Object}
 */
function validateRazorpayCredentials() {
  var props = PropertiesService.getScriptProperties();
  var keyId = (props.getProperty(RZP_PROP_KEY_ID) || "").trim();
  var keySecret = (props.getProperty(RZP_PROP_KEY_SECRET) || "").trim();
  var mode = (props.getProperty(RZP_PROP_MODE) || "").trim().toLowerCase();

  var problems = [];

  if (!keyId) problems.push("RZP_KEY_ID is not set.");
  if (!keySecret) problems.push("RZP_KEY_SECRET is not set.");

  if (!mode) {
    problems.push('RZP_MODE is not set — it must be "test" or "live".');
  } else if (mode !== "test" && mode !== "live") {
    problems.push('RZP_MODE must be exactly "test" or "live", got "' + mode + '".');
  }

  if (keyId && keyId.indexOf("rzp_") !== 0) {
    problems.push("RZP_KEY_ID does not look like a Razorpay key (expected rzp_test_ or rzp_live_).");
  }
  if (keyId && mode === "test" && keyId.indexOf("rzp_test") !== 0) {
    problems.push('RZP_MODE is "test" but RZP_KEY_ID is not a test key.');
  }
  if (keyId && mode === "live" && keyId.indexOf("rzp_live") !== 0) {
    problems.push('RZP_MODE is "live" but RZP_KEY_ID is not a live key.');
  }

  // A stray space from copy/paste is the usual cause of a 401 later.
  if (keyId !== (props.getProperty(RZP_PROP_KEY_ID) || "")) {
    problems.push("RZP_KEY_ID has leading/trailing whitespace — re-enter it.");
  }
  if (keySecret !== (props.getProperty(RZP_PROP_KEY_SECRET) || "")) {
    problems.push("RZP_KEY_SECRET has leading/trailing whitespace — re-enter it.");
  }

  var report = {
    ok: problems.length === 0,
    keyId: keyId ? "set (" + keyId.slice(0, 8) + "..., " + keyId.length + " chars)" : "MISSING",
    keySecret: keySecret ? "set (" + keySecret.length + " chars)" : "MISSING",
    mode: mode || "MISSING",
    webhookToken: props.getProperty(RZP_PROP_WEBHOOK_TOKEN) ? "set" : "not generated yet",
    problems: problems,
    next: problems.length
      ? "Fix the problems above, then run this again."
      : "Credentials look sane. Run testRazorpayConnection() next.",
  };

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Private. Returns credentials for the adapter. Throws if unconfigured.
 * @return {{keyId: string, keySecret: string, mode: string}}
 */
function getRazorpayCredentials_() {
  var props = PropertiesService.getScriptProperties();
  var keyId = props.getProperty(RZP_PROP_KEY_ID);
  var keySecret = props.getProperty(RZP_PROP_KEY_SECRET);
  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay credentials are not configured. Run setupRazorpayCredentials() from the Apps Script editor."
    );
  }
  return {
    keyId: keyId,
    keySecret: keySecret,
    mode: props.getProperty(RZP_PROP_MODE) || "test",
  };
}

/** Private. The webhook URL token, or "" if never generated. */
function getWebhookToken_() {
  return PropertiesService.getScriptProperties().getProperty(
    RZP_PROP_WEBHOOK_TOKEN
  ) || "";
}

/**
 * Safe status for the UI and for settings.html. Never returns a secret.
 * @return {Object}
 */
function getPaymentModuleStatus(sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var props = PropertiesService.getScriptProperties();
    var config = getPaymentConfig();

    return {
      success: true,
      enabled: config.enabled === true,
      credentialsConfigured: !!(
        props.getProperty(RZP_PROP_KEY_ID) && props.getProperty(RZP_PROP_KEY_SECRET)
      ),
      webhookConfigured: !!props.getProperty(RZP_PROP_WEBHOOK_TOKEN),
      mode: props.getProperty(RZP_PROP_MODE) || "not set",
      defaultAmountPaise: config.default_amount_paise,
      holdMinutes: config.hold_minutes,
      paymentRequiredTypes: config.payment_required_types,
      canRefund: getUserAccessLevel(session.role) <= config.refund_min_role_level,
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Money helpers — paise is the only unit stored anywhere.
// ---------------------------------------------------------------------------

/** @param {number} paise @return {string} e.g. "Rs 500" or "Rs 500.50" */
function formatPaise(paise) {
  var n = Number(paise) || 0;
  var rupees = n / 100;
  return "Rs " + (rupees % 1 === 0 ? rupees.toFixed(0) : rupees.toFixed(2));
}

/** @param {number|string} rupees @return {number} integer paise */
function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

// ---------------------------------------------------------------------------
// Health check — the "done when" test for WP1 and WP2.
// ---------------------------------------------------------------------------

/**
 * Run from the Apps Script editor after setup. Reports what is configured and
 * whether Razorpay is reachable. Prints no secrets.
 * @return {Object}
 */
function paymentModuleHealthCheck() {
  var report = { sheets: {}, config: {}, credentials: {}, provider: {} };
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var sheets = [PAYMENT_SHEET, REFUND_SHEET, PAYMENT_LOG_SHEET];
  for (var i = 0; i < sheets.length; i++) {
    var sheet = ss.getSheetByName(sheets[i]);
    report.sheets[sheets[i]] = sheet
      ? "OK (" + Math.max(0, sheet.getLastRow() - 1) + " rows)"
      : "MISSING — run initializePaymentSheets()";
  }

  var config = getPaymentConfig();
  report.config = {
    enabled: config.enabled,
    defaultAmount: formatPaise(config.default_amount_paise),
    holdMinutes: config.hold_minutes,
    paymentRequiredTypes: config.payment_required_types,
    refundMinRoleLevel: config.refund_min_role_level,
  };

  var props = PropertiesService.getScriptProperties();
  report.credentials = {
    keyId: props.getProperty(RZP_PROP_KEY_ID) ? "set" : "MISSING",
    keySecret: props.getProperty(RZP_PROP_KEY_SECRET) ? "set" : "MISSING",
    webhookToken: props.getProperty(RZP_PROP_WEBHOOK_TOKEN) ? "set" : "MISSING",
    mode: props.getProperty(RZP_PROP_MODE) || "not set",
  };

  if (report.credentials.keyId === "set" && report.credentials.keySecret === "set") {
    report.provider = testRazorpayConnection();
  } else {
    report.provider = { success: false, message: "Credentials not configured yet." };
  }

  // Appointment types are configured in generalSettings!D2 (Code.js:5814);
  // confirm the payment-required list actually matches what is in use there.
  try {
    var types = getAppointmentTypes();
    if (types && types.success) {
      report.config.appointmentTypesInUse = types.appointmentTypes;
      report.config.note =
        "Check payment_required_types against appointmentTypesInUse — they must match the strings in generalSettings!D2.";
    }
  } catch (e) {
    report.config.appointmentTypesInUse = "could not read: " + e.toString();
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
