/**
 * PaymentService.gs — provider-agnostic payment orchestration.
 *
 * This file owns the payment state machine and all payment sheet I/O.
 * It never calls Razorpay directly — everything goes through
 * getPaymentProvider_() (RazorpayAdapter.gs), so the module can be lifted
 * into the new EMR by reimplementing the adapter alone (handoff §2, §34).
 *
 * Design notes that are easy to get wrong later:
 *   - Money is integer paise everywhere. Rupees exist only in display strings.
 *   - Nothing is written to the `appointment` sheet. cancelAppointment()
 *     (Code.js:10629) copies rows by numeric index into `cancel` and deletes
 *     the original, so payment columns there would not survive a cancellation.
 *   - A SLOT_HELD appointment row already blocks its slot, because
 *     getBookedSlots() (Code.js:7592) counts every row regardless of status.
 *   - Every state change goes through transitionPayment_() under a script lock.
 *     Nothing else may write PaymentStatus.
 *
 * See paymentPlan.md.
 */

// ---------------------------------------------------------------------------
// Status vocabularies (§16) — the two machines are deliberately independent.
// ---------------------------------------------------------------------------

var PAYMENT_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
};

var APPOINTMENT_PAYMENT_STATUS = {
  REQUESTED: "REQUESTED",
  SLOT_HELD: "SLOT_HELD",
  CONFIRMED: "CONFIRMED",
  RELEASED: "RELEASED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
};

var REFUND_STATUS = {
  NONE: "NONE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  REFUND_PENDING: "REFUND_PENDING",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED",
  REFUND_FAILED: "REFUND_FAILED",
};

var PAYMENT_LOCK_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Run fn holding the script lock. This project had no LockService use before
 * payments; the webhook, the expiry sweep and two receptionists genuinely race
 * here, so every state change must be serialized.
 *
 * @param {Function} fn
 * @return {*} fn's return value, or a failure object if the lock is unavailable
 */
function withPaymentLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(PAYMENT_LOCK_TIMEOUT_MS);
  } catch (e) {
    return {
      success: false,
      message: "System busy, please try again in a moment.",
      code: "LOCK_TIMEOUT",
    };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Payment reference (§4)
// ---------------------------------------------------------------------------

/**
 * SAMP-APT-YYYYMMDD-NNNNNN, unique for the life of the clinic.
 * The counter lives in Script Properties and is only ever incremented while
 * the caller holds the payment lock.
 * @return {string}
 */
function generatePaymentRef_() {
  var tz = Session.getScriptTimeZone();
  var datePart = Utilities.formatDate(new Date(), tz, "yyyyMMdd");
  var props = PropertiesService.getScriptProperties();
  var propKey = PAYMENT_SEQ_PROP_PREFIX + datePart;

  var next = Number(props.getProperty(propKey) || 0) + 1;
  props.setProperty(propKey, String(next));

  var padded = ("000000" + next).slice(-6);
  return "SAMP-APT-" + datePart + "-" + padded;
}

// ---------------------------------------------------------------------------
// Appointment lookup
// ---------------------------------------------------------------------------

/**
 * Find an appointment in `appointment`, then `cancel`, then `archive`.
 * Returns which sheet it was found in, which the payment row records so a
 * later cancellation or archive does not orphan the payment.
 *
 * @param {string} appointmentId
 * @return {{found: boolean, sheetName: string, appointment: Object}}
 */
function findAppointmentAnywhere_(appointmentId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var candidates = ["appointment", "cancel", "archive", "appointment_archive"];
  var searchId = String(appointmentId).trim();

  for (var s = 0; s < candidates.length; s++) {
    var sheet = ss.getSheetByName(candidates[s]);
    if (!sheet) continue;

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;
    var headers = values[0];

    for (var r = 1; r < values.length; r++) {
      if (String(values[r][0] || "").trim() !== searchId) continue;

      var appointment = {};
      for (var c = 0; c < headers.length; c++) {
        var key = String(headers[c] || "").trim();
        if (key) appointment[key] = values[r][c];
      }
      return { found: true, sheetName: candidates[s], appointment: appointment };
    }
  }
  return { found: false, sheetName: "", appointment: null };
}

// ---------------------------------------------------------------------------
// Payment row access
// ---------------------------------------------------------------------------

/**
 * Locate a payment row by reference, appointment id, or provider link id.
 * @param {Object} query one of { paymentRef, appointmentId, providerLinkId }
 * @return {{found: boolean, table: Object, sheetRow: number, payment: Object}}
 */
function findPaymentRow_(query) {
  var table = readPaymentTable_(PAYMENT_SHEET);
  var column, wanted;

  if (query.paymentRef) {
    column = "PaymentRef";
    wanted = String(query.paymentRef).trim();
  } else if (query.providerLinkId) {
    column = "ProviderLinkId";
    wanted = String(query.providerLinkId).trim();
  } else if (query.appointmentId) {
    column = "AppointmentID";
    wanted = String(query.appointmentId).trim();
  } else {
    return { found: false, table: table, sheetRow: -1, payment: null };
  }

  var colIndex = table.index[column];
  if (colIndex === undefined) {
    return { found: false, table: table, sheetRow: -1, payment: null };
  }

  // Search backwards: an appointment can accumulate several payment requests
  // (one cancelled, one live) and the latest is the one that matters.
  for (var i = table.rows.length - 1; i >= 0; i--) {
    if (String(table.rows[i][colIndex] || "").trim() !== wanted) continue;
    return {
      found: true,
      table: table,
      sheetRow: i + 2, // +1 for the header, +1 for 1-based rows
      payment: rowToObject_(table.rows[i], table.index),
    };
  }
  return { found: false, table: table, sheetRow: -1, payment: null };
}

/**
 * The single writer of PaymentStatus / AppointmentStatus.
 *
 * @param {Object} located     result of findPaymentRow_
 * @param {Array<string>|null} expectedFrom  allowed current PaymentStatus values,
 *                                           or null to skip the guard
 * @param {Object} fields      columns to write (may include PaymentStatus)
 * @param {Object} context     { actor, eventType, detail }
 * @return {{success: boolean, changed: boolean, message: string}}
 */
function transitionPayment_(located, expectedFrom, fields, context) {
  if (!located || !located.found) {
    return { success: false, changed: false, message: "Payment record not found." };
  }

  var current = String(located.payment.PaymentStatus || "").trim();
  if (expectedFrom && expectedFrom.indexOf(current) === -1) {
    // Not an error — this is how duplicate webhooks and a racing expiry sweep
    // are absorbed (§13, §17).
    logPaymentEvent({
      eventType: (context && context.eventType) || PAYMENT_EVENTS.WEBHOOK_DUPLICATE,
      appointmentId: located.payment.AppointmentID,
      paymentRef: located.payment.PaymentRef,
      providerLinkId: located.payment.ProviderLinkId,
      providerPaymentId: located.payment.ProviderPaymentId,
      actor: (context && context.actor) || "SYSTEM",
      result: "IGNORED",
      detail: {
        reason: "status guard",
        currentStatus: current,
        expected: expectedFrom,
        attempted: fields.PaymentStatus || "(no status change)",
      },
    });
    return {
      success: true,
      changed: false,
      message: "Already in status " + current + " — no change made.",
    };
  }

  fields.LastEventAt = new Date();
  writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, fields);

  return { success: true, changed: true, message: "" };
}

