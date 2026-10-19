// Razorpay payment links for appointments (D-034, D-017). A person makes the link, confirms the phone number it is for,
// and sends it (WhatsApp through AiSensy, or WhatsApp on the PC with the text ready). Sudarshan asks Razorpay every minute
// how open links and refunds stand (no webhook: nothing on shichika is reachable from the internet).
// Razorpay is told the patient's name and phone (needed to pay) and "<clinic> appointment <date>": never the plan or
// any clinical detail. A paid link does not change the appointment (whether it should is open question P-5).
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { one, q, setAuditSummary, withTx, type AuditContext, type Db } from "../db.js";
import { HttpError, badRequest, conflict, notFound } from "../lib/errors.js";
import { guardImported } from "../lib/trial.js";
import { niceDate } from "../lib/time.js";
import { describe, whenText } from "./booking.js";
import { cleanPhone, isPracticeBooking, modeOf, scrubNumbers, setting, type Mode } from "./outreach.js";
import * as rzp from "./razorpay.js";
import { deliverQueued, queuePaymentMessage } from "./whatsapp.js";

export interface PaymentSettings { mode: Mode; defaultAmount: number; minAmount: number; maxAmount: number; linkHours: number }
export async function loadPayments(db?: Db): Promise<PaymentSettings> {
  const n = async (k: string, d: number) => { const v = Number(await setting(k, d, db)); return Number.isFinite(v) ? v : d; };
  return { mode: await modeOf("payments.mode", db), defaultAmount: await n("payments.default_amount", 500),
           minAmount: await n("payments.min_amount", 100), maxAmount: await n("payments.max_amount", 5000), linkHours: await n("payments.link_hours", 24) };
}

/** Why Razorpay cannot be used in this mode with these keys, or null. */
export function keysProblem(mode: Mode): string | null {
  const k = rzp.keyMode();
  if (mode === "off") return "Payments are switched off (Settings)";
  if (!k) return "Razorpay keys are not set (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env)";
  if (k === "unknown") return "The Razorpay key in .env is neither a test key (rzp_test_) nor a live key (rzp_live_)";
  if (mode === "test" && k !== "test") return "Test mode needs Razorpay test keys (rzp_test_...): live keys are in .env";
  if (mode === "live" && k !== "live") return "Live payments need Razorpay live keys (rzp_live_...): test keys are in .env";
  return null;
}

const refuse = (msg: string) => new HttpError(409, "payments_unavailable", msg);

export const PAYMENT_COLS = `
  p.id, p.appointment_id AS "appointmentId", p.patient_id AS "patientId", p.amount, p.purpose, p.status, p.mode, p.phone,
  p.reference, p.link_url AS "linkUrl", p.expires_at AS "expiresAt", p.paid_amount AS "paidAmount", p.paid_at AS "paidAt",
  p.provider_payment_id AS "razorpayPaymentId", p.refunded_amount AS "refundedAmount", p.needs_review AS "needsReview",
  p.error, p.sent_at AS "sentAt", p.sent_via AS "sentVia", p.cancelled_at AS "cancelledAt", p.cancel_reason AS "cancelReason",
  p.created_at AS "createdAt", cu.full_name AS "createdBy",
  a.patient_name AS "patientName", a.mrd, to_char(a.appointment_date,'YYYY-MM-DD') AS "date", to_char(a.slot_time,'HH24:MI') AS "slotTime",
  (SELECT coalesce(json_agg(json_build_object('id', r.id, 'amount', r.amount, 'reason', r.reason, 'status', r.status, 'error', r.error,
                                              'requestedAt', r.requested_at, 'processedAt', r.processed_at, 'by', ru.full_name) ORDER BY r.id), '[]')
     FROM app.payment_refunds r LEFT JOIN app.users ru ON ru.id = r.requested_by WHERE r.payment_id = p.id) AS refunds`;
