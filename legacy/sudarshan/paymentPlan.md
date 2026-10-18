# Payment System Implementation Plan
### Sampada Appointment System — Google Apps Script + Razorpay

Status: **WP0–WP8 complete.** WP9 outstanding: run the Part G test matrix in
`paymentSetup.md` against the test-mode account, then switch to live keys (Part H).

Post-build audit (12 Sep 2026) closed three gaps: the payment record now follows an
appointment through a reschedule and logs `RESCHEDULE_LINKED` (§29); `payment.failed`
records a real `PAYMENT_FAILED` entry (§30); the unused `MANUAL_REVIEW_FLAGGED`
constant is gone. All 21 declared event types are now emitted somewhere.
Setup steps live in `paymentSetup.md`.
Target: Phase 1 scope from the handoff document (§35), built so it can be lifted out into the new EMR (§2, §34).

---

## 1. What the existing codebase forces us to design around

These are findings from the current code, not assumptions. They drive most of the decisions below.

| Finding | Where | Consequence for payments |
|---|---|---|
| **There is no `doPost` anywhere in the project** | `Code.js:2` has only `doGet` | The Razorpay webhook endpoint is a greenfield addition — no conflict, but the web app must be re-deployed with "Anyone, even anonymous" access. |
| **Apps Script cannot read HTTP request headers** | GAS platform limit — `doPost(e)` exposes `postData`, `parameter`, `queryString` only | **Razorpay's `X-Razorpay-Signature` HMAC check as written in §12 is not implementable in pure GAS.** See §6.1 for the replacement design. This is the single biggest deviation from the handoff doc. |
| **`cancelAppointment()` moves the row out of `appointment` into `cancel` and deletes the original** | `Code.js:10629` | Payment data must **not** live in the appointment row — it would be shredded on cancel/archive. Payment state lives in its own sheet keyed by `AppointmentID`. |
| **`rescheduleAppointment()` updates in place and keeps the same `AppointmentID`** | `Code.js:8968` | §29 (payment survives reschedule) is free — no work needed beyond an audit entry. |
| **`getBookedSlots()` counts every row in `appointment` regardless of status** | `Code.js:7592` | A `SLOT_HELD` appointment row already blocks the slot from other bookings. Correct behaviour with zero changes. Releasing a hold must therefore *remove the row* (move to `cancel`), not just flip a flag. |
| **The `appointment` sheet has no status column at all** | header names in use: `AppointmentID`, `AppointmentDate`, `TimeSlot`, `MRDNo`, `PatientName`, … no `Status` | `AppointmentStatus` (REQUESTED/SLOT_HELD/CONFIRMED/…) is introduced in the payment sheet only, for payment-enabled appointments. **No schema change to `appointment` in Phase 1.** |
| **`cancelAppointment` copies rows by numeric index and pads to fixed widths** | `Code.js:10659-10690` | Confirms the above: adding columns to `appointment` is hazardous here. Avoid it. |
| **No `LockService` usage anywhere in the project** | grep: zero hits | Payment writes are the first place in this codebase with genuine concurrent writers (webhook + expiry trigger + two receptionists). Every payment state transition must take a script lock. |
| **Sessions are stored in `PropertiesService.getScriptProperties()`** | `Code.js:140` | Same store the Razorpay secrets will use. Namespacing matters (`RZP_*`), and the sessions purge routines must not wipe unknown keys. Verify `purgeAllSessions()` (`Code.js:294`) before go-live. |
| **AiSensy WhatsApp is campaign/template based** (`campaignName` + `templateParams` array) | `broadcast.js:360`, `API_setting.gs:32` | Sending a payment link automatically needs a **new Meta-approved WhatsApp template with a URL button**. That has an external approval lead time, so Phase 1 ships the manual `wa.me` path (as §9 allows) and Phase 2 wires AiSensy. |
| **AiSensy API key is stored in the visible `API_setting` sheet** | `API_setting.gs:32` | Do not follow that pattern for Razorpay. §12/§33 require Script Properties. (Separately worth migrating the AiSensy key — out of scope here.) |
| **Audit trail already exists and is the house pattern** | `logAuditEvent()` `Code.js:1587`, `logAppointmentJourney()` | Payment events go to a dedicated `paymentLog` sheet (§30) **and** mirror the significant ones into `AuditLog` so existing audit screens still tell the whole story. |
| Pre-existing bug: `submitAppointment` logs `appointmentId` (undefined) instead of `appointmentID` | `Code.js:6160` | Booking audit rows are silently being dropped. Fix as a one-line prerequisite since payments hang off booking. |

