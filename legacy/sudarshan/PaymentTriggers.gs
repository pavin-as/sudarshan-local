/**
 * PaymentTriggers.gs — scheduled maintenance for the payment module (WP7).
 *
 * Two time-driven jobs:
 *
 *   sweepExpiredPaymentHolds()  every minute — releases slots whose payment
 *                               hold has run out, so an urgent slot is never
 *                               blocked indefinitely (§8, §17).
 *
 *   reconcileOpenPayments()     hourly — re-checks anything still PENDING well
 *                               past its hold. This is the safety net for a
 *                               webhook that never arrived (§14, §32).
 *
 * THE RACE THAT MATTERS (§17): a payment that completed before the deadline
 * must win, even if the sweep runs first. The sweep therefore never trusts its
 * own view of the sheet — for every candidate it asks Razorpay first, and only
 * releases the slot if the payment is genuinely still outstanding afterwards.
 */

// A minute's worth of work. Apps Script allows ~6 minutes per execution, and a
// release does several sheet operations plus up to two API calls.
var PAYMENT_SWEEP_BATCH_LIMIT = 15;
var PAYMENT_RECONCILE_BATCH_LIMIT = 25;

// ---------------------------------------------------------------------------
// Trigger installation
// ---------------------------------------------------------------------------

/**
 * Install both jobs. Idempotent — existing payment triggers are removed first,
 * so re-running never leaves duplicates behind.
 * Run once from the editor.
 */
function installPaymentTriggers() {
  removePaymentTriggers();

  ScriptApp.newTrigger("sweepExpiredPaymentHolds")
    .timeBased()
    .everyMinutes(1)
    .create();

  ScriptApp.newTrigger("reconcileOpenPayments").timeBased().everyHours(1).create();

  Logger.log("Payment triggers installed: sweep (1 min), reconcile (1 hour).");
  return { success: true, message: "Payment triggers installed." };
}

/** Remove this module's triggers, leaving every other project trigger alone. */
function removePaymentTriggers() {
  var ours = { sweepExpiredPaymentHolds: true, reconcileOpenPayments: true };
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;

  for (var i = 0; i < triggers.length; i++) {
    if (ours[triggers[i].getHandlerFunction()]) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  Logger.log("Removed " + removed + " payment trigger(s).");
  return { success: true, removed: removed };
}

/** What is currently scheduled. Useful when a hold does not seem to expire. */
function listPaymentTriggers() {
  var ours = { sweepExpiredPaymentHolds: true, reconcileOpenPayments: true };
  var found = [];
  var triggers = ScriptApp.getProjectTriggers();

  for (var i = 0; i < triggers.length; i++) {
    if (ours[triggers[i].getHandlerFunction()]) {
      found.push(triggers[i].getHandlerFunction());
    }
  }

  Logger.log("Payment triggers: " + (found.length ? found.join(", ") : "NONE INSTALLED"));
  return found;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Release slots whose payment hold has expired.
 * Runs as the script owner, with no session — actor is SYSTEM throughout.
 */
function sweepExpiredPaymentHolds() {
  try {
    var config = getPaymentConfig();
    if (config.enabled !== true) return { success: true, skipped: "module disabled" };

    var candidates = findExpiredHoldCandidates_(PAYMENT_SWEEP_BATCH_LIMIT);
    if (!candidates.length) return { success: true, released: 0, rescued: 0 };

    var released = 0;
    var rescued = 0;

    for (var i = 0; i < candidates.length; i++) {
      var outcome = expireOnePaymentHold_(candidates[i]);
      if (outcome === "released") released++;
      if (outcome === "rescued") rescued++;
    }

    Logger.log(
      "Payment sweep: " +
        candidates.length +
        " candidate(s), " +
        released +
        " released, " +
        rescued +
        " rescued by a late-arriving payment."
    );
    return { success: true, released: released, rescued: rescued };
  } catch (e) {
    Logger.log("sweepExpiredPaymentHolds failed: " + e.toString());
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_EXPIRED,
      actor: "SYSTEM",
      result: "FAIL",
      detail: { stage: "sweep" },
      error: e.toString(),
    });
    return { success: false, message: e.toString() };
  }
}