export const PAYMENT_FROM = `FROM app.payments p LEFT JOIN app.appointments a ON a.id = p.appointment_id LEFT JOIN app.users cu ON cu.id = p.created_by`;

export async function loadPayment(id: number, db?: Db) {
  return one<any>(`SELECT ${PAYMENT_COLS} ${PAYMENT_FROM} WHERE p.id = $1`, [id], db);
}

async function lockPayment(c: PoolClient, id: number) {
  const p = await one<any>(
    `SELECT p.*, a.patient_name, a.mrd, a.legacy_id FROM app.payments p LEFT JOIN app.appointments a ON a.id = p.appointment_id
      WHERE p.id = $1 FOR UPDATE OF p`, [id], c);
  if (!p) throw notFound("Payment");
  return p;
}

const who = (p: { patient_name?: string | null; mrd?: string | null }) => describe({ patient_name: p.patient_name ?? "a patient", mrd: p.mrd ?? null });

// ---------- make a link ----------------------------------------------------------------
export async function createPayment(ctx: AuditContext, userId: number, appointmentId: number, b: { amount?: number | null; phone: string; purpose?: string | null }) {
  const s = await loadPayments();
  const problem = keysProblem(s.mode);
  if (problem) throw refuse(problem);
  const amount = b.amount ?? s.defaultAmount;
  if (amount < s.minAmount || amount > s.maxAmount) throw badRequest(`The amount must be between ₹${s.minAmount} and ₹${s.maxAmount}`);
  const phone = cleanPhone(b.phone);
  if (!phone) throw badRequest("That is not a mobile number: the link is sent to it, so check it with the patient");
  const clinic = String(await setting("followup.clinic_name", "Sampada"));

  // 1. the record first, so the reference Razorpay gets (SUD-<id>) is ours and a retry can never make a second link
  const p = await withTx(ctx, async (c) => {
    const a = await one<any>(`SELECT id, patient_name, mrd, patient_id, status, legacy_id, to_char(appointment_date,'YYYY-MM-DD') AS date,
                                     to_char(slot_time,'HH24:MI') AS slot FROM app.appointments WHERE id = $1 FOR UPDATE`, [appointmentId], c);
    if (!a) throw notFound("Appointment");
    await guardImported(a);
    if (!["booked", "confirmed", "waitlist"].includes(a.status)) throw conflict(`This appointment is ${a.status.replace("_", " ")}: no payment link`);
    if (s.mode === "test" && !isPracticeBooking(a.patient_name)) throw refuse("Test mode: payment links only for TEST bookings");
    const open = await one(`SELECT 1 FROM app.payments WHERE appointment_id = $1 AND status IN ('created','sent')`, [a.id], c);
    if (open) throw conflict("This appointment already has an open payment link: cancel it first to make a new one");
    await setAuditSummary(c, `Payment link of ₹${amount} for ${who(a)}, ${whenText(a.date, a.slot)}${s.mode === "test" ? " (test mode)" : ""}`);
    const row = await one<{ id: number }>(
      `INSERT INTO app.payments (appointment_id, patient_id, amount, purpose, status, mode, phone, created_by) VALUES ($1,$2,$3,$4,'created',$5,$6,$7) RETURNING id`,
      [a.id, a.patient_id, amount, b.purpose ?? null, s.mode, phone, userId], c);
    await c.query(`UPDATE app.payments SET reference = 'SUD-' || id WHERE id = $1`, [row!.id]);
    return { id: row!.id, reference: `SUD-${row!.id}`, a };
  });

  // 2. Razorpay, outside the transaction (no lock held while waiting on the internet)
  const expiresAt = new Date(Date.now() + Math.max(1, s.linkHours) * 3_600_000);
  try {
    const l = await rzp.createLink({ amount, reference: p.reference, description: `${clinic} appointment ${niceDate(p.a.date)}`,
                                     name: p.a.patient_name, phone, expiresAt, notes: { sudarshan_payment: String(p.id), appointment: String(p.a.id) } });
    await withTx({ ...ctx, summary: `Razorpay link made for ${who(p.a)}: ₹${amount}` }, (c) => c.query(
      `UPDATE app.payments SET link_id = $2, link_url = $3, expires_at = $4 WHERE id = $1`, [p.id, l.id, l.url, expiresAt]));
  } catch (e: any) {
    const msg = e instanceof rzp.RazorpayError ? e.message : "The link could not be made";
    await withTx({ ...ctx, summary: `Razorpay link for ${who(p.a)} could not be made: ${msg}` }, (c) => c.query(
      `UPDATE app.payments SET status = 'failed', error = $2 WHERE id = $1`, [p.id, msg]));
    if (!(e instanceof rzp.RazorpayError)) throw e;
  }
  return loadPayment(p.id);
}

