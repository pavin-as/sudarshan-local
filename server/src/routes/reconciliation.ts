// Money reconciliation (D-052): Yarago against the Zoho bank, adjustment requests and their approval, bank rules,
// the read-only Zoho fetch and the optional local assistant. Every figure comes from services/reconcile.ts.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { q, withTx } from "../db.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { addDays, dateStr, todayIST } from "../lib/time.js";
import { adjustmentTrail, approve, listAdjustments, loadAdjustment, pendingCount, prepare, reject, requestReversal, submit, withdraw,
         type SubmitBody } from "../services/adjustments.js";
import { dayDetail, loadInput, loadRules, reconSettings, searchRecords, zohoLines } from "../services/reconData.js";
import { AssistantUnavailable, explain } from "../services/reconAssistant.js";
import { CATEGORIES, CATEGORY_WORDS, KIND_WORDS, METHOD_WORDS, METHODS, reconcile, STATUS_WORDS, type Method } from "../services/reconcile.js";
import { ZohoError } from "../services/zohoBooks.js";
import { fetchZoho, zohoRuns, zohoStatus } from "../services/zohoSync.js";

const MAX_DAYS = 92;
const method = z.enum(METHODS as [Method, ...Method[]]);
const category = z.enum(CATEGORIES as [string, ...string[]]);
const money = z.number().min(0).max(10_000_000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Rupees with at most two decimals");
const range = z.object({ from: dateStr, to: dateStr }).refine((r) => r.from <= r.to, "The start must not be after the end")
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86400000 < MAX_DAYS, `Choose at most ${MAX_DAYS} days`);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const submitBody = z.object({
  requestKey: z.string().uuid("Reload the form and try again"),
  kind: z.enum(["refund_method", "method_correction", "amount_correction", "date_correction", "missing_entry", "payment_fee", "bank_credit"]),
  onDate: dateStr, otherDate: dateStr.nullable().optional(),
  amount: money, recordedAmount: money.nullable().optional(),
  category: category.nullable().optional(),
  sourceMethod: method.nullable().optional(), recordedMethod: method.nullable().optional(), actualMethod: method.nullable().optional(),
  bankClass: z.enum(["clinic", "not_clinic"]).nullable().optional(),
  yaragoSource: z.enum(["clinic_bill", "pharmacy_payment", "opd_refund", "pharmacy_refund"]).nullable().optional(),
  yaragoId: z.string().trim().max(40).nullable().optional(),
  zohoTxnId: z.string().trim().max(40).nullable().optional(),
  reason: z.string().trim().min(10, "Explain in a sentence what happened (at least 10 letters)").max(1000),
  refs: z.string().trim().max(500).nullable().optional(),
}).refine((b) => b.onDate <= todayIST() && (!b.otherDate || b.otherDate <= todayIST()), "A business day cannot be in the future");