/**
 * PENDING payments whose hold deadline has passed.
 * @param {number} limit
 * @return {Array<Object>} payment row objects
 */
function findExpiredHoldCandidates_(limit) {
  var table = readPaymentTable_(PAYMENT_SHEET);
  var now = new Date();
  var candidates = [];

  for (var i = 0; i < table.rows.length; i++) {
    var payment = rowToObject_(table.rows[i], table.index);

    if (String(payment.PaymentStatus || "") !== PAYMENT_STATUS.PENDING) continue;
    if (!payment.HoldExpiresAt) continue;

    var deadline = new Date(payment.HoldExpiresAt);
    if (isNaN(deadline.getTime()) || deadline > now) continue;

    candidates.push(payment);
    if (candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * Expire one hold.
 *
 * Order is deliberate and load-bearing:
 *   1. Ask Razorpay for the truth. If the patient paid in time, reconcile
 *      confirms the appointment and this row is no longer PENDING.
 *   2. Only if it is STILL PENDING afterwards do we release the slot.
 *
 * @param {Object} payment
 * @return {string} "released" | "rescued" | "skipped"
 */
function expireOnePaymentHold_(payment) {
  // 1. Truth first — a payment made before the deadline takes priority (§17).
  try {
    reconcilePayment_(payment.PaymentRef, "SYSTEM", {
      eventType: PAYMENT_EVENTS.MANUAL_CHECK,
    });
  } catch (e) {
    // A provider outage must not cause us to release a slot that may have been
    // paid for. Leave it PENDING and try again next minute.
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.VERIFICATION_FAILED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      actor: "SYSTEM",
      result: "FAIL",
      detail: { stage: "sweep pre-check — slot NOT released" },
      error: e.toString(),
    });
    return "skipped";
  }

  var fresh = findPaymentRow_({ paymentRef: payment.PaymentRef });
  if (!fresh.found) return "skipped";

  if (String(fresh.payment.PaymentStatus || "") !== PAYMENT_STATUS.PENDING) {
    // Reconcile moved it — paid, expired at the provider, or cancelled.
    return String(fresh.payment.PaymentStatus) === PAYMENT_STATUS.PAID
      ? "rescued"
      : "skipped";
  }

  // 2. Genuinely unpaid. Release.
  return withPaymentLock_(function () {
    var located = findPaymentRow_({ paymentRef: payment.PaymentRef });
    if (!located.found) return "skipped";
    if (String(located.payment.PaymentStatus || "") !== PAYMENT_STATUS.PENDING) {
      return "skipped";
    }

    // Kill the link so it cannot be paid after the slot is gone. Best effort:
    // Razorpay may already have expired it, which is not an error for us.
    var providerCancelled = false;
    try {
      var provider = getPaymentProvider_();
      var cancelled = provider.cancelPaymentLink(located.payment.ProviderLinkId);
      providerCancelled = cancelled.ok;
    } catch (e) {
      Logger.log("Could not cancel expired link: " + e.toString());
    }

    transitionPayment_(
      located,
      [PAYMENT_STATUS.PENDING],
      {
        PaymentStatus: PAYMENT_STATUS.EXPIRED,
        AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.RELEASED,
        Remarks: appendRemark_(
          located.payment.Remarks,
          "Hold expired — payment not received. Slot released automatically."
        ),
      },
      { actor: "SYSTEM", eventType: PAYMENT_EVENTS.PAYMENT_EXPIRED }
    );

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_EXPIRED,
      appointmentId: located.payment.AppointmentID,
      paymentRef: located.payment.PaymentRef,
      providerLinkId: located.payment.ProviderLinkId,
      amountPaise: located.payment.AmountPaise,
      actor: "SYSTEM",
      result: "OK",
      detail: {
        holdExpiresAt: String(located.payment.HoldExpiresAt),
        providerLinkCancelled: providerCancelled,
      },
    });

    releaseHeldAppointmentSlot_(located.payment);
    return "released";
  });
}

