/**
 * PaymentRefund.gs — cancellation and refund workflow (WP8).
 *
 * Principles from the handoff document, all load-bearing:
 *   §19  Cancellation and refund are SEPARATE operations. Cancelling never
 *        refunds by itself.
 *   §20  A refund always requires an explicit staff confirmation.
 *   §21  Refunds go back through the ORIGINAL payment, never to a bank account
 *        typed in by reception.
 *   §22  Partial refunds are supported by the data model from day one.
 *   §23  The original Payment ID is never overwritten. Payment and refund IDs
 *        both remain permanently readable.
 *   §28  CANCELLED + PAID + no refund is a legitimate, recordable state.
 *   §32  A payment can never be refunded twice.
 *   §33  Refunds are restricted to authorised users (level 1 by default).
 */

/** Structured refund reasons (§24). Free-text remarks are separate. */
var REFUND_REASONS = [
  "Doctor unavailable",
  "Clinic cancelled",
  "Patient cancelled",
  "Duplicate booking",
  "Appointment rescheduled",
  "Incorrect payment",
  "Administrative cancellation",
  "Other",
];

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * @param {string} sessionToken
 * @return {{ok: boolean, session: Object|null, message: string}}
 */
function requireRefundAuthority_(sessionToken) {
  var session = getUserSession(sessionToken);
  if (!session) return { ok: false, session: null, message: "Session expired." };

  var config = getPaymentConfig();
  var level = getUserAccessLevel(session.role);
  if (level > (Number(config.refund_min_role_level) || 1)) {
    return {
      ok: false,
      session: session,
      message: "You do not have permission to issue refunds. Ask an administrator.",
    };
  }
  return { ok: true, session: session, message: "" };
}

/** Can this user see the refund buttons at all? */
function canIssueRefunds(sessionToken) {
  return requireRefundAuthority_(sessionToken).ok;
}

// ---------------------------------------------------------------------------
// Refund reference
// ---------------------------------------------------------------------------

/** SAMP-RFD-YYYYMMDD-NNNNNN. Doubles as the Razorpay receipt/idempotency key. */
function generateRefundRef_() {
  var tz = Session.getScriptTimeZone();
  var datePart = Utilities.formatDate(new Date(), tz, "yyyyMMdd");
  var props = PropertiesService.getScriptProperties();
  var propKey = "RFD_SEQ_" + datePart;

  var next = Number(props.getProperty(propKey) || 0) + 1;
  props.setProperty(propKey, String(next));

  return "SAMP-RFD-" + datePart + "-" + ("000000" + next).slice(-6);
}

// ---------------------------------------------------------------------------
// The confirmation screen (§25)
// ---------------------------------------------------------------------------

/**
 * Everything the refund confirmation dialog needs, including the authoritative
 * already-refunded figure from Razorpay rather than our own cached total.
 *
 * @param {string} appointmentIdOrRef
 * @param {string} sessionToken
 * @return {Object}
 */