---

## 2. Module layout

Payment logic is kept in new files with **no payment code added to `Code.js`** beyond three thin call sites. Everything below the "Payment Service" line is portable to the new EMR as-is; the adapter is the only Razorpay-aware file.

```
bookAppointment.html / appointmentList.html / cancelList.html
        │  google.script.run
        ▼
PaymentApi.gs          ← session validation, role gating, the only functions the UI may call
        ▼
PaymentService.gs      ← provider-agnostic orchestration + all sheet I/O + state machine
        ▼
RazorpayAdapter.gs     ← generic interface (§34): createLink / fetchLink / cancelLink /
        │                createRefund / fetchRefund / parseEvent
        ▼
RazorpayAdapter.gs     ← HTTP only. Knows about paise, Basic auth, Razorpay JSON shapes.
```

Supporting files:

| File | Contents |
|---|---|
| `PaymentConfig.gs` | Script Properties accessors for secrets; non-secret config read from the `API_setting` sheet (category `payment`). |
| `PaymentWebhook.gs` | `doPost(e)` — the only web-facing entry point. Authenticates, enqueues, delegates. |
| `PaymentSheets.gs` | Sheet creation/migration for `payment`, `refund`, `paymentLog`. Follows house style (`initializeXSheet()`, frozen blue header row). |
| `PaymentTriggers.gs` | Expiry sweep + reconciliation sweep + installer functions. |
| `PaymentPanel.html` | Reusable reception UI block, `include()`-ed into the three pages. |
| `PaymentNotify.gs` | Email bodies + WhatsApp message/`wa.me` link builder. |

Rule for the whole module: **`PaymentService` never calls Razorpay directly, and `RazorpayAdapter` never touches a sheet.**

---

## 3. Data model

### 3.1 `payment` sheet — one row per payment request, `PaymentRef` is the primary key

| # | Column | Notes |
|---|---|---|
| 1 | `PaymentRef` | `SAMP-APT-YYYYMMDD-NNNNNN`. Unique. Also sent to Razorpay as `reference_id`. |
| 2 | `AppointmentID` | Join key to `appointment` / `cancel` / `archive`. |
| 3 | `AppointmentSheet` | Which sheet the appointment currently lives in (`appointment` / `cancel` / `archive`). |
| 4 | `MRDNo` | |
| 5 | `PatientName` | |
| 6 | `Mobile` | Confirmed at link-generation time (§1). |
| 7 | `AppointmentDate` | Snapshot at creation; updated on reschedule. |
| 8 | `AppointmentTime` | Same. |
| 9 | `AmountPaise` | Integer paise. Rupees are display-only, never stored as the source of truth. |
| 10 | `Currency` | `INR`. |
| 11 | `Provider` | `razorpay`. |
| 12 | `ProviderLinkId` | `plink_xxx`. |
| 13 | `PaymentUrl` | Short URL from Razorpay. |
| 14 | `PaymentStatus` | See §4.2. |
| 15 | `ProviderPaymentId` | `pay_xxx`. **Never overwritten** (§23). |
| 16 | `PaidAmountPaise` | What actually arrived. |
| 17 | `PaidAt` | |
| 18 | `LinkCreatedAt` | |
| 19 | `HoldExpiresAt` | Internal hold deadline — authoritative for slot release. |
| 20 | `LinkExpiresAt` | What we told Razorpay. |
| 21 | `AppointmentStatus` | See §4.1. |
| 22 | `RefundStatus` | Rolled up from the `refund` sheet: `NONE` / `NOT_APPLICABLE` / `REFUND_PENDING` / `PARTIALLY_REFUNDED` / `REFUNDED` / `REFUND_FAILED`. |
| 23 | `RefundedAmountPaise` | Sum of successful refunds. |
| 24 | `ConfirmationEmailSent` | `Yes` / `No`. |
| 25 | `CreatedBy` | Username from session. |
| 26 | `LastEventAt` | |
| 27 | `Remarks` | Free text. |

### 3.2 `refund` sheet — one row per refund attempt (supports partial refunds, §22)