/**
 * Free the slot by moving the appointment out of the `appointment` sheet.
 *
 * A SLOT_HELD row still blocks its slot, because getBookedSlots()
 * (Code.js:7592) counts every row regardless of status. So the row has to go,
 * and it goes through the project's own cancelAppointment() rather than a
 * bespoke deletion — that keeps the journey trail, the tag migration, and the
 * `cancel` sheet layout identical to a staff cancellation.
 *
 * @param {Object} payment
 * @param {string} [sessionToken]  present when a person triggered the release
 */
function releaseHeldAppointmentSlot_(payment, sessionToken) {
  try {
    // cancelAppointment takes a session token only to name the actor. The sweep
    // has no session and falls back to the script owner's identity; a staff-
    // initiated release passes its own token so the cancel row names a person.
    var result = cancelAppointment(payment.AppointmentID, sessionToken || null, false);

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.SLOT_RELEASED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      actor: "SYSTEM",
      result: result && result.success ? "OK" : "FAIL",
      detail: {
        movedTo: "cancel",
        reason: "payment hold expired",
        message: result ? result.message : "",
      },
      error: result && result.success ? "" : (result ? result.message : "no result"),
    });

    if (result && result.success) {
      // Keep the payment row pointing at where the appointment actually lives.
      var located = findPaymentRow_({ paymentRef: payment.PaymentRef });
      if (located.found) {
        writePaymentFields_(
          located.table.sheet,
          located.table.index,
          located.sheetRow,
          { AppointmentSheet: "cancel" }
        );
      }

      try {
        updatePlanningBStats(formatAppointmentDateIso_(payment.AppointmentDate));
      } catch (statsError) {
        Logger.log("planningB stats update after release failed: " + statsError.toString());
      }
    }
  } catch (e) {
    Logger.log("releaseHeldAppointmentSlot_ failed: " + e.toString());
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.SLOT_RELEASED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      actor: "SYSTEM",
      result: "FAIL",
      error: e.toString(),
    });
  }
}

// ---------------------------------------------------------------------------
// The hourly safety net
// ---------------------------------------------------------------------------

/**
 * Re-check payments that are still open long after their hold, and refunds that
 * are still pending. Catches anything a missed webhook left stranded.
 */