// ---------- what Razorpay says now ----------------------------------------------------
/** Ask Razorpay about one payment (link and pending refunds) and record any change. Returns true when something changed. */
export async function refreshPayment(id: number, ctx: AuditContext): Promise<boolean> {
  const cur = await one<any>(`SELECT p.id, p.status, p.link_id, p.amount, p.mode, p.provider_payment_id FROM app.payments p WHERE p.id = $1`, [id]);
  if (!cur) throw notFound("Payment");
  if (keysProblem(cur.mode)) return false;                       // keys of the other mode: Razorpay would not know this link
  let changed = false;
  if (["created", "sent"].includes(cur.status) && cur.link_id) {
    const l = await rzp.fetchLink(cur.link_id);
    const next = l.status === "paid" ? "paid" : l.status === "expired" ? "expired" : l.status === "cancelled" ? "cancelled" : null;
    const review = l.status === "partially_paid" ? `Partly paid: ₹${l.amountPaid} of ₹${cur.amount}`
      : next === "paid" && Math.abs(l.amountPaid - cur.amount) > 0.001 ? `Paid ₹${l.amountPaid}, the link asked ₹${cur.amount}` : null;
    if (next || review) {
      changed = await withTx(ctx, async (c) => {
        const p = await lockPayment(c, id);
        if (!["created", "sent"].includes(p.status)) return false;   // someone else recorded it meanwhile
        const words: Record<string, string> = { paid: `Paid ₹${l.amountPaid}`, expired: "Link expired unpaid", cancelled: "Link cancelled at Razorpay" };
        await setAuditSummary(c, `${next ? words[next] : review}: ${who(p)}${review && next ? ` (${review})` : ""}`);
        await c.query(`UPDATE app.payments SET status = coalesce($2, status), paid_amount = CASE WHEN $2 = 'paid' THEN $3 ELSE paid_amount END,
                              paid_at = CASE WHEN $2 = 'paid' THEN coalesce($4, now()) ELSE paid_at END,
                              provider_payment_id = coalesce(provider_payment_id, $5), needs_review = coalesce($6, needs_review) WHERE id = $1`,
                      [id, next, l.amountPaid, l.paidAt, l.paymentId, review]);
        return true;
      });
    }
  }
  for (const r of await q<any>(`SELECT id, provider_refund_id FROM app.payment_refunds WHERE payment_id = $1 AND status = 'pending'`, [id])) {
    const pay = await one<any>(`SELECT provider_payment_id FROM app.payments WHERE id = $1`, [id]);
    const f = await rzp.fetchRefund(pay.provider_payment_id, r.provider_refund_id);
    if (f.status === "processed" || f.status === "failed") { await settleRefund(r.id, f.status, ctx, null); changed = true; }
  }
  return changed;
}