`RefundRef`, `PaymentRef`, `AppointmentID`, `ProviderPaymentId`, `ProviderRefundId`, `RefundAmountPaise`, `RefundType` (FULL/PARTIAL), `RefundStatus`, `RefundReason` (structured list, §24), `RefundRemarks`, `RequestedAt`, `RequestedBy`, `CompletedAt`, `ProviderArn` (bank/UPI reference where Razorpay gives one), `LastError`.

### 3.3 `paymentLog` sheet — append-only event log (§30)

`Timestamp`, `EventType`, `AppointmentID`, `PaymentRef`, `ProviderLinkId`, `ProviderPaymentId`, `ProviderRefundId`, `AmountPaise`, `Actor` (username or `SYSTEM`/`WEBHOOK`), `Result` (`OK`/`FAIL`/`IGNORED`), `ProviderEventId`, `Detail` (JSON), `Error`.

Event types exactly as §30 lists, plus `SLOT_RELEASED`, `RESCHEDULE_LINKED`, `MANUAL_REVIEW_FLAGGED`, `AMOUNT_MISMATCH`.

**Never truncated or edited.** Archive by year like `AuditLogArchive` when it grows.

### 3.4 No change to the `appointment` sheet

The reception UI joins `appointment` rows to payment rows by `AppointmentID` with one bulk read of the (small) `payment` sheet. This keeps the module droppable into the EMR and avoids the index-copy hazards in `cancelAppointment`/`archiveAppointment`.

---

## 4. The two independent state machines (§16)

### 4.1 AppointmentStatus (payment-enabled appointments only)

```
REQUESTED ──generate link──► SLOT_HELD ──payment verified──► CONFIRMED
                                 │                               │
                                 │ hold expires                  │ staff cancels
                                 ▼                               ▼
                             RELEASED                        CANCELLED ──► COMPLETED
                                 │
                                 │ late payment arrives (§18)
                                 ▼
                        MANUAL_REVIEW_REQUIRED
```

`RELEASED` also physically moves the appointment row to the `cancel` sheet with reason "Payment not received — slot released", so the slot frees for other patients through the existing machinery.

`MANUAL_REVIEW_REQUIRED` **never** restores the appointment automatically. The released slot's new owner is never displaced (§18). Staff resolve it by hand using the existing `restoreCancelledAppointment()` or by refunding.

### 4.2 PaymentStatus

`NOT_REQUIRED` · `PENDING` · `PAID` · `FAILED` · `EXPIRED` · `CANCELLED` · plus refund states tracked separately in `RefundStatus` so `CANCELLED` appointment + `PAID` payment can legitimately coexist (§16, §28).

All transitions go through one function — `PaymentService.transition_(paymentRef, expectedFrom[], to, context)` — which takes the script lock, re-reads the row, rejects illegal transitions, writes, and logs. Nothing else writes `PaymentStatus`.

---

## 5. Configuration

### 5.1 Secrets — Script Properties only (§12, §33)

`RZP_KEY_ID`, `RZP_KEY_SECRET`, `RZP_WEBHOOK_TOKEN` (see §6.1), `RZP_MODE` (`test`/`live`).

Never returned to the browser, never logged, never emailed. A one-time `setupRazorpayCredentials()` function run from the editor writes them; it is the only place they are assigned, and it logs nothing but "stored".

### 5.2 Non-secret config — `API_setting` sheet, category `payment`

Reuses the existing pattern at `API_setting.gs:16`, so it is editable from `settings.html` with existing plumbing:

| Key | Default | Meaning |
|---|---|---|
| `default_amount_paise` | `50000` | ₹500 (§7) |
| `allow_amount_override` | `true` | Reception override, gated by role |
| `min_amount_paise` / `max_amount_paise` | `10000` / `500000` | Guard rails on override |
| `hold_minutes` | `15` | `URGENT_PAYMENT_HOLD_MINUTES` (§8) |
| `link_expiry_buffer_minutes` | `5` | See the Razorpay 15-minute floor in §6.2 |
| `payment_required_types` | `["EMERGENCY","SAME_DAY","NEXT_DAY"]` | Which appointment types trigger the prompt |
| `clinic_notify_emails` | `[]` | Recipients for payment/refund notifications |
| `refund_min_role_level` | `1` | Access level allowed to refund (§33) |
| `enabled` | `false` | Master kill switch — ships **off** |

---

## 6. The four hard problems, and the decisions

