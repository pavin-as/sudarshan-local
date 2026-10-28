// Database side of the reconciliation (D-052): builds reconcile()'s input from the Yarago money views
// (db/views/40_money.sql), the Zoho copy, the bank rules, settings and APPROVED adjustment effects; and the record lists
// behind a day (detail) and the Yarago record picker of the adjustment form. Reads only.
import { one, q } from "../db.js";
import { addDays } from "../lib/time.js";
import { CATEGORIES, METHODS, type BankRule, type Category, type Effect, type Method, type ReconInput } from "./reconcile.js";
import { zohoAccountIds } from "./zohoBooks.js";
import { zohoStatus } from "./zohoSync.js";

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

export async function loadInput(from: string, to: string, today: string): Promise<ReconInput> {
  const rules = await loadRules();
  const maxWindow = Math.max(0, ...rules.filter((r) => r.isActive).map((r) => r.windowDays));
  const start = addDays(from, -maxWindow), end = addDays(to, maxWindow);
  const accounts = zohoAccountIds();
  const [lines, payments, refunds, bank, settings, zs] = await Promise.all([
    q(`SELECT line_id AS "lineId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              service_group AS "serviceGroup", item, amount FROM clinical.money_revenue_line WHERE on_date BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT payment_id AS "paymentId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              method, amount, ref FROM clinical.money_payment WHERE on_date BETWEEN $1 AND $2`, [start, to]),
    q(`SELECT refund_id AS "refundId", source, source_id AS "sourceId", bill_no AS "billNo", on_date AS "onDate", patient_id AS "patientId",
              method, amount, date_uncertain AS "dateUncertain" FROM clinical.money_refund WHERE on_date BETWEEN $1 AND $2`, [start, to]),
    q(`SELECT transaction_id AS "transactionId", account_id AS "accountId", txn_date AS "date", amount, debit_or_credit AS "debitOrCredit",
              description, zoho_status AS "zohoStatus", missing_since IS NOT NULL AS missing
         FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3))`, [start, end, accounts]),
    reconSettings(),
    zohoStatus(),
  ]);
  // approved adjustments, and approved ones reversed since (their reversal is approved too, so the pair nets to nothing)
  const effects = await q<Effect>(
    `SELECT ${EFFECT_COLS} FROM app.recon_adjustment_effects e JOIN app.recon_adjustments a ON a.id = e.adjustment_id
      WHERE a.status IN ('approved','reversed') AND (e.on_date BETWEEN $1 AND $2 OR e.zoho_txn_id = ANY($3))
      ORDER BY e.adjustment_id, e.position`, [addDays(start, -10), addDays(end, 10), bank.map((b) => b.transactionId)]);
  return { from, to, today, lines, payments, refunds, bank, rules, effects, ...settings,
           zoho: { configured: zs.configured, fetchedAt: zs.fetchedAt, feedRefreshedOn: zs.feedRefreshedOn, stale: zs.stale } };
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
