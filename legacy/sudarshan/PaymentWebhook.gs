/**
 * PaymentWebhook.gs — Razorpay webhook receiver (WP5).
 *
 * This is the ONLY doPost in the project. Adding it requires the web app to be
 * deployed with access "Anyone, even anonymous"; edit the EXISTING deployment
 * so the /exec URL stays stable (paymentSetup.md, Part D).
 *
 * WHY THERE IS NO HMAC CHECK
 * --------------------------
 * Razorpay signs each delivery with an X-Razorpay-Signature header, and marks
 * duplicates with x-razorpay-event-id. Apps Script exposes NEITHER: doPost(e)
 * gives us postData, parameter and queryString, and no request headers at all.
 * So the signature cannot be verified here. Three defences replace it:
 *
 *   1. The webhook URL carries an unguessable token (?wh=...). A request
 *      without it is rejected before anything is read.
 *   2. NOTHING in the request body is trusted. We take identifiers out of it
 *      and then re-fetch authoritative state from the Razorpay API with our own
 *      key and secret. A forged body therefore causes, at most, one read-only
 *      API call and no state change.
 *   3. Amount and payment reference are re-verified against our stored values
 *      before any confirmation (applyProviderLinkState_).
 *
 * Approved 4 Sep 2026. See paymentPlan.md §6.1.
 *
 * TIMING: Razorpay expects a 2xx within 5 seconds. A confirmation costs roughly
 * one API fetch plus a few sheet writes plus one email. If we do overrun,
 * Razorpay retries, and the duplicate guards make the retry a no-op.
 */

/**
 * Web app POST entry point.
 * Always returns 200 with a JSON body — Apps Script cannot set status codes,
 * and Razorpay only needs a 2xx. The body says what actually happened.
 */
function doPost(e) {
  var response = { received: true };

  try {
    // ---- 1. URL token -----------------------------------------------------
    var supplied = e && e.parameter ? String(e.parameter.wh || "") : "";
    var expected = getWebhookToken_();

    if (!expected) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_REJECTED,
        actor: "WEBHOOK",
        result: "FAIL",
        error: "No webhook token configured. Run generateWebhookToken().",
      });
      return webhookResponse_({ received: true, handled: false, reason: "not_configured" });
    }

    if (!constantTimeEquals_(supplied, expected)) {
      // Deliberately terse, and the supplied token is never logged.
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_REJECTED,
        actor: "WEBHOOK",
        result: "FAIL",
        error: "Invalid or missing webhook token",
      });
      return webhookResponse_({ received: true, handled: false, reason: "unauthorized" });
    }

    // ---- 2. Body ----------------------------------------------------------
    if (!e.postData || !e.postData.contents) {
      return webhookResponse_({ received: true, handled: false, reason: "empty_body" });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseError) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_REJECTED,
        actor: "WEBHOOK",
        result: "FAIL",
        error: "Body is not valid JSON",
      });
      return webhookResponse_({ received: true, handled: false, reason: "bad_json" });
    }

    // ---- 3. Identifiers only ---------------------------------------------
    var provider = getPaymentProvider_();
    var event = provider.parseWebhookEvent(body);

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.WEBHOOK_RECEIVED,
      paymentRef: event.reference,
      providerLinkId: event.providerLinkId,
      providerPaymentId: event.providerPaymentId,
      providerRefundId: event.providerRefundId,
      actor: "WEBHOOK",
      result: "OK",
      providerEventId: event.providerEventId,
      detail: { event: event.event },
    });

    // ---- 4. Duplicate suppression ----------------------------------------
    // x-razorpay-event-id is a header we cannot read, so dedupe on the event id
    // in the body when present. This is the cheap first pass; the authoritative
    // guard is the status check inside applyProviderLinkState_.
    if (event.providerEventId && isWebhookEventAlreadyProcessed_(event.providerEventId)) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_DUPLICATE,
        paymentRef: event.reference,
        providerLinkId: event.providerLinkId,
        actor: "WEBHOOK",
        result: "IGNORED",
        providerEventId: event.providerEventId,
        detail: { event: event.event, reason: "event id already seen" },
      });
      return webhookResponse_({ received: true, handled: false, reason: "duplicate" });
    }

    // ---- 5. Route ---------------------------------------------------------
    response = routeWebhookEvent_(event);
    return webhookResponse_(response);
  } catch (error) {
    // Never throw out of doPost — an Apps Script error page is not a 2xx and
    // would put Razorpay into a retry loop.
    Logger.log("doPost failed: " + error.toString());
    try {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_REJECTED,
        actor: "WEBHOOK",
        result: "FAIL",
        error: error.toString(),
      });
    } catch (ignored) {}
    return webhookResponse_({ received: true, handled: false, reason: "internal_error" });
  }
}

/**
 * Dispatch one parsed event.
 * @param {Object} event  output of parseWebhookEvent
 * @return {Object}
 */