function reconcileOpenPayments() {
  try {
    var config = getPaymentConfig();
    if (config.enabled !== true) return { success: true, skipped: "module disabled" };

    var checkedPayments = reconcileStalePendingPayments_(config);
    var checkedRefunds = reconcilePendingRefunds_();
    var repaired = syncCancelledAppointments_();

    Logger.log(
      "Hourly reconcile: " +
        checkedPayments +
        " payment(s), " +
        checkedRefunds +
        " refund(s) re-checked, " +
        repaired +
        " payment record(s) re-pointed after a cancellation elsewhere."
    );
    return {
      success: true,
      paymentsChecked: checkedPayments,
      refundsChecked: checkedRefunds,
      recordsRepaired: repaired,
    };
  } catch (e) {
    Logger.log("reconcileOpenPayments failed: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

/** PENDING payments older than their hold plus a grace period. */
function reconcileStalePendingPayments_(config) {
  var table = readPaymentTable_(PAYMENT_SHEET);
  var graceMs = ((Number(config.hold_minutes) || 15) + 5) * 60 * 1000;
  var cutoff = new Date(Date.now() - graceMs);
  var checked = 0;

  for (var i = 0; i < table.rows.length && checked < PAYMENT_RECONCILE_BATCH_LIMIT; i++) {
    var payment = rowToObject_(table.rows[i], table.index);
    if (String(payment.PaymentStatus || "") !== PAYMENT_STATUS.PENDING) continue;
    if (!payment.LinkCreatedAt) continue;

    var created = new Date(payment.LinkCreatedAt);
    if (isNaN(created.getTime()) || created > cutoff) continue;

    try {
      reconcilePayment_(payment.PaymentRef, "SYSTEM", {
        eventType: PAYMENT_EVENTS.MANUAL_CHECK,
      });
    } catch (e) {
      Logger.log("Reconcile failed for " + payment.PaymentRef + ": " + e.toString());
    }
    checked++;
  }

  return checked;
}

/**
 * Refunds sitting in REFUND_PENDING. Razorpay processes most refunds
 * asynchronously, so this is how REFUND_PENDING becomes REFUNDED without
 * anyone clicking Check Refund (§27).
 */
function reconcilePendingRefunds_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(REFUND_SHEET)) return 0;

  var table = readPaymentTable_(REFUND_SHEET);
  var checked = 0;

  for (var i = 0; i < table.rows.length && checked < PAYMENT_RECONCILE_BATCH_LIMIT; i++) {
    var refund = rowToObject_(table.rows[i], table.index);
    if (String(refund.RefundStatus || "") !== REFUND_STATUS.REFUND_PENDING) continue;
    if (!refund.ProviderRefundId) continue;

    try {
      refreshRefundFromProvider_(refund.RefundRef, "SYSTEM");
    } catch (e) {
      Logger.log("Refund reconcile failed for " + refund.RefundRef + ": " + e.toString());
    }
    checked++;
  }

  return checked;
}

/**
 * Repair payment records for appointments cancelled somewhere this module does
 * not control.
 *
 * All four cancellation screens now route through
 * cancelAppointmentWithPaymentCheck(), so drift should be rare. It can still
 * happen: that function deliberately swallows payment-bookkeeping errors so a
 * sheet problem cannot be reported as a failed cancellation, and rows are also
 * moved by archiveAppointment() and by hand. This pass finds a payment row
 * still claiming CONFIRMED whose appointment has left the `appointment` sheet,
 * and corrects the record.
 *
 * It only corrects bookkeeping — it never refunds anything. A paid appointment
 * cancelled elsewhere still shows a Refund button in the cancelled list, which
 * is where the human decision belongs (§19, §20).
 *
 * @return {number} rows repaired
 */
function syncCancelledAppointments_() {
  var table = readPaymentTable_(PAYMENT_SHEET);
  var repaired = 0;

  var live = {
    CONFIRMED: true,
    SLOT_HELD: true,
    REQUESTED: true,
  };

  for (var i = 0; i < table.rows.length; i++) {
    var payment = rowToObject_(table.rows[i], table.index);
    if (!live[String(payment.AppointmentStatus || "")]) continue;
    if (String(payment.AppointmentSheet || "") !== "appointment") continue;

    var found = findAppointmentAnywhere_(payment.AppointmentID);
    if (!found.found || found.sheetName === "appointment") continue;

    // The appointment is no longer live — it was cancelled or archived.
    var newStatus =
      found.sheetName === "cancel"
        ? APPOINTMENT_PAYMENT_STATUS.CANCELLED
        : APPOINTMENT_PAYMENT_STATUS.COMPLETED;

    writePaymentFields_(table.sheet, table.index, i + 2, {
      AppointmentSheet: found.sheetName,
      AppointmentStatus: newStatus,
      LastEventAt: new Date(),
      Remarks: appendRemark_(
        payment.Remarks,
        "Record synced: the appointment was moved to the '" +
          found.sheetName +
          "' sheet outside the payment module."
      ),
    });

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.APPOINTMENT_CANCELLED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      providerPaymentId: payment.ProviderPaymentId,
      amountPaise: payment.PaidAmountPaise || payment.AmountPaise,
      actor: "SYSTEM",
      result: "OK",
      detail: {
        movedTo: found.sheetName,
        newAppointmentStatus: newStatus,
        paymentStatus: payment.PaymentStatus,
        note:
          String(payment.PaymentStatus) === PAYMENT_STATUS.PAID
            ? "PAID and cancelled — a refund decision is still outstanding"
            : "no payment held",
      },
    });

    repaired++;
  }

  return repaired;
}

// ---------------------------------------------------------------------------
// Manual equivalents — for testing without waiting for the clock.
// ---------------------------------------------------------------------------

/** Run the sweep once, by hand, from the editor. */
function runPaymentSweepNow() {
  var result = sweepExpiredPaymentHolds();
  Logger.log(JSON.stringify(result));
  return result;
}

/** Run the hourly reconcile once, by hand, from the editor. */
function runPaymentReconcileNow() {
  var result = reconcileOpenPayments();
  Logger.log(JSON.stringify(result));
  return result;
}
