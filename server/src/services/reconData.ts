// Database side of the reconciliation (D-052): builds reconcile()'s input from the Yarago money views
// (db/views/40_money.sql), the Zoho copy, the bank rules, settings and APPROVED adjustment effects; and the record lists
// behind a day (detail) and the Yarago record picker of the adjustment form. Reads only.
import { one, q } from "../db.js";
import { addDays } from "../lib/time.js";
import { dayBands, type FeeFixed, type FeeRate } from "./bankFees.js";
import { cashBook, type CashBook, type CashDeposit, type CashLimits } from "./cashBook.js";
import { CATEGORIES, classifyCharge, METHODS, type BankLine, type BankRule, type Category, type Effect, type Method, type ReconInput } from "./reconcile.js";
import { zohoAccountIds } from "./zohoBooks.js";
import { zohoStatus, type ZohoStatus } from "./zohoSync.js";

async function setting<T>(key: string, dflt: T): Promise<T> {
  const r = await one<{ value: any }>(`SELECT value FROM app.settings WHERE key = $1`, [key]);
  return (r?.value ?? dflt) as T;
}

export async function loadRules(): Promise<BankRule[]> {
  return q<BankRule>(`SELECT id, position, pattern, class, method, window_days AS "windowDays", is_active AS "isActive", note
                        FROM app.recon_bank_rules ORDER BY position, id`);
}

export async function reconSettings() {
  const map = await setting<Record<string, Category>>("recon.category_map", {});
  const tol = await setting<Partial<Record<Method, number>>>("recon.tolerance", {});
  const categoryMap = Object.fromEntries(Object.entries(map).filter(([, v]) => (CATEGORIES as string[]).includes(v))) as Record<string, Category>;
  const tolerance = Object.fromEntries(Object.entries(tol).filter(([k, v]) => (METHODS as string[]).includes(k) && Number(v) >= 0).map(([k, v]) => [k, Number(v)]));
  return { categoryMap, tolerance: tolerance as Partial<Record<Method, number>> };
}

const EFFECT_COLS = `e.adjustment_id AS "adjustmentId", e.on_date AS "onDate", e.measure, e.category, e.method, e.amount,
                     e.zoho_txn_id AS "zohoTxnId", e.words, a.self_approved AS "selfApproved", a.kind`;

// ---------- bank fees (D-053) ----------
export async function loadFeeRates(): Promise<FeeRate[]> {
  const rows = await q<any>(`SELECT id, effective_from AS "effectiveFrom", method, kind, amount_above AS "amountAbove", amount_upto AS "amountUpto",
                                    rate_pct AS "ratePct", cap_rupees AS "capRupees", flat_rupees AS "flatRupees", note
                               FROM app.bank_fee_rates ORDER BY effective_from, method, kind, amount_above`);
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map((r) => ({ ...r, amountAbove: Number(r.amountAbove), amountUpto: n(r.amountUpto), ratePct: Number(r.ratePct), capRupees: n(r.capRupees), flatRupees: n(r.flatRupees) }));
}
export async function feeFixed(): Promise<FeeFixed> {
  const v = await setting<Partial<FeeFixed>>("recon.fee_fixed", {});
  return { gstPct: Number(v.gstPct ?? 18), servicePerMonth: Number(v.servicePerMonth ?? 99), perBatch: Number(v.perBatch ?? 1), lateSettleDays: Number(v.lateSettleDays ?? 2) };
}

const BANK_COLS = `transaction_id AS "transactionId", account_id AS "accountId", txn_date AS "date", amount::float AS amount, debit_or_credit AS "debitOrCredit",
                   description, zoho_status AS "zohoStatus", missing_since IS NOT NULL AS missing`;
const bankLines = (from: string, to: string) =>
  q<BankLine>(`SELECT ${BANK_COLS} FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3))`,
              [from, to, zohoAccountIds()]);