### 6.1 Webhook authenticity without request headers — **deviates from §12**

Apps Script gives `doPost(e)` no access to `X-Razorpay-Signature`, so the HMAC verification the handoff document specifies cannot be performed on the incoming request. Three defences replace it, and together they are stronger than signature-only verification:

1. **Unguessable webhook URL.** Razorpay is configured with `…/exec?wh=<32-char random token>`; `doPost` rejects anything whose `wh` does not match `RZP_WEBHOOK_TOKEN` (constant-time compare). Rotatable.
2. **The webhook body is treated as a hint, never as truth.** On every event we discard the payload's financial fields and re-fetch authoritative state from Razorpay's API using the Key ID/Secret (`GET /v1/payment_links/:id`, `GET /v1/payments/:id`). Only the API response drives a state change. A forged webhook therefore achieves nothing beyond causing us to make a read-only API call.
3. **Amount and reference are re-verified** against our stored `AmountPaise` and `PaymentRef` before confirming (§32 amount-mismatch rule).

Optional Phase 2 hardening, if true HMAC verification is required for compliance: put a ~30-line Cloudflare Worker (or Cloud Function) in front that validates `X-Razorpay-Signature` and forwards verified events to the GAS URL. The GAS side needs no change. **Recommend deferring** — defence #2 already makes forgery useless.

I'll flag this explicitly for sign-off since §12 is written as a hard requirement.

### 6.2 Razorpay's 15-minute minimum link expiry vs. a 15-minute hold

Razorpay rejects `expire_by` less than 15 minutes in the future, so a 15-minute hold sits exactly on the boundary and will intermittently fail.

Decision: **our internal `HoldExpiresAt` is authoritative** for releasing the slot. Razorpay's `expire_by` is set to `hold_minutes + link_expiry_buffer_minutes` (default 20 min) so link creation never fails, and when we release a slot we actively `POST /v1/payment_links/:id/cancel` to kill the link immediately. A patient who pays after our deadline but before Razorpay's expiry lands in the §18 late-payment path, which is exactly what §18 asks for.

### 6.3 Concurrency

Every state-changing operation wraps in `LockService.getScriptLock()` with a 30-second timeout: link creation, webhook processing, manual check, expiry sweep, refund. The sweep and the webhook genuinely race (§17: "a verified payment received before the valid deadline should take priority") — the lock plus the `expectedFrom[]` guard in `transition_` resolves it deterministically:

- Webhook wins the lock first → status becomes `PAID`, sweep then sees `PAID ∉ [PENDING]` and does nothing.
- Sweep wins first → status becomes `EXPIRED`/`RELEASED`; the webhook then compares the **actual payment timestamp from the Razorpay API** against `HoldExpiresAt`. Paid before the deadline → we reverse the release and confirm. Paid after → `MANUAL_REVIEW_REQUIRED`.

### 6.4 Idempotency (§13)

Three independent layers:

1. Razorpay rejects a duplicate `reference_id` on payment-link creation, so a double-click cannot create two links for one appointment.
2. Before processing, `paymentLog` is checked for the provider event id / `ProviderPaymentId`; a hit logs `WEBHOOK_DUPLICATE` and returns.
3. `transition_`'s `expectedFrom[]` guard makes a second `PENDING → PAID` a no-op, so no duplicate email can be sent even if layers 1–2 are bypassed.

Refunds add a fourth: `X-Razorpay-Idempotency-Key` on the refund call, plus a pre-flight `GET /v1/payments/:id/refunds` to confirm the payment is not already fully refunded (§32).

---

## 7. Reception UI (§31)

One reusable `PaymentPanel.html` block, `include()`-ed into `bookAppointment.html`, `appointmentList.html`, and `cancelList.html`. It renders from a single `getPaymentSummary(appointmentId, sessionToken)` call and shows one of four states:

| State | Shows | Actions |
|---|---|---|
| No payment | Amount field (prefilled ₹500, override if permitted), mobile number with a **confirm-this-number** step (§1) | **Generate Payment Link** |
| PENDING | Link, countdown to `HoldExpiresAt`, status | **Copy Link** · **Open WhatsApp** (`wa.me` prefilled) · **Check Payment** · **Cancel Payment Request** |
| PAID | ✅ ₹500 received, Payment ID, paid-at, `Appointment: CONFIRMED` | **Cancel Appointment** · **Cancel & Refund** |
| Refunded | Refund amount/status/ID, with original payment details still visible (§31) | **Check Refund Status** |

