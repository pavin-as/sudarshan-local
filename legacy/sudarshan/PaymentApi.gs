/**
 * PaymentApi.gs — the surface the reception UI is allowed to call (WP4).
 *
 * The booking flow stays in Code.js and knows nothing about payments. This file
 * is the seam: it calls submitAppointment() exactly as the page did before, then
 * attaches a payment request to the appointment it created. If the payment step
 * fails, the appointment still exists and reception can retry the link from the
 * panel — a provider outage must never lose a booking (§32).
 *
 * Every function here validates the session before doing anything.
 */

/**
 * Book an appointment and, when asked, immediately raise a payment request.
 *
 * Drop-in replacement for google.script.run.submitAppointment(...) — the
 * response keeps `success` and `message` in the same shape, and adds a
 * `payment` block when one was requested.
 *
 * @param {Object} appointmentData  Everything submitAppointment() takes, plus:
 * @param {boolean} appointmentData.paymentRequired
 * @param {number}  [appointmentData.paymentAmountPaise]
 * @param {string}  [appointmentData.paymentMobile]  reception-confirmed number
 * @return {Object}
 */
function submitAppointmentWithPayment(appointmentData) {
  appointmentData = appointmentData || {};

  var session = getUserSession(appointmentData.sessionToken);
  if (!session) {
    return { success: false, message: "Session expired. Please login again." };
  }

  // 1. Book. Unmodified core path.
  var booking = submitAppointment(appointmentData);
  if (!booking || !booking.success) {
    return booking || { success: false, message: "Booking failed." };
  }

  if (!appointmentData.paymentRequired) {
    return booking;
  }

  // 2. Attach a payment request.
  if (!booking.appointmentId) {
    // Should not happen — submitAppointment returns it — but never leave the
    // user thinking a payment link exists when it does not.
    booking.payment = {
      success: false,
      message:
        "Appointment booked, but its ID was not returned so no payment link could be created. Raise the link from the appointment list.",
    };
    return booking;
  }

  var payment = createPaymentRequest({
    appointmentId: booking.appointmentId,
    sessionToken: appointmentData.sessionToken,
    amountPaise: appointmentData.paymentAmountPaise,
    mobile:
      appointmentData.paymentMobile ||
      (appointmentData.patientData ? appointmentData.patientData.Phone : ""),
  });

  booking.payment = payment;
  booking.message = payment.success
    ? booking.message + " Payment link created — send it to the patient to confirm the slot."
    : booking.message +
      " NOTE: the payment link could NOT be created (" +
      payment.message +
      "). The slot is booked but unpaid — retry the link from the appointment list.";

  return booking;
}

/**
 * Config the booking page needs before it can show the payment section.
 * Cheap enough to call on page load.
 */
function getPaymentBookingContext(sessionToken) {
  try {
    var session = getUserSession(sessionToken);
    if (!session) return { success: false, message: "Session expired." };

    var config = getPaymentConfig();
    return {
      success: true,
      enabled: config.enabled === true,
      defaultAmountPaise: config.default_amount_paise,
      defaultAmountDisplay: formatPaise(config.default_amount_paise),
      allowAmountOverride: config.allow_amount_override === true,
      minAmountPaise: config.min_amount_paise,
      maxAmountPaise: config.max_amount_paise,
      holdMinutes: config.hold_minutes,
      paymentRequiredTypes: config.payment_required_types || [],
      clinicName: config.clinic_display_name,
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Raise a payment link for an appointment that already exists — the retry path
 * after a provider failure, and the entry point from the appointment list.
 */
function createPaymentLinkForAppointment(appointmentId, amountPaise, mobile, sessionToken) {
  return createPaymentRequest({
    appointmentId: appointmentId,
    sessionToken: sessionToken,
    amountPaise: amountPaise,
    mobile: mobile,
  });
}