// ---------------------------------------------------------------------------
// Formatting helpers (local to the module so it stays portable)
// ---------------------------------------------------------------------------

/** "2026-08-29" or a Date -> "29 August 2026" */
function formatAppointmentDateLong_(value) {
  if (!value) return "";
  var date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "d MMMM yyyy");
}

/** "16:30" or a Date -> "4:30 PM" */
function formatAppointmentTime12h_(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "h:mm a");
  }
  var text = String(value).trim();
  var match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text;
  var hours = Number(match[1]);
  var minutes = match[2];
  var suffix = hours >= 12 ? "PM" : "AM";
  var display = hours % 12;
  if (display === 0) display = 12;
  return display + ":" + minutes + " " + suffix;
}

/** "yyyy-MM-dd" for storage/comparison. */
function formatAppointmentDateIso_(value) {
  if (!value) return "";
  var date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * "98XXXXXXXX" -> "919XXXXXXXXX".
 * Deliberately a local copy rather than broadcast.js's cleanPhoneNumber_, so
 * the payment module carries no dependency outside its own files.
 */
function paymentNormalizeMobile_(phone) {
  var digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.indexOf("91") === 0) return digits;
  if (digits.length === 11 && digits.indexOf("0") === 0) return "91" + digits.slice(1);
  return digits;
}

