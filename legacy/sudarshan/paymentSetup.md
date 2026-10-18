# Payment Module — Setup Runbook

Companion to `paymentPlan.md`. Follow the parts in order.
**You cannot break anything by doing Part A and Part B early** — the module ships with
`enabled = false`, so nothing in the appointment system changes until you flip it.

---

## When do you actually need the Razorpay account?

| You need | At which point | Why |
|---|---|---|
| **Nothing** | WP0, WP1 (bug fix, sheets, config) | Already done — no Razorpay contact at all. |
| **Test-mode account + test API keys** | **WP2 — now** | To make any real API call. Sign-up takes ~10 minutes and **test mode does not require KYC**. |
| **KYC submitted** | Before WP9 (go-live) | Only live keys need an activated account. |
| **Fully activated account + live keys** | WP9 only | Real money. |

So: **create the account now, in test mode.** KYC can run in parallel over the
following week while WP3–WP8 are built against test mode.

Budget for the activation timeline — KYC review is roughly 1–2 business days and
operations activation a further 3–4 business days, so start the paperwork early
even though nothing before WP9 is blocked on it.

One test-mode limit worth knowing: Razorpay caps test accounts at **30 payment
links per business**. That is enough for the WP2–WP8 test matrix, but do not
generate them carelessly.

---

## Part A — Create the Razorpay account

1. Go to <https://razorpay.com> and click **Sign Up**.
2. Register with a **clinic-owned email address**, not a personal one. This
   mailbox receives settlement and dispute notices and is painful to change later.
   Use a shared/role mailbox if you have one.
3. Set the business name to the clinic's registered legal name (not the trading
   name) — it must match the KYC documents.
4. Choose business category: **Healthcare → Clinics / Hospitals**.
5. When asked which products you want, select **Payment Links**. You do not need
   Payment Gateway checkout, Route, or RazorpayX for this module.

You now have a working **Test Mode** dashboard. Stop here and go to Part B —
everything in WP2–WP8 runs on test mode.

### KYC documents to start gathering (needed only before go-live)

The exact list depends on the clinic's legal entity type (proprietorship,
partnership, private limited, trust). Typically:

- PAN card of the business, plus PAN of the proprietor/directors
- Business registration proof (GST certificate, Shops & Establishment licence,
  clinic registration certificate, or incorporation certificate)
- Address proof (Aadhaar / passport / utility bill)
- Bank account proof in the business's name — cancelled cheque or bank statement
  (this is the account settlements land in)
- Authorised signatory identity proof

Check the exact list for your entity type at
<https://razorpay.com/docs/payments/business-types-kyc-documents/>.
The whole KYC process is online — nothing needs to be posted.

**Settlement account:** decide now which bank account receives the money, and
confirm with your accountant before submitting. Changing it after activation
requires a fresh verification round.

---

## Part B — Get test API keys

1. In the Razorpay dashboard, confirm the mode toggle (top of the screen) reads
   **Test Mode**.
2. Go to **Account & Settings → API Keys → Generate Test Key**.
3. You will be shown a **Key ID** (`rzp_test_...`) and a **Key Secret**.
   The secret is displayed **exactly once**. Copy both into your password
   manager immediately.
4. Do **not** paste them into a sheet, a document, a chat message, or any file in
   this repository.

If a secret has been exposed anywhere — including a chat window — regenerate it
in the Razorpay dashboard and repeat Part B. Regenerating invalidates the old
pair immediately.

---

## Part C — Configure the Apps Script side

Run these from the Apps Script editor, in this order. Select the function name in
the toolbar dropdown, press Run, and read the output in **Executions / Logs**.

### 1. Create the sheets and configuration rows

```
initializePaymentSheets()
```

Creates `payment`, `refund`, and `paymentLog`, and seeds the `payment` category
rows in the existing `API_setting` sheet. Safe to re-run — it only adds what is
missing.

### 2. Store the credentials

**The editor's Run button cannot pass arguments to a function**, so running
`setupRazorpayCredentials()` directly will always fail with
*"Both keyId and keySecret are required."* Use one of these instead.