function getRefundContext(appointmentIdOrRef, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var located = findPaymentRow_({ paymentRef: appointmentIdOrRef });
    if (!located.found) {
      located = findPaymentRow_({ appointmentId: appointmentIdOrRef });
    }
    if (!located.found) {
      return { success: false, message: "No payment found for this appointment." };
    }

    var payment = located.payment;
    var paidPaise = Number(payment.PaidAmountPaise || payment.AmountPaise) || 0;
    var config = getPaymentConfig();
    var canRefund = getUserAccessLevel(session.role) <= (config.refund_min_role_level || 1);

    var context = {
      success: true,
      canRefund: canRefund,
      paymentRef: payment.PaymentRef,
      appointmentId: payment.AppointmentID,
      patientName: payment.PatientName,
      mrdNo: payment.MRDNo,
      mobile: payment.Mobile,
      appointmentDate: formatAppointmentDateLong_(payment.AppointmentDate),
      appointmentTime: payment.AppointmentTime,
      paymentStatus: payment.PaymentStatus,
      appointmentStatus: payment.AppointmentStatus,
      refundStatus: payment.RefundStatus,
      providerPaymentId: payment.ProviderPaymentId,
      paidAmountPaise: paidPaise,
      paidAmountDisplay: formatPaise(paidPaise),
      reasons: REFUND_REASONS,
      refundable: false,
      refundableAmountPaise: 0,
      refundableAmountDisplay: formatPaise(0),
      alreadyRefundedPaise: 0,
      alreadyRefundedDisplay: formatPaise(0),
      message: "",
    };

    if (String(payment.PaymentStatus) !== PAYMENT_STATUS.PAID) {
      context.message =
        "No refund is possible — this payment is " +
        (payment.PaymentStatus || "not recorded as paid") +
        ".";
      return context;
    }
    if (!payment.ProviderPaymentId) {
      context.message = "No provider payment id is recorded, so no refund can be raised.";
      return context;
    }

    // Ask Razorpay what has already gone back, rather than trusting our own
    // rolled-up figure. This is the guard against a double refund (§32).
    var provider = getPaymentProvider_();
    var existing = provider.fetchRefundsForPayment(payment.ProviderPaymentId);
    if (!existing.ok) {
      context.message =
        "Could not check existing refunds with the provider: " + existing.message;
      return context;
    }

    var refundedPaise = 0;
    var priorRefunds = [];
    for (var i = 0; i < existing.refunds.length; i++) {
      var refund = existing.refunds[i];
      if (refund.status !== "failed") refundedPaise += refund.amountPaise;
      priorRefunds.push({
        refundId: refund.providerRefundId,
        amountDisplay: formatPaise(refund.amountPaise),
        status: refund.status,
      });
    }

    context.alreadyRefundedPaise = refundedPaise;
    context.alreadyRefundedDisplay = formatPaise(refundedPaise);
    context.priorRefunds = priorRefunds;
    context.refundableAmountPaise = Math.max(0, paidPaise - refundedPaise);
    context.refundableAmountDisplay = formatPaise(context.refundableAmountPaise);
    context.refundable = canRefund && context.refundableAmountPaise > 0;

    if (context.refundableAmountPaise <= 0) {
      context.message = "This payment has already been fully refunded.";
    } else if (!canRefund) {
      context.message = "A refund is possible, but only an administrator can issue it.";
    }

    return context;
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Cancellation (§19) — deliberately does NOT refund
// ---------------------------------------------------------------------------

/**
 * Cancel an appointment and record what that means for its payment.
 * Never issues a refund. Returns whether one is available so the UI can offer it.
 *
 * @param {string} appointmentId
 * @param {string} sessionToken
 * @param {boolean} [callbackRequired]
 * @return {Object}
 */
function cancelAppointmentWithPaymentCheck(appointmentId, sessionToken, callbackRequired) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var cancellation = cancelAppointment(appointmentId, sessionToken, !!callbackRequired);
    if (!cancellation || !cancellation.success) {
      return cancellation || { success: false, message: "Cancellation failed." };
    }

    // From here the appointment IS cancelled. Everything below is payment
    // bookkeeping, and a failure in it must never be reported as a failed
    // cancellation — that would tell staff to retry something already done.
    // The hourly reconcile (syncCancelledAppointments_) repairs the record if
    // this block does not complete.
    try {
      cancellation.payment = attachPaymentToCancellation_(
        appointmentId,
        sessionToken,
        session
      );
    } catch (paymentError) {
      Logger.log(
        "Cancellation succeeded but payment bookkeeping failed for " +
          appointmentId +
          ": " +
          paymentError.toString()
      );
      cancellation.payment = { hasPayment: false, error: paymentError.toString() };
    }

    return cancellation;
  } catch (e) {
    return { success: false, message: "Error cancelling appointment: " + e.toString() };
  }
}

/**
 * Update the payment record for a just-cancelled appointment and report whether
 * a refund is available. Split out so cancelAppointmentWithPaymentCheck can
 * contain its failures.
 *
 * @return {Object} the `payment` block of the cancellation response
 */