/** True if the mobile number looks like a sendable Indian number. */
function isValidPaymentMobile_(phone) {
  var normalized = paymentNormalizeMobile_(phone);
  return /^91[6-9]\d{9}$/.test(normalized);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Whether an appointment type defaults to payment-required (§3 of the brief).
 * Reception can always tick the box on or off; this only sets the default.
 * Matching is case- and separator-insensitive because the type strings live in
 * generalSettings!D2 (Code.js:5814) and vary in spelling.
 *
 * @param {string} appointmentType
 * @return {boolean}
 */
function isPaymentRequiredByDefault(appointmentType) {
  var config = getPaymentConfig();
  if (config.enabled !== true) return false;

  var normalize = function (value) {
    return String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  };
  var target = normalize(appointmentType);
  if (!target) return false;

  var list = config.payment_required_types || [];
  for (var i = 0; i < list.length; i++) {
    if (normalize(list[i]) === target) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Create Payment Request (§6)
// ---------------------------------------------------------------------------

/**
 * Generate a payment link for an appointment and put the slot on hold.
 *
 * @param {Object} request
 * @param {string} request.appointmentId
 * @param {string} request.sessionToken
 * @param {number} [request.amountPaise]  Overrides the configured default
 * @param {string} [request.mobile]       Reception-confirmed number (§1)
 * @param {string} [request.remarks]
 * @return {Object} { success, paymentRef, paymentUrl, whatsapp: {...}, ... }
 */
function createPaymentRequest(request) {
  try {
    request = request || {};

    var session = getUserSession(request.sessionToken);
    if (!session) {
      return { success: false, message: "Session expired. Please login again." };
    }

    var config = getPaymentConfig();
    if (config.enabled !== true) {
      return {
        success: false,
        message: "Online payments are currently disabled for this clinic.",
      };
    }

    if (!request.appointmentId) {
      return { success: false, message: "Appointment ID is required." };
    }

    var found = findAppointmentAnywhere_(request.appointmentId);
    if (!found.found) {
      return {
        success: false,
        message: "Appointment not found: " + request.appointmentId,
      };
    }
    if (found.sheetName !== "appointment") {
      return {
        success: false,
        message:
          "This appointment is in the '" +
          found.sheetName +
          "' sheet and can no longer take a payment.",
      };
    }

    var appointment = found.appointment;

    // Mobile: reception must confirm it, because that is where the link goes.
    var mobile = request.mobile || appointment.Phone || "";
    if (!isValidPaymentMobile_(mobile)) {
      return {
        success: false,
        message:
          "A valid 10-digit mobile number is required to send the payment link. Got: " +
          (mobile || "(blank)"),
      };
    }

    // Amount
    var amountPaise = config.default_amount_paise;
    if (request.amountPaise !== undefined && request.amountPaise !== null && request.amountPaise !== "") {
      var requested = Math.round(Number(request.amountPaise));
      if (isNaN(requested)) {
        return { success: false, message: "Invalid amount." };
      }
      if (requested !== config.default_amount_paise) {
        if (config.allow_amount_override !== true) {
          return { success: false, message: "Amount override is not permitted." };
        }
        if (requested < config.min_amount_paise || requested > config.max_amount_paise) {
          return {
            success: false,
            message:
              "Amount must be between " +
              formatPaise(config.min_amount_paise) +
              " and " +
              formatPaise(config.max_amount_paise) +
              ".",
          };
        }
      }
      amountPaise = requested;
    }

    return withPaymentLock_(function () {
      // Refuse a second live request for the same appointment (§13 layer 1).
      var existing = findPaymentRow_({ appointmentId: request.appointmentId });
      if (existing.found) {
        var currentStatus = String(existing.payment.PaymentStatus || "");
        if (currentStatus === PAYMENT_STATUS.PAID) {
          return {
            success: false,
            code: "ALREADY_PAID",
            message:
              "This appointment has already been paid (" +
              existing.payment.PaymentRef +
              ").",
            paymentRef: existing.payment.PaymentRef,
          };
        }
        if (currentStatus === PAYMENT_STATUS.PENDING) {
          return {
            success: false,
            code: "ALREADY_PENDING",
            message:
              "A payment link is already active for this appointment. Cancel it first, or use Check Payment.",
            paymentRef: existing.payment.PaymentRef,
            paymentUrl: existing.payment.PaymentUrl,
          };
        }
        // EXPIRED / CANCELLED / FAILED fall through — a fresh request is fine.
      }

      var now = new Date();
      var holdMinutes = Number(config.hold_minutes) || 15;
      var bufferMinutes = Number(config.link_expiry_buffer_minutes) || 5;
      var holdExpiresAt = new Date(now.getTime() + holdMinutes * 60 * 1000);
      var linkExpiresAt = new Date(
        now.getTime() + (holdMinutes + bufferMinutes) * 60 * 1000
      );

      var paymentRef = generatePaymentRef_();
      var patientName = String(appointment.PatientName || appointment.Name || "Patient");
      var dateDisplay = formatAppointmentDateLong_(appointment.AppointmentDate);
      var timeDisplay = formatAppointmentTime12h_(appointment.TimeSlot);

      var provider = getPaymentProvider_();
      var created = provider.createPaymentLink({
        reference: paymentRef,
        amountPaise: amountPaise,
        currency: config.currency || "INR",
        description:
          "Appointment booking amount — " +
          config.clinic_display_name +
          " — " +
          dateDisplay +
          (timeDisplay ? " " + timeDisplay : ""),
        customerName: patientName,
        customerContact: "+" + paymentNormalizeMobile_(mobile),
        expiresAt: linkExpiresAt,
        notes: {
          payment_ref: paymentRef,
          appointment_id: String(request.appointmentId),
          mrd: String(appointment.MRDNo || ""),
        },
      });

      if (!created.ok) {
        // §32: a link that could not be created must not confirm anything and
        // must leave no half-written payment row behind.
        logPaymentEvent({
          eventType: PAYMENT_EVENTS.PROVIDER_ERROR,
          appointmentId: request.appointmentId,
          paymentRef: paymentRef,
          amountPaise: amountPaise,
          actor: session.username || "UNKNOWN",
          result: "FAIL",
          detail: { stage: "createPaymentLink", providerCode: created.error && created.error.code },
          error: created.message,
        });
        return {
          success: false,
          code: "PROVIDER_ERROR",
          message: "Could not create the payment link: " + created.message,
        };
      }

      var link = created.link;
      var table = readPaymentTable_(PAYMENT_SHEET);
      var row = new Array(table.headers.length).fill("");
      var set = function (header, value) {
        if (table.index[header] !== undefined) row[table.index[header]] = value;
      };

      set("PaymentRef", paymentRef);
      set("AppointmentID", String(request.appointmentId));
      set("AppointmentSheet", "appointment");
      set("MRDNo", String(appointment.MRDNo || ""));
      set("PatientName", patientName);
      set("Mobile", paymentNormalizeMobile_(mobile));
      set("AppointmentDate", formatAppointmentDateIso_(appointment.AppointmentDate));
      set("AppointmentTime", timeDisplay);
      set("AppointmentType", String(appointment.AppointmentType || ""));
      set("AmountPaise", amountPaise);
      set("Currency", config.currency || "INR");
      set("Provider", provider.name);
      set("ProviderLinkId", link.providerLinkId);
      set("PaymentUrl", link.url);
      set("PaymentStatus", PAYMENT_STATUS.PENDING);
      set("ProviderPaymentId", "");
      set("PaidAmountPaise", "");
      set("PaidAt", "");
      set("LinkCreatedAt", now);
      set("HoldExpiresAt", holdExpiresAt);
      set("LinkExpiresAt", link.expiresAt || linkExpiresAt);
      set("AppointmentStatus", APPOINTMENT_PAYMENT_STATUS.SLOT_HELD);
      set("RefundStatus", REFUND_STATUS.NONE);
      set("RefundedAmountPaise", 0);
      set("ConfirmationEmailSent", "No");
      set("CreatedBy", session.username || "UNKNOWN");
      set("LastEventAt", now);
      set("Remarks", request.remarks || "");

      table.sheet.appendRow(row);

      logPaymentEvent({
        eventType: PAYMENT_EVENTS.PAYMENT_LINK_CREATED,
        appointmentId: String(request.appointmentId),
        paymentRef: paymentRef,
        providerLinkId: link.providerLinkId,
        amountPaise: amountPaise,
        actor: session.username || "UNKNOWN",
        result: "OK",
        detail: {
          holdMinutes: holdMinutes,
          holdExpiresAt: holdExpiresAt.toISOString(),
          mobile: paymentNormalizeMobile_(mobile),
        },
      });

      try {
        logAuditEvent(
          request.sessionToken,
          "CREATE_PAYMENT_LINK",
          "PAYMENT",
          paymentRef,
          {
            appointmentId: String(request.appointmentId),
            amount: formatPaise(amountPaise),
            mrd: String(appointment.MRDNo || ""),
            sheetName: PAYMENT_SHEET,
          }
        );
      } catch (auditError) {
        Logger.log("Payment audit log failed: " + auditError.toString());
      }

      var whatsapp = buildPaymentWhatsAppMessage_({
        PatientName: patientName,
        Mobile: paymentNormalizeMobile_(mobile),
        AppointmentDate: appointment.AppointmentDate,
        AppointmentTime: timeDisplay,
        AmountPaise: amountPaise,
        PaymentUrl: link.url,
      });

      return {
        success: true,
        message: "Payment link created. Slot held for " + holdMinutes + " minutes.",
        paymentRef: paymentRef,
        paymentUrl: link.url,
        providerLinkId: link.providerLinkId,
        amountPaise: amountPaise,
        amountDisplay: formatPaise(amountPaise),
        paymentStatus: PAYMENT_STATUS.PENDING,
        appointmentStatus: APPOINTMENT_PAYMENT_STATUS.SLOT_HELD,
        holdExpiresAt: holdExpiresAt.toISOString(),
        holdMinutes: holdMinutes,
        whatsapp: whatsapp,
      };
    });
  } catch (e) {
    Logger.log("createPaymentRequest failed: " + e.toString());
    return { success: false, message: "Error creating payment request: " + e.toString() };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp message (§9)
// ---------------------------------------------------------------------------

/**
 * Build the ready-to-send message and a one-click wa.me link.
 *
 * Phase 1 is deliberately manual: AiSensy is campaign/template based
 * (broadcast.js:360) and sending a link automatically needs a Meta-approved
 * template with a URL button. Until that exists, reception clicks through.
 *
 * @param {Object} payment  a payment row (or the equivalent fields)
 * @return {{message: string, waLink: string, mobile: string}}
 */
function buildPaymentWhatsAppMessage_(payment) {
  var config = getPaymentConfig();
  var dateDisplay = formatAppointmentDateLong_(payment.AppointmentDate);
  var timeDisplay = payment.AppointmentTime
    ? formatAppointmentTime12h_(payment.AppointmentTime)
    : "";
  var amountDisplay = formatPaise(payment.AmountPaise);

  var lines = [
    config.clinic_display_name,
    "",
    "Your appointment slot for " +
      dateDisplay +
      (timeDisplay ? " at " + timeDisplay : "") +
      " is temporarily reserved.",
    "",
    "Booking amount: " + amountDisplay,
    "",
    "Please complete payment using the link below to confirm the appointment:",
    payment.PaymentUrl,
    "",
    "Your appointment will be confirmed after successful payment.",
  ];

  var message = lines.join("\n");
  var mobile = paymentNormalizeMobile_(payment.Mobile);

  return {
    message: message,
    mobile: mobile,
    waLink: "https://wa.me/" + mobile + "?text=" + encodeURIComponent(message),
  };
}

/**
 * UI entry point for the Copy/Send action, and the place that records
 * PAYMENT_LINK_SENT so the log shows the link actually went out (§30).
 */
function getPaymentWhatsAppMessage(paymentRef, sessionToken, markAsSent) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var located = findPaymentRow_({ paymentRef: paymentRef });
    if (!located.found) return { success: false, message: "Payment record not found." };

    var whatsapp = buildPaymentWhatsAppMessage_(located.payment);

    if (markAsSent) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.PAYMENT_LINK_SENT,
        appointmentId: located.payment.AppointmentID,
        paymentRef: located.payment.PaymentRef,
        providerLinkId: located.payment.ProviderLinkId,
        amountPaise: located.payment.AmountPaise,
        actor: session.username || "UNKNOWN",
        result: "OK",
        detail: { channel: "whatsapp_manual", mobile: whatsapp.mobile },
      });
    }

    return { success: true, whatsapp: whatsapp };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Verification — the shared reconciliation path (§11, §14)
// ---------------------------------------------------------------------------

/**
 * Check Payment. Fetches authoritative state from the provider and applies it.
 *
 * This is the SAME code path the webhook uses, which is the point: a missed
 * webhook and a manual check can never produce different outcomes.
 *
 * @param {string} paymentRef
 * @param {string} sessionToken
 * @return {Object} payment summary after reconciliation
 */
function checkPaymentStatus(paymentRef, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };
    return reconcilePayment_(paymentRef, session.username || "UNKNOWN", {
      eventType: PAYMENT_EVENTS.MANUAL_CHECK,
    });
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Pull provider state for one payment and move our records to match.
 * Callable with actor "WEBHOOK" or "SYSTEM" from the webhook and the sweep.
 *
 * @param {string} paymentRef
 * @param {string} actor
 * @param {Object} [context] { eventType, providerEventId }
 * @return {Object}
 */
function reconcilePayment_(paymentRef, actor, context) {
  context = context || {};

  var located = findPaymentRow_({ paymentRef: paymentRef });
  if (!located.found) {
    return { success: false, message: "Payment record not found: " + paymentRef };
  }
  var payment = located.payment;

  if (!payment.ProviderLinkId) {
    return { success: false, message: "Payment record has no provider link id." };
  }

  var provider = getPaymentProvider_();
  var fetched = provider.fetchPaymentLink(payment.ProviderLinkId);
  if (!fetched.ok) {
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.VERIFICATION_FAILED,
      appointmentId: payment.AppointmentID,
      paymentRef: paymentRef,
      providerLinkId: payment.ProviderLinkId,
      actor: actor,
      result: "FAIL",
      providerEventId: context.providerEventId || "",
      error: fetched.message,
    });
    return {
      success: false,
      message: "Could not reach the payment provider: " + fetched.message,
    };
  }

  return withPaymentLock_(function () {
    // Re-read inside the lock — another writer may have moved since.
    var fresh = findPaymentRow_({ paymentRef: paymentRef });
    if (!fresh.found) {
      return { success: false, message: "Payment record disappeared." };
    }
    return applyProviderLinkState_(fresh, fetched.link, actor, context);
  });
}