/** A refund is done (or failed): record it and, when processed, add it to the payment. */
async function settleRefund(refundId: number, status: "processed" | "failed", ctx: AuditContext, error: string | null) {
  await withTx(ctx, async (c) => {
    const r = await one<any>(`SELECT * FROM app.payment_refunds WHERE id = $1 FOR UPDATE`, [refundId], c);
    if (!r || ["processed", "failed"].includes(r.status)) return;
    const p = await lockPayment(c, r.payment_id);
    await setAuditSummary(c, status === "processed" ? `Refund of ₹${r.amount} done: ${who(p)}` : `Refund of ₹${r.amount} failed: ${who(p)}${error ? ` (${error})` : ""}`);
    await c.query(`UPDATE app.payment_refunds SET status = $2, processed_at = CASE WHEN $2 = 'processed' THEN now() END, error = $3 WHERE id = $1`,
                  [refundId, status, error ?? (status === "failed" ? "Razorpay could not make the refund" : null)]);
    if (status === "processed") {
      const total = Number(p.refunded_amount) + Number(r.amount);
      await c.query(`UPDATE app.payments SET refunded_amount = $2, status = CASE WHEN $2 >= coalesce(paid_amount, amount) THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`,
                    [p.id, total]);
    }
  });
}

// ---------- staff actions --------------------------------------------------------------
export async function cancelPayment(ctx: AuditContext, userId: number, id: number, reason: string) {
  const cur = await one<any>(`SELECT status, link_id, mode FROM app.payments WHERE id = $1`, [id]);
  if (!cur) throw notFound("Payment");
  if (!["created", "sent", "failed"].includes(cur.status)) throw conflict(`This payment is ${cur.status.replace("_", " ")}: it cannot be cancelled`);
  if (cur.link_id && cur.status !== "failed") {
    const problem = keysProblem(cur.mode);
    if (problem) throw refuse(problem);
    try { await rzp.cancelLink(cur.link_id); }
    catch (e) {
      if (!(e instanceof rzp.RazorpayError)) throw e;
      // most often: the patient has just paid. Ask again so the screen shows the truth.
      await refreshPayment(id, ctx).catch(() => false);
      throw conflict(`Razorpay did not cancel the link (${e.message}). If the patient has just paid, it now shows as paid.`);
    }
  }
  await withTx(ctx, async (c) => {
    const p = await lockPayment(c, id);
    await setAuditSummary(c, `Payment link of ₹${p.amount} cancelled: ${who(p)} (${reason})`);
    await c.query(`UPDATE app.payments SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [id, userId, reason]);
  });
  return loadPayment(id);
}

/** Staff sent the link from WhatsApp on the PC (wa.me); the patient's own message, so no AiSensy record. */
export async function markSent(ctx: AuditContext, id: number) {
  await withTx(ctx, async (c) => {
    const p = await lockPayment(c, id);
    if (!["created", "sent"].includes(p.status) || !p.link_url) throw conflict("Only an open link can be sent");
    await setAuditSummary(c, `Payment link sent to ${who(p)} from WhatsApp on the PC`);
    await c.query(`UPDATE app.payments SET status = 'sent', sent_at = coalesce(sent_at, now()), sent_via = coalesce(sent_via, 'whatsapp_pc') WHERE id = $1`, [id]);
  });
  return loadPayment(id);
}

/** Queue the payment_link template on AiSensy. */
export async function sendOnWhatsApp(ctx: AuditContext, userId: number, id: number) {
  await withTx(ctx, async (c) => {
    const p = await lockPayment(c, id);
    if (!["created", "sent"].includes(p.status) || !p.link_url) throw conflict("Only an open link can be sent");
    await setAuditSummary(c, `WhatsApp payment link of ₹${p.amount} to ${who(p)}`);
    await queuePaymentMessage(c, userId, { paymentId: p.id, appointmentId: p.appointment_id, patientName: p.patient_name ?? "Patient",
                                           phone: p.phone, amount: Number(p.amount), link: p.link_url });
  });
  return loadPayment(id);
}

export async function refundPayment(ctx: AuditContext, userId: number, id: number, b: { amount: number; reason: string; note?: string | null }) {
  const cur = await one<any>(
    `SELECT p.status, p.mode, p.provider_payment_id, coalesce(p.paid_amount, p.amount) AS paid, p.refunded_amount,
            (SELECT coalesce(sum(amount), 0) FROM app.payment_refunds WHERE payment_id = p.id AND status IN ('requested','pending')) AS waiting,
            (SELECT count(*) FROM app.payment_refunds WHERE payment_id = p.id)::int AS n
       FROM app.payments p WHERE p.id = $1`, [id]);
  if (!cur) throw notFound("Payment");
  if (!["paid", "partially_refunded"].includes(cur.status) || !cur.provider_payment_id) throw conflict("Only a paid payment can be refunded");
  const problem = keysProblem(cur.mode);
  if (problem) throw refuse(problem);
  const left = Math.round((Number(cur.paid) - Number(cur.refunded_amount) - Number(cur.waiting)) * 100) / 100;
  if (b.amount > left) throw badRequest(left > 0 ? `At most ₹${left} can still be refunded` : "Everything paid has been refunded already (or is being refunded)");
  const key = `SUDR-${id}-${cur.n + 1}`;
  const refundId = await withTx(ctx, async (c) => {
    const p = await lockPayment(c, id);
    await setAuditSummary(c, `Refund of ₹${b.amount} asked for ${who(p)}: ${b.reason}`);
    const r = await one<{ id: number }>(
      `INSERT INTO app.payment_refunds (payment_id, patient_id, amount, reason, note, idempotency_key, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, p.patient_id, b.amount, b.reason, b.note ?? null, key, userId], c);
    return r!.id;
  });
  try {
    const f = await rzp.createRefund(cur.provider_payment_id, b.amount, key, { sudarshan_payment: String(id), reason: b.reason.slice(0, 200) });
    await withTx({ ...ctx, summary: `Refund of ₹${b.amount} sent to Razorpay` }, (c) => c.query(
      `UPDATE app.payment_refunds SET provider_refund_id = $2, status = 'pending' WHERE id = $1`, [refundId, f.id]));
    if (f.status === "processed" || f.status === "failed") await settleRefund(refundId, f.status, ctx, null);
  } catch (e: any) {
    if (!(e instanceof rzp.RazorpayError)) throw e;
    await settleRefund(refundId, "failed", ctx, e.message);
  }
  return loadPayment(id);
}