function attachPaymentToCancellation_(appointmentId, sessionToken, session) {
  var located = findPaymentRow_({ appointmentId: appointmentId });
  if (!located.found) {
    return { hasPayment: false };
  }

  var payment = located.payment;

  writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
    AppointmentStatus: APPOINTMENT_PAYMENT_STATUS.CANCELLED,
    AppointmentSheet: "cancel",
    LastEventAt: new Date(),
    Remarks: appendRemark_(
      payment.Remarks,
      "Appointment cancelled by " + (session.username || "staff") + "."
    ),
  });

  logPaymentEvent({
    eventType: PAYMENT_EVENTS.APPOINTMENT_CANCELLED,
    appointmentId: appointmentId,
    paymentRef: payment.PaymentRef,
    providerPaymentId: payment.ProviderPaymentId,
    amountPaise: payment.PaidAmountPaise || payment.AmountPaise,
    actor: session.username || "UNKNOWN",
    result: "OK",
    detail: {
      paymentStatus: payment.PaymentStatus,
      refundIssued: false,
      note: "cancellation and refund are separate actions",
    },
  });

  // If the money is still with us, tell the caller so it can offer a refund.
  var refundContext =
    String(payment.PaymentStatus) === PAYMENT_STATUS.PAID
      ? getRefundContext(payment.PaymentRef, sessionToken)
      : { refundable: false };

  return {
    hasPayment: true,
    paymentRef: payment.PaymentRef,
    paymentStatus: payment.PaymentStatus,
    paidAmountDisplay: formatPaise(payment.PaidAmountPaise || payment.AmountPaise),
    refundable: !!refundContext.refundable,
    refundableAmountDisplay: refundContext.refundableAmountDisplay || "",
    message: refundContext.refundable
      ? "This appointment was paid for. Decide whether to refund."
      : refundContext.message || "",
  };
}

/**
 * Record that a paid, cancelled appointment will NOT be refunded (§28).
 * The policy itself stays a human decision — this only writes it down.
 */
function markRefundNotApplicable(paymentRef, reason, sessionToken) {
  try {
    var auth = requireRefundAuthority_(sessionToken);
    if (!auth.ok) return { success: false, message: auth.message };
    if (!reason) return { success: false, message: "A reason is required." };

    return withPaymentLock_(function () {
      var located = findPaymentRow_({ paymentRef: paymentRef });
      if (!located.found) return { success: false, message: "Payment not found." };
      if (Number(located.payment.RefundedAmountPaise) > 0) {
        return {
          success: false,
          message: "This payment has already been refunded in part or in full.",
        };
      }

      writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
        RefundStatus: REFUND_STATUS.NOT_APPLICABLE,
        LastEventAt: new Date(),
        Remarks: appendRemark_(
          located.payment.Remarks,
          "No refund: " + reason + " (" + (auth.session.username || "staff") + ")"
        ),
      });

      logPaymentEvent({
        eventType: PAYMENT_EVENTS.REFUND_REQUESTED,
        appointmentId: located.payment.AppointmentID,
        paymentRef: paymentRef,
        providerPaymentId: located.payment.ProviderPaymentId,
        actor: auth.session.username || "UNKNOWN",
        result: "IGNORED",
        detail: { decision: "NOT_APPLICABLE", reason: reason },
      });

      try {
        logAuditEvent(sessionToken, "REFUND_DECLINED", "PAYMENT", paymentRef, {
          appointmentId: located.payment.AppointmentID,
          reason: reason,
          sheetName: PAYMENT_SHEET,
        });
      } catch (auditError) {
        Logger.log("Audit failed: " + auditError.toString());
      }

      return { success: true, message: "Recorded: no refund for this payment." };
    });
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Refund (§20)
// ---------------------------------------------------------------------------

/**
 * Initiate a refund against the original payment.
 *
 * @param {Object} request
 * @param {string} request.paymentRef
 * @param {number} [request.amountPaise]  Omit or pass the full amount for a full refund
 * @param {string} request.reason         One of REFUND_REASONS
 * @param {string} [request.remarks]
 * @param {string} request.sessionToken
 * @return {Object}
 */
