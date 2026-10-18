/**
 * RazorpayAdapter.gs — the ONLY file that knows Razorpay exists.
 *
 * Rules (paymentPlan.md §2):
 *   - This file makes HTTP calls and normalizes responses. It never touches a sheet.
 *   - PaymentService.gs never calls Razorpay directly; it calls the provider
 *     object returned by getPaymentProvider_(), whose method names are the
 *     generic set from handoff §34. Swapping in PhonePe later means adding a
 *     sibling file and changing one line in getPaymentProvider_().
 *
 * API reference (verified Sept 2026):
 *   POST   /v1/payment_links                     create
 *   GET    /v1/payment_links/:id                 fetch
 *   POST   /v1/payment_links/:id/cancel          cancel
 *   GET    /v1/payments/:id                      fetch payment
 *   POST   /v1/payments/:id/refund               create refund
 *   GET    /v1/payments/:id/refunds              list refunds for a payment
 *   GET    /v1/payments/:id/refunds/:refundId    fetch one refund
 *
 * All amounts across this file are integer paise, as Razorpay requires.
 */

var RZP_API_BASE = "https://api.razorpay.com/v1";

// Razorpay rejects expire_by less than 15 minutes in the future. Our internal
// hold is authoritative; the link is simply given a longer life and actively
// cancelled on release. See paymentPlan.md §6.2.
var RZP_MIN_EXPIRY_MINUTES = 16;

// reference_id is capped at 40 characters by Razorpay.
var RZP_MAX_REFERENCE_LENGTH = 40;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One HTTP call to Razorpay with Basic auth and uniform error shape.
 *
 * @param {string} method   "get" | "post"
 * @param {string} path     Path after /v1, e.g. "/payment_links"
 * @param {Object} [body]   JSON body for POST
 * @param {Object} [extraHeaders]
 * @return {{ok: boolean, status: number, data: Object, error: Object|null}}
 */
function razorpayRequest_(method, path, body, extraHeaders) {
  var creds = getRazorpayCredentials_();

  var headers = {
    Authorization:
      "Basic " + Utilities.base64Encode(creds.keyId + ":" + creds.keySecret),
  };
  if (extraHeaders) {
    for (var h in extraHeaders) headers[h] = extraHeaders[h];
  }

  var options = {
    method: method,
    headers: headers,
    contentType: "application/json",
    muteHttpExceptions: true,
  };
  if (body) options.payload = JSON.stringify(body);

  var response;
  try {
    response = UrlFetchApp.fetch(RZP_API_BASE + path, options);
  } catch (e) {
    // Network / DNS / timeout — distinct from an API-level rejection.
    return {
      ok: false,
      status: 0,
      data: null,
      error: { code: "NETWORK_ERROR", description: String(e.message || e) },
    };
  }

  var status = response.getResponseCode();
  var raw = response.getContentText();
  var data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }

  if (status >= 200 && status < 300) {
    return { ok: true, status: status, data: data, error: null };
  }

  var apiError = data && data.error ? data.error : {};
  return {
    ok: false,
    status: status,
    data: data,
    error: {
      code: apiError.code || "HTTP_" + status,
      description:
        apiError.description || String(raw || "").slice(0, 300) || "Unknown error",
      reason: apiError.reason || "",
      step: apiError.step || "",
      field: apiError.field || "",
    },
  };
}

/** Human-readable one-liner for logs and UI. Never contains credentials. */
function razorpayErrorText_(result) {
  if (!result || !result.error) return "Unknown provider error";
  var e = result.error;
  return e.description + " (" + e.code + (e.field ? ", field: " + e.field : "") + ")";
}

// ---------------------------------------------------------------------------
// Normalizers — Razorpay shapes in, provider-neutral shapes out.
// ---------------------------------------------------------------------------

/** Unix seconds -> Date, tolerating 0/null which Razorpay uses for "unset". */
function rzpTimestampToDate_(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000);
}

/**
 * Razorpay payment link -> neutral link object.
 * Status vocabulary in: created | partially_paid | paid | expired | cancelled
 */
function rzpNormalizeLink_(link) {
  if (!link) return null;

  var payments = [];
  if (link.payments && link.payments.length) {
    for (var i = 0; i < link.payments.length; i++) {
      var p = link.payments[i];
      payments.push({
        providerPaymentId: p.payment_id || p.id || "",
        amountPaise: Number(p.amount) || 0,
        status: String(p.status || "").toLowerCase(),
        method: p.method || "",
        createdAt: rzpTimestampToDate_(p.created_at),
      });
    }
  }

  return {
    provider: "razorpay",
    providerLinkId: link.id || "",
    referenceId: link.reference_id || "",
    url: link.short_url || "",
    status: String(link.status || "").toLowerCase(),
    amountPaise: Number(link.amount) || 0,
    amountPaidPaise: Number(link.amount_paid) || 0,
    currency: link.currency || "INR",
    createdAt: rzpTimestampToDate_(link.created_at),
    expiresAt: rzpTimestampToDate_(link.expire_by),
    cancelledAt: rzpTimestampToDate_(link.cancelled_at),
    expiredAt: rzpTimestampToDate_(link.expired_at),
    notes: link.notes || {},
    payments: payments,
    raw: link,
  };
}

