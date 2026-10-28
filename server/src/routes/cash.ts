// Cash deposits and the cash book (D-053). The cash desk (cash.deposit) records what it takes to the bank without seeing
// Yarago's cash (blind): its answers are built from deskView() only. Finance (reconciliation.read) sees the whole book:
// Yarago cash per deposit, the drawer's carry, the bank match and cash in hand. A wrong entry is voided by an admin with
// a reason and recorded again; nothing is changed or deleted (guard trigger in 0029).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, has, need, needAny } from "../auth.js";
import { one, withTx } from "../db.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { dateStr, niceDate, todayIST } from "../lib/time.js";
import { deskView } from "../services/cashBook.js";
import { cashSettings, loadCashBook } from "../services/reconData.js";
import { rupees } from "../services/reconcile.js";
import { zohoStatus } from "../services/zohoSync.js";

const money = z.number().positive("The amount must be more than ₹0").max(5_000_000, "That is more than ₹50 lakh: check the amount")
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Rupees with at most two decimals");
const depositBody = z.object({
  requestKey: z.string().uuid("Reload the form and try again"),
  depositedOn: dateStr, coversTo: dateStr, amount: money,
  slipNo: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function cashRoutes(app: FastifyInstance) {
  app.get("/api/cash", async (req) => {
    const me = needAny(req, ["cash.deposit", "reconciliation.read"]);
    const book = await loadCashBook(todayIST());
    const desk = deskView(book);
    if (!has(me, "reconciliation.read")) return { full: false, desk };
    return { full: true, desk, book, settings: await cashSettings(), zohoStatus: await zohoStatus() };
  });

  app.post("/api/cash/deposits", async (req, reply) => {
    const me = need(req, "cash.deposit");
    const b = depositBody.parse(req.body);
    const today = todayIST();
    if (b.depositedOn > today) throw badRequest("The deposit day cannot be in the future");
    if (b.coversTo > b.depositedOn) throw badRequest("The cash deposited cannot be from after the deposit day");
    const r = await withTx(auditCtx(req, `Cash deposit recorded: ${rupees(b.amount)} on ${niceDate(b.depositedOn)}, cash up to ${niceDate(b.coversTo)}${b.slipNo ? `, slip ${b.slipNo}` : ""}`), async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('app.cash_deposits'))`);
      const again = (await c.query(`SELECT id FROM app.cash_deposits WHERE request_key = $1`, [b.requestKey])).rows[0];
      if (again) return { id: Number(again.id), again: true };
      const { start } = await cashSettings();
      if (b.coversTo < start) throw badRequest(`The cash book starts with the cash of ${niceDate(start)}: a deposit for earlier days is not recorded here`);
      const last = (await c.query(`SELECT id, covers_to::text AS "coversTo" FROM app.cash_deposits WHERE status = 'recorded' ORDER BY covers_to DESC LIMIT 1`)).rows[0];
      if (last && b.coversTo <= last.coversTo)
        throw new HttpError(409, "covered", `The cash up to ${niceDate(last.coversTo)} is already in deposit #${last.id}: choose a later day, or ask the admin to void that deposit`);
      const id = (await c.query(`INSERT INTO app.cash_deposits (request_key, deposited_on, covers_to, amount, slip_no, note, recorded_by)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                                [b.requestKey, b.depositedOn, b.coversTo, b.amount, b.slipNo || null, b.note || null, me.id])).rows[0].id;
      return { id: Number(id), again: false };
    });
    reply.status(r.again ? 200 : 201);
    return { id: r.id, again: r.again };
  });

  app.post("/api/cash/deposits/:id/void", async (req) => {
    need(req, "adjustments.approve");
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5, "Say why the deposit is voided").max(300) }).parse(req.body);
    const cur = await one<{ amount: number; deposited_on: string; status: string }>(`SELECT amount::float AS amount, deposited_on::text, status FROM app.cash_deposits WHERE id = $1`, [id]);
    if (!cur) throw new HttpError(404, "not_found", "Cash deposit not found");
    const n = await withTx(auditCtx(req, `Cash deposit #${id} (${rupees(cur.amount)} on ${niceDate(cur.deposited_on)}) voided: ${reason}`), async (c) =>
      (await c.query(`UPDATE app.cash_deposits SET status = 'voided', voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1 AND status = 'recorded'`,
                     [id, req.user!.id, reason])).rowCount);
    if (!n) throw new HttpError(409, "conflict", "That deposit is already voided");
    return { ok: true };
  });

  app.put("/api/cash/settings", async (req) => {
    need(req, "adjustments.approve");
    const b = z.object({
      start: dateStr.optional(), opening: z.number().min(-1_000_000).max(10_000_000).optional(), bankFrom: dateStr.optional(),
      warnAt: z.number().min(0).max(10_000_000).optional(), limit: z.number().min(1).max(10_000_000).optional(), carryBand: z.number().min(0).max(1000).optional(),
    }).parse(req.body);
    const cur = await cashSettings();
    const book = { start: b.start ?? cur.start, opening: b.opening ?? cur.opening, bankFrom: b.bankFrom ?? cur.bankFrom };
    const limits = { warnAt: b.warnAt ?? cur.limits.warnAt, limit: b.limit ?? cur.limits.limit, carryBand: b.carryBand ?? cur.limits.carryBand };
    if (limits.warnAt > limits.limit) throw badRequest("The warning must come before the limit");
    await withTx(auditCtx(req, `Cash book settings: starts ${niceDate(book.start)} with ${rupees(book.opening)} in hand, bank from ${niceDate(book.bankFrom)}; amber from ${rupees(limits.warnAt)}, limit ${rupees(limits.limit)}, rounding up to ${rupees(limits.carryBand)}`), async (c) => {
      await c.query(`INSERT INTO app.settings (key, value) VALUES ('cash.book', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(book)]);
      await c.query(`INSERT INTO app.settings (key, value) VALUES ('cash.limits', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(limits)]);
    });
    return { settings: await cashSettings() };
  });
}
