// Reconciliation adjustments (D-052): a request (manager or admin) is counted only once an admin approves it.
// - Effects are worked out once, at submission (effectsFor), and frozen; the tally sums approved effects only, so nothing
//   is ever applied and nothing can be applied twice.
// - The same form sent twice (request_key) is one request; the same correction to the same record cannot be pending or
//   approved twice (checked here, and by a unique index).
// - Decisions take a row lock and change only a pending row: of two approvals at once, one wins and the other is told.
// - An approved adjustment is corrected only by a reversal (optionally with a replacement), itself approved by an admin.
// - The submitter may approve their own request only with a note; it is then flagged self-approved (Pavin, 28 Oct).
// - Original Yarago and Zoho records are never touched: requests point to them.
import type pg from "pg";
import { one, q, setAuditSummary, withTx, type AuditContext } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { niceDate } from "../lib/time.js";
import { AdjustmentRefused, effectsFor, KIND_WORDS, reversalEffects, rupees, type AdjInput, type AdjKind, type Category, type EffectDraft, type Method } from "./reconcile.js";
import { yaragoRecord, zohoLine } from "./reconData.js";

export interface SubmitBody {
  requestKey: string; kind: Exclude<AdjKind, "reversal">; onDate: string; otherDate?: string | null; amount: number; recordedAmount?: number | null;
  category?: Category | null; sourceMethod?: Method | null; recordedMethod?: Method | null; actualMethod?: Method | null;
  bankClass?: "clinic" | "not_clinic" | null; yaragoSource?: "clinic_bill" | "pharmacy_payment" | "opd_refund" | "pharmacy_refund" | null;
  yaragoId?: string | null; zohoTxnId?: string | null; reason: string; refs?: string | null;
}

const ADJ_COLS = `a.id, a.kind, a.status, a.on_date AS "onDate", a.other_date AS "otherDate", a.amount, a.recorded_amount AS "recordedAmount",
  a.category, a.source_method AS "sourceMethod", a.recorded_method AS "recordedMethod", a.actual_method AS "actualMethod", a.bank_class AS "bankClass",
  a.yarago_source AS "yaragoSource", a.yarago_id AS "yaragoId", a.bill_no AS "billNo", a.patient_id AS "patientId", a.zoho_txn_id AS "zohoTxnId",
  a.reason, a.refs, a.submitted_by AS "submittedBy", su.full_name AS "submittedByName", a.submitted_at AS "submittedAt",
  a.reviewed_by AS "reviewedBy", ru.full_name AS "reviewedByName", a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote",
  a.rejection_reason AS "rejectionReason", a.self_approved AS "selfApproved", a.withdrawn_at AS "withdrawnAt",
  a.reverses_id AS "reversesId", a.replaces_id AS "replacesId", a.paired_with AS "pairedWith", a.reversed_by AS "reversedBy",
  (SELECT r.id FROM app.recon_adjustments r WHERE r.paired_with = a.id LIMIT 1) AS "replacementId",
  cp.mrd, cp.name AS "patientName",
  coalesce((SELECT json_agg(json_build_object('onDate', e.on_date, 'measure', e.measure, 'category', e.category, 'method', e.method,
                                              'amount', e.amount, 'zohoTxnId', e.zoho_txn_id, 'words', e.words) ORDER BY e.position)
              FROM app.recon_adjustment_effects e WHERE e.adjustment_id = a.id), '[]') AS effects`;
const ADJ_FROM = `FROM app.recon_adjustments a JOIN app.users su ON su.id = a.submitted_by LEFT JOIN app.users ru ON ru.id = a.reviewed_by
                  LEFT JOIN clinical.patient cp ON cp.patient_id = a.patient_id`;

export async function loadAdjustment(id: number, db?: pg.PoolClient) {
  return one<any>(`SELECT ${ADJ_COLS} ${ADJ_FROM} WHERE a.id = $1`, [id], db);
}

