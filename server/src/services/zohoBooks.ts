// Zoho Books REST, read only, nothing else (no database here). D-052: the reconciliation reads bank accounts, bank-feed
// lines and the bookkeeper's customer payments; D-054: the Books audit also reads invoices and expenses. Keys in .env (ZOHO_*; written by scripts/setup-zoho.ps1, never logged):
// a Self Client with READ scopes only. The only POST ever made is the OAuth token refresh; any other non-GET is refused
// before it leaves the server. Sudarshan sends Zoho dates and account ids, never patient data.

export interface ZohoRequest { method: "GET" | "POST"; url: string; headers: Record<string, string> }
export interface ZohoResponse { status: number; data: any }
export type ZohoTransport = (req: ZohoRequest) => Promise<ZohoResponse>;

const dc = () => (process.env.ZOHO_DC ?? "in").trim() || "in";
export const accountsBase = () => `https://accounts.zoho.${dc()}`;
export const booksBase = () => `https://www.zohoapis.${dc()}/books/v3`;
export const zohoOrgId = () => (process.env.ZOHO_ORG_ID ?? "").trim();
export const zohoAccountIds = () => (process.env.ZOHO_BANK_ACCOUNTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export function zohoConfigured(): boolean {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN && zohoOrgId());
}

const https: ZohoTransport = async ({ method, url, headers }) => {
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  return { status: res.status, data };
};
let transport: ZohoTransport = https;
/** Tests replace the Zoho call; nothing else should. */
export function setZohoTransport(t: ZohoTransport | null) { transport = t ?? https; accessToken = null; }

export class ZohoError extends Error {
  /** Zoho refused because the self-client lacks that READ scope (HTTP 401/403 on a read after a good sign-in). */
  constructor(message: string, readonly denied = false) { super(message); }
}

/** Read-only guard: the token refresh is the only request that is not a GET. */
export function allowed(req: ZohoRequest): boolean {
  if (req.method === "GET") return req.url.startsWith(booksBase() + "/");
  return req.url.startsWith(`${accountsBase()}/oauth/v2/token?`) && req.url.includes("grant_type=refresh_token");
}

async function send(req: ZohoRequest): Promise<ZohoResponse> {
  if (!allowed(req)) throw new ZohoError("Sudarshan only reads from Zoho: this request was stopped");
  try { return await transport(req); }
  catch (e: any) {
    throw new ZohoError(e?.name === "TimeoutError" ? "Zoho did not answer within 30 seconds" : "Could not reach Zoho (check the internet connection)");
  }
}

let accessToken: { value: string; until: number } | null = null;
async function token(): Promise<string> {
  if (accessToken && accessToken.until > Date.now() + 60_000) return accessToken.value;
  const qs = new URLSearchParams({ refresh_token: process.env.ZOHO_REFRESH_TOKEN ?? "", client_id: process.env.ZOHO_CLIENT_ID ?? "",
                                   client_secret: process.env.ZOHO_CLIENT_SECRET ?? "", grant_type: "refresh_token" });
  const r = await send({ method: "POST", url: `${accountsBase()}/oauth/v2/token?${qs}`, headers: {} });
  // Zoho's own error words only (they never repeat the secret); nothing from the request is passed on
  if (r.status !== 200 || !r.data?.access_token) throw new ZohoError(`Zoho refused the sign-in${r.data?.error ? ` (${String(r.data.error).slice(0, 60)})` : ""}: run scripts\\setup-zoho.ps1 again`);
  accessToken = { value: String(r.data.access_token), until: Date.now() + Number(r.data.expires_in ?? 3600) * 1000 };
  return accessToken.value;
}

async function get(path: string, params: Record<string, string | number>): Promise<any> {
  const qs = new URLSearchParams({ organization_id: zohoOrgId(), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const r = await send({ method: "GET", url: `${booksBase()}${path}?${qs}`, headers: { authorization: `Zoho-oauthtoken ${await token()}` } });
  if (r.status === 401) accessToken = null;
  if (r.status < 200 || r.status >= 300 || (r.data?.code != null && r.data.code !== 0))
    throw new ZohoError(`Zoho refused the read (HTTP ${r.status})${r.data?.message ? `: ${String(r.data.message).slice(0, 200)}` : ""}`,
                        r.status === 401 || r.status === 403 || r.data?.code === 57);
  return r.data;
}

/** Every page of a list (200 a page, at most 50 pages). */
async function all(path: string, listKey: string, params: Record<string, string | number>): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const d = await get(path, { ...params, page, per_page: 200 });
    out.push(...(Array.isArray(d?.[listKey]) ? d[listKey] : []));
    if (!d?.page_context?.has_more_page) return out;
  }
  throw new ZohoError("Zoho returned more than 10,000 lines for this period: choose a shorter period");
}

export interface ZBankAccount { accountId: string; name: string; type: string; feedRefreshedOn: string | null; balance: number | null }
export interface ZBankTxn { transactionId: string; accountId: string; date: string; amount: number;
                            debitOrCredit: "credit" | "debit";      // the bank statement's side: credit = money in
                            type: string | null;
                            status: string | null; description: string | null; reference: string | null; payee: string | null; raw: any }