#### Option A — enter them by hand (recommended)

The secret never touches a code file this way.

1. In the Apps Script editor, click the **gear icon (Project Settings)** in the
   left sidebar.
2. Scroll to **Script Properties** → **Add script property**.
3. Add three properties, exactly these names:

   | Property | Value |
   |---|---|
   | `RZP_KEY_ID` | `rzp_test_XXXXXXXX` |
   | `RZP_KEY_SECRET` | your test key secret |
   | `RZP_MODE` | `test` |

4. Click **Save script properties**.
5. Back in the editor, run:

   ```
   validateRazorpayCredentials()
   ```

   It checks the names, the `rzp_test_` / `rzp_live_` prefix against the mode,
   and catches the stray copy-paste whitespace that otherwise shows up later as
   a confusing 401. It reports lengths and a truncated key ID only — never the
   secret.

#### Option B — type them into a dialog

With the spreadsheet open, run:

```
setupRazorpayCredentialsFromPrompt()
```

Three dialogs appear in the spreadsheet tab; paste Key ID, Key Secret, and
`test`. This calls the same validation and storage as Option A.

If it reports that no UI is available, the spreadsheet is not open — use Option A.

### 3. Verify the connection

```
testRazorpayConnection()
```

Expect `Razorpay connection OK (mode: test, links visible: 0)`.
If it fails, the message tells you whether it was auth (`BAD_REQUEST_ERROR` /
401) or network.

### 4. Full health check

```
paymentModuleHealthCheck()
```

Prints sheets, configuration, which credentials are set (never their values), and
provider reachability. This is the "done when" test for WP1 and WP2.

### 5. Match the appointment types to reality

The health check prints `appointmentTypesInUse`, read from `generalSettings!D2`
(the list `getAppointmentTypes()` uses, `Code.js:5814`). Compare it against
`payment_required_types` in the `API_setting` sheet and make the strings match
what reception actually selects. The default is:

```json
["EMERGENCY", "SAME DAY", "NEXT DAY"]
```

Matching ignores case, spaces, hyphens and underscores, so `Same-Day` and
`SAME DAY` both work — but a genuinely different word (`URGENT`, say) will not.
This only sets the **default** state of the checkbox; reception can always tick it
on or off per appointment.

### 6. Point the clinic email at the right mailbox

The code default is now `["admin@gs.sampadavr.com"]`. **If you already ran
`initializePaymentSheets()` before this change**, the `API_setting` row was
created with the old empty value and will not be overwritten — open the
`API_setting` sheet, find the row with category `payment` and key
`clinic_notify_emails`, and set its `value` cell to exactly:

```
["admin@gs.sampadavr.com"]
```

The JSON brackets and quotes matter. A malformed value is ignored and logged,
and the module falls back to the default.

### 7. Leave the module off

`payment.enabled` stays `false` in `API_setting` until WP4's UI is built and
tested. Nothing in booking, rescheduling, or cancellation behaves differently
while it is off.

---

## Part D — Webhook (WP5 — code is ready, do this now)

1. Run `generateWebhookToken()` in the editor and copy the URL it logs.
2. Razorpay dashboard → **Account & Settings → Webhooks → Add New Webhook**.
3. Paste the URL (it already includes `?wh=<token>`).
4. Select events: `payment_link.paid`, `payment_link.expired`,
   `payment_link.cancelled`, `payment.failed`, `refund.processed`, `refund.failed`.
   The first four are handled now; the refund events are logged for
   reconciliation and acted on in WP8.
5. Razorpay will also ask for a webhook secret. Set one — it costs nothing — but
   be aware Apps Script cannot read the signature header it produces, which is why
   the URL token plus API re-verification is what actually protects us
   (`paymentPlan.md` §6.1).
6. Re-deploy the web app: **Deploy → Manage deployments → edit the existing
   deployment → New version**, execute as **Me**, access **Anyone**.
   Editing the existing deployment keeps the `/exec` URL stable; creating a *new*
   deployment would change it and break both the webhook and every saved staff link.