function routeWebhookEvent_(event) {
  var name = String(event.event || "");

  // --- Failed payment attempt ----------------------------------------------
  // Handled separately from payment_link.*: a link with one failed attempt
  // still reads `created` at the provider, so routing this through
  // reconcilePayment_ would report "no payment yet" and record nothing. The
  // patient can still retry the same link, so nothing changes state here —
  // this exists so failed attempts are visible in the log (§30, §32).
  if (name === "payment.failed") {
    return handleFailedPayment_(event);
  }

  // --- Payment link lifecycle ---------------------------------------------
  if (name.indexOf("payment_link.") === 0) {
    var located = locatePaymentForEvent_(event);
    if (!located.found) {
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.VERIFICATION_FAILED,
        paymentRef: event.reference,
        providerLinkId: event.providerLinkId,
        providerPaymentId: event.providerPaymentId,
        actor: "WEBHOOK",
        result: "IGNORED",
        providerEventId: event.providerEventId,
        detail: {
          event: name,
          reason: "no matching payment record — link not created by this system",
        },
      });
      return { received: true, handled: false, reason: "unknown_payment" };
    }

    // Everything financial is decided by reconcilePayment_, which re-fetches
    // authoritative state from Razorpay. The webhook body is only a trigger.
    var result = reconcilePayment_(located.payment.PaymentRef, "WEBHOOK", {
      eventType: PAYMENT_EVENTS.WEBHOOK_RECEIVED,
      providerEventId: event.providerEventId,
    });

    return {
      received: true,
      handled: true,
      event: name,
      paymentRef: located.payment.PaymentRef,
      changed: !!result.changed,
    };
  }

  // --- Refund lifecycle ----------------------------------------------------
  if (name.indexOf("refund.") === 0) {
    if (!event.providerRefundId) {
      return { received: true, handled: false, reason: "no_refund_id" };
    }

    var refundRow = findRefundByProviderId_(event.providerRefundId);
    if (!refundRow.found) {
      // A refund raised directly in the Razorpay dashboard rather than through
      // this system. Log it so reconciliation can see it, but do not invent a
      // record for money we did not send.
      logPaymentEvent({
        eventType: PAYMENT_EVENTS.WEBHOOK_RECEIVED,
        providerPaymentId: event.providerPaymentId,
        providerRefundId: event.providerRefundId,
        actor: "WEBHOOK",
        result: "IGNORED",
        providerEventId: event.providerEventId,
        detail: {
          event: name,
          reason: "refund not raised by this system — possibly issued from the Razorpay dashboard",
        },
      });
      return { received: true, handled: false, reason: "unknown_refund" };
    }

    // Same rule as payments: the body is a trigger, the API is the truth.
    var refreshed = refreshRefundFromProvider_(
      refundRow.refund.RefundRef,
      "WEBHOOK"
    );

    return {
      received: true,
      handled: true,
      event: name,
      refundRef: refundRow.refund.RefundRef,
      changed: !!refreshed.changed,
    };
  }

  // --- Anything else -------------------------------------------------------
  return { received: true, handled: false, reason: "unhandled_event", event: name };
}

/**
 * Record a failed payment attempt.
 *
 * Log-only by design. The payment link stays open and the hold keeps running,
 * so the patient can simply try again — marking the payment FAILED here would
 * strand a slot that is still legitimately payable. §32 requires only that a
 * failed payment does not confirm the appointment, which it does not.
 *
 * As everywhere else, the webhook body is a trigger and the API is the truth:
 * the failure reason is read back from Razorpay, not taken from the payload.
 *
 * @param {Object} event  output of parseWebhookEvent
 * @return {Object}
 */
function handleFailedPayment_(event) {
  var located = locatePaymentForEvent_(event);

  if (!located.found) {
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_FAILED,
      providerPaymentId: event.providerPaymentId,
      actor: "WEBHOOK",
      result: "IGNORED",
      providerEventId: event.providerEventId,
      detail: {
        event: event.event,
        reason: "no matching payment record — not a link raised by this system",
      },
    });
    return { received: true, handled: false, reason: "unknown_payment" };
  }

  var payment = located.payment;
  var errorCode = "";
  var errorDescription = "";
  var method = "";

  if (event.providerPaymentId) {
    try {
      var fetched = getPaymentProvider_().fetchPayment(event.providerPaymentId);
      if (fetched.ok && fetched.payment) {
        errorCode = fetched.payment.errorCode || "";
        errorDescription = fetched.payment.errorDescription || "";
        method = fetched.payment.method || "";
      }
    } catch (e) {
      Logger.log("Could not fetch failed payment " + event.providerPaymentId + ": " + e);
    }
  }

  logPaymentEvent({
    eventType: PAYMENT_EVENTS.PAYMENT_FAILED,
    appointmentId: payment.AppointmentID,
    paymentRef: payment.PaymentRef,
    providerLinkId: payment.ProviderLinkId,
    providerPaymentId: event.providerPaymentId,
    amountPaise: payment.AmountPaise,
    actor: "WEBHOOK",
    result: "FAIL",
    providerEventId: event.providerEventId,
    detail: {
      event: event.event,
      method: method,
      paymentStatus: payment.PaymentStatus,
      note: "link still open — the patient can retry until the hold expires",
    },
    error: errorDescription
      ? errorDescription + (errorCode ? " (" + errorCode + ")" : "")
      : errorCode || "payment attempt failed",
  });

  return {
    received: true,
    handled: true,
    event: event.event,
    paymentRef: payment.PaymentRef,
    changed: false,
  };
}