/**
 * Apply authoritative provider state to a payment row. Must be called under
 * the payment lock.
 *
 * Every financial decision in the module is made here and nowhere else.
 *
 * @param {Object} located  findPaymentRow_ result (fresh, inside the lock)
 * @param {Object} link     normalized provider link
 * @param {string} actor
 * @param {Object} context
 * @return {Object} payment summary
 */
function applyProviderLinkState_(located, link, actor, context) {
  var payment = located.payment;
  var expectedPaise = Number(payment.AmountPaise) || 0;
  var currentStatus = String(payment.PaymentStatus || "");

  // ---- Paid ---------------------------------------------------------------
  if (link.status === "paid") {
    var settled = link.payments && link.payments.length ? link.payments[0] : null;
    var providerPaymentId = settled ? settled.providerPaymentId : "";
    var paidPaise = Number(link.amountPaidPaise) || (settled ? settled.amountPaise : 0);
    var paidAt = settled && settled.createdAt ? settled.createdAt : new Date();

    // §13: already processed — do nothing, say nothing new, send nothing.
    if (currentStatus === PAYMENT_STATUS.PAID) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_DUPLICATE,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerLinkId: link.providerLinkId,
        providerPaymentId: providerPaymentId,
        actor: actor,
        result: "IGNORED",
        providerEventId: context.providerEventId || "",
        detail: { reason: "payment already recorded as PAID" },
      });
      return buildPaymentSummary_(payment, {
        success: true,
        changed: false,
        message: "Payment was already recorded.",
      });
    }

    // §32: amount mismatch never auto-confirms.
    if (paidPaise !== expectedPaise) {
      transitionPayment_(
        located,
        null,
        {
          PaymentStatus: PAYMENT_STATUS.PAID,
          ProviderPaymentId: providerPaymentId,
          PaidAmountPaise: paidPaise,
          PaidAt: paidAt,
          AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.MANUAL_REVIEW_REQUIRED,
          Remarks: appendRemark_(
            payment.Remarks,
            "Amount mismatch: expected " +
              formatPaise(expectedPaise) +
              ", received " +
              formatPaise(paidPaise)
          ),
        },
        { actor: actor, eventType: PAYMENT_EVENTS.AMOUNT_MISMATCH }
      );
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.AMOUNT_MISMATCH,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerLinkId: link.providerLinkId,
        providerPaymentId: providerPaymentId,
        amountPaise: paidPaise,
        actor: actor,
        result: "FAIL",
        providerEventId: context.providerEventId || "",
        detail: { expectedPaise: expectedPaise, receivedPaise: paidPaise },
      });
      notifyPaymentNeedsReview_(
        payment.PaymentRef,
        "Amount mismatch: expected " +
          formatPaise(expectedPaise) +
          " but " +
          formatPaise(paidPaise) +
          " was received."
      );

      return buildPaymentSummary_(readPaymentAfterWrite_(payment.PaymentRef), {
        success: true,
        changed: true,
        message:
          "Amount mismatch — flagged for manual review. Expected " +
          formatPaise(expectedPaise) +
          ", received " +
          formatPaise(paidPaise) +
          ".",
      });
    }

    // §18: late payment after the slot was released must never reconfirm.
    var holdExpiresAt = payment.HoldExpiresAt ? new Date(payment.HoldExpiresAt) : null;
    var slotAlreadyReleased =
      String(payment.AppointmentStatus || "") === APPOINTMENT_PAYMENT_STATUS.RELEASED ||
      currentStatus === PAYMENT_STATUS.EXPIRED ||
      currentStatus === PAYMENT_STATUS.CANCELLED;
    var paidAfterDeadline =
      holdExpiresAt && !isNaN(holdExpiresAt.getTime()) && paidAt > holdExpiresAt;

    if (slotAlreadyReleased || paidAfterDeadline) {
      transitionPayment_(
        located,
        null,
        {
          PaymentStatus: PAYMENT_STATUS.PAID,
          ProviderPaymentId: providerPaymentId,
          PaidAmountPaise: paidPaise,
          PaidAt: paidAt,
          AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.MANUAL_REVIEW_REQUIRED,
          Remarks: appendRemark_(
            payment.Remarks,
            "Late payment received after the hold expired — staff decision required."
          ),
        },
        { actor: actor, eventType: PAYMENT_EVENTS.LATE_PAYMENT_RECEIVED }
      );
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.LATE_PAYMENT_RECEIVED,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerLinkId: link.providerLinkId,
        providerPaymentId: providerPaymentId,
        amountPaise: paidPaise,
        actor: actor,
        result: "OK",
        providerEventId: context.providerEventId || "",
        detail: {
          holdExpiresAt: holdExpiresAt ? holdExpiresAt.toISOString() : "",
          paidAt: paidAt.toISOString(),
          slotAlreadyReleased: slotAlreadyReleased,
        },
      });
      notifyPaymentNeedsReview_(
        payment.PaymentRef,
        "Payment arrived after the slot hold expired. The slot may already have been given to another patient — it must NOT be taken back."
      );

      return buildPaymentSummary_(readPaymentAfterWrite_(payment.PaymentRef), {
        success: true,
        changed: true,
        message:
          "Payment received AFTER the slot was released. Flagged for manual review — the appointment has NOT been reconfirmed.",
      });
    }

    // Happy path.
    transitionPayment_(
      located,
      [PAYMENT_STATUS.PENDING],
      {
        PaymentStatus: PAYMENT_STATUS.PAID,
        ProviderPaymentId: providerPaymentId,
        PaidAmountPaise: paidPaise,
        PaidAt: paidAt,
        AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.CONFIRMED,
      },
      { actor: actor, eventType: PAYMENT_EVENTS.PAYMENT_CONFIRMED }
    );
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_CONFIRMED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      providerLinkId: link.providerLinkId,
      providerPaymentId: providerPaymentId,
      amountPaise: paidPaise,
      actor: actor,
      result: "OK",
      providerEventId: context.providerEventId || "",
      detail: { method: settled ? settled.method : "" },
    });

    // WP6 seam: the confirmation email (§15) is sent from PaymentNotify.gs.
    // Until that lands, ConfirmationEmailSent stays "No" and the event log is
    // the record of the confirmation.
    notifyPaymentConfirmed_(payment.PaymentRef);

    return buildPaymentSummary_(readPaymentAfterWrite_(payment.PaymentRef), {
      success: true,
      changed: true,
      message: "Payment received. Appointment CONFIRMED.",
    });
  }

  // ---- Expired ------------------------------------------------------------
  if (link.status === "expired") {
    var expiredResult = transitionPayment_(
      located,
      [PAYMENT_STATUS.PENDING],
      { PaymentStatus: PAYMENT_STATUS.EXPIRED },
      { actor: actor, eventType: PAYMENT_EVENTS.PAYMENT_EXPIRED }
    );
    if (expiredResult.changed) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.PAYMENT_EXPIRED,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerLinkId: link.providerLinkId,
        actor: actor,
        result: "OK",
        providerEventId: context.providerEventId || "",
      });
    }
    return buildPaymentSummary_(readPaymentAfterWrite_(payment.PaymentRef), {
      success: true,
      changed: expiredResult.changed,
      message: "Payment link has expired.",
    });
  }

  // ---- Cancelled ----------------------------------------------------------
  if (link.status === "cancelled") {
    var cancelledResult = transitionPayment_(
      located,
      [PAYMENT_STATUS.PENDING],
      { PaymentStatus: PAYMENT_STATUS.CANCELLED },
      { actor: actor, eventType: PAYMENT_EVENTS.PAYMENT_LINK_CANCELLED }
    );
    return buildPaymentSummary_(readPaymentAfterWrite_(payment.PaymentRef), {
      success: true,
      changed: cancelledResult.changed,
      message: "Payment link was cancelled.",
    });
  }

  // ---- Still open ---------------------------------------------------------
  return buildPaymentSummary_(payment, {
    success: true,
    changed: false,
    message: "No payment received yet.",
  });
}