---

## Part E — Install the background triggers (WP7)

The 15-minute hold does nothing until a scheduled job enforces it. Run once
from the editor:

```
installPaymentTriggers()
```

This creates two time-driven triggers and is safe to re-run — it removes its own
triggers first, so you never end up with duplicates. It leaves every other
project trigger alone.

| Job | Every | What it does |
|---|---|---|
| `sweepExpiredPaymentHolds` | 1 minute | Releases slots whose hold has run out |
| `reconcileOpenPayments` | 1 hour | Re-checks stranded payments and pending refunds, and repairs payment records for appointments cancelled from other screens |

Verify with `listPaymentTriggers()`. Remove with `removePaymentTriggers()`.

**How the sweep avoids stealing a slot from someone who paid:** for every
expired candidate it asks Razorpay first. Only if the payment is *still*
outstanding after that check does it cancel the link, mark the payment EXPIRED,
and move the appointment into the `cancel` sheet. A payment that completed
before the deadline wins, even if the sweep got there first (§17).

To test without waiting for the clock, run `runPaymentSweepNow()` or
`runPaymentReconcileNow()`.

---

## Part F — What reception sees

**Booking screen** — a payment section above the action buttons. Auto-ticks for
Emergency / Same Day / Next Day, amount prefilled, mobile confirmed explicitly.
On submit, a modal with the link plus *Send on WhatsApp*, *Copy link*,
*Check payment*, *Cancel request*.

**Appointment list** — a badge on every appointment that has a payment
(`AWAITING Rs 500`, `PAID Rs 500`, `NEEDS REVIEW`, `REFUNDED`) plus the actions
appropriate to that state: *Generate payment link*, *Check payment*,
*Resend link*, *Cancel request*, *Cancel & refund*.

**Cancelled list** — the same badges, with *Refund* and *Refund status*.
The appointment is already cancelled there, so refunding is a separate act.

Refund buttons appear only for level 1 (director/admin) users, and the server
refuses the call regardless of what the browser sends.

---

## Testing the webhook without waiting for Razorpay

`simulateWebhookForPayment("SAMP-APT-...")` replays a `payment_link.paid`
delivery through the real `doPost` path — token check, duplicate guard, routing
and all. It does **not** fake a payment: the handler still asks Razorpay for the
truth, so unless that link really was paid in test mode the correct answer comes
back as "No payment received yet". That is the point — it proves the trust model
works.

---

## Redeploying after a code change

Any time a `.gs` or `.html` file changes, the **web app must be redeployed** or
the webhook keeps running the old code. The editor's Save button is not enough.

1. Push the changed files (clasp `clasp push`, or paste them in the editor).
2. **Deploy → Manage deployments → pencil icon on the existing deployment →
   Version: New version → Deploy.**
3. Confirm the `/exec` URL is unchanged. Editing the existing deployment keeps
   it; creating a *new* deployment would issue a different URL and silently
   break the webhook and every saved staff link.
4. Reload any open reception tabs — the browser caches the served HTML.

Triggers pick up new code automatically; only the web app needs redeploying.
Re-run `installPaymentTriggers()` only if you changed trigger schedules.

---

## Part G — End-to-end test script (test mode)

Run these in order. Watch the `paymentLog` sheet throughout — it is the
authoritative record of what the system thinks happened.

Test payment credentials: UPI ID `success@razorpay` for a successful payment and
`failure@razorpay` for a declined one. For cards, use any number from
<https://razorpay.com/docs/payments/payments/test-card-details/> with any future
expiry and any CVV. No real money moves.

Remember the test-mode cap of **30 payment links per business** — these tests use
about eight.

### G1. Happy path

1. Book an Emergency appointment with the payment box ticked.
2. Expect: modal with a link, `payment` row PENDING / SLOT_HELD, `paymentLog`
   row `PAYMENT_LINK_CREATED`.