export async function listAdjustments(f: { status?: string; mine?: number; from?: string; to?: string; limit?: number }) {
  const p: unknown[] = []; const w: string[] = [];
  if (f.status) { p.push(f.status); w.push(`a.status = $${p.length}`); }
  if (f.mine) { p.push(f.mine); w.push(`a.submitted_by = $${p.length}`); }
  if (f.from) { p.push(f.from); w.push(`a.on_date >= $${p.length}`); }
  if (f.to) { p.push(f.to); w.push(`a.on_date <= $${p.length}`); }
  p.push(f.limit ?? 300);
  return q(`SELECT ${ADJ_COLS} ${ADJ_FROM} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY a.id DESC LIMIT $${p.length}`, p);
}

export async function pendingCount(): Promise<number> {
  return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM app.recon_adjustments WHERE status = 'pending' AND paired_with IS NULL`))?.n ?? 0;
}

/** Who did what, from the activity log. */
export async function adjustmentTrail(id: number) {
  return q(`SELECT l.at, u.full_name AS who, l.action, l.summary, l.changes FROM app.audit_log l LEFT JOIN app.users u ON u.id = l.actor_id
             WHERE l.entity_type = 'recon_adjustments' AND l.entity_id = $1 ORDER BY l.at, l.id`, [String(id)]);
}

/** Checks a request against the records it points to, and works out its effects (throws a plain-sentence 400). */
export async function prepare(b: SubmitBody): Promise<{ effects: EffectDraft[]; billNo: string | null; patientId: number | null; bankAmount: number | null }> {
  let billNo: string | null = null, patientId: number | null = null, bankAmount: number | null = null;
  if (b.yaragoSource && b.yaragoId) {
    const rec = await yaragoRecord(b.yaragoSource, b.yaragoId);
    if (!rec) throw badRequest("That Yarago record was not found: search for it again");
    billNo = rec.billNo; patientId = rec.patientId;
    const has = (m: Method | null | undefined) => rec.methods.find((x) => x.method === m);
    if (b.kind === "refund_method" && b.recordedMethod && b.yaragoSource.endsWith("_refund") && !has(b.recordedMethod))
      throw badRequest(`Yarago does not show this refund as ${b.recordedMethod.toUpperCase() === "UPI" ? "UPI" : b.recordedMethod}: choose the method it shows`);
    if (b.kind === "method_correction") {
      const r = has(b.recordedMethod);
      if (!r) throw badRequest("Yarago shows no payment by that method on this record: choose the method it shows");
      if (b.amount > Number(r.amount) + 0.001) throw badRequest(`Yarago shows only ${rupees(Number(r.amount))} by that method on this record`);
    }
    if ((b.kind === "amount_correction") && b.recordedAmount != null && b.actualMethod && has(b.actualMethod) &&
        Math.abs(Number(has(b.actualMethod)!.amount) - b.recordedAmount) > 0.001)
      throw badRequest(`Yarago shows ${rupees(Number(has(b.actualMethod)!.amount))} by that method on this record, not ${rupees(b.recordedAmount)}`);
  } else if (["refund_method", "method_correction", "amount_correction", "date_correction"].includes(b.kind)) {
    throw badRequest("Choose the Yarago record this is about");
  }
  if (b.zohoTxnId) {
    const z = await zohoLine(b.zohoTxnId);
    if (!z) throw badRequest("That Zoho bank line is not in Sudarshan's copy: fetch from Zoho, then choose it again");
    if (b.kind === "bank_credit" && z.side !== "credit") throw badRequest("Only a bank credit can be classified as money received");
    if (b.kind === "payment_fee" && z.side !== "debit") throw badRequest("A fee is a debit on the bank statement: choose a debit, or leave the bank line out");
    bankAmount = Number(z.amount);
  } else if (b.kind === "bank_credit") throw badRequest("Choose the Zoho bank line");
  const input: AdjInput = { kind: b.kind, onDate: b.onDate, otherDate: b.otherDate, amount: b.amount, recordedAmount: b.recordedAmount, category: b.category,
                            sourceMethod: b.sourceMethod, recordedMethod: b.recordedMethod, actualMethod: b.actualMethod, bankClass: b.bankClass,
                            zohoTxnId: b.zohoTxnId, bankAmount: b.kind === "bank_credit" ? bankAmount : null };
  try { return { effects: effectsFor(input), billNo, patientId, bankAmount }; }
  catch (e) { if (e instanceof AdjustmentRefused) throw badRequest(e.message); throw e; }
}

async function findDuplicate(c: pg.PoolClient, b: SubmitBody, replacesId: number | null): Promise<number | null> {
  const r = await one<{ id: number }>(
    `SELECT id FROM app.recon_adjustments WHERE status IN ('pending','approved') AND kind = $1 AND id IS DISTINCT FROM $8 AND (
       ($2::text IS NOT NULL AND yarago_source = $2 AND yarago_id = $3 AND amount = $4 AND coalesce(recorded_method,'') = coalesce($5,'')
        AND coalesce(actual_method,'') = coalesce($6,'') AND on_date = $7)
       OR ($9::text IS NOT NULL AND kind IN ('bank_credit','payment_fee') AND zoho_txn_id = $9)) LIMIT 1`,
    [b.kind, b.yaragoSource ?? null, b.yaragoId ?? null, b.amount, b.recordedMethod ?? null, b.actualMethod ?? null, b.onDate, replacesId, b.zohoTxnId ?? null], c);
  return r?.id ?? null;
}

async function insertRequest(c: pg.PoolClient, me: number, b: SubmitBody, prep: Awaited<ReturnType<typeof prepare>>,
                             extra: { replacesId?: number | null; pairedWith?: number | null } = {}): Promise<number> {
  const id = (await c.query(
    `INSERT INTO app.recon_adjustments (request_key, kind, on_date, other_date, amount, recorded_amount, category, source_method, recorded_method,
       actual_method, bank_class, yarago_source, yarago_id, bill_no, patient_id, zoho_txn_id, reason, refs, submitted_by, replaces_id, paired_with)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [b.requestKey, b.kind, b.onDate, b.otherDate ?? null, b.amount, b.recordedAmount ?? null, b.category ?? null, b.sourceMethod ?? null,
     b.recordedMethod ?? null, b.actualMethod ?? null, b.bankClass ?? null, b.yaragoSource ?? null, b.yaragoId ?? null, prep.billNo, prep.patientId,
     b.zohoTxnId ?? null, b.reason.trim(), b.refs?.trim() || null, me, extra.replacesId ?? null, extra.pairedWith ?? null])).rows[0].id as number;
  await insertEffects(c, id, prep.effects);
  return id;
}
async function insertEffects(c: pg.PoolClient, id: number, effects: EffectDraft[]) {
  for (const [i, e] of effects.entries())
    await c.query(`INSERT INTO app.recon_adjustment_effects (adjustment_id, position, on_date, measure, category, method, amount, zoho_txn_id, words)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, i + 1, e.onDate, e.measure, e.category, e.method, e.amount, e.zohoTxnId, e.words]);
}
const describe = (b: { kind: AdjKind; amount: number; onDate: string }, billNo: string | null) =>
  `${KIND_WORDS[b.kind]} ${rupees(b.amount)} for ${niceDate(b.onDate)}${billNo ? ` (bill ${billNo})` : ""}`;

/** Send a request. The same requestKey sent again returns the first request instead of making a second. */
export async function submit(ctx: AuditContext, me: number, b: SubmitBody): Promise<{ id: number; again: boolean }> {
  const seen = await one<{ id: number; submitted_by: number }>(`SELECT id, submitted_by FROM app.recon_adjustments WHERE request_key = $1`, [b.requestKey]);
  if (seen) { if (seen.submitted_by !== me) throw conflict("That request key belongs to another request: reload the form"); return { id: seen.id, again: true }; }
  const prep = await prepare(b);
  return withTx(ctx, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('recon_adjustment'))`);     // duplicates are checked under one lock
    const again = await one<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE request_key = $1`, [b.requestKey], c);
    if (again) return { id: again.id, again: true };
    const dup = await findDuplicate(c, b, null);
    if (dup) throw conflict(`The same adjustment is already requested or approved (#${dup}). Open it instead of sending another.`, { id: dup });
    await setAuditSummary(c, `Adjustment requested: ${describe(b, prep.billNo)}`);      // the trigger reads it as each row is written
    return { id: await insertRequest(c, me, b, prep), again: false };
  });
}