/** Razorpay payment -> neutral payment object. */
function rzpNormalizePayment_(payment) {
  if (!payment) return null;
  return {
    provider: "razorpay",
    providerPaymentId: payment.id || "",
    status: String(payment.status || "").toLowerCase(), // captured | authorized | failed | refunded
    amountPaise: Number(payment.amount) || 0,
    amountRefundedPaise: Number(payment.amount_refunded) || 0,
    currency: payment.currency || "INR",
    method: payment.method || "",
    contact: payment.contact || "",
    email: payment.email || "",
    capturedAt: rzpTimestampToDate_(payment.created_at),
    errorCode: payment.error_code || "",
    errorDescription: payment.error_description || "",
    notes: payment.notes || {},
    raw: payment,
  };
}

/** Razorpay refund -> neutral refund object. */
function rzpNormalizeRefund_(refund) {
  if (!refund) return null;
  return {
    provider: "razorpay",
    providerRefundId: refund.id || "",
    providerPaymentId: refund.payment_id || "",
    amountPaise: Number(refund.amount) || 0,
    status: String(refund.status || "").toLowerCase(), // pending | processed | failed
    speedRequested: refund.speed_requested || "",
    speedProcessed: refund.speed_processed || "",
    arn: refund.acquirer_data ? refund.acquirer_data.arn || "" : "",
    receipt: refund.receipt || "",
    createdAt: rzpTimestampToDate_(refund.created_at),
    raw: refund,
  };
}

// ---------------------------------------------------------------------------
// Provider interface (§34)
// ---------------------------------------------------------------------------

/**
 * The active payment provider. PaymentService.gs talks only to this.
 * @return {Object}
 */
function getPaymentProvider_() {
  return RazorpayProvider;
}

