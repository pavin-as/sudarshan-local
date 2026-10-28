// Day collection (D-057): one day's money as Yarago recorded it, at a glance and in detail. No bank, no matching: that is
// the reconciliation's job (services/reconcile.ts); this is what was taken, how, for what and when.
// Pure: no database, no clock, so it is tested in test/recon.unit.test.ts. The SQL is in services/collectionsData.ts.
// Amounts are worked in paise and returned in rupees, as in reconcile.ts.
import { categoryOf, METHODS, sourceOf, type Category, type Method, type MoneySource, type PaymentRow, type RefundRow, type RevenueLine,
         type SourceSplit } from "./reconcile.js";

export interface Who { mrd: string | null; name: string | null }
/** a payment with its time ("YYYY-MM-DDTHH:MM", Yarago's clock) and the bill or pharmacy order it belongs to */
export interface DayPayment extends PaymentRow, Who { at: string | null; billKey: string | null }
export interface DayRefund extends RefundRow, Who { at: string | null; reason: string | null }
export interface DayLine extends RevenueLine, Who {}
/** a clinic bill of the day: what was billed, given off and left due */
export interface DayBill extends Who { billKey: string; billNo: string | null; patientId: number | null; at: string | null; total: number; discount: number; due: number }

export interface DayInput {
  date: string;
  lines: DayLine[]; payments: DayPayment[]; refunds: DayRefund[]; bills: DayBill[];
  categoryMap: Record<string, Category>;
  lastWeek?: { date: string; collected: number; byThisTime: boolean };   // the same weekday a week before, for comparison
}

export interface DaySummary {
  date: string;
  totals: { collected: number; collectedBy: SourceSplit; refunds: number; refundsBy: SourceSplit; net: number;
            billed: number; billedBy: SourceSplit; patients: number; bills: number; payments: number;
            firstAt: string | null; lastAt: string | null; discount: number; due: number };
  byMethod: { method: Method; amount: number; count: number; by: SourceSplit }[];
  byService: { source: MoneySource; group: string; category: Category; amount: number; lines: number; items: { item: string; amount: number; lines: number }[] }[];
  byHour: { hour: number; amount: number; count: number; by: SourceSplit }[];
  billedVsCollected: { source: MoneySource; billed: number; collected: number; gap: number }[];
  payments: (Omit<DayPayment, "source"> & { source: MoneySource; yaragoSource: string })[];
  refunds: (Omit<DayRefund, "source"> & { source: MoneySource; yaragoSource: string })[];
  lines: (Omit<DayLine, "source"> & { source: MoneySource })[];
  discounts: DayBill[]; dues: DayBill[];
  untimed: number;        // payments with no time in Yarago: left out of byHour, counted everywhere else
  lastWeek: { date: string; collected: number; byThisTime: boolean } | null;
}

