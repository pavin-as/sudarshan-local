// Bank fees (D-053): what the bank may keep from card and UPI money, from the rates in app.bank_fee_rates. Pure: no
// database, no clock. HDFC settles card money net of its commission (Zoho, Sep-Oct 2026: 0-2.6% a day) and UPI money
// almost always whole, so the reconciliation accepts a settlement below the day's money by up to the dearest possible
// fee and reports what was kept. Yarago does not record whether a card was debit, credit or RuPay, so every figure is
// a range: low (every payment on the cheapest kind), high (every payment on the dearest usual kind), and a ceiling
// (dearest of all, international cards) beyond which a short settlement is a difference, not a fee.
// One Yarago payment row (a bill's card or UPI amount) is taken as one payment; a bill paid with two swipes is an
// approximation, which is why the range is shown and only the ceiling decides.

export type FeeMethod = "card" | "upi";
export type FeeKind = "debit" | "rupay_debit" | "credit" | "international" | "upi" | "upi_rupay_credit";
export const FEE_KIND_WORDS: Record<FeeKind, string> = {
  rupay_debit: "RuPay debit card", debit: "Debit card", credit: "Credit card", international: "Business, commercial or foreign card",
  upi: "UPI", upi_rupay_credit: "UPI on a RuPay credit card",
};
const USUAL: Record<FeeMethod, FeeKind[]> = { card: ["rupay_debit", "debit", "credit"], upi: ["upi", "upi_rupay_credit"] };
const ALL_KINDS: Record<FeeMethod, FeeKind[]> = { card: [...USUAL.card, "international"], upi: USUAL.upi };

export interface FeeRate { id?: number; effectiveFrom: string; method: FeeMethod; kind: FeeKind; amountAbove: number; amountUpto: number | null;
                           ratePct: number; capRupees: number | null; flatRupees: number | null; note?: string | null }
export interface FeeFixed { gstPct: number; servicePerMonth: number; perBatch: number; lateSettleDays: number }
export interface FeeBand { low: number; high: number; ceiling: number; payments: number }   // rupees, GST included

const P = (r: number) => Math.round(Number(r) * 100);
const R = (p: number) => p / 100;

/** The rate rows in force on a day: the set with the latest effective_from on or before it. */
export function ratesOn(rates: FeeRate[], date: string): FeeRate[] {
  const from = rates.map((r) => r.effectiveFrom).filter((d) => d <= date).sort().pop();
  return from ? rates.filter((r) => r.effectiveFrom === from) : [];
}

/** Fee in paise, before GST, on one payment as a kind; null when no row covers that kind and amount. */
export function feeOn(amount: number, method: FeeMethod, kind: FeeKind, set: FeeRate[]): number | null {
  const a = P(amount);
  const row = set.find((r) => r.method === method && r.kind === kind && a > P(r.amountAbove) && (r.amountUpto == null || a <= P(r.amountUpto)));
  if (!row) return null;
  if (row.flatRupees != null) return P(row.flatRupees);
  const fee = Math.round(a * Number(row.ratePct) / 100);
  return row.capRupees != null ? Math.min(fee, P(row.capRupees)) : fee;
}

/** The fee range for one payment, GST included, in paise. */
export function paymentBand(amount: number, method: FeeMethod, date: string, rates: FeeRate[], gstPct: number) {
  const set = ratesOn(rates, date);
  const gst = (p: number) => Math.round(p * (1 + gstPct / 100));
  const fees = (kinds: FeeKind[]) => kinds.map((k) => feeOn(amount, method, k, set)).filter((x): x is number => x != null);
  const usual = fees(USUAL[method]), all = fees(ALL_KINDS[method]);
  return { low: gst(usual.length ? Math.min(...usual) : 0), high: gst(usual.length ? Math.max(...usual) : 0), ceiling: gst(all.length ? Math.max(...all) : 0) };
}

/** Fee ranges per day and method ("YYYY-MM-DD|card") for the card and UPI payments given, in rupees. */
export function dayBands(payments: { onDate: string; method: string; amount: number }[], rates: FeeRate[], gstPct: number): Record<string, FeeBand> {
  const acc: Record<string, { low: number; high: number; ceiling: number; payments: number }> = {};
  for (const p of payments) {
    if ((p.method !== "card" && p.method !== "upi") || !(Number(p.amount) > 0)) continue;
    const b = paymentBand(Number(p.amount), p.method, p.onDate, rates, gstPct);
    const k = `${p.onDate}|${p.method}`;
    const a = acc[k] ??= { low: 0, high: 0, ceiling: 0, payments: 0 };
    a.low += b.low; a.high += b.high; a.ceiling += b.ceiling; a.payments++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { low: R(a.low), high: R(a.high), ceiling: R(a.ceiling), payments: a.payments }]));
}

