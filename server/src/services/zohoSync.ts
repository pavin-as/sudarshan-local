// Copies Zoho bank lines and customer payments into app.zoho_* (D-052). A changed line keeps its previous version; a line
// Zoho no longer lists for a fetched range is marked missing, never deleted. Every two hours 08:00-22:00 (startZohoJobs,
// started by index.ts, never by tests) and on demand from the Reconciliation page. One fetch at a time.
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { one, q, withTx } from "../db.js";
import { addDays, todayIST } from "../lib/time.js";
import { listBankAccounts, listBankTransactions, listCustomerPayments, zohoAccountIds, zohoConfigured, ZohoError, type ZBankTxn } from "./zohoBooks.js";

const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
export const rawHash = (raw: unknown) => createHash("sha256").update(JSON.stringify(sorted(raw))).digest("hex");

let running = false;
export const zohoFetchRunning = () => running;

export interface FetchResult { runId: number; status: "ok" | "failed"; counts: Record<string, number>; message: string | null }

/** Fetch [from, to] for the configured bank accounts (all active bank accounts when none are named). */
export async function fetchZoho(from: string, to: string, requestedBy: number | null): Promise<FetchResult> {
  if (!zohoConfigured()) throw new ZohoError("Zoho is not connected yet: an administrator runs scripts\\setup-zoho.ps1 first");
  if (running) throw new ZohoError("A Zoho fetch is already running: try again in a minute");
  running = true;
  const source = requestedBy == null ? "job" : "web";
  const run = await withTx({ userId: requestedBy, source, summary: `Zoho fetch started for ${from} to ${to}` }, async (c) =>
    (await c.query(`INSERT INTO app.zoho_fetch_runs (date_from, date_to, requested_by) VALUES ($1, $2, $3) RETURNING id`, [from, to, requestedBy])).rows[0].id as number);
  const counts: Record<string, number> = { accounts: 0, lines: 0, new: 0, changed: 0, missing: 0, payments: 0 };
  try {
    const accounts = (await listBankAccounts()).filter((a) => a.type === "bank");
    const wanted = zohoAccountIds();
    const chosen = wanted.length ? accounts.filter((a) => wanted.includes(a.accountId)) : accounts;
    if (wanted.length && chosen.length < wanted.length) throw new ZohoError("A bank account named in ZOHO_BANK_ACCOUNTS is not in Zoho: run setup-zoho.ps1 again");
    const lines: ZBankTxn[] = [];
    for (const a of chosen) lines.push(...(await listBankTransactions(a.accountId, from, to)));
    const payments = await listCustomerPayments(from, to);

    await withTx({ userId: requestedBy, source, summary: `Zoho copy updated for ${from} to ${to}` }, async (c) => {
      for (const a of chosen) {
        await c.query(`INSERT INTO app.zoho_bank_accounts (account_id, account_name, account_type, feed_refreshed_on, balance, fetched_at)
                       VALUES ($1,$2,$3,$4,$5, now()) ON CONFLICT (account_id) DO UPDATE SET account_name = EXCLUDED.account_name,
                       account_type = EXCLUDED.account_type, feed_refreshed_on = EXCLUDED.feed_refreshed_on, balance = EXCLUDED.balance, fetched_at = now()`,
                      [a.accountId, a.name, a.type, a.feedRefreshedOn, a.balance]);
        counts.accounts++;
      }
      const seen = new Set<string>();
      for (const t of lines) {
        seen.add(t.transactionId);
        const h = rawHash(t.raw);
        const cur = (await c.query(`SELECT raw, raw_hash FROM app.zoho_bank_txns WHERE transaction_id = $1`, [t.transactionId])).rows[0];
        if (cur && cur.raw_hash !== h) {
          await c.query(`INSERT INTO app.zoho_bank_txn_versions (transaction_id, raw, raw_hash) VALUES ($1, $2, $3)`, [t.transactionId, cur.raw, cur.raw_hash]);
          counts.changed++;
        }
        if (!cur) counts.new++;
        await c.query(`INSERT INTO app.zoho_bank_txns (transaction_id, account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status,
                         description, reference_number, payee, raw, raw_hash)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                       ON CONFLICT (transaction_id) DO UPDATE SET account_id = EXCLUDED.account_id, txn_date = EXCLUDED.txn_date, amount = EXCLUDED.amount,
                         debit_or_credit = EXCLUDED.debit_or_credit, transaction_type = EXCLUDED.transaction_type, zoho_status = EXCLUDED.zoho_status,
                         description = EXCLUDED.description, reference_number = EXCLUDED.reference_number, payee = EXCLUDED.payee,
                         raw = EXCLUDED.raw, raw_hash = EXCLUDED.raw_hash, last_seen_at = now(), missing_since = NULL`,
                      [t.transactionId, t.accountId, t.date, t.amount, t.debitOrCredit, t.type, t.status, t.description, t.reference, t.payee, t.raw, h]);
        counts.lines++;
      }
      const gone = await c.query(`UPDATE app.zoho_bank_txns SET missing_since = now()
                                   WHERE account_id = ANY($1) AND txn_date BETWEEN $2 AND $3 AND missing_since IS NULL AND NOT (transaction_id = ANY($4))`,
                                 [chosen.map((a) => a.accountId), from, to, [...seen]]);
      counts.missing = gone.rowCount ?? 0;
      for (const p of payments) {
        await c.query(`INSERT INTO app.zoho_customer_payments (payment_id, pay_date, payment_mode, amount, account_id, account_name, description,
                         reference_number, invoice_numbers, raw, raw_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                       ON CONFLICT (payment_id) DO UPDATE SET pay_date = EXCLUDED.pay_date, payment_mode = EXCLUDED.payment_mode, amount = EXCLUDED.amount,
                         account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name, description = EXCLUDED.description,
                         reference_number = EXCLUDED.reference_number, invoice_numbers = EXCLUDED.invoice_numbers, raw = EXCLUDED.raw,
                         raw_hash = EXCLUDED.raw_hash, last_seen_at = now()`,
                      [p.paymentId, p.date, p.mode, p.amount, p.accountId, p.accountName, p.description, p.reference, p.invoiceNumbers, p.raw, rawHash(p.raw)]);
        counts.payments++;
      }
      await c.query(`UPDATE app.zoho_fetch_runs SET finished_at = now(), status = 'ok', counts = $2 WHERE id = $1`, [run, counts]);
    });
    return { runId: run, status: "ok", counts, message: null };
  } catch (e: any) {
    const message = e instanceof ZohoError ? e.message : "The Zoho copy could not be saved";
    await withTx({ userId: requestedBy, source, summary: `Zoho fetch failed for ${from} to ${to}` }, (c) =>
      c.query(`UPDATE app.zoho_fetch_runs SET finished_at = now(), status = 'failed', counts = $2, message = $3 WHERE id = $1`, [run, counts, message]));
    if (e instanceof ZohoError) return { runId: run, status: "failed", counts, message };
    throw e;
  } finally {
    running = false;
  }
}