export interface ZCustomerPayment { paymentId: string; date: string; mode: string | null; amount: number; accountId: string | null; accountName: string | null;
                                    description: string | null; reference: string | null; invoiceNumbers: string | null; raw: any }

const dateOrNull = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const str = (s: unknown) => (s == null || s === "" ? null : String(s));

export async function listBankAccounts(): Promise<ZBankAccount[]> {
  const rows = await all("/bankaccounts", "bankaccounts", { filter_by: "Status.Active" });
  return rows.map((a) => ({ accountId: String(a.account_id), name: String(a.account_name ?? ""), type: String(a.account_type ?? ""),
                            feedRefreshedOn: dateOrNull(a.feeds_last_refresh_date), balance: a.bank_balance == null ? null : Number(a.bank_balance) }));
}

/** Pages of a bank account's lines, newest first, until a page is wholly before `from`. Zoho ignores date filters on
 *  this list (checked 28 Oct 2026: date_start, date.start and from_date all return the whole history). */
async function bankPages(accountId: string, filter: string, from: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const d = await get("/banktransactions", { account_id: accountId, filter_by: filter, sort_column: "date", sort_order: "D", page, per_page: 200 });
    const rows: any[] = Array.isArray(d?.banktransactions) ? d.banktransactions : [];
    out.push(...rows);
    if (!d?.page_context?.has_more_page || rows.every((t) => (dateOrNull(t.date) ?? "") < from)) return out;
  }
  throw new ZohoError("Zoho returned more than 10,000 bank lines: choose a shorter period");
}

/** A bank account's lines dated from..to: categorised ones (Status.All leaves out the feed lines the bookkeeper has not
 *  categorised yet) and uncategorised ones. Zoho's debit_or_credit is the ledger's side (money in DEBITS the bank
 *  account); Sudarshan keeps the statement's side, so money in is "credit". */
export async function listBankTransactions(accountId: string, from: string, to: string): Promise<ZBankTxn[]> {
  const rows = [...await bankPages(accountId, "Status.All", from), ...await bankPages(accountId, "Status.Uncategorized", from)];
  const seen = new Set<string>();
  const out: ZBankTxn[] = [];
  for (const t of rows) {
    const date = dateOrNull(t.date);
    const id = String(t.transaction_id ?? t.imported_transaction_id);
    if (!date || date < from || date > to || seen.has(id)) continue;
    seen.add(id);
    const moneyIn = String(t.debit_or_credit ?? "").toLowerCase() === "debit";
    out.push({ transactionId: id, accountId: String(t.account_id ?? accountId), date, amount: Math.abs(Number(t.amount ?? 0)),
               debitOrCredit: moneyIn ? "credit" : "debit", type: str(t.transaction_type), status: str(t.status),
               description: str(t.description ?? t.payee), reference: str(t.reference_number), payee: str(t.payee), raw: t });
  }
  return out;
}

// ---------- the Books audit (D-054): ZohoBooks.invoices.READ and ZohoBooks.expenses.READ ----------
export interface ZInvoice { invoiceId: string; number: string | null; date: string; customer: string | null; status: string | null; total: number;
                            balance: number; createdTime: string | null; raw: any }
export interface ZExpense { expenseId: string; date: string; account: string | null; paidThrough: string | null; description: string | null;
                            reference: string | null; vendor: string | null; total: number; hasAttachment: boolean; createdTime: string | null; raw: any }
const timeOrNull = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) ? s : null);

export async function listInvoices(from: string, to: string): Promise<ZInvoice[]> {
  const rows = await all("/invoices", "invoices", { date_start: from, date_end: to, sort_column: "date" });
  return rows.filter((i) => dateOrNull(i.date)).map((i) => ({
    invoiceId: String(i.invoice_id), number: str(i.invoice_number), date: dateOrNull(i.date)!, customer: str(i.customer_name), status: str(i.status),
    total: Number(i.total ?? 0), balance: Number(i.balance ?? 0), createdTime: timeOrNull(i.created_time), raw: i }));
}

export async function listExpenses(from: string, to: string): Promise<ZExpense[]> {
  const rows = await all("/expenses", "expenses", { date_start: from, date_end: to, sort_column: "date" });
  return rows.filter((e) => dateOrNull(e.date)).map((e) => ({
    expenseId: String(e.expense_id), date: dateOrNull(e.date)!, account: str(e.account_name), paidThrough: str(e.paid_through_account_name),
    description: str(e.description), reference: str(e.reference_number), vendor: str(e.vendor_name), total: Number(e.total ?? 0),
    hasAttachment: e.has_attachment === true || !!str(e.expense_receipt_name), createdTime: timeOrNull(e.created_time), raw: e }));
}

export async function listCustomerPayments(from: string, to: string): Promise<ZCustomerPayment[]> {
  const rows = await all("/customerpayments", "customerpayments", { date_start: from, date_end: to });
  return rows.filter((p) => dateOrNull(p.date)).map((p) => ({
    paymentId: String(p.payment_id), date: dateOrNull(p.date)!, mode: str(p.payment_mode), amount: Number(p.amount ?? 0),
    accountId: str(p.account_id), accountName: str(p.account_name), description: str(p.description), reference: str(p.reference_number),
    invoiceNumbers: str(p.invoice_numbers), raw: p }));
}