3. Click **Send on WhatsApp** — expect a `PAYMENT_LINK_SENT` row.
4. Open the link, pay with `success@razorpay`.
5. Within seconds expect `WEBHOOK_RECEIVED` then `PAYMENT_CONFIRMED`, the
   `payment` row at PAID / CONFIRMED, and an email at
   admin@gs.sampadavr.com.
6. Appointment list should now show a green `PAID Rs 500` badge.

**Pass criteria:** exactly one confirmation email, `ProviderPaymentId` populated,
`ConfirmationEmailSent` = Yes.

### G2. Duplicate webhook

1. In the Razorpay dashboard, find the webhook delivery and **Resend** it
   (or run `simulateWebhookForPayment` with the same reference).
2. Expect a `WEBHOOK_DUPLICATE` row and **no** second email.

**Pass criteria:** the payment row is byte-identical afterwards.

### G3. Rejected webhook

1. Open your webhook URL in a browser with the `wh` token altered.
2. Expect a `WEBHOOK_REJECTED` row and no state change anywhere.

### G4. Hold expiry

1. Book another payment-required appointment. Do **not** pay.
2. Wait out the hold (default 15 minutes) — or set `hold_minutes` to `1` in
   `API_setting` first to make this quick, then set it back.
3. Expect `PAYMENT_EXPIRED` then `SLOT_RELEASED`, the payment row at
   EXPIRED / RELEASED, and the appointment moved to the `cancel` sheet.
4. Confirm the time slot is bookable again.

### G5. Late payment (the important one)

1. Repeat G4 but keep the payment link open.
2. After the slot is released, pay the link with `success@razorpay`.
3. Expect `LATE_PAYMENT_RECEIVED`, payment row PAID /
   **MANUAL_REVIEW_REQUIRED**, and an **ACTION REQUIRED** email.

**Pass criteria:** the appointment is *not* reconfirmed and the released slot is
*not* taken back. This is the rule that protects whoever got the slot next (§18).

### G5b. Cancelling a payment request

1. Book a payment-required appointment, then click **Cancel request**.
2. Confirm. Expect `PAYMENT_LINK_CANCELLED` and `SLOT_RELEASED`, the payment row
   at CANCELLED / RELEASED, the appointment moved to the `cancel` sheet, and the
   slot bookable again.

**Why the appointment exists before payment:** a held slot has to occupy a row
in the `appointment` sheet, because `getBookedSlots()` (Code.js:7592) counts
every row there — that is what stops a second patient being given the same slot
while the first is paying. So the row appearing immediately is correct; what
matters is that it goes away when the hold ends, whether that is a cancellation
or the sweep.

If reception simply closes the payment modal without cancelling, the sweep
releases the slot when the hold expires — **but only if
`installPaymentTriggers()` has been run.** Without the triggers, abandoned holds
sit in the appointment sheet indefinitely.

### G5c. Reschedule keeps the payment (§29)

1. Take the confirmed appointment from G1 and reschedule it to another date.
2. Expect a `RESCHEDULE_LINKED` row in `paymentLog` recording the from/to dates.
3. Expect the `payment` row's `AppointmentDate` / `AppointmentTime` to show the
   **new** slot, `PaymentStatus` still PAID, and no refund raised.
4. Refund it and check the refund email quotes the **new** date, not the old one.

**Pass criteria:** rescheduling never refunds, never re-opens the payment, and
never leaves a patient-facing message quoting the appointment they no longer have.

### G6. Failed payment

1. Create a link and pay it with `failure@razorpay`.
2. Expect a `PAYMENT_FAILED` row in `paymentLog` carrying the provider's failure
   reason, and the payment row **still PENDING** — the link stays open so the
   patient can retry.
3. Retry the same link with `success@razorpay`. Expect a normal confirmation:
   the earlier failure must not block it.
4. If left unpaid, expect the hold to expire normally per G4.

**Pass criteria:** a failed attempt is visible in the log, confirms nothing, and
does not prevent a later successful payment on the same link.

### G7. Refund

1. Take the confirmed appointment from G1.
2. Appointment list → **Cancel & refund**. Check the confirmation screen shows
   patient, appointment, original payment, original Payment ID, and refundable
   balance.