var RazorpayProvider = {
  name: "razorpay",

  /**
   * Create Payment Link.
   *
   * @param {Object} req
   * @param {string} req.reference        Our internal payment reference (unique)
   * @param {number} req.amountPaise
   * @param {string} req.currency
   * @param {string} req.description
   * @param {string} req.customerName
   * @param {string} req.customerContact  E.164-ish, e.g. "+919999999999"
   * @param {string} [req.customerEmail]
   * @param {Date}   req.expiresAt
   * @param {Object} [req.notes]
   * @return {{ok: boolean, link: Object|null, error: Object|null, message: string}}
   */
  createPaymentLink: function (req) {
    var reference = String(req.reference || "").slice(0, RZP_MAX_REFERENCE_LENGTH);

    // Razorpay rejects expire_by under 15 minutes out; clamp defensively so a
    // misconfigured hold_minutes cannot make link creation fail outright.
    var floor = new Date(Date.now() + RZP_MIN_EXPIRY_MINUTES * 60 * 1000);
    var expiresAt = req.expiresAt && req.expiresAt > floor ? req.expiresAt : floor;

    var body = {
      amount: Math.round(req.amountPaise),
      currency: req.currency || "INR",
      accept_partial: false,
      reference_id: reference,
      description: String(req.description || "").slice(0, 2048),
      customer: {
        name: String(req.customerName || "").slice(0, 100),
        contact: req.customerContact || "",
      },
      // We send the link ourselves over WhatsApp, and we send our own
      // confirmation email (§15), so Razorpay's own notifications stay off.
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: Math.floor(expiresAt.getTime() / 1000),
      notes: req.notes || {},
    };
    if (req.customerEmail) body.customer.email = req.customerEmail;

    var result = razorpayRequest_("post", "/payment_links", body);
    if (!result.ok) {
      return {
        ok: false,
        link: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return {
      ok: true,
      link: rzpNormalizeLink_(result.data),
      error: null,
      message: "",
    };
  },

  /** Check Payment — fetch authoritative link state. */
  fetchPaymentLink: function (providerLinkId) {
    var result = razorpayRequest_(
      "get",
      "/payment_links/" + encodeURIComponent(providerLinkId)
    );
    if (!result.ok) {
      return {
        ok: false,
        link: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return { ok: true, link: rzpNormalizeLink_(result.data), error: null, message: "" };
  },

  /** Cancel Payment Request. Only a link in `created` state can be cancelled. */
  cancelPaymentLink: function (providerLinkId) {
    var result = razorpayRequest_(
      "post",
      "/payment_links/" + encodeURIComponent(providerLinkId) + "/cancel"
    );
    if (!result.ok) {
      return {
        ok: false,
        link: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return { ok: true, link: rzpNormalizeLink_(result.data), error: null, message: "" };
  },

  /** Fetch one payment — used to verify amount and capture time. */
  fetchPayment: function (providerPaymentId) {
    var result = razorpayRequest_(
      "get",
      "/payments/" + encodeURIComponent(providerPaymentId)
    );
    if (!result.ok) {
      return {
        ok: false,
        payment: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return {
      ok: true,
      payment: rzpNormalizePayment_(result.data),
      error: null,
      message: "",
    };
  },

  /**
   * Create Refund against the original payment (§21 — always back to source).
   *
   * @param {string} providerPaymentId
   * @param {number} [amountPaise]  Omit for a full refund.
   * @param {Object} [opts]
   * @param {string} [opts.receipt]         Our RefundRef; Razorpay treats it as
   *                                        an idempotency key.
   * @param {string} [opts.idempotencyKey]  Sent as X-Razorpay-Idempotency-Key.
   * @param {Object} [opts.notes]
   */
  createRefund: function (providerPaymentId, amountPaise, opts) {
    opts = opts || {};
    var body = { speed: "normal" };
    if (amountPaise) body.amount = Math.round(amountPaise);
    if (opts.receipt) body.receipt = String(opts.receipt).slice(0, 40);
    if (opts.notes) body.notes = opts.notes;

    var headers = {};
    if (opts.idempotencyKey) {
      headers["X-Razorpay-Idempotency-Key"] = String(opts.idempotencyKey);
    }

    var result = razorpayRequest_(
      "post",
      "/payments/" + encodeURIComponent(providerPaymentId) + "/refund",
      body,
      headers
    );
    if (!result.ok) {
      return {
        ok: false,
        refund: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return {
      ok: true,
      refund: rzpNormalizeRefund_(result.data),
      error: null,
      message: "",
    };
  },

  /** Check Refund — one refund by id. */
  fetchRefund: function (providerPaymentId, providerRefundId) {
    var result = razorpayRequest_(
      "get",
      "/payments/" +
        encodeURIComponent(providerPaymentId) +
        "/refunds/" +
        encodeURIComponent(providerRefundId)
    );
    if (!result.ok) {
      return {
        ok: false,
        refund: null,
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    return {
      ok: true,
      refund: rzpNormalizeRefund_(result.data),
      error: null,
      message: "",
    };
  },

  /**
   * Every refund already raised against a payment. Used before initiating a
   * refund so we can never accidentally refund twice (§32).
   */
  fetchRefundsForPayment: function (providerPaymentId) {
    var result = razorpayRequest_(
      "get",
      "/payments/" + encodeURIComponent(providerPaymentId) + "/refunds"
    );
    if (!result.ok) {
      return {
        ok: false,
        refunds: [],
        error: result.error,
        message: razorpayErrorText_(result),
      };
    }
    var items = (result.data && result.data.items) || [];
    var refunds = [];
    for (var i = 0; i < items.length; i++) {
      refunds.push(rzpNormalizeRefund_(items[i]));
    }
    return { ok: true, refunds: refunds, error: null, message: "" };
  },

  /**
   * Process Payment Notification — pull the identifiers out of a webhook body.
   *
   * Deliberately extracts identifiers ONLY. Every financial field is discarded
   * and re-fetched from the API before anything is acted on, because Apps Script
   * cannot verify the X-Razorpay-Signature header. See paymentPlan.md §6.1.
   *
   * @param {Object} body Parsed webhook JSON
   * @return {{event: string, providerLinkId: string, providerPaymentId: string,
   *           providerRefundId: string, reference: string, providerEventId: string}}
   */
  parseWebhookEvent: function (body) {
    var payload = (body && body.payload) || {};
    var link =
      payload.payment_link && payload.payment_link.entity
        ? payload.payment_link.entity
        : {};
    var payment =
      payload.payment && payload.payment.entity ? payload.payment.entity : {};
    var refund =
      payload.refund && payload.refund.entity ? payload.refund.entity : {};

    // Our reference travels in three places; take whichever survives.
    var reference =
      link.reference_id ||
      (link.notes && link.notes.payment_ref) ||
      (payment.notes && payment.notes.payment_ref) ||
      "";

    return {
      event: String((body && body.event) || ""),
      providerLinkId: link.id || "",
      providerPaymentId: payment.id || refund.payment_id || "",
      providerRefundId: refund.id || "",
      reference: reference,
      providerEventId: String((body && body.id) || ""),
      accountId: String((body && body.account_id) || ""),
    };
  },
};

// ---------------------------------------------------------------------------
// Connectivity check — run from the editor after storing credentials.
// ---------------------------------------------------------------------------

/**
 * Verifies that the stored credentials can actually talk to Razorpay.
 * Returns a safe summary; never echoes the key or secret.
 */
function testRazorpayConnection() {
  try {
    var creds = getRazorpayCredentials_();
    var result = razorpayRequest_("get", "/payment_links?count=1");
    if (!result.ok) {
      Logger.log("Razorpay connection FAILED: " + razorpayErrorText_(result));
      return {
        success: false,
        mode: creds.mode,
        message: razorpayErrorText_(result),
      };
    }
    var count = result.data && result.data.count !== undefined ? result.data.count : 0;
    Logger.log(
      "Razorpay connection OK (mode: " + creds.mode + ", links visible: " + count + ")"
    );
    return { success: true, mode: creds.mode, linksVisible: count };
  } catch (e) {
    Logger.log("Razorpay connection error: " + e.toString());
    return { success: false, message: e.toString() };
  }
}