function initiateRefund(request) {
  try {
    request = request || {};

    var auth = requireRefundAuthority_(request.sessionToken);
    if (!auth.ok) return { success: false, message: auth.message };

    if (!request.reason || REFUND_REASONS.indexOf(request.reason) === -1) {
      return { success: false, message: "Select a valid refund reason." };
    }

    // Re-derive everything from the provider, inside the confirmation path,
    // so a stale UI cannot cause an over-refund.
    var context = getRefundContext(request.paymentRef, request.sessionToken);
    if (!context.success) return { success: false, message: context.message };
    if (!context.refundable) {
      return {
        success: false,
        message: context.message || "This payment cannot be refunded.",
      };
    }

    var amountPaise = request.amountPaise
      ? Math.round(Number(request.amountPaise))
      : context.refundableAmountPaise;

    if (!amountPaise || amountPaise <= 0) {
      return { success: false, message: "Refund amount must be greater than zero." };
    }
    if (amountPaise > context.refundableAmountPaise) {
      return {
        success: false,
        message:
          "Refund of " +
          formatPaise(amountPaise) +
          " exceeds the refundable balance of " +
          context.refundableAmountDisplay +
          ".",
      };
    }

    return withPaymentLock_(function () {
      var located = findPaymentRow_({ paymentRef: request.paymentRef });
      if (!located.found) return { success: false, message: "Payment not found." };
      var payment = located.payment;

      if (String(payment.RefundStatus) === REFUND_STATUS.REFUND_PENDING) {
        return {
          success: false,
          message:
            "A refund is already in progress for this payment. Use Check Refund Status.",
        };
      }

      var refundRef = generateRefundRef_();
      var isFull = amountPaise >= context.refundableAmountPaise;
      var now = new Date();

      // Write the request BEFORE calling the provider. If the script dies
      // mid-call, the intent is on record and reconciliation can find it.
      appendRefundRow_({
        RefundRef: refundRef,
        PaymentRef: payment.PaymentRef,
        AppointmentID: payment.AppointmentID,
        ProviderPaymentId: payment.ProviderPaymentId,
        ProviderRefundId: "",
        RefundAmountPaise: amountPaise,
        RefundType: isFull ? "FULL" : "PARTIAL",
        RefundStatus: REFUND_STATUS.REFUND_PENDING,
        RefundReason: request.reason,
        RefundRemarks: request.remarks || "",
        RequestedAt: now,
        RequestedBy: auth.session.username || "UNKNOWN",
        CompletedAt: "",
        ProviderArn: "",
        LastError: "",
      });

      logPaymentEvent({
        eventType: PAYMENT_EVENTS.REFUND_REQUESTED,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerPaymentId: payment.ProviderPaymentId,
        providerRefundId: refundRef,
        amountPaise: amountPaise,
        actor: auth.session.username || "UNKNOWN",
        result: "OK",
        detail: { reason: request.reason, type: isFull ? "FULL" : "PARTIAL" },
      });

      var provider = getPaymentProvider_();
      var created = provider.createRefund(payment.ProviderPaymentId, amountPaise, {
        receipt: refundRef,
        idempotencyKey: refundRef,
        notes: {
          payment_ref: payment.PaymentRef,
          refund_ref: refundRef,
          appointment_id: String(payment.AppointmentID),
          reason: request.reason,
        },
      });

      if (!created.ok) {
        // §32: a failed refund API call must NOT be recorded as refunded.
        updateRefundRow_(refundRef, {
          RefundStatus: REFUND_STATUS.REFUND_FAILED,
          LastError: created.message,
        });
        writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
          RefundStatus: REFUND_STATUS.REFUND_FAILED,
          LastEventAt: new Date(),
        });
        logPaymentEvent({
          eventType: PAYMENT_EVENTS.REFUND_FAILED,
          appointmentId: payment.AppointmentID,
          paymentRef: payment.PaymentRef,
          providerPaymentId: payment.ProviderPaymentId,
          providerRefundId: refundRef,
          amountPaise: amountPaise,
          actor: auth.session.username || "UNKNOWN",
          result: "FAIL",
          error: created.message,
        });
        return {
          success: false,
          refundRef: refundRef,
          message: "Refund failed: " + created.message + " — you can retry.",
        };
      }

      var refund = created.refund;
      var mappedStatus = mapProviderRefundStatus_(refund.status);

      updateRefundRow_(refundRef, {
        ProviderRefundId: refund.providerRefundId,
        RefundStatus: mappedStatus,
        ProviderArn: refund.arn || "",
        CompletedAt: mappedStatus === REFUND_STATUS.REFUNDED ? new Date() : "",
      });

      applyRefundTotalsToPayment_(payment.PaymentRef);

      logPaymentEvent({
        eventType: PAYMENT_EVENTS.REFUND_INITIATED,
        appointmentId: payment.AppointmentID,
        paymentRef: payment.PaymentRef,
        providerPaymentId: payment.ProviderPaymentId,
        providerRefundId: refund.providerRefundId,
        amountPaise: amountPaise,
        actor: auth.session.username || "UNKNOWN",
        result: "OK",
        detail: { providerStatus: refund.status, refundRef: refundRef },
      });

      try {
        logAuditEvent(request.sessionToken, "REFUND_INITIATED", "PAYMENT", refundRef, {
          appointmentId: payment.AppointmentID,
          paymentRef: payment.PaymentRef,
          amount: formatPaise(amountPaise),
          reason: request.reason,
          sheetName: REFUND_SHEET,
        });
      } catch (auditError) {
        Logger.log("Audit failed: " + auditError.toString());
      }

      notifyRefundInitiated_(refundRef);

      return {
        success: true,
        refundRef: refundRef,
        providerRefundId: refund.providerRefundId,
        refundStatus: mappedStatus,
        amountDisplay: formatPaise(amountPaise),
        refundType: isFull ? "FULL" : "PARTIAL",
        patientMessage: buildRefundWhatsAppMessage_(payment, amountPaise, refund.providerRefundId),
        message:
          mappedStatus === REFUND_STATUS.REFUNDED
            ? "Refund of " + formatPaise(amountPaise) + " completed."
            : "Refund of " +
              formatPaise(amountPaise) +
              " initiated. Razorpay is processing it — the status will update automatically.",
      };
    });
  } catch (e) {
    Logger.log("initiateRefund failed: " + e.toString());
    return { success: false, message: "Error initiating refund: " + e.toString() };
  }
}