async function lockPending(c: pg.PoolClient, id: number) {
  const a = await one<any>(`SELECT * FROM app.recon_adjustments WHERE id = $1 FOR UPDATE`, [id], c);
  if (!a) throw notFound("Adjustment request");
  if (a.status !== "pending") {
    const who = a.reviewed_by ? (await one<{ n: string }>(`SELECT full_name AS n FROM app.users WHERE id = $1`, [a.reviewed_by], c))?.n : null;
    throw conflict(`Request #${id} is already ${a.status}${who ? ` (by ${who})` : ""}: nothing was changed`);
  }
  return a;
}

/** Approve (admin). A reversal also marks the original reversed and approves its paired replacement, in one transaction. */
export async function approve(ctx: AuditContext, me: number, id: number, note: string | null): Promise<void> {
  await withTx(ctx, async (c) => {
    const a = await lockPending(c, id);
    if (a.paired_with) throw badRequest(`Request #${id} is decided together with reversal #${a.paired_with}: open that one`);
    const self = a.submitted_by === me;
    if (self && (note ?? "").trim().length < 3) throw badRequest("You sent this request yourself: write an approval note saying why it is right");
    const decide = async (rowId: number, label: string) => {
      await setAuditSummary(c, label);
      await c.query(`UPDATE app.recon_adjustments SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, self_approved = $4
                      WHERE id = $1 AND status = 'pending'`, [rowId, me, note?.trim() || null, self]);
    };
    await decide(id, `Adjustment #${id} approved${self ? " (self-approved)" : ""}: ${describe({ kind: a.kind, amount: Number(a.amount), onDate: a.on_date }, a.bill_no)}`);
    if (a.kind === "reversal") {
      const orig = await one<any>(`SELECT id, status FROM app.recon_adjustments WHERE id = $1 FOR UPDATE`, [a.reverses_id], c);
      if (orig?.status !== "approved") throw conflict(`Request #${a.reverses_id} is no longer approved, so it cannot be reversed`);
      await setAuditSummary(c, `Adjustment #${orig.id} reversed by #${id}`);
      await c.query(`UPDATE app.recon_adjustments SET status = 'reversed', reversed_by = $2 WHERE id = $1`, [orig.id, id]);
      const rep = await one<any>(`SELECT id, kind, amount, on_date, bill_no FROM app.recon_adjustments WHERE paired_with = $1 AND status = 'pending' FOR UPDATE`, [id], c);
      if (rep) await decide(rep.id, `Adjustment #${rep.id} approved with reversal #${id}${self ? " (self-approved)" : ""}: ${describe({ kind: rep.kind, amount: Number(rep.amount), onDate: rep.on_date }, rep.bill_no)}`);
    }
  });
}

