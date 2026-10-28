// Database side of the Books audit (D-054): builds booksAudit()'s input from the Zoho copies (app.zoho_*), the bank rules
// and Yarago's collections (clinical.money_payment / money_refund); saves the day's score for the weekly trend. The
// snapshot is the only write, and it goes through withTx.
import { one, q, withTx } from "../db.js";
import { addDays, isoWeekday, todayIST } from "../lib/time.js";
import { booksAudit, DEFAULT_AUDIT, type AuditBankLine, type AuditResult, type AuditSettings } from "./booksAudit.js";
import { loadRules } from "./reconData.js";
import { zohoAccountIds } from "./zohoBooks.js";

const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export async function auditSettings(): Promise<AuditSettings> {
  const v = (await one<{ value: any }>(`SELECT value FROM app.settings WHERE key = 'books.audit'`))?.value ?? {};
  const n = (x: unknown, d: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : d);
  return {
    from: isDate(v.from) ? v.from : DEFAULT_AUDIT.from, qualityFrom: isDate(v.qualityFrom) ? v.qualityFrom : DEFAULT_AUDIT.qualityFrom,
    dueDays: n(v.dueDays, DEFAULT_AUDIT.dueDays), bankBehindDays: n(v.bankBehindDays, DEFAULT_AUDIT.bankBehindDays),
    invoiceTolerance: n(v.invoiceTolerance, DEFAULT_AUDIT.invoiceTolerance), receiptAbove: n(v.receiptAbove, DEFAULT_AUDIT.receiptAbove),
    vendorAbove: n(v.vendorAbove, DEFAULT_AUDIT.vendorAbove),
    patientsCustomer: typeof v.patientsCustomer === "string" && v.patientsCustomer.trim() ? v.patientsCustomer.trim() : DEFAULT_AUDIT.patientsCustomer,
    vagueAccounts: Array.isArray(v.vagueAccounts) ? v.vagueAccounts.filter((a: unknown) => typeof a === "string") : DEFAULT_AUDIT.vagueAccounts,
  };
}

/** Whether the last good fetch could read that part of Zoho (-1 or absent: the self-client lacks the scope). */
async function readable(part: "invoices" | "expenses"): Promise<boolean> {
  const r = await one<{ n: string | null }>(`SELECT counts->>$1 AS n FROM app.zoho_fetch_runs WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1`, [part]);
  return r?.n != null && Number(r.n) >= 0;
}

export async function loadAudit(today = todayIST()): Promise<AuditResult & { lastFetch: string | null; readable: { invoices: boolean; expenses: boolean } }> {
  const settings = await auditSettings();
  const from = settings.from < settings.qualityFrom ? settings.from : settings.qualityFrom;
  const [rules, bank, pay, ref, canInv, canExp, last] = await Promise.all([
    loadRules(),
    q<AuditBankLine>(`SELECT transaction_id AS "transactionId", account_id AS "accountId", txn_date AS "date", amount::float AS amount, debit_or_credit AS "debitOrCredit",
                             description, zoho_status AS "zohoStatus", missing_since IS NOT NULL AS missing, transaction_type AS type,
                             nullif(raw->>'offset_account_name', '') AS "offsetAccount"
                        FROM app.zoho_bank_txns WHERE txn_date BETWEEN $1 AND $2 AND (cardinality($3::text[]) = 0 OR account_id = ANY($3))`,
                     [settings.from, today, zohoAccountIds()]),
    q<{ d: string; a: number; uc: number }>(`SELECT on_date AS d, sum(amount)::float AS a, coalesce(sum(amount) FILTER (WHERE method IN ('upi','card')), 0)::float AS uc
                                               FROM clinical.money_payment WHERE on_date BETWEEN $1 AND $2 GROUP BY 1`, [settings.from, today]),
    q<{ d: string; a: number }>(`SELECT on_date AS d, sum(amount)::float AS a FROM clinical.money_refund WHERE on_date BETWEEN $1 AND $2 GROUP BY 1`, [settings.from, today]),
    readable("invoices"), readable("expenses"),
    one<{ at: string }>(`SELECT finished_at::text AS at FROM app.zoho_fetch_runs WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1`),
  ]);
  const refunds = new Map(ref.map((r) => [r.d, Number(r.a)]));
  const clinicDays = pay.map((p) => ({ date: p.d, collected: Math.round((Number(p.a) - (refunds.get(p.d) ?? 0)) * 100) / 100, upiCard: Number(p.uc) }));
  const invoices = canInv ? (await q<any>(`SELECT invoice_id AS id, invoice_number AS number, inv_date AS date, customer_name AS customer, status, total::float AS total,
                                                  balance::float AS balance, (created_time AT TIME ZONE 'Asia/Kolkata')::date::text AS "createdOn"
                                             FROM app.zoho_invoices WHERE missing_since IS NULL AND inv_date BETWEEN $1 AND $2`, [from, today])) : null;
  const expenses = canExp ? (await q<any>(`SELECT expense_id AS id, exp_date AS date, account_name AS account, paid_through AS "paidThrough", description,
                                                  vendor_name AS vendor, total::float AS total, has_attachment AS "hasAttachment"
                                             FROM app.zoho_expenses WHERE missing_since IS NULL AND exp_date BETWEEN $1 AND $2`, [from, today])) : null;
  const result = booksAudit({ today, settings, rules, bank, clinicDays, invoices, expenses });
  return { ...result, lastFetch: last?.at ?? null, readable: { invoices: canInv, expenses: canExp } };
}

/** Save the day's score (after each Zoho fetch; the day's last one wins). */
export async function saveAuditSnapshot(today = todayIST()): Promise<void> {
  const r = await loadAudit(today);
  if (r.score == null) return;
  const checks = r.checks.map((c) => ({ key: c.key, level: c.level, due: c.due, amount: c.amount }));
  await withTx({ userId: null, source: "job", summary: `Books audit score for ${today}: ${r.score}` }, (c) =>
    c.query(`INSERT INTO app.books_audit_snapshots (on_date, score, checks) VALUES ($1, $2, $3)
             ON CONFLICT (on_date) DO UPDATE SET score = EXCLUDED.score, checks = EXCLUDED.checks, saved_at = now()`, [today, r.score, JSON.stringify(checks)]));
}

/** The score each week (Saturday to Friday, the sheet's week): the last snapshot of the week, the latest 12 weeks. */
export async function auditTrend(): Promise<{ weekEnding: string; onDate: string; score: number; checks: { key: string; level: string; due: number; amount: number }[] }[]> {
  const rows = await q<{ on_date: string; score: number; checks: any }>(`SELECT on_date::text, score, checks FROM app.books_audit_snapshots ORDER BY on_date DESC LIMIT 120`);
  const weeks = new Map<string, { weekEnding: string; onDate: string; score: number; checks: any }>();
  for (const r of rows) {
    const friday = addDays(r.on_date, (5 - isoWeekday(r.on_date) + 7) % 7);
    if (!weeks.has(friday)) weeks.set(friday, { weekEnding: friday, onDate: r.on_date, score: r.score, checks: r.checks });
  }
  return [...weeks.values()].slice(0, 12).reverse();
}