3. Pick a reason, confirm.
4. Expect a `refund` row at REFUND_PENDING, `REFUND_REQUESTED` then
   `REFUND_INITIATED` in the log, a **Refund Initiated** email, and a WhatsApp
   window with the patient message.
5. Wait for Razorpay to process (test mode is usually quick) or run
   `runPaymentReconcileNow()`. Expect REFUNDED and a **Refund Completed** email.

### G8. Double-refund guard

1. Try to refund the same payment again.
2. Expect a refusal saying it has already been fully refunded — the check reads
   Razorpay's own refund list, not our cached total.

### G9. Permissions

1. Log in as a level 4 (receptionist) user.
2. Expect **no** refund buttons anywhere.
3. Confirm `canIssueRefunds()` returns false for that session.

### G10. Kill switch

1. Set `payment.enabled` to `false` in `API_setting`.
2. Reload the booking page and the lists — every payment control should vanish
   and booking should behave exactly as it did before this module existed.
3. Set it back to `true`.

### G11. Secret leakage sweep

Search the `paymentLog` sheet, the `AuditLog` sheet, and your inbox for
`rzp_test`, `rzp_live`, and a fragment of your key secret. **Expect zero hits.**

---

## Part H — Going live (WP9)

**Do not start this until every test in Part G has passed in test mode.**

### Before you switch

- [ ] Part G tests G1–G11 all pass, including G5 (late payment) and G8 (double-refund guard)
- [ ] Razorpay KYC approved and the account activated
- [ ] Settlement bank account confirmed with your accountant
- [ ] Payment methods enabled on the merchant account: UPI, cards, net banking
      (Razorpay dashboard → Payment Methods). The module does not care which the
      patient uses
- [ ] `clinic_notify_emails` points at a monitored mailbox
- [ ] `hold_minutes` set to the value reception actually wants (default 15)
- [ ] `default_amount_paise` set to the real booking amount
- [ ] `payment_required_types` matches the exact strings in `generalSettings!D2`
- [ ] `listPaymentTriggers()` reports both jobs

### The switch

1. Generate **live** keys in the Razorpay dashboard.
2. Update Script Properties: `RZP_KEY_ID` (`rzp_live_...`), `RZP_KEY_SECRET`,
   and `RZP_MODE` = `live`.
3. Run `validateRazorpayCredentials()` — it refuses a live key while the mode
   says test, and vice versa.
4. Run `testRazorpayConnection()` — it must report `mode: live`.
5. Run `generateWebhookToken()` again to rotate the token for live, and update
   the URL in the Razorpay dashboard. **The old test webhook URL must stop
   working** — otherwise a stale endpoint is still accepting deliveries.
6. Re-check that the webhook events are all selected on the live webhook.
   Webhook configuration does not carry over from test mode.

### Prove it with real money

7. Temporarily set `min_amount_paise` to `100`, book a Rs 1 appointment, pay it
   yourself, confirm the appointment goes CONFIRMED and the email arrives.
8. Refund that Rs 1 through the UI. Confirm REFUND_PENDING → REFUNDED and that
   the money actually returns to your account (this can take a few working days
   — check `paymentLog` for `REFUND_COMPLETED` in the meantime).
9. Restore `min_amount_paise`.

### Roll out

10. Set `payment.enabled = true`.
11. Start with **emergency appointments only** — narrow
    `payment_required_types` to just that one for the first week, then widen.
12. Watch `paymentLog` daily for the first week. The rows that matter are
    `AMOUNT_MISMATCH`, `LATE_PAYMENT_RECEIVED`, `VERIFICATION_FAILED` and
    `WEBHOOK_REJECTED` — any of those means something needs a human.

**Rollback at any point:** set `payment.enabled = false` in `API_setting`.
The panel disappears, booking reverts to exactly today's behaviour, and existing
payment records are left untouched.

### Also rotate

Your test Key Secret was shared in plaintext during development. Regenerate it
in the Razorpay dashboard once you no longer need test mode, and never paste the
live secret anywhere but Script Properties.