// ---------- the fees section of the reconciliation --------------------------------------------
export interface FeeDayIn { date: string; method: string; expected: number; deposited: number; bankFee: number; status: string; band: FeeBand | null; matched: boolean }
export interface ChargeLine { transactionId: string; date: string; amount: number; description: string | null }
export type FeeDayState = "normal" | "high" | "none" | "not_settled" | "waiting";
export interface FeeDay { date: string; method: FeeMethod; sales: number; settled: number | null; fee: number | null; pct: number | null;
                          low: number; high: number; state: FeeDayState; words: string }
export interface FeeMonth { month: string; method: FeeMethod; sales: number; salesSettled: number; feesKept: number; pct: number | null;
                            low: number; high: number; highDays: number }
export interface FeeReport {
  days: FeeDay[]; months: FeeMonth[];
  charges: ChargeLine[];                                    // money out the bank rules call bank charges (terminal service charge)
  totals: { cardSales: number; upiSales: number; cardSettled: number; upiSettled: number; cardFees: number; upiFees: number; charges: number;
            cardPct: number | null; upiPct: number | null };
  late: { date: string; sales: number; words: string }[];   // card days with no settlement after lateSettleDays
  upiFeesSeen: boolean;
  fixed: FeeFixed;
}

const pct = (fee: number, sales: number) => (sales > 0 ? Math.round((fee / sales) * 10000) / 100 : null);
const money = (r: number) => `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
const addDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

export function feeReport(rows: FeeDayIn[], charges: ChargeLine[], fixed: FeeFixed, bankKnownUntil: string | null): FeeReport {
  const days: FeeDay[] = [];
  for (const r of rows) {
    if ((r.method !== "card" && r.method !== "upi") || !(r.expected > 0)) continue;
    const b = r.band ?? { low: 0, high: 0, ceiling: 0, payments: 0 };
    const settled = r.matched ? r.deposited : null;
    const fee = r.matched ? Math.max(0, r.bankFee) : null;
    const state: FeeDayState = r.matched ? (r.status === "fee_high" ? "high" : fee! > 0 ? "normal" : "none")
      : r.status === "awaiting" || r.status === "no_bank_data" ? "waiting" : "not_settled";
    const words = state === "high" ? `${money(fee!)} kept: more than the ${money(b.high)} expected at the highest usual rate`
      : state === "normal" ? `${money(fee!)} kept (${money(b.low)}–${money(b.high)} expected)`
      : state === "none" ? "Settled in full" : state === "waiting" ? "Not settled yet" : "No settlement matched";
    days.push({ date: r.date, method: r.method, sales: r.expected, settled, fee, pct: fee != null ? pct(fee, r.expected) : null, low: b.low, high: b.high, state, words });
  }
  days.sort((a, b) => a.date.localeCompare(b.date) || a.method.localeCompare(b.method));

  const months = new Map<string, FeeMonth>();
  for (const d of days) {
    const k = `${d.date.slice(0, 7)}|${d.method}`;
    const m = months.get(k) ?? { month: d.date.slice(0, 7), method: d.method, sales: 0, salesSettled: 0, feesKept: 0, pct: null, low: 0, high: 0, highDays: 0 };
    m.sales = R(P(m.sales) + P(d.sales));
    if (d.fee != null) { m.salesSettled = R(P(m.salesSettled) + P(d.sales)); m.feesKept = R(P(m.feesKept) + P(d.fee)); m.low = R(P(m.low) + P(d.low)); m.high = R(P(m.high) + P(d.high)); }
    if (d.state === "high") m.highDays++;
    months.set(k, m);
  }
  for (const m of months.values()) m.pct = pct(m.feesKept, m.salesSettled);

  const sum = (xs: FeeDay[], f: (d: FeeDay) => number) => R(xs.reduce((s, d) => s + P(f(d)), 0));
  const card = days.filter((d) => d.method === "card"), upi = days.filter((d) => d.method === "upi");
  const cardSettled = card.filter((d) => d.fee != null), upiSettled = upi.filter((d) => d.fee != null);
  const cardFees = sum(cardSettled, (d) => d.fee!), upiFees = sum(upiSettled, (d) => d.fee!);
  const late = card.filter((d) => d.state === "not_settled" && bankKnownUntil != null && addDays(d.date, fixed.lateSettleDays) < bankKnownUntil)
    .map((d) => ({ date: d.date, sales: d.sales, words: `Card money of ${money(d.sales)} not settled within ${fixed.lateSettleDays} days: settle the terminal batch daily (HDFC charges 0.5% or ₹499 on late batches)` }));
  return {
    days, months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month) || a.method.localeCompare(b.method)),
    charges,
    totals: { cardSales: sum(card, (d) => d.sales), upiSales: sum(upi, (d) => d.sales),
              cardSettled: sum(cardSettled, (d) => d.sales), upiSettled: sum(upiSettled, (d) => d.sales), cardFees, upiFees, charges: R(charges.reduce((s, c) => s + P(c.amount), 0)),
              cardPct: pct(cardFees, sum(cardSettled, (d) => d.sales)), upiPct: pct(upiFees, sum(upiSettled, (d) => d.sales)) },
    late, upiFeesSeen: upiSettled.some((d) => (d.fee ?? 0) > 0), fixed,
  };
}