export async function reconciliationRoutes(app: FastifyInstance) {
  // ---- the reconciliation ----
  app.get("/api/recon", async (req) => {
    need(req, "reconciliation.read");
    const r = range.parse(req.query);
    const result = reconcile(await loadInput(r.from, r.to, todayIST()));
    const last = await q(`SELECT max(finished_at)::text AS at FROM app.sync_runs WHERE status = 'ok'`);
    return { result, yaragoSyncedAt: last[0]?.at ?? null, words: { methods: METHOD_WORDS, categories: CATEGORY_WORDS, statuses: STATUS_WORDS, kinds: KIND_WORDS },
             zohoStatus: await zohoStatus(), pendingAdjustments: await pendingCount() };
  });

  app.get("/api/recon/detail", async (req) => {
    need(req, "reconciliation.read");
    const f = z.object({ date: dateStr, method: method.optional() }).parse(req.query);
    const rules = await loadRules();
    const w = Math.max(0, ...rules.filter((r) => r.isActive && (!f.method || r.method === f.method)).map((r) => r.windowDays));
    return { date: f.date, method: f.method ?? null, windowDays: w, ...(await dayDetail(f.date, f.method ?? null, w)) };
  });

  app.get("/api/recon/search", async (req) => {
    need(req, "adjustments.submit");
    const f = z.object({ q: z.string().trim().min(2).max(30).optional(), date: dateStr.optional() }).parse(req.query);
    if (!f.q && !f.date) throw badRequest("Give a bill number, an MRD or a day");
    return searchRecords(f);
  });

  app.get("/api/recon/zoho-lines", async (req) => {
    need(req, "reconciliation.read");
    const r = range.parse(req.query);
    return { lines: await zohoLines(r.from, addDays(r.to, 10)) };
  });

  app.get("/api/recon/zoho", async (req) => {
    need(req, "reconciliation.read");
    return { status: await zohoStatus(), runs: await zohoRuns() };
  });

  app.post("/api/recon/zoho/fetch", async (req) => {
    const me = need(req, "reconciliation.read");
    const r = range.parse(req.body ?? {});
    try { return await fetchZoho(addDays(r.from, -10), addDays(r.to, 10) > todayIST() ? todayIST() : addDays(r.to, 10), me.id); }
    catch (e) { if (e instanceof ZohoError) throw new HttpError(503, "zoho", e.message); throw e; }
  });

  app.post("/api/recon/assistant", async (req) => {
    const me = need(req, "reconciliation.read");
    const b = z.object({ from: dateStr, to: dateStr, question: z.string().trim().max(300).nullable().optional() }).parse(req.body);
    const r = range.parse(b);
    const result = reconcile(await loadInput(r.from, r.to, todayIST()));
    try { return await explain(me.id, result, b.question || null); }
    catch (e) { if (e instanceof AssistantUnavailable) throw new HttpError(503, "assistant_unavailable", e.message); throw e; }
  });

  // ---- adjustments ----
  app.get("/api/adjustments", async (req) => {
    const me = need(req, "adjustments.submit");
    const f = z.object({ status: z.enum(["pending", "approved", "rejected", "withdrawn", "reversed"]).optional(), mine: z.coerce.boolean().optional(),
                         from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    return { adjustments: await listAdjustments({ ...f, mine: f.mine ? me.id : undefined }), pending: await pendingCount() };
  });

  app.get("/api/adjustments/:id", async (req) => {
    need(req, "reconciliation.read");
    const { id } = idParam.parse(req.params);
    const a = await loadAdjustment(id);
    if (!a) throw new HttpError(404, "not_found", "Adjustment request not found");
    const linked = await q(`SELECT id, kind, status FROM app.recon_adjustments WHERE id = ANY($1) OR reverses_id = $2 OR replaces_id = $2 OR paired_with = $2 ORDER BY id`,
                           [[a.reversesId, a.replacesId, a.pairedWith, a.reversedBy].filter(Boolean), id]);
    return { adjustment: a, linked: linked.filter((x: any) => x.id !== id), trail: await adjustmentTrail(id) };
  });

  app.post("/api/adjustments/preview", async (req) => {
    need(req, "adjustments.submit");
    const b = submitBody.parse(req.body) as SubmitBody;
    return { effects: (await prepare(b)).effects };
  });

  app.post("/api/adjustments", async (req, reply) => {
    const me = need(req, "adjustments.submit");
    const b = submitBody.parse(req.body) as SubmitBody;
    const r = await submit(auditCtx(req), me.id, b);
    reply.status(r.again ? 200 : 201);
    return { adjustment: await loadAdjustment(r.id), again: r.again };
  });

  app.post("/api/adjustments/:id/withdraw", async (req) => {
    const me = need(req, "adjustments.submit");
    const { id } = idParam.parse(req.params);
    await withdraw(auditCtx(req), me.id, id);
    return { adjustment: await loadAdjustment(id) };
  });

  app.post("/api/adjustments/:id/reverse", async (req, reply) => {
    const me = need(req, "adjustments.submit");
    const { id } = idParam.parse(req.params);
    const b = z.object({ requestKey: z.string().uuid("Reload the form and try again"),
                         reason: z.string().trim().min(10, "Explain why the approved adjustment is wrong (at least 10 letters)").max(1000),
                         refs: z.string().trim().max(500).nullable().optional(), replacement: submitBody.nullable().optional() }).parse(req.body);
    const r = await requestReversal(auditCtx(req), me.id, id, { ...b, replacement: (b.replacement ?? null) as SubmitBody | null });
    reply.status(r.again ? 200 : 201);
    return { adjustment: await loadAdjustment(r.id), replacementId: r.replacementId, again: r.again };
  });

  app.post("/api/adjustments/:id/approve", async (req) => {
    const me = need(req, "adjustments.approve");
    const { id } = idParam.parse(req.params);
    const { note } = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body ?? {});
    await approve(auditCtx(req), me.id, id, note ?? null);
    return { adjustment: await loadAdjustment(id) };
  });

  app.post("/api/adjustments/:id/reject", async (req) => {
    const me = need(req, "adjustments.approve");
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3, "Say why the request is rejected").max(500) }).parse(req.body);
    await reject(auditCtx(req), me.id, id, reason);
    return { adjustment: await loadAdjustment(id) };
  });

  // ---- bank rules and settings (admin: they decide which bank money counts) ----
  app.get("/api/recon/bank-rules", async (req) => {
    need(req, "reconciliation.read");
    return { rules: await loadRules(), settings: await reconSettings() };
  });

  const ruleBody = z.object({
    position: z.number().int().min(0).max(1000), pattern: z.string().trim().min(3).max(200).refine((p) => { try { new RegExp(p, "i"); return true; } catch { return false; } }, "That pattern is not valid"),
    class: z.enum(["upi_settlement", "card_settlement", "cash_deposit", "online_settlement", "not_clinic"]), method: method.nullable(),
    windowDays: z.number().int().min(0).max(10), isActive: z.boolean(), note: z.string().trim().max(200).nullable().optional(),
  }).refine((r) => r.class === "not_clinic" || r.method, "Choose the payment method the bank money is for");

  app.post("/api/recon/bank-rules", async (req) => {
    need(req, "adjustments.approve");
    const b = ruleBody.parse(req.body);
    await withTx(auditCtx(req, `Bank rule added: "${b.pattern}" counts as ${b.class.replace("_", " ")}`), (c) =>
      c.query(`INSERT INTO app.recon_bank_rules (position, pattern, class, method, window_days, is_active, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [b.position, b.pattern, b.class, b.method, b.windowDays, b.isActive, b.note ?? null]));
    return { rules: await loadRules() };
  });

  app.put("/api/recon/bank-rules/:id", async (req) => {
    need(req, "adjustments.approve");
    const { id } = idParam.parse(req.params);
    const b = ruleBody.parse(req.body);
    const n = await withTx(auditCtx(req, `Bank rule ${id} changed: "${b.pattern}" ${b.isActive ? "on" : "off"}`), async (c) =>
      (await c.query(`UPDATE app.recon_bank_rules SET position = $2, pattern = $3, class = $4, method = $5, window_days = $6, is_active = $7, note = $8 WHERE id = $1`,
                     [id, b.position, b.pattern, b.class, b.method, b.windowDays, b.isActive, b.note ?? null])).rowCount);
    if (!n) throw new HttpError(404, "not_found", "Bank rule not found");
    return { rules: await loadRules() };
  });

  app.put("/api/recon/settings", async (req) => {
    need(req, "adjustments.approve");
    const b = z.object({ tolerance: z.record(method, z.number().min(0).max(500)).optional(),
                         categoryMap: z.record(z.string().min(1).max(60), category).optional() }).parse(req.body);
    if (!b.tolerance && !b.categoryMap) throw badRequest("Nothing to change");
    await withTx(auditCtx(req, `Reconciliation settings changed${b.tolerance ? `: tolerance ${Object.entries(b.tolerance).map(([k, v]) => `${k} ₹${v}`).join(", ")}` : ""}`), async (c) => {
      if (b.tolerance) await c.query(`UPDATE app.settings SET value = value || $1::jsonb WHERE key = 'recon.tolerance'`, [JSON.stringify(b.tolerance)]);
      if (b.categoryMap) await c.query(`UPDATE app.settings SET value = value || $1::jsonb WHERE key = 'recon.category_map'`, [JSON.stringify(b.categoryMap)]);
    });
    return { settings: await reconSettings() };
  });
}
