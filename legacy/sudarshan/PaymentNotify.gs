/**
 * PaymentNotify.gs — outbound notifications for the payment module (WP6).
 *
 * Phase 1 policy (confirmed 4 Sep 2026):
 *   - Clinic gets EMAIL for every confirmed payment and every refund.
 *   - Patient gets WHATSAPP ONLY, sent manually by reception through the
 *     one-click wa.me link. No patient email is sent.
 *
 * Apps Script sends the clinic email itself rather than relying on Razorpay's
 * own receipts (§15), so a Razorpay notification failure never means the clinic
 * is unaware a payment arrived.
 *
 * Nothing here may ever include a credential (§33).
 */

/**
 * Recipients for clinic-facing payment mail.
 * @return {Array<string>}
 */
function getPaymentNotifyRecipients_() {
  var config = getPaymentConfig();
  var list = config.clinic_notify_emails || [];
  var valid = [];
  for (var i = 0; i < list.length; i++) {
    var address = String(list[i] || "").trim();
    if (address && address.indexOf("@") > 0) valid.push(address);
  }
  return valid;
}

/**
 * Send the clinic's payment-received email and flag the payment row.
 *
 * Called from applyProviderLinkState_() while the payment lock is held, so it
 * must stay quick — one MailApp call, one cell write. If Razorpay times out
 * waiting for the webhook it simply retries, and the duplicate guard in
 * applyProviderLinkState_ means the second delivery sends nothing.
 *
 * @param {string} paymentRef
 * @return {{success: boolean, message: string}}
 */
function sendPaymentConfirmationEmail_(paymentRef) {
  try {
    var located = findPaymentRow_({ paymentRef: paymentRef });
    if (!located.found) {
      return { success: false, message: "Payment record not found." };
    }
    var payment = located.payment;

    // Idempotency: never send twice for the same payment (§13).
    if (String(payment.ConfirmationEmailSent || "").toLowerCase() === "yes") {
      return { success: true, message: "Confirmation email already sent." };
    }

    var recipients = getPaymentNotifyRecipients_();
    if (!recipients.length) {
      Logger.log(
        "No clinic_notify_emails configured — skipping confirmation email for " +
          paymentRef
      );
      return { success: false, message: "No recipients configured." };
    }

    var config = getPaymentConfig();
    var dateDisplay = formatAppointmentDateLong_(payment.AppointmentDate);
    var timeDisplay = payment.AppointmentTime || "";
    var paidDisplay = payment.PaidAt
      ? Utilities.formatDate(
          new Date(payment.PaidAt),
          Session.getScriptTimeZone(),
          "d MMM yyyy, h:mm a"
        )
      : "";

    var subject =
      "Payment received — " +
      payment.PatientName +
      " — " +
      dateDisplay +
      (timeDisplay ? " " + timeDisplay : "");

    var rows = [
      ["Patient", payment.PatientName],
      ["MRD No", payment.MRDNo],
      ["Mobile", payment.Mobile],
      ["Appointment", dateDisplay + (timeDisplay ? ", " + timeDisplay : "")],
      ["Appointment ID", payment.AppointmentID],
      ["Amount", formatPaise(payment.PaidAmountPaise || payment.AmountPaise)],
      ["Payment", "Successful"],
      ["Payment ID", payment.ProviderPaymentId],
      ["Payment Reference", payment.PaymentRef],
      ["Paid at", paidDisplay],
      ["Appointment status", payment.AppointmentStatus],
    ];

    var plain = [config.clinic_display_name, "", "PAYMENT RECEIVED", ""];
    for (var i = 0; i < rows.length; i++) {
      plain.push(rows[i][0] + ": " + rows[i][1]);
    }
    plain.push("");
    plain.push("This is an automated message from the Sampada appointment system.");

    MailApp.sendEmail({
      to: recipients.join(","),
      subject: subject,
      body: plain.join("\n"),
      htmlBody: buildPaymentEmailHtml_(
        config.clinic_display_name,
        "Payment Received",
        "#1e7e34",
        rows
      ),
    });

    writePaymentFields_(located.table.sheet, located.table.index, located.sheetRow, {
      ConfirmationEmailSent: "Yes",
    });

    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_CONFIRMED,
      appointmentId: payment.AppointmentID,
      paymentRef: payment.PaymentRef,
      providerPaymentId: payment.ProviderPaymentId,
      amountPaise: payment.PaidAmountPaise || payment.AmountPaise,
      actor: "SYSTEM",
      result: "OK",
      detail: { stage: "confirmation_email", recipients: recipients.length },
    });

    return { success: true, message: "Confirmation email sent." };
  } catch (e) {
    Logger.log("sendPaymentConfirmationEmail_ failed: " + e.toString());
    logPaymentEvent({
      eventType: PAYMENT_EVENTS.PAYMENT_CONFIRMED,
      paymentRef: paymentRef,
      actor: "SYSTEM",
      result: "FAIL",
      detail: { stage: "confirmation_email" },
      error: e.toString(),
    });
    return { success: false, message: e.toString() };
  }
}