/** Re-read a payment row after writing, so the summary reflects the new state. */
function readPaymentAfterWrite_(paymentRef) {
  var located = findPaymentRow_({ paymentRef: paymentRef });
  return located.found ? located.payment : null;
}

/** Append a dated note to the Remarks cell without losing what was there. */
function appendRemark_(existing, note) {
  var stamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyy-MM-dd HH:mm"
  );
  var line = "[" + stamp + "] " + note;
  return existing ? String(existing) + "\n" + line : line;
}

/**
 * Clinic confirmation email (§15), implemented in PaymentNotify.gs.
 * Wrapped so a mail failure can never roll back a confirmed payment — the money
 * has arrived and the appointment is confirmed regardless of whether the email
 * got out. The failure is recorded in paymentLog instead.
 */
function notifyPaymentConfirmed_(paymentRef) {
  try {
    sendPaymentConfirmationEmail_(paymentRef);
  } catch (e) {
    Logger.log("notifyPaymentConfirmed_ failed for " + paymentRef + ": " + e.toString());
  }
}

/** Clinic alert for anything a human has to decide (§18, §32). */
function notifyPaymentNeedsReview_(paymentRef, reason) {
  try {
    sendPaymentReviewAlert_(paymentRef, reason);
  } catch (e) {
    Logger.log("notifyPaymentNeedsReview_ failed for " + paymentRef + ": " + e.toString());
  }
}

