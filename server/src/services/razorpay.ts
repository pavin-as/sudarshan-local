// Razorpay REST, nothing else (no database here). Payment links, their status, cancelling, refunds.
// Keys RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env (never logged). No webhook: Sudarshan asks Razorpay (D-017).
// Amounts: rupees in Sudarshan, paise at Razorpay.

export interface RzpResponse { status: number; data: any }
export type RzpTransport = (method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) => Promise<RzpResponse>;

/** 'test' / 'live' from the key id, null when no keys are set, 'unknown' for anything else. */
export function keyMode(): "test" | "live" | "unknown" | null {
  const id = process.env.RAZORPAY_KEY_ID ?? "";
  if (!id || !process.env.RAZORPAY_KEY_SECRET) return null;
  return id.startsWith("rzp_test_") ? "test" : id.startsWith("rzp_live_") ? "live" : "unknown";
}

const https: RzpTransport = async (method, path, body, headers = {}) => {
  const id = process.env.RAZORPAY_KEY_ID ?? "", secret = process.env.RAZORPAY_KEY_SECRET ?? "";
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
};
let transport: RzpTransport = https;
/** Tests replace the Razorpay call; nothing else should. */
export function setRazorpayTransport(t: RzpTransport | null) { transport = t ?? https; }

export class RazorpayError extends Error {}

async function call(method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) {
  let r: RzpResponse;
  try { r = await transport(method, path, body, headers); }
  catch (e: any) {
    throw new RazorpayError(e?.name === "TimeoutError" ? "Razorpay did not answer within 20 seconds" : `Could not reach Razorpay: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (r.status >= 200 && r.status < 300) return r.data;
  const why = r.data?.error?.description ?? r.data?.error?.reason ?? r.data?.raw ?? "";
  throw new RazorpayError(`Razorpay refused it (HTTP ${r.status})${why ? `: ${String(why).slice(0, 300)}` : ""}`);
}

export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const toRupees = (paise: number) => Math.round(paise) / 100;

export interface LinkRequest { amount: number; reference: string; description: string; name: string; phone: string; expiresAt: Date; notes: Record<string, string> }
export interface Link { id: string; url: string; status: string; amountPaid: number; paymentId: string | null; paidAt: Date | null }

function link(d: any): Link {
  const paid = (Array.isArray(d.payments) ? d.payments : []).filter((p: any) => ["captured", "authorized"].includes(String(p.status)));
  return { id: String(d.id), url: String(d.short_url ?? ""), status: String(d.status ?? ""), amountPaid: toRupees(Number(d.amount_paid ?? 0)),
           paymentId: paid[0]?.payment_id ? String(paid[0].payment_id) : null,
           paidAt: paid[0]?.created_at ? new Date(Number(paid[0].created_at) * 1000) : null };
}

export async function createLink(r: LinkRequest): Promise<Link> {
  return link(await call("POST", "/payment_links", {
    amount: toPaise(r.amount), currency: "INR", accept_partial: false, reference_id: r.reference, description: r.description,
    customer: { name: r.name, contact: `+${r.phone}` },
    notify: { sms: false, email: false }, reminder_enable: false,      // the clinic sends the link itself (WhatsApp)
    expire_by: Math.floor(r.expiresAt.getTime() / 1000), notes: r.notes,
  }));
}
export async function fetchLink(id: string): Promise<Link> { return link(await call("GET", `/payment_links/${encodeURIComponent(id)}`)); }
export async function cancelLink(id: string): Promise<Link> { return link(await call("POST", `/payment_links/${encodeURIComponent(id)}/cancel`)); }

export interface Refund { id: string; status: "pending" | "processed" | "failed" | string; amount: number }
const refund = (d: any): Refund => ({ id: String(d.id), status: String(d.status ?? "pending"), amount: toRupees(Number(d.amount ?? 0)) });

/** The idempotency key goes in the header and as the receipt, so the same request can never refund twice. */
export async function createRefund(paymentId: string, amount: number, key: string, notes: Record<string, string>): Promise<Refund> {
  return refund(await call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`,
                           { amount: toPaise(amount), speed: "normal", receipt: key, notes }, { "X-Razorpay-Idempotency-Key": key }));
}
export async function fetchRefund(paymentId: string, refundId: string): Promise<Refund> {
  return refund(await call("GET", `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`));
}