/**
 * Cancel & Refund as one staff action (§20). Cancels first, then refunds —
 * if the refund fails, the cancellation still stands and the refund is retryable.
 */
function cancelAppointmentAndRefund(request) {
  try {
    request = request || {};

    var auth = requireRefundAuthority_(request.sessionToken);
    if (!auth.ok) return { success: false, message: auth.message };

    var cancellation = cancelAppointmentWithPaymentCheck(
      request.appointmentId,
      request.sessionToken,
      request.callbackRequired
    );
    if (!cancellation.success) return cancellation;

    if (!cancellation.payment || !cancellation.payment.hasPayment) {
      cancellation.message += " No payment was found, so no refund was needed.";
      return cancellation;
    }

    var refund = initiateRefund({
      paymentRef: cancellation.payment.paymentRef,
      amountPaise: request.amountPaise,
      reason: request.reason,
      remarks: request.remarks,
      sessionToken: request.sessionToken,
    });

    cancellation.refund = refund;
    cancellation.message =
      "Appointment cancelled. " +
      (refund.success ? refund.message : "REFUND FAILED: " + refund.message);
    return cancellation;
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Check Refund Status (§27)
// ---------------------------------------------------------------------------

/**
 * Ask the provider for the current state of one refund and store the answer.
 * @param {string} refundRef
 * @param {string} sessionToken
 */
function checkRefundStatus(refundRef, sessionToken) {
  var session = getUserSession(sessionToken);
  if (!session) return { success: false, message: "Session expired." };
  return refreshRefundFromProvider_(refundRef, session.username || "UNKNOWN");
}

/**
 * Shared refresh path — used by the UI button and by the hourly reconcile.
 * @param {string} refundRef
 * @param {string} actor
 */
function refreshRefundFromProvider_(refundRef, actor) {
  try {
    var located = findRefundRow_(refundRef);
    if (!located.found) return { success: false, message: "Refund record not found." };

    var refund = located.refund;
    if (!refund.ProviderRefundId) {
      return {
        success: false,
        message:
          "This refund was never accepted by the provider (" +
          (refund.LastError || refund.RefundStatus) +
          "). Retry the refund.",
      };
    }

    var provider = getPaymentProvider_();
    var fetched = provider.fetchRefund(refund.ProviderPaymentId, refund.ProviderRefundId);
    if (!fetched.ok) {
      return {
        success: false,
        message: "Could not reach the payment provider: " + fetched.message,
      };
    }

    var mapped = mapProviderRefundStatus_(fetched.refund.status);
    var changed = mapped !== String(refund.RefundStatus || "");

    updateRefundRow_(refundRef, {
      RefundStatus: mapped,
      ProviderArn: fetched.refund.arn || refund.ProviderArn || "",
      CompletedAt:
        mapped === REFUND_STATUS.REFUNDED
          ? refund.CompletedAt || new Date()
          : refund.CompletedAt || "",
    });

    applyRefundTotalsToPayment_(refund.PaymentRef);

    if (changed) {
      logPaymentEvent({
        eventType:
          mapped === REFUND_STATUS.REFUNDED
            ? PAYMENT_EVENTS.REFUND_COMPLETED
            : mapped === REFUND_STATUS.REFUND_FAILED
              ? PAYMENT_EVENTS.REFUND_FAILED
              : PAYMENT_EVENTS.REFUND_INITIATED,
        appointmentId: refund.AppointmentID,
        paymentRef: refund.PaymentRef,
        providerPaymentId: refund.ProviderPaymentId,
        providerRefundId: refund.ProviderRefundId,
        amountPaise: refund.RefundAmountPaise,
        actor: actor,
        result: mapped === REFUND_STATUS.REFUND_FAILED ? "FAIL" : "OK",
        detail: { providerStatus: fetched.refund.status, arn: fetched.refund.arn || "" },
      });

      if (mapped === REFUND_STATUS.REFUNDED) notifyRefundCompleted_(refundRef);
    }

    return {
      success: true,
      changed: changed,
      refundRef: refundRef,
      refundStatus: mapped,
      providerRefundId: refund.ProviderRefundId,
      providerPaymentId: refund.ProviderPaymentId,
      arn: fetched.refund.arn || "",
      amountDisplay: formatPaise(refund.RefundAmountPaise),
      message:
        mapped === REFUND_STATUS.REFUNDED
          ? "Refund completed."
          : mapped === REFUND_STATUS.REFUND_FAILED
            ? "Refund FAILED at the provider — it can be retried."
            : "Refund is still being processed by the bank.",
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/** Every refund raised against one payment, for the UI. */
function getRefundsForPayment(paymentRef, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var table = readPaymentTable_(REFUND_SHEET);
    var refunds = [];

    for (var i = 0; i < table.rows.length; i++) {
      var refund = rowToObject_(table.rows[i], table.index);
      if (String(refund.PaymentRef || "").trim() !== String(paymentRef).trim()) continue;
      refunds.push({
        refundRef: refund.RefundRef,
        providerRefundId: refund.ProviderRefundId,
        amountDisplay: formatPaise(refund.RefundAmountPaise),
        refundType: refund.RefundType,
        refundStatus: refund.RefundStatus,
        reason: refund.RefundReason,
        remarks: refund.RefundRemarks,
        requestedAt: refund.RequestedAt ? new Date(refund.RequestedAt).toISOString() : "",
        requestedBy: refund.RequestedBy,
        arn: refund.ProviderArn,
        lastError: refund.LastError,
      });
    }

    return { success: true, refunds: refunds };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Refund sheet plumbing
// ---------------------------------------------------------------------------

function appendRefundRow_(fields) {
  var table = readPaymentTable_(REFUND_SHEET);
  var row = new Array(table.headers.length).fill("");
  for (var key in fields) {
    if (table.index[key] !== undefined) row[table.index[key]] = fields[key];
  }
  table.sheet.appendRow(row);
}

function findRefundRow_(refundRef) {
  var table = readPaymentTable_(REFUND_SHEET);
  var colIndex = table.index.RefundRef;
  if (colIndex === undefined) return { found: false };

  for (var i = table.rows.length - 1; i >= 0; i--) {
    if (String(table.rows[i][colIndex] || "").trim() !== String(refundRef).trim()) continue;
    return {
      found: true,
      table: table,
      sheetRow: i + 2,
      refund: rowToObject_(table.rows[i], table.index),
    };
  }
  return { found: false };
}

function updateRefundRow_(refundRef, fields) {
  var located = findRefundRow_(refundRef);
  if (!located.found) return false;
  writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, fields);
  return true;
}

/** Find a refund by its provider id — the webhook's entry point. */
function findRefundByProviderId_(providerRefundId) {
  var table = readPaymentTable_(REFUND_SHEET);
  var colIndex = table.index.ProviderRefundId;
  if (colIndex === undefined) return { found: false };

  for (var i = table.rows.length - 1; i >= 0; i--) {
    if (String(table.rows[i][colIndex] || "").trim() !== String(providerRefundId).trim()) {
      continue;
    }
    return {
      found: true,
      table: table,
      sheetRow: i + 2,
      refund: rowToObject_(table.rows[i], table.index),
    };
  }
  return { found: false };
}

/**
 * Recompute a payment's rolled-up refund figures from the refund rows.
 * The refund sheet is the detail; the payment row is a summary of it.
 */
function applyRefundTotalsToPayment_(paymentRef) {
  var located = findPaymentRow_({ paymentRef: paymentRef });
  if (!located.found) return;

  var table = readPaymentTable_(REFUND_SHEET);
  var settled = 0;
  var pending = 0;
  var failed = 0;

  for (var i = 0; i < table.rows.length; i++) {
    var refund = rowToObject_(table.rows[i], table.index);
    if (String(refund.PaymentRef || "").trim() !== String(paymentRef).trim()) continue;

    var status = String(refund.RefundStatus || "");
    var amount = Number(refund.RefundAmountPaise) || 0;

    if (status === REFUND_STATUS.REFUNDED) settled += amount;
    else if (status === REFUND_STATUS.REFUND_PENDING) pending += amount;
    else if (status === REFUND_STATUS.REFUND_FAILED) failed++;
  }

  var paidPaise =
    Number(located.payment.PaidAmountPaise || located.payment.AmountPaise) || 0;

  var rolledUp;
  if (pending > 0) rolledUp = REFUND_STATUS.REFUND_PENDING;
  else if (settled >= paidPaise && settled > 0) rolledUp = REFUND_STATUS.REFUNDED;
  else if (settled > 0) rolledUp = REFUND_STATUS.PARTIALLY_REFUNDED;
  else if (failed > 0) rolledUp = REFUND_STATUS.REFUND_FAILED;
  else rolledUp = located.payment.RefundStatus || REFUND_STATUS.NONE;

  writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
    RefundStatus: rolledUp,
    RefundedAmountPaise: settled,
    LastEventAt: new Date(),
  });
}

/** Razorpay refund status -> our vocabulary. */
function mapProviderRefundStatus_(providerStatus) {
  switch (String(providerStatus || "").toLowerCase()) {
    case "processed":
      return REFUND_STATUS.REFUNDED;
    case "failed":
      return REFUND_STATUS.REFUND_FAILED;
    case "pending":
    default:
      return REFUND_STATUS.REFUND_PENDING;
  }
}

// ---------------------------------------------------------------------------
// Patient-facing refund message (§26) — WhatsApp only in Phase 1
// ---------------------------------------------------------------------------

function buildRefundWhatsAppMessage_(payment, amountPaise, providerRefundId) {
  var config = getPaymentConfig();
  var lines = [
    config.clinic_display_name,
    "",
    "Your appointment has been cancelled.",
    "",
    "A refund of " +
      formatPaise(amountPaise) +
      " has been initiated to the original payment method.",
    "",
    "Refund Reference: " + (providerRefundId || "will be shared shortly"),
    "",
    "Please retain this reference until the refund is completed.",
  ];

  var message = lines.join("\n");
  var mobile = paymentNormalizeMobile_(payment.Mobile);

  return {
    message: message,
    mobile: mobile,
    waLink: "https://wa.me/" + mobile + "?text=" + encodeURIComponent(message),
  };
}

/** UI entry point for resending the refund message, with a log entry. */
function getRefundWhatsAppMessage(refundRef, sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var located = findRefundRow_(refundRef);
    if (!located.found) return { success: false, message: "Refund not found." };

    var payment = findPaymentRow_({ paymentRef: located.refund.PaymentRef });
    if (!payment.found) return { success: false, message: "Payment not found." };

    return {
      success: true,
      whatsapp: buildRefundWhatsAppMessage_(
        payment.payment,
        located.refund.RefundAmountPaise,
        located.refund.ProviderRefundId
      ),
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/** Refund reasons for the dropdown. */
function getRefundReasons() {
  return REFUND_REASONS;
}