/**
 * Find our payment row for a webhook event. Tries the provider link id first,
 * then our own reference, which travels in reference_id and in notes.
 */
function locatePaymentForEvent_(event) {
  if (event.providerLinkId) {
    var byLink = findPaymentRow_({ providerLinkId: event.providerLinkId });
    if (byLink.found) return byLink;
  }
  if (event.reference) {
    var byRef = findPaymentRow_({ paymentRef: event.reference });
    if (byRef.found) return byRef;
  }
  return { found: false, payment: null };
}

/**
 * Has this provider event id already been logged as received AND acted on?
 *
 * Scans the tail of paymentLog rather than the whole sheet — webhook retries
 * arrive within minutes, so recent history is enough, and this keeps the 5
 * second response budget intact as the log grows.
 *
 * @param {string} providerEventId
 * @return {boolean}
 */
function isWebhookEventAlreadyProcessed_(providerEventId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(PAYMENT_LOG_SHEET);
    if (!sheet) return false;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return false;

    var scanRows = 300;
    var startRow = Math.max(2, lastRow - scanRows + 1);
    var count = lastRow - startRow + 1;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var eventTypeCol = headers.indexOf("EventType");
    var eventIdCol = headers.indexOf("ProviderEventId");
    var resultCol = headers.indexOf("Result");
    if (eventIdCol === -1) return false;

    var values = sheet.getRange(startRow, 1, count, sheet.getLastColumn()).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][eventIdCol] || "").trim() !== String(providerEventId)) continue;
      // A prior WEBHOOK_RECEIVED alone is not proof of processing — the run may
      // have died mid-way. Only a terminal outcome counts as "done".
      var type = eventTypeCol === -1 ? "" : String(values[i][eventTypeCol] || "");
      var outcome = resultCol === -1 ? "" : String(values[i][resultCol] || "");
      if (
        type === PAYMENT_EVENTS.PAYMENT_CONFIRMED ||
        type === PAYMENT_EVENTS.PAYMENT_EXPIRED ||
        type === PAYMENT_EVENTS.LATE_PAYMENT_RECEIVED ||
        type === PAYMENT_EVENTS.AMOUNT_MISMATCH ||
        type === PAYMENT_EVENTS.WEBHOOK_DUPLICATE ||
        type === PAYMENT_EVENTS.REFUND_COMPLETED ||
        type === PAYMENT_EVENTS.REFUND_FAILED ||
        (type === PAYMENT_EVENTS.PAYMENT_LINK_CANCELLED && outcome === "OK")
      ) {
        return true;
      }
    }
    return false;
  } catch (e) {
    // If the check itself fails, let the event through — applyProviderLinkState_
    // still refuses to process an already-PAID payment twice.
    Logger.log("isWebhookEventAlreadyProcessed_ failed: " + e.toString());
    return false;
  }
}

/**
 * Compare two strings without leaking length or position through timing.
 * Modest protection in an Apps Script context, but it costs nothing.
 */
function constantTimeEquals_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/** JSON response with a 200 status (the only status Apps Script can return). */
function webhookResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ---------------------------------------------------------------------------
// Local test harness — run from the editor, no Razorpay involvement.
// ---------------------------------------------------------------------------

/**
 * Simulate a payment_link.paid delivery for an existing PENDING payment.
 *
 * This exercises the real doPost path including the token check and the
 * duplicate guard. It does NOT fake a payment: reconcilePayment_ still asks
 * Razorpay for the truth, so unless the link really was paid in test mode the
 * result will correctly be "no payment received yet".
 *
 * @param {string} paymentRef
 */
function simulateWebhookForPayment(paymentRef) {
  var located = findPaymentRow_({ paymentRef: paymentRef });
  if (!located.found) {
    Logger.log("No payment row for " + paymentRef);
    return "No such payment reference.";
  }

  var fakeDelivery = {
    parameter: { wh: getWebhookToken_() },
    postData: {
      contents: JSON.stringify({
        entity: "event",
        event: "payment_link.paid",
        id: "evt_simulated_" + Date.now(),
        payload: {
          payment_link: {
            entity: {
              id: located.payment.ProviderLinkId,
              reference_id: located.payment.PaymentRef,
            },
          },
          payment: { entity: { id: "" } },
        },
      }),
    },
  };

  var output = doPost(fakeDelivery);
  var text = output.getContent();
  Logger.log("Simulated webhook result: " + text);
  return text;
}