**Cancel & Refund** opens the explicit confirmation screen from §25 (patient, appointment, original amount, refund amount, original Payment ID, structured reason dropdown from §24, remarks) — a second, deliberate click. Refund actions are hidden entirely below `refund_min_role_level`.

Existing patients: MRD is enough to prefill; the panel forces an explicit tick on the mobile number before the link can be generated, because that number is where the link goes (§1).

---

## 8. Build order

Each work package is independently testable and leaves the system working.

**WP0 — Prerequisites (½ day)** — ✅ code done
Fix the `appointmentId`/`appointmentID` audit bug at `Code.js:6160`. Create a Razorpay **test-mode** account and generate keys. Confirm the web-app deployment's access setting and note whether re-deploying changes the `/exec` URL (it does not, if you edit the existing deployment).

**WP1 — Sheets, config, secrets (1 day)** — ✅ code done
`PaymentSheets.gs`, `PaymentConfig.gs`, `setupRazorpayCredentials()`. Add `payment` category rows to `API_setting`. Master switch off. No behaviour change yet.
*Done when:* the three sheets exist with correct headers and config reads back correctly.

**WP2 — Razorpay adapter (1 day)** — ✅ code done, blocked on a Razorpay test account to verify
`RazorpayAdapter.gs` with `fetchLink`, `fetchPayment`, `fetchRefunds`, Basic auth, paise handling, structured error mapping. Test against the test account with hand-created links.
*Done when:* a manually created test payment link can be fetched and parsed from the Apps Script editor.

**WP3 — Create link + reference + storage (2 days)** — ✅ code done, blocked on the same
`PaymentService.createPaymentRequest()`, the `SAMP-APT-…` sequence generator (locked Script-Property counter), `payment` row write, `PAYMENT_LINK_CREATED` log, `SLOT_HELD` + `PENDING`. Plus `cancelPaymentRequest()`.
*Done when:* clicking a test function produces a real test-mode link, a `payment` row, and a log row — and a duplicate call is rejected.

**WP4 — Reception UI, manual flow (2 days)** — ✅ done. Booking page has its own inline panel; `appointmentList.html` and `cancelList.html` share `PaymentPanel.html`; `Dashboard.html`, `dayOverview.html` and `Visualization.html` share `PaymentRefundPrompt.html`. All five cancellation screens route through `cancelAppointmentWithPaymentCheck()`.
`PaymentPanel.html`, `PaymentApi.gs`, `wa.me` message builder (§9 wording). No webhook yet — **Check Payment** is the confirmation path.
*Done when:* reception can generate a link, send it manually, pay it in test mode, hit **Check Payment**, and see the appointment go CONFIRMED.

**WP5 — Webhook (2 days)** — ✅ code done, needs deployment + Razorpay dashboard config
`doPost`, token auth, re-fetch-and-verify, duplicate suppression, amount-mismatch flagging, `payment_link.paid` / `payment_link.expired` / `payment.failed`. Re-deploy the web app.
*Done when:* a test payment confirms the appointment with no human action, and replaying the same webhook body changes nothing.

**WP6 — Confirmation email + notifications (1 day)** — ✅ code done
`PaymentNotify.gs` using `MailApp` (pattern at `Code.js:11667`), sent independently of Razorpay's own receipts (§15). `ConfirmationEmailSent` flag prevents duplicates.

**WP7 — Expiry sweep + late-payment safety (1.5 days)** — ✅ code done (`PaymentTriggers.gs`); needs `installPaymentTriggers()` run once
Time-driven trigger every minute; `PENDING` + `HoldExpiresAt < now` → cancel the Razorpay link, `EXPIRED`, `RELEASED`, move the row to `cancel`. Late payment → `PAID` + `MANUAL_REVIEW_REQUIRED`, clinic email, no auto-restore (§18).
*Note:* this is listed under Phase 2 in the handoff doc (§36), but a manual-only hold has no way to free an urgent slot. Recommend keeping it in Phase 1; it can ship behind its own flag.