// ---------- once a minute ----------------------------------------------------------------
let lastPoll: { at: string; checked: number; changed: number; error: string | null } | null = null;
export const pollStatus = () => lastPoll;
let polling = false;
/** Open links and pending refunds of the mode the keys in .env belong to. */
export async function pollPayments(log?: Pick<FastifyBaseLogger, "error">): Promise<void> {
  if (polling) return;
  polling = true;
  const k = rzp.keyMode();
  try {
    if (k !== "test" && k !== "live") return;
    const ids = await q<{ id: number }>(
      `SELECT p.id FROM app.payments p WHERE p.mode = $1 AND ((p.status IN ('created','sent') AND p.link_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM app.payment_refunds r WHERE r.payment_id = p.id AND r.status = 'pending')) ORDER BY p.id`, [k]);
    let changed = 0, error: string | null = null;
    for (const { id } of ids) {
      try { if (await refreshPayment(id, { userId: null, source: "job" })) changed++; }
      catch (e: any) { error = String(e?.message ?? e).slice(0, 300); log?.error({ paymentId: id }, `payment check failed: ${scrubNumbers(error)}`); }
    }
    lastPoll = { at: new Date().toISOString(), checked: ids.length, changed, error };
  } finally { polling = false; }
}

/** Started by index.ts (never by tests): the WhatsApp outbox every 5 seconds, Razorpay every minute. */
export function startOutreachJobs(log: FastifyBaseLogger) {
  const a = setInterval(() => { void deliverQueued(log).catch((e) => log.error({ err: e }, "whatsapp outbox")); }, 5_000);
  const b = setInterval(() => { void pollPayments(log).catch((e) => log.error({ err: e }, "payment check")); }, 60_000);
  return [a, b];
}
