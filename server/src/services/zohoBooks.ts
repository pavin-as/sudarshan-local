// Zoho Books REST, read only, nothing else (no database here). D-052: the reconciliation reads bank accounts, bank-feed
// lines and the bookkeeper's customer payments. Keys in .env (ZOHO_*; written by scripts/setup-zoho.ps1, never logged):
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

export class ZohoError extends Error {}

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
    throw new ZohoError(`Zoho refused the read (HTTP ${r.status})${r.data?.message ? `: ${String(r.data.message).slice(0, 200)}` : ""}`);
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
export interface ZBankTxn { transactionId: string; accountId: string; date: string; amount: number; debitOrCredit: "credit" | "debit"; type: string | null;
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

export async function listBankTransactions(accountId: string, from: string, to: string): Promise<ZBankTxn[]> {
  const rows = await all("/banktransactions", "banktransactions", { account_id: accountId, date_start: from, date_end: to, filter_by: "Status.All" });
  return rows.filter((t) => dateOrNull(t.date)).map((t) => {
    const dc = String(t.debit_or_credit ?? "").toLowerCase();
    return { transactionId: String(t.transaction_id ?? t.imported_transaction_id), accountId: String(t.account_id ?? accountId), date: dateOrNull(t.date)!,
             amount: Math.abs(Number(t.amount ?? 0)), debitOrCredit: dc === "debit" ? "debit" : "credit", type: str(t.transaction_type), status: str(t.status),
             description: str(t.description ?? t.payee), reference: str(t.reference_number), payee: str(t.payee), raw: t };
  });
}

export async function listCustomerPayments(from: string, to: string): Promise<ZCustomerPayment[]> {
  const rows = await all("/customerpayments", "customerpayments", { date_start: from, date_end: to });
  return rows.filter((p) => dateOrNull(p.date)).map((p) => ({
    paymentId: String(p.payment_id), date: dateOrNull(p.date)!, mode: str(p.payment_mode), amount: Number(p.amount ?? 0),
    accountId: str(p.account_id), accountName: str(p.account_name), description: str(p.description), reference: str(p.reference_number),
    invoiceNumbers: str(p.invoice_numbers), raw: p }));
}