export async function reject(ctx: AuditContext, me: number, id: number, reason: string): Promise<void> {
  if (reason.trim().length < 3) throw badRequest("Say why the request is rejected");
  await withTx(ctx, async (c) => {
    const a = await lockPending(c, id);
    if (a.paired_with) throw badRequest(`Request #${id} is decided together with reversal #${a.paired_with}: open that one`);
    for (const rowId of [id, ...(await q<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE paired_with = $1 AND status = 'pending'`, [id], c)).map((r) => r.id)]) {
      await setAuditSummary(c, `Adjustment #${rowId} rejected: ${reason.trim()}`);
      await c.query(`UPDATE app.recon_adjustments SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3 WHERE id = $1 AND status = 'pending'`,
                    [rowId, me, reason.trim()]);
    }
  });
}

/** Only the person who sent it, while pending. */
export async function withdraw(ctx: AuditContext, me: number, id: number): Promise<void> {
  await withTx(ctx, async (c) => {
    const a = await lockPending(c, id);
    if (a.submitted_by !== me) throw forbidden("Only the person who sent a request can withdraw it");
    if (a.paired_with) throw badRequest(`Withdraw reversal #${a.paired_with} instead: this replacement goes with it`);
    for (const rowId of [id, ...(await q<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE paired_with = $1 AND status = 'pending'`, [id], c)).map((r) => r.id)]) {
      await setAuditSummary(c, `Adjustment #${rowId} withdrawn`);
      await c.query(`UPDATE app.recon_adjustments SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1 AND status = 'pending'`, [rowId]);
    }
  });
}

/** Ask to reverse an approved adjustment, optionally with a corrected replacement; both wait for an admin. */
export async function requestReversal(ctx: AuditContext, me: number, originalId: number,
                                      b: { requestKey: string; reason: string; refs?: string | null; replacement?: SubmitBody | null }): Promise<{ id: number; replacementId: number | null; again: boolean }> {
  const seen = await one<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE request_key = $1`, [b.requestKey]);
  if (seen) return { id: seen.id, replacementId: (await one<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE paired_with = $1`, [seen.id]))?.id ?? null, again: true };
  const prep = b.replacement ? await prepare(b.replacement) : null;
  return withTx(ctx, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('recon_adjustment'))`);
    const o = await one<any>(`SELECT * FROM app.recon_adjustments WHERE id = $1 FOR UPDATE`, [originalId], c);
    if (!o) throw notFound("Adjustment request");
    if (o.kind === "reversal") throw badRequest("A reversal cannot itself be reversed: send a new adjustment instead");
    if (o.status !== "approved") throw conflict(`Only an approved adjustment can be reversed; #${originalId} is ${o.status}`);
    const live = await one<{ id: number }>(`SELECT id FROM app.recon_adjustments WHERE reverses_id = $1 AND status IN ('pending','approved')`, [originalId], c);
    if (live) throw conflict(`A reversal of #${originalId} is already requested (#${live.id})`, { id: live.id });
    const origEffects = await q<EffectDraft>(`SELECT on_date AS "onDate", measure, category, method, amount, zoho_txn_id AS "zohoTxnId", words
                                                FROM app.recon_adjustment_effects WHERE adjustment_id = $1 ORDER BY position`, [originalId], c);
    const amount = Number(o.amount) > 0 ? Number(o.amount) : Math.abs(Number(o.recorded_amount ?? 0)) || 0.01;
    await setAuditSummary(c, `Reversal of adjustment #${originalId} requested`);
    const id = (await c.query(
      `INSERT INTO app.recon_adjustments (request_key, kind, on_date, amount, category, yarago_source, yarago_id, bill_no, patient_id, zoho_txn_id,
         reason, refs, submitted_by, reverses_id) VALUES ($1,'reversal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.requestKey, o.on_date, amount, o.category, o.yarago_source, o.yarago_id, o.bill_no, o.patient_id, o.zoho_txn_id, b.reason.trim(),
       b.refs?.trim() || null, me, originalId])).rows[0].id as number;
    await insertEffects(c, id, reversalEffects(originalId, origEffects));
    let replacementId: number | null = null;
    if (b.replacement && prep) {
      const dup = await findDuplicate(c, b.replacement, originalId);
      if (dup) throw conflict(`The same adjustment is already requested or approved (#${dup})`, { id: dup });
      await setAuditSummary(c, `Adjustment requested to replace #${originalId} (with reversal #${id}): ${describe(b.replacement, prep.billNo)}`);
      replacementId = await insertRequest(c, me, b.replacement, prep, { replacesId: originalId, pairedWith: id });
    }
    return { id, replacementId, again: false };
  });
}