/**
 * Alert the clinic when something needs a human: amount mismatch, or a payment
 * that arrived after the slot was released (§18, §32).
 *
 * @param {string} paymentRef
 * @param {string} reason  short human sentence
 */
function sendPaymentReviewAlert_(paymentRef, reason) {
  try {
    var located = findPaymentRow_({ paymentRef: paymentRef });
    if (!located.found) return { success: false, message: "Not found." };
    var payment = located.payment;

    var recipients = getPaymentNotifyRecipients_();
    if (!recipients.length) return { success: false, message: "No recipients." };

    var config = getPaymentConfig();
    var rows = [
      ["Why this needs review", reason],
      ["Patient", payment.PatientName],
      ["MRD No", payment.MRDNo],
      ["Mobile", payment.Mobile],
      [
        "Appointment",
        formatAppointmentDateLong_(payment.AppointmentDate) +
          (payment.AppointmentTime ? ", " + payment.AppointmentTime : ""),
      ],
      ["Appointment ID", payment.AppointmentID],
      ["Expected amount", formatPaise(payment.AmountPaise)],
      [
        "Amount received",
        payment.PaidAmountPaise ? formatPaise(payment.PaidAmountPaise) : "—",
      ],
      ["Payment ID", payment.ProviderPaymentId],
      ["Payment Reference", payment.PaymentRef],
      ["Payment status", payment.PaymentStatus],
      ["Appointment status", payment.AppointmentStatus],
    ];

    var plain = [
      config.clinic_display_name,
      "",
      "ACTION REQUIRED — PAYMENT NEEDS MANUAL REVIEW",
      "",
    ];
    for (var i = 0; i < rows.length; i++) {
      plain.push(rows[i][0] + ": " + rows[i][1]);
    }
    plain.push("");
    plain.push(
      "The appointment has NOT been confirmed automatically. Staff must decide whether to offer another slot, refund the payment, or make another arrangement."
    );

    MailApp.sendEmail({
      to: recipients.join(","),
      subject:
        "ACTION REQUIRED: payment needs review — " +
        payment.PatientName +
        " (" +
        payment.PaymentRef +
        ")",
      body: plain.join("\n"),
      htmlBody: buildPaymentEmailHtml_(
        config.clinic_display_name,
        "Payment Needs Manual Review",
        "#b02a37",
        rows,
        "The appointment has <strong>not</strong> been confirmed automatically. Staff must decide whether to offer another slot, refund the payment, or make another arrangement."
      ),
    });

    return { success: true };
  } catch (e) {
    Logger.log("sendPaymentReviewAlert_ failed: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

/**
 * Shared HTML shell. Deliberately plain — this is operational mail, and it has
 * to stay readable in every client the clinic uses.
 */
function buildPaymentEmailHtml_(clinicName, heading, accent, rows, footnote) {
  var cells = "";
  for (var i = 0; i < rows.length; i++) {
    cells +=
      '<tr><td style="padding:6px 12px 6px 0;color:#555;white-space:nowrap;vertical-align:top">' +
      escapeHtmlForEmail_(rows[i][0]) +
      '</td><td style="padding:6px 0;font-weight:600;color:#111">' +
      escapeHtmlForEmail_(rows[i][1]) +
      "</td></tr>";
  }

  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;max-width:560px">' +
    '<div style="border-left:4px solid ' +
    accent +
    ';padding-left:12px;margin-bottom:16px">' +
    '<div style="color:#666;font-size:12px;letter-spacing:.5px;text-transform:uppercase">' +
    escapeHtmlForEmail_(clinicName) +
    "</div>" +
    '<div style="font-size:18px;font-weight:700;color:' +
    accent +
    '">' +
    escapeHtmlForEmail_(heading) +
    "</div></div>" +
    '<table style="border-collapse:collapse">' +
    cells +
    "</table>" +
    (footnote
      ? '<p style="margin-top:16px;color:#333">' + footnote + "</p>"
      : "") +
    '<p style="margin-top:20px;color:#888;font-size:12px">Automated message from the Sampada appointment system.</p>' +
    "</div>"
  );
}

/** Minimal escaping — these values come from our own sheets, not user HTML. */
function escapeHtmlForEmail_(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Refund notifications (§26)
// ---------------------------------------------------------------------------

/**
 * Clinic email when a refund is raised. Records who initiated it — refunds move
 * real money, so the audit trail names a person, not "the system".
 * @param {string} refundRef
 */
function notifyRefundInitiated_(refundRef) {
  try {
    sendRefundEmail_(
      refundRef,
      "Refund Initiated",
      "#b8860b",
      "The refund has been sent to Razorpay. It will show as REFUNDED once the bank completes it — this normally takes a few working days."
    );
  } catch (e) {
    Logger.log("notifyRefundInitiated_ failed for " + refundRef + ": " + e.toString());
  }
}

/** Clinic email when the bank has actually completed the refund. */
function notifyRefundCompleted_(refundRef) {
  try {
    sendRefundEmail_(
      refundRef,
      "Refund Completed",
      "#1e7e34",
      "The refund has been completed by the bank and has left Razorpay."
    );
  } catch (e) {
    Logger.log("notifyRefundCompleted_ failed for " + refundRef + ": " + e.toString());
  }
}

/**
 * Shared refund mail. Includes every identifier the clinic needs to answer
 * "where is my refund?" without opening the Razorpay dashboard (§27).
 */
function sendRefundEmail_(refundRef, heading, accent, footnote) {
  var located = findRefundRow_(refundRef);
  if (!located.found) return { success: false, message: "Refund not found." };
  var refund = located.refund;

  var recipients = getPaymentNotifyRecipients_();
  if (!recipients.length) {
    Logger.log("No clinic_notify_emails configured — skipping refund mail for " + refundRef);
    return { success: false, message: "No recipients configured." };
  }

  var paymentRow = findPaymentRow_({ paymentRef: refund.PaymentRef });
  var payment = paymentRow.found ? paymentRow.payment : {};
  var config = getPaymentConfig();

  var rows = [
    ["Patient", payment.PatientName || ""],
    ["MRD No", payment.MRDNo || ""],
    ["Mobile", payment.Mobile || ""],
    [
      "Appointment",
      formatAppointmentDateLong_(payment.AppointmentDate) +
        (payment.AppointmentTime ? ", " + payment.AppointmentTime : ""),
    ],
    ["Appointment ID", refund.AppointmentID],
    ["Original payment", formatPaise(payment.PaidAmountPaise || payment.AmountPaise)],
    ["Original Payment ID", refund.ProviderPaymentId],
    ["Refund amount", formatPaise(refund.RefundAmountPaise)],
    ["Refund type", refund.RefundType],
    ["Refund ID", refund.ProviderRefundId || "(not yet issued)"],
    ["Refund reference", refund.RefundRef],
    ["Refund status", refund.RefundStatus],
    ["Reason", refund.RefundReason],
    ["Remarks", refund.RefundRemarks || "—"],
    ["Initiated by", refund.RequestedBy],
    ["Bank reference (ARN)", refund.ProviderArn || "not yet available"],
  ];

  var plain = [config.clinic_display_name, "", heading.toUpperCase(), ""];
  for (var i = 0; i < rows.length; i++) {
    plain.push(rows[i][0] + ": " + rows[i][1]);
  }
  plain.push("");
  plain.push(footnote);

  MailApp.sendEmail({
    to: recipients.join(","),
    subject:
      heading +
      " — " +
      (payment.PatientName || refund.AppointmentID) +
      " — " +
      formatPaise(refund.RefundAmountPaise),
    body: plain.join("\n"),
    htmlBody: buildPaymentEmailHtml_(
      config.clinic_display_name,
      heading,
      accent,
      rows,
      footnote
    ),
  });

  return { success: true };
}