export interface ZohoStatus { configured: boolean; fetchedAt: string | null; feedRefreshedOn: string | null; stale: boolean; staleHours: number;
                              running: boolean; lastRun: { status: string; startedAt: string; message: string | null } | null }
export async function zohoStatus(): Promise<ZohoStatus> {
  const staleHours = Number((await one<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = 'recon.stale_hours'`))?.value ?? 24) || 24;
  const ok = await one<{ finished_at: string }>(`SELECT finished_at::text FROM app.zoho_fetch_runs WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
  const last = await one<any>(`SELECT status, started_at::text AS "startedAt", message FROM app.zoho_fetch_runs ORDER BY started_at DESC LIMIT 1`);
  const wanted = zohoAccountIds();
  const feed = await one<{ d: string | null }>(`SELECT min(feed_refreshed_on)::text AS d FROM app.zoho_bank_accounts WHERE cardinality($1::text[]) = 0 OR account_id = ANY($1)`, [wanted]);
  // Zoho can say the feed was refreshed today while its lines stop days earlier (28 Oct 2026: refreshed 28 Oct, lines to
  // 21 Oct): bank data is known only up to the earlier of the two
  const lines = await one<{ d: string | null }>(`SELECT max(txn_date)::text AS d FROM app.zoho_bank_txns WHERE missing_since IS NULL AND (cardinality($1::text[]) = 0 OR account_id = ANY($1))`, [wanted]);
  const fetchedAt = ok?.finished_at ?? null;
  const stale = fetchedAt ? Date.now() - Date.parse(fetchedAt) > staleHours * 3600_000 : false;
  const known = [feed?.d, lines?.d].filter((d): d is string => !!d).sort()[0] ?? null;
  return { configured: zohoConfigured(), fetchedAt, feedRefreshedOn: known, stale, staleHours, running, lastRun: last ?? null };
}

/** Every 10 minutes: fetch the last 45 days when the copy is over 2 hours old, 08:00-22:00 only. */
export function startZohoJobs(log: FastifyBaseLogger): NodeJS.Timeout[] {
  const tick = async () => {
    if (!zohoConfigured() || running) return;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date()));
    if (hour < 8 || hour >= 22) return;
    const last = await one<{ started_at: string }>(`SELECT started_at::text FROM app.zoho_fetch_runs ORDER BY started_at DESC LIMIT 1`);
    if (last && Date.now() - Date.parse(last.started_at) < 2 * 3600_000) return;
    const today = todayIST();
    const r = await fetchZoho(addDays(today, -45), today, null);
    if (r.status === "failed") log.warn({ run: r.runId }, `Zoho fetch failed: ${r.message}`);
  };
  return [setInterval(() => { tick().catch((e) => log.error({ err: String(e?.message ?? e) }, "Zoho job failed")); }, 10 * 60_000)];
}

export async function zohoRuns(limit = 10) {
  return q(`SELECT id, started_at::text AS "startedAt", finished_at::text AS "finishedAt", status, date_from AS "from", date_to AS "to", counts, message
              FROM app.zoho_fetch_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
}