// ---------------------------------------------------------------------------
// Cancel Payment Request (§31)
// ---------------------------------------------------------------------------

/**
 * Cancel an unpaid payment request: kill the provider link, cancel the
 * appointment, and free the slot.
 *
 * The slot was only ever held pending payment, so cancelling the payment
 * cancels the booking — there is no in-between state. The appointment row has
 * to go, because getBookedSlots() (Code.js:7592) counts every row in the
 * `appointment` sheet regardless of status, so a row left behind would keep
 * blocking the slot.
 *
 * @param {string} paymentRef
 * @param {string} sessionToken
 * @param {string} [reason]
 */
function cancelPaymentRequest(paymentRef, sessionToken, reason) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    return withPaymentLock_(function () {
      var located = findPaymentRow_({ paymentRef: paymentRef });
      if (!located.found) {
        return { success: false, message: "Payment record not found." };
      }
      var payment = located.payment;

      if (String(payment.PaymentStatus) === PAYMENT_STATUS.PAID) {
        return {
          success: false,
          message:
            "This payment has already been received. Use Cancel & Refund instead.",
        };
      }
      if (String(payment.PaymentStatus) !== PAYMENT_STATUS.PENDING) {
        return {
          success: false,
          message: "Only a PENDING payment request can be cancelled.",
        };
      }

      var provider = getPaymentProvider_();
      var cancelled = provider.cancelPaymentLink(payment.ProviderLinkId);

      // A link that Razorpay has already expired cannot be cancelled, and that
      // is fine — our record still needs to move out of PENDING.
      if (!cancelled.ok) {
        logPaymentEvent({
          eventType: PAYMENT_EVENTS.PROVIDER_ERROR,
          appointmentId: payment.AppointmentID,
          paymentRef: paymentRef,
          providerLinkId: payment.ProviderLinkId,
          actor: session.username || "UNKNOWN",
          result: "FAIL",
          detail: { stage: "cancelPaymentLink" },
          error: cancelled.message,
        });
      }

      transitionPayment_(
        located,
        [PAYMENT_STATUS.PENDING],
        {
          PaymentStatus: PAYMENT_STATUS.CANCELLED,
          AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.RELEASED,
          Remarks: appendRemark_(
            payment.Remarks,
            "Payment request cancelled by " +
              (session.username || "staff") +
              (reason ? ": " + reason : "") +
              " — appointment cancelled and slot released."
          ),
        },
        { actor: session.username, eventType: PAYMENT_EVENTS.PAYMENT_LINK_CANCELLED }
      );

      logPaymentEvent({
        eventType: PAYMENT_EVENTS.PAYMENT_LINK_CANCELLED,
        appointmentId: payment.AppointmentID,
        paymentRef: paymentRef,
        providerLinkId: payment.ProviderLinkId,
        amountPaise: payment.AmountPaise,
        actor: session.username || "UNKNOWN",
        result: cancelled.ok ? "OK" : "FAIL",
        detail: { reason: reason || "", providerCancelled: cancelled.ok },
        error: cancelled.ok ? "" : cancelled.message,
      });

      try {
        logAuditEvent(sessionToken, "CANCEL_PAYMENT_LINK", "PAYMENT", paymentRef, {
          appointmentId: payment.AppointmentID,
          reason: reason || "",
          sheetName: PAYMENT_SHEET,
        });
      } catch (auditError) {
        Logger.log("Payment audit log failed: " + auditError.toString());
      }

      // Free the slot. Uses the same release path as the expiry sweep, so the
      // journey trail, tag migration and `cancel` sheet layout match a normal
      // staff cancellation.
      var slotReleased = false;
      if (String(payment.AppointmentSheet || "") === "appointment") {
        releaseHeldAppointmentSlot_(payment, sessionToken);
        var after = findAppointmentAnywhere_(payment.AppointmentID);
        slotReleased = after.found && after.sheetName !== "appointment";
      } else {
        // The appointment had already moved on — nothing left to release.
        slotReleased = true;
      }

      return {
        success: true,
        message: slotReleased
          ? "Payment request cancelled. Appointment cancelled and the slot released."
          : "Payment request cancelled, but the appointment could not be released — check it manually.",
        providerCancelled: cancelled.ok,
        slotReleased: slotReleased,
      };
    });
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Rescheduling (§29)
// ---------------------------------------------------------------------------