const P = (r: number) => Math.round(Number(r) * 100);
const R = (p: number) => p / 100;
const zero = (): SourceSplit => ({ clinic: 0, pharmacy: 0 });
const splitR = (s: SourceSplit): SourceSplit => ({ clinic: R(s.clinic), pharmacy: R(s.pharmacy) });
const hourOf = (at: string | null) => (at && /T\d{2}:/.test(at) ? Number(at.slice(11, 13)) : null);
/** by time, those without one last */
const byTime = (a: { at: string | null }, b: { at: string | null }) => (a.at == null ? (b.at == null ? 0 : 1) : b.at == null ? -1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

export function daySummary(inp: DayInput): DaySummary {
  const pays = inp.payments.filter((p) => p.onDate === inp.date);
  const refs = inp.refunds.filter((r) => r.onDate === inp.date);
  const lines = inp.lines.filter((l) => l.onDate === inp.date);

  const collectedBy = zero(), refundsBy = zero(), billedBy = zero();
  for (const p of pays) collectedBy[sourceOf(p.source)] += P(p.amount);
  for (const r of refs) refundsBy[sourceOf(r.source)] += P(r.amount);
  for (const l of lines) billedBy[sourceOf(l.source)] += P(l.amount);
  const collected = collectedBy.clinic + collectedBy.pharmacy, refunds = refundsBy.clinic + refundsBy.pharmacy;

  // methods, in the usual order, only those used
  const byMethod = METHODS.map((m) => {
    const xs = pays.filter((p) => p.method === m);
    const by = zero();
    for (const p of xs) by[sourceOf(p.source)] += P(p.amount);
    return { method: m, amount: R(by.clinic + by.pharmacy), count: xs.length, by: splitR(by) };
  }).filter((x) => x.count);

  // what the money was billed for: service group (Yarago's), then its items, largest first
  const groups = new Map<string, { source: MoneySource; group: string; amount: number; lines: number; items: Map<string, { amount: number; lines: number }> }>();
  for (const l of lines) {
    const source = sourceOf(l.source), k = `${source}|${l.serviceGroup}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { source, group: l.serviceGroup, amount: 0, lines: 0, items: new Map() });
    g.amount += P(l.amount); g.lines++;
    const name = l.item?.trim() || "Not named";
    const it = g.items.get(name) ?? { amount: 0, lines: 0 };
    it.amount += P(l.amount); it.lines++;
    g.items.set(name, it);
  }
  const byService = [...groups.values()]
    .sort((a, b) => (a.source === b.source ? b.amount - a.amount : a.source === "clinic" ? -1 : 1))
    .map((g) => ({ source: g.source, group: g.group, category: categoryOf(g.group, inp.categoryMap), amount: R(g.amount), lines: g.lines,
                   items: [...g.items].map(([item, v]) => ({ item, amount: R(v.amount), lines: v.lines })).sort((a, b) => b.amount - a.amount) }));

  // through the day: every hour from the first to the last payment, empty hours included so gaps show
  const hours = pays.map((p) => hourOf(p.at)).filter((h): h is number => h != null);
  const byHour: DaySummary["byHour"] = [];
  if (hours.length) {
    for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
      const xs = pays.filter((p) => hourOf(p.at) === h);
      const by = zero();
      for (const p of xs) by[sourceOf(p.source)] += P(p.amount);
      byHour.push({ hour: h, amount: R(by.clinic + by.pharmacy), count: xs.length, by: splitR(by) });
    }
  }

  const timed = pays.filter((p) => p.at).sort(byTime);
  const billKeys = new Set(pays.map((p) => `${sourceOf(p.source)}|${p.billKey ?? p.sourceId}`));
  const patients = new Set(pays.map((p) => p.patientId).filter((x) => x != null));
  const bills = inp.bills;

  return {
    date: inp.date,
    totals: { collected: R(collected), collectedBy: splitR(collectedBy), refunds: R(refunds), refundsBy: splitR(refundsBy), net: R(collected - refunds),
              billed: R(billedBy.clinic + billedBy.pharmacy), billedBy: splitR(billedBy),
              patients: patients.size, bills: billKeys.size, payments: pays.length,
              firstAt: timed[0]?.at ?? null, lastAt: timed[timed.length - 1]?.at ?? null,
              discount: R(bills.reduce((s, b) => s + P(b.discount), 0)), due: R(bills.reduce((s, b) => s + P(b.due), 0)) },
    byMethod, byService, byHour,
    billedVsCollected: (["clinic", "pharmacy"] as const).map((s) => ({ source: s, billed: R(billedBy[s]), collected: R(collectedBy[s]), gap: R(billedBy[s] - collectedBy[s]) }))
      .filter((x) => x.billed || x.collected),
    payments: [...pays].sort((a, b) => byTime(a, b) || a.paymentId.localeCompare(b.paymentId))
      .map((p) => ({ ...p, amount: Number(p.amount), source: sourceOf(p.source), yaragoSource: p.source })),
    refunds: [...refs].sort(byTime).map((r) => ({ ...r, amount: Number(r.amount), source: sourceOf(r.source), yaragoSource: r.source })),
    lines: lines.map((l) => ({ ...l, amount: Number(l.amount), source: sourceOf(l.source) })),
    discounts: bills.filter((b) => P(b.discount) > 0).sort(byTime),
    dues: bills.filter((b) => P(b.due) > 0).sort(byTime),
    untimed: pays.length - timed.length,
    lastWeek: inp.lastWeek ?? null,
  };
}