**WP8 — Cancellation + full refund (2.5 days)** — ✅ code done (`PaymentRefund.gs`); partial refunds supported by the data model and the UI
`cancelAppointmentWithPaymentCheck()` wrapping the existing `cancelAppointment()`, refund confirmation screen, `createRefund` with idempotency key, `refund` row, `REFUND_PENDING`, patient + clinic messages (§26), **Check Refund Status**, `refund.processed`/`refund.failed` webhook handling. Cancellation-without-refund path sets `NOT_APPLICABLE` + reason (§28).

**WP9 — Hardening & go-live (1.5 days)** — next: run the Part G test script in `paymentSetup.md`, then live keys
Full test matrix (§9 below), role gating audit, secret-leak review of every log/email path, switch to live keys, `enabled = true` for emergency appointments only.

**Rough total: ~15 working days** for one developer, excluding Razorpay account/KYC and WhatsApp template approval lead time.

---

## 9. Test matrix

Must pass before live keys go in:

- Happy path: link → pay → webhook → CONFIRMED → email, once and only once.
- Webhook replayed 3× → one confirmation, two `WEBHOOK_DUPLICATE` rows.
- Webhook with a bad/absent `wh` token → rejected, logged, no state change.
- Forged webhook body claiming a payment that does not exist in Razorpay → rejected at the re-fetch step.
- Amount mismatch (₹1 paid against a ₹500 request) → flagged, **not** confirmed.
- Payment 1 s before `HoldExpiresAt` while the sweep is running → CONFIRMED, slot kept.
- Payment 1 min after release, slot already re-booked by someone else → `MANUAL_REVIEW_REQUIRED`, the new booking untouched.
- Reschedule a `PAID` appointment → payment still `PAID`, dates updated, audit entry written.
- Cancel a `PAID` appointment without refund → `CANCELLED` + `PAID` + `NOT_APPLICABLE`.
- Refund → `REFUND_PENDING` → webhook → `REFUNDED`; second refund attempt on the same payment blocked.
- Refund API failure → `REFUND_FAILED`, retryable, money not double-sent.
- Link creation failure (bad key / network) → appointment **not** confirmed, retry available, no orphan `payment` row in a wrong state.
- Level 4 user → no refund buttons, and the server-side call refuses even if the button is forged.
- `grep -i` over `paymentLog`, `AuditLog`, and every email body for `rzp_`, `RZP_`, secret fragments → zero hits.

---

## 10. Deployment & ops checklist

- Web app re-deployed: execute as **owner**, access **Anyone, even anonymous** (required for the webhook). Edit the existing deployment so `/exec` stays stable.
- Razorpay dashboard → Webhooks → URL `…/exec?wh=<token>`, events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.failed`, `refund.processed`, `refund.failed`.
- Time-driven trigger installed for the expiry sweep (1 min) and a reconciliation sweep (hourly, re-checks anything `PENDING` older than the hold, catching missed webhooks).
- `UrlFetchApp` daily quota is 20 000 calls — nowhere near a constraint at clinic volume, but the reconciliation sweep should only touch open rows.
- Rollback: set `payment.enabled = false` in `API_setting`. The panel disappears, booking behaves exactly as it does today, existing payment rows are untouched.

---

## 11. Decisions — settled 4 Sep 2026

| # | Question | Decision |
|---|---|---|
| 1 | Webhook signature deviation (§6.1) | **Approved** — URL token + authoritative API re-verification. No relay service. |
| 2 | Who may refund | **Level 1 only** (director / admin). `refund_min_role_level = 1`. |
| 3 | Payment-required types | Emergency, Same Day, Next Day **by default**, with an editable checkbox reception can tick on or off per appointment. |
| 4 | Notification recipients | **admin@gs.sampadavr.com** — now the code default for `clinic_notify_emails`. |
| 5 | Patient email as well as WhatsApp | **WhatsApp only** in Phase 1, sent manually via the one-click wa.me link. No patient email. |
| 6 | Expiry sweep phase | Phase 1 (WP7), behind its own flag. |
| 7 | Razorpay account | Test keys supplied 4 Sep 2026. **Rotate the test secret** — it was shared in plaintext. KYC still needed before WP9. |

## 12. Phase 2 backlog (§36)

Automatic AiSensy sending once the WhatsApp template with a URL button is approved · partial refunds through the UI (the data model already supports them) · configurable no-show/late-cancellation refund policy · daily payment report · reconciliation dashboard · Zoho Books sync (kept strictly off the booking critical path, §37) · second provider behind `RazorpayAdapter.gs` · migration of the whole module into the new EMR.