/**
 * Re-point a payment record at an appointment's new date and time.
 *
 * Rescheduling never refunds and never re-opens a payment — the money stays
 * exactly where it is (§29). What has to move is the snapshot: the payment row
 * caches AppointmentDate/AppointmentTime at link-creation time, and every
 * patient-facing message (confirmation email, refund email, refund WhatsApp)
 * reads them. Left unsynced they would quote the appointment the patient no
 * longer has.
 *
 * Called from rescheduleAppointment() (Code.js) for every reschedule, and safe
 * to call for appointments that have no payment at all.
 *
 * @param {string} appointmentId
 * @param {string} [sessionToken]
 * @param {Object} [previous]  { fromDate, fromTime } for the audit trail
 * @return {Object}
 */
function syncPaymentAfterReschedule(appointmentId, sessionToken, previous) {
  try {
    var located = findPaymentRow_({ appointmentId: appointmentId });
    if (!located.found) return { success: true, changed: false, hasPayment: false };

    var payment = located.payment;

    var found = findAppointmentAnywhere_(appointmentId);
    if (!found.found) {
      return { success: false, changed: false, message: "Appointment not found." };
    }

    var newDate = formatAppointmentDateIso_(found.appointment.AppointmentDate);
    var newTime = formatAppointmentTime12h_(found.appointment.TimeSlot);
    var oldDate = formatAppointmentDateIso_(payment.AppointmentDate);
    var oldTime = String(payment.AppointmentTime || "");

    if (newDate === oldDate && newTime === oldTime) {
      return { success: true, changed: false, hasPayment: true };
    }

    var actor = "SYSTEM";
    if (sessionToken) {
      var session = getUserSession(sessionToken);
      if (session) actor = session.username || "UNKNOWN";
    }

    writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
      AppointmentDate: newDate,
      AppointmentTime: newTime,
      AppointmentSheet: found.sheetName,
      LastEventAt: new Date(),
      Remarks: appendRemark_(
        payment.Remarks,
        "Appointment rescheduled from " +
          (oldDate || "?") +
          " " +
          (oldTime || "") +
          " to " +
          newDate +
          " " +
          newTime +
          " by " +
          actor +
          ". Payment unchanged."
      ),
    });

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.RESCHEDULE_LINKED,
      appointmentId: appointmentId,
      paymentRef: payment.PaymentRef,
      providerLinkId: payment.ProviderLinkId,
      providerPaymentId: payment.ProviderPaymentId,
      amountPaise: payment.PaidAmountPaise || payment.AmountPaise,
      actor: actor,
      result: "OK",
      detail: {
        from: {
          date: (previous && previous.fromDate) || oldDate,
          time: (previous && previous.fromTime) || oldTime,
        },
        to: { date: newDate, time: newTime },
        paymentStatus: payment.PaymentStatus,
        note: "payment carried over to the rescheduled appointment",
      },
    });

    return {
      success: true,
      changed: true,
      hasPayment: true,
      paymentRef: payment.PaymentRef,
      paymentStatus: payment.PaymentStatus,
      message:
        "Payment " +
        payment.PaymentRef +
        " (" +
        payment.PaymentStatus +
        ") carried over to " +
        newDate +
        " " +
        newTime +
        ".",
    };
  } catch (e) {
    Logger.log("syncPaymentAfterReschedule failed: " + e.toString());
    return { success: false, changed: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Read models for the reception UI (§31)
// ---------------------------------------------------------------------------

/** Shape one payment row for the front end. Contains no credentials. */
function buildPaymentSummary_(payment, outcome) {
  outcome = outcome || {};
  if (!payment) {
    return {
      success: outcome.success !== false,
      changed: !!outcome.changed,
      message: outcome.message || "",
      hasPayment: false,
    };
  }

  var holdExpiresAt = payment.HoldExpiresAt ? new Date(payment.HoldExpiresAt) : null;
  var holdValid = holdExpiresAt && !isNaN(holdExpiresAt.getTime());

  return {
    success: outcome.success !== false,
    changed: !!outcome.changed,
    message: outcome.message || "",
    hasPayment: true,
    paymentRef: payment.PaymentRef,
    appointmentId: payment.AppointmentID,
    patientName: payment.PatientName,
    mobile: payment.Mobile,
    amountPaise: Number(payment.AmountPaise) || 0,
    amountDisplay: formatPaise(payment.AmountPaise),
    paidAmountDisplay: payment.PaidAmountPaise
      ? formatPaise(payment.PaidAmountPaise)
      : "",
    paymentStatus: payment.PaymentStatus,
    appointmentStatus: payment.AppointmentStatus,
    refundStatus: payment.RefundStatus,
    paymentUrl: payment.PaymentUrl,
    providerPaymentId: payment.ProviderPaymentId,
    paidAt: payment.PaidAt ? new Date(payment.PaidAt).toISOString() : "",
    holdExpiresAt: holdValid ? holdExpiresAt.toISOString() : "",
    holdSecondsRemaining: holdValid
      ? Math.max(0, Math.round((holdExpiresAt.getTime() - Date.now()) / 1000))
      : 0,
    remarks: payment.Remarks || "",
  };
}

/**
 * Everything the payment panel needs for one appointment.
 * Returns hasPayment:false (plus the default amount) when none exists yet.
 */
function getPaymentSummary(appointmentId, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var config = getPaymentConfig();
    var located = findPaymentRow_({ appointmentId: appointmentId });

    if (!located.found) {
      var found = findAppointmentAnywhere_(appointmentId);
      var appointmentType = found.found
        ? String(found.appointment.AppointmentType || "")
        : "";
      return {
        success: true,
        hasPayment: false,
        paymentEnabled: config.enabled === true,
        paymentRequiredByDefault: isPaymentRequiredByDefault(appointmentType),
        defaultAmountPaise: config.default_amount_paise,
        defaultAmountDisplay: formatPaise(config.default_amount_paise),
        allowAmountOverride: config.allow_amount_override === true,
        holdMinutes: config.hold_minutes,
        mobile: found.found ? String(found.appointment.Phone || "") : "",
        canRefund: getUserAccessLevel(session.role) <= config.refund_min_role_level,
      };
    }

    var summary = buildPaymentSummary_(located.payment, { success: true });
    summary.paymentEnabled = config.enabled === true;
    summary.canRefund = getUserAccessLevel(session.role) <= config.refund_min_role_level;
    summary.whatsapp = buildPaymentWhatsAppMessage_(located.payment);
    return summary;
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Bulk read for list pages — one pass over the (small) payment sheet instead
 * of a lookup per row.
 * @param {Array<string>} appointmentIds
 * @return {Object} map of appointmentId -> compact status object
 */
function getPaymentStatusMap(appointmentIds, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var wanted = {};
    if (appointmentIds && appointmentIds.length) {
      for (var i = 0; i < appointmentIds.length; i++) {
        wanted[String(appointmentIds[i]).trim()] = true;
      }
    }

    var table = readPaymentTable_(PAYMENT_SHEET);
    var map = {};
    for (var r = 0; r < table.rows.length; r++) {
      var row = rowToObject_(table.rows[r], table.index);
      var id = String(row.AppointmentID || "").trim();
      if (!id) continue;
      if (appointmentIds && appointmentIds.length && !wanted[id]) continue;
      map[id] = {
        paymentRef: row.PaymentRef,
        paymentStatus: row.PaymentStatus,
        appointmentStatus: row.AppointmentStatus,
        refundStatus: row.RefundStatus,
        amountDisplay: formatPaise(row.AmountPaise),
      };
    }
    return { success: true, statuses: map };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}