/** Bank charges (money out a bank_charge rule names) dated from..to. */
export async function bankCharges(from: string, to: string, rules: BankRule[]) {
  return (await bankLines(from, to)).filter((b) => classifyCharge(b, rules))
    .map((b) => ({ transactionId: b.transactionId, date: b.date, amount: Number(b.amount), description: b.description }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- the cash book (D-053) ----------
export async function cashSettings() {
  const book = await setting<{ start?: string; opening?: number; bankFrom?: string }>("cash.book", {});
  const lim = await setting<Partial<CashLimits>>("cash.limits", {});
  const start = /^\d{4}-\d{2}-\d{2}$/.test(book.start ?? "") ? book.start! : "2026-10-11";
  return { start, opening: Number(book.opening ?? 0), bankFrom: /^\d{4}-\d{2}-\d{2}$/.test(book.bankFrom ?? "") ? book.bankFrom! : start,
           limits: { warnAt: Number(lim.warnAt ?? 300000), limit: Number(lim.limit ?? 400000), carryBand: Number(lim.carryBand ?? 99) } };
}

export async function loadDeposits(): Promise<CashDeposit[]> {
  const rows = await q<any>(`SELECT d.id, d.deposited_on AS "depositedOn", d.covers_to AS "coversTo", d.amount::float AS amount, d.slip_no AS "slipNo", d.note,
                                    d.recorded_by AS "recordedBy", r.full_name AS "recordedByName", d.recorded_at::text AS "recordedAt", d.status,
                                    d.void_reason AS "voidReason", v.full_name AS "voidedByName", d.voided_at::text AS "voidedAt"
                               FROM app.cash_deposits d JOIN app.users r ON r.id = d.recorded_by LEFT JOIN app.users v ON v.id = d.voided_by
                              ORDER BY d.covers_to, d.id`);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** The cash book from its start to today: Yarago cash per day (with approved cash adjustments), deposits, the bank. */
export async function loadCashBook(today: string, zs?: ZohoStatus, rules?: BankRule[]): Promise<CashBook> {
  const s = await cashSettings();
  const [rl, z, deposits, pay, ref, eff, bank] = await Promise.all([
    rules ? Promise.resolve(rules) : loadRules(),
    zs ? Promise.resolve(zs) : zohoStatus(),
    loadDeposits(),
    q<{ d: string; a: number }>(`SELECT on_date AS d, sum(amount)::float AS a FROM clinical.money_payment WHERE method = 'cash' AND on_date BETWEEN $1 AND $2 GROUP BY 1`, [s.start, today]),
    q<{ d: string; a: number }>(`SELECT on_date AS d, sum(amount)::float AS a FROM clinical.money_refund WHERE method = 'cash' AND on_date BETWEEN $1 AND $2 GROUP BY 1`, [s.start, today]),
    q<{ d: string; a: number }>(`SELECT e.on_date AS d, sum(CASE e.measure WHEN 'collected' THEN e.amount ELSE -e.amount END)::float AS a
                                   FROM app.recon_adjustment_effects e JOIN app.recon_adjustments a ON a.id = e.adjustment_id
                                  WHERE a.status IN ('approved','reversed') AND e.method = 'cash' AND e.measure IN ('collected','refund') AND e.on_date BETWEEN $1 AND $2
                                  GROUP BY 1`, [s.start, today]),
    bankLines(s.bankFrom, addDays(today, 1)),
  ]);
  const net = new Map<string, number>();
  const add = (d: string, v: number) => net.set(d, Math.round(((net.get(d) ?? 0) + v) * 100) / 100);
  for (const r of pay) add(r.d, Number(r.a));
  for (const r of ref) add(r.d, -Number(r.a));
  for (const r of eff) add(r.d, Number(r.a));
  const bankKnownUntil = !z.configured || !z.fetchedAt ? null : [z.feedRefreshedOn, z.fetchedAt.slice(0, 10)].filter(Boolean).sort()[0] ?? null;
  return cashBook({ start: s.start, opening: s.opening, bankFrom: s.bankFrom, today, days: [...net].map(([date, v]) => ({ date, net: v })),
                    deposits, bank, rules: rl, limits: s.limits, bankKnownUntil, bankTrusted: bankKnownUntil != null && !z.stale });
}

export async function loadInput(from: string, to: string, today: string, book?: CashBook): Promise<ReconInput> {
  const rules = await loadRules();
  const maxWindow = Math.max(0, ...rules.filter((r) => r.isActive).map((r) => r.windowDays));
  const start = addDays(from, -maxWindow), end = addDays(to, maxWindow);
  const accounts = zohoAccountIds();
  const [lines, payments, refunds, bank, settings, zs, rates, fixed] = await Promise.all([
    q(`SELECT line_id AS "lineId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              service_group AS "serviceGroup", item, amount FROM clinical.money_revenue_line WHERE on_date BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT payment_id AS "paymentId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              method, amount, ref FROM clinical.money_payment WHERE on_date BETWEEN $1 AND $2`, [start, to]),
    q(`SELECT refund_id AS "refundId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              method, amount, date_uncertain AS "dateUncertain" FROM clinical.money_refund WHERE on_date BETWEEN $1 AND $2`, [start, to]),
    q<BankLine>(`SELECT ${BANK_COLS} FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3))`, [start, end, accounts]),
    reconSettings(),
    zohoStatus(),
    loadFeeRates(),
    feeFixed(),
  ]);
  const cb = book ?? await loadCashBook(today, zs, rules);
  // approved adjustments, and approved ones reversed since (their reversal is approved too, so the pair nets to nothing)
  const effects = await q<Effect>(
    `SELECT ${EFFECT_COLS} FROM app.recon_adjustment_effects e JOIN app.recon_adjustments a ON a.id = e.adjustment_id
      WHERE a.status IN ('approved','reversed') AND (e.on_date BETWEEN $1 AND $2 OR e.zoho_txn_id = ANY($3))
      ORDER BY e.adjustment_id, e.position`, [addDays(start, -10), addDays(end, 10), bank.map((b) => b.transactionId)]);
  return { from, to, today, lines, payments, refunds, bank, rules, effects, ...settings,
           zoho: { configured: zs.configured, fetchedAt: zs.fetchedAt, feedRefreshedOn: zs.feedRefreshedOn, stale: zs.stale },
           feeBands: dayBands(payments, rates, fixed.gstPct),
           cash: { deposits: cb.deposits.map((d) => ({ id: d.id, depositedOn: d.depositedOn, coversFrom: d.coversFrom, coversTo: d.coversTo })),
                   matchedCreditIds: cb.matchedCreditIds } };
}

/** Everything behind one day (and method): the Yarago records with patient and bill, adjustments, Zoho lines. */
export async function dayDetail(date: string, method: Method | null, windowDays: number) {
  const m = method ?? null;
  const pat = `LEFT JOIN clinical.patient cp ON cp.patient_id = x.patient_id`;
  const [payments, refunds, lines, adjustments, zohoPayments, bank] = await Promise.all([
    q(`SELECT x.payment_id AS id, x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.method, x.amount, x.ref, x.patient_id AS "patientId",
              cp.mrd, cp.name FROM clinical.money_payment x ${pat} WHERE x.on_date = $1 AND ($2::text IS NULL OR x.method = $2) ORDER BY x.source, x.bill_no`, [date, m]),
    q(`SELECT x.refund_id AS id, x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.method, x.amount, x.date_uncertain AS "dateUncertain",
              x.patient_id AS "patientId", cp.mrd, cp.name FROM clinical.money_refund x ${pat}
        WHERE x.on_date = $1 ORDER BY x.source_id`, [date]),       // every refund of the day: one recorded under another method may explain this one
    m ? Promise.resolve([]) : q(`SELECT service_group AS "serviceGroup", source, count(*)::int AS lines, sum(amount) AS amount
                                   FROM clinical.money_revenue_line WHERE on_date = $1 GROUP BY 1, 2 ORDER BY 1`, [date]),
    q(`SELECT DISTINCT a.id, a.kind, a.status, a.amount, a.self_approved AS "selfApproved", a.bill_no AS "billNo", a.reason
         FROM app.recon_adjustments a JOIN app.recon_adjustment_effects e ON e.adjustment_id = a.id
        WHERE e.on_date = $1 AND ($2::text IS NULL OR e.method = $2 OR e.method IS NULL) AND a.status IN ('pending','approved','reversed') ORDER BY a.id`, [date, m]),
    q(`SELECT payment_id AS id, pay_date AS date, payment_mode AS mode, amount, account_name AS "accountName", description, invoice_numbers AS "invoiceNumbers"
         FROM app.zoho_customer_payments WHERE pay_date BETWEEN $1 AND $2 ORDER BY pay_date, payment_id`, [date, addDays(date, windowDays)]),
    q(`SELECT transaction_id AS id, txn_date AS date, amount, debit_or_credit AS side, description, zoho_status AS status, missing_since IS NOT NULL AS missing
         FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3)) ORDER BY txn_date, transaction_id`,
      [date, addDays(date, windowDays), zohoAccountIds()]),
  ]);
  return { payments, refunds, lines, adjustments, zohoPayments, bank };
}

/** Yarago records for the adjustment form: by bill number, MRD or day. */
export async function searchRecords(f: { q?: string; date?: string }) {
  const p: unknown[] = [];
  const where: string[] = [];
  if (f.date) { p.push(f.date); where.push(`x.on_date = $${p.length}`); }
  if (f.q) { p.push(f.q); where.push(`(x.bill_no = $${p.length} OR cp.mrd ILIKE $${p.length})`); }
  if (!where.length) return { payments: [], refunds: [] };
  const w = where.join(" AND ");
  const payments = await q(`SELECT x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.on_date AS "onDate", x.patient_id AS "patientId", cp.mrd, cp.name,
                                   json_agg(json_build_object('method', x.method, 'amount', x.amount) ORDER BY x.method) AS methods, sum(x.amount) AS total
                              FROM clinical.money_payment x LEFT JOIN clinical.patient cp ON cp.patient_id = x.patient_id
                             WHERE ${w} GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 4 DESC, 3 LIMIT 100`, p);
  const refunds = await q(`SELECT x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.on_date AS "onDate", x.patient_id AS "patientId", cp.mrd, cp.name,
                                  json_agg(json_build_object('method', x.method, 'amount', x.amount) ORDER BY x.method) AS methods, sum(x.amount) AS total
                             FROM clinical.money_refund x LEFT JOIN clinical.patient cp ON cp.patient_id = x.patient_id
                            WHERE ${w} GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 4 DESC, 3 LIMIT 100`, p);
  return { payments, refunds };
}

/** One Yarago record as the adjustment form saw it: the method amounts, for checking a request against the record. */
export async function yaragoRecord(source: string, sourceId: string) {
  const view = source === "opd_refund" || source === "pharmacy_refund" ? "clinical.money_refund" : "clinical.money_payment";
  const rows = await q<{ method: string; amount: number; onDate: string; billNo: string | null; patientId: number | null }>(
    `SELECT method, amount, on_date AS "onDate", bill_no AS "billNo", patient_id AS "patientId" FROM ${view} WHERE source = $1 AND source_id = $2`, [source, sourceId]);
  return rows.length ? { onDate: rows[0].onDate, billNo: rows[0].billNo, patientId: rows[0].patientId, methods: rows.map((r) => ({ method: r.method, amount: Number(r.amount) })) } : null;
}

export async function zohoLine(id: string) {
  return one<{ id: string; date: string; amount: number; side: "credit" | "debit"; description: string | null; missing: boolean }>(
    `SELECT transaction_id AS id, txn_date AS date, amount, debit_or_credit AS side, description, missing_since IS NOT NULL AS missing
       FROM app.zoho_bank_txns WHERE transaction_id = $1`, [id]);
}

export async function zohoLines(from: string, to: string) {
  return q(`SELECT transaction_id AS id, txn_date AS date, amount, debit_or_credit AS side, description, zoho_status AS status, missing_since IS NOT NULL AS missing
              FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3))
             ORDER BY txn_date, transaction_id LIMIT 2000`, [from, to, zohoAccountIds()]);
}
