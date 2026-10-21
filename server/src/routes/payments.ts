// Razorpay payment links (D-034, D-017): make one for an appointment, send it, ask Razorpay now, cancel, refund (admins).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { q, withTx } from "../db.js";
import { badRequest, forbidden } from "../lib/errors.js";
import { guardLive, MODE_WORDS, MODES, setting, type Mode } from "../services/outreach.js";
import { cancelPayment, createPayment, keysProblem, loadPayment, loadPayments, markSent, PAYMENT_COLS, PAYMENT_FROM, pollStatus,
         refreshPayment, refundPayment, sendOnWhatsApp } from "../services/payments.js";
import { keyMode } from "../services/razorpay.js";
import { kickOutbox } from "./whatsapp.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const money = z.number().positive().max(100000).refine((v) => Math.round(v * 100) === v * 100, "Rupees with at most two decimals");

const VIEWS: Record<string, string> = {
  open: "p.status IN ('created','sent')",
  paid: "p.status IN ('paid','partially_refunded','refunded')",
  review: "(p.needs_review IS NOT NULL OR p.status = 'failed' OR EXISTS (SELECT 1 FROM app.payment_refunds r WHERE r.payment_id = p.id AND r.status IN ('failed','requested')))",
  all: "true",
};

export async function paymentRoutes(app: FastifyInstance) {
  app.get("/api/payments/status", async (req) => {
    need(req, "payments.write");
    const s = await loadPayments();
    const clinicName = String(await setting("followup.clinic_name", "Sampada"));      // for the WhatsApp-on-the-PC text, as Razorpay's description
    return { ...s, modeWords: MODE_WORDS[s.mode], keyMode: keyMode(), problem: keysProblem(s.mode), lastCheck: pollStatus(), clinicName };
  });

  app.get("/api/payments", async (req) => {
    need(req, "payments.write");
    const f = z.object({ view: z.enum(["open", "paid", "review", "all"]).default("open"), q: z.string().trim().max(60).optional() }).parse(req.query);
    const p: unknown[] = [];
    let where = VIEWS[f.view];
    if (f.q) { p.push(f.q); where += ` AND (a.patient_name ILIKE '%' || $1 || '%' OR a.mrd ILIKE $1 || '%' OR p.reference ILIKE $1)`; }
    const payments = await q(`SELECT ${PAYMENT_COLS} ${PAYMENT_FROM} WHERE ${where} ORDER BY p.id DESC LIMIT 300`, p);
    const counts = (await q<any>(`SELECT count(*) FILTER (WHERE ${VIEWS.open})::int AS open, count(*) FILTER (WHERE ${VIEWS.review})::int AS review FROM app.payments p`))[0];
    return { payments, counts };
  });

  app.get("/api/appointments/:id/payments", async (req) => {
    need(req, "appointments.read");
    const { id } = idParam.parse(req.params);
    return { payments: await q(`SELECT ${PAYMENT_COLS} ${PAYMENT_FROM} WHERE p.appointment_id = $1 ORDER BY p.id DESC`, [id]) };
  });

  app.post("/api/appointments/:id/payments", async (req) => {
    const me = need(req, "payments.write");
    const { id } = idParam.parse(req.params);
    const b = z.object({ amount: money.nullable().optional(), phone: z.string().trim().min(6).max(30), purpose: z.string().trim().max(200).nullable().optional(),
                         phoneConfirmed: z.literal(true, { errorMap: () => ({ message: "Check the phone number with the patient first: the link goes to it" }) }) }).parse(req.body);
    return { payment: await createPayment(auditCtx(req), me.id, id, b) };
  });

  app.post("/api/payments/:id/check", async (req) => {
    need(req, "payments.write");
    const { id } = idParam.parse(req.params);
    const changed = await refreshPayment(id, auditCtx(req));
    return { payment: await loadPayment(id), changed };
  });

  app.post("/api/payments/:id/cancel", async (req) => {
    const me = need(req, "payments.write");
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(2).max(300) }).parse(req.body);
    return { payment: await cancelPayment(auditCtx(req), me.id, id, reason) };
  });

  app.post("/api/payments/:id/sent", async (req) => {
    need(req, "payments.write");
    const { id } = idParam.parse(req.params);
    return { payment: await markSent(auditCtx(req), id) };
  });

  app.post("/api/payments/:id/whatsapp", async (req) => {
    const me = need(req, "payments.write");
    need(req, "messages.send");
    const { id } = idParam.parse(req.params);
    const payment = await sendOnWhatsApp(auditCtx(req), me.id, id);
    kickOutbox(req.log);
    return { payment };
  });

  app.post("/api/payments/:id/refunds", async (req) => {
    const me = need(req, "payments.refund");
    const { id } = idParam.parse(req.params);
    const b = z.object({ amount: money, reason: z.string().trim().min(3).max(120), note: z.string().trim().max(500).nullable().optional() }).parse(req.body);
    return { payment: await refundPayment(auditCtx(req), me.id, id, b) };
  });

  // ---- settings ----
  app.get("/api/settings/payments", async (req) => {
    need(req, "settings.manage");
    const s = await loadPayments();
    return { ...s, modes: MODES.map((m) => ({ key: m, label: MODE_WORDS[m] })), keyMode: keyMode(), problem: keysProblem(s.mode) };
  });

  app.put("/api/settings/payments", async (req) => {
    const me = need(req, "settings.manage");
    const whole = z.number().int().positive().max(100000);
    const b = z.object({ mode: z.enum(MODES as [Mode, ...Mode[]]).optional(), defaultAmount: whole.optional(), minAmount: whole.optional(),
                         maxAmount: whole.optional(), linkMinutes: z.number().int().min(15).max(10080).optional() }).parse(req.body);
    const cur = await loadPayments();
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as typeof cur;
    if (next.minAmount > next.maxAmount) throw badRequest("The smallest amount must not be above the largest");
    if (next.defaultAmount < next.minAmount || next.defaultAmount > next.maxAmount) throw badRequest("The usual amount must be between the smallest and the largest");
    if (b.mode === "live" && cur.mode !== "live") {
      if (me.role !== "admin") throw forbidden("Only an admin can switch payments to live");
      await guardLive("Payments");
      if (keyMode() !== "live") throw badRequest("Put the Razorpay live keys (rzp_live_...) in .env before going live");
    }
    const keys: [keyof typeof b, string, string][] = [["mode", "payments.mode", "mode"], ["defaultAmount", "payments.default_amount", "usual amount ₹"],
      ["minAmount", "payments.min_amount", "smallest ₹"], ["maxAmount", "payments.max_amount", "largest ₹"], ["linkMinutes", "payments.link_minutes", "link minutes "]];
    const set = keys.filter(([k]) => b[k] !== undefined);
    if (!set.length) throw badRequest("Nothing to change");
    await withTx(auditCtx(req, `Payment settings: ${set.map(([k, , w]) => `${w}${k === "mode" ? ` ${MODE_WORDS[b.mode!].toLowerCase()}` : b[k]}`).join(", ")}`), async (c) => {
      for (const [k, key] of set)
        await c.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(b[k])]);
    });
    return { ok: true };
  });
}
