// The cash book (D-053). Pure: no database, no clock. Cash is not banked daily: the cash desk takes the drawer to the
// bank every week or so and records the deposit in Sudarshan without seeing Yarago's figures (blind). The rules:
//  1. Each recorded deposit covers the collection days after the previous one, up to and including its covers_to.
//  2. Yarago cash of those days (collected - refunds +- approved cash adjustments) plus what the drawer carried in,
//     minus the deposit, is carried forward. Within +-carryBand (rounding to ₹10, ₹50 or ₹100) that is normal; more
//     left behind is Short, less is Excess (more banked than Yarago shows collected).
//  3. A deposit is found in the bank when exactly one cash-deposit credit of the same amount is dated within 3 days
//     after it, and that credit fits no other deposit. Cash-deposit credits no recorded deposit explains are listed.
//  4. Cash in hand now = carried forward after the last deposit + Yarago cash of the days since. Amber from warnAt,
//     red at the limit (Pavin: never above ₹4,00,000).
import { addDays } from "../lib/time.js";
import { classify, rupees, shortDate, type BankLine, type BankRule } from "./reconcile.js";

export interface CashDeposit {
  id: number; depositedOn: string; coversTo: string; amount: number; slipNo: string | null; note: string | null;
  recordedBy: number; recordedByName: string; recordedAt: string;
  status: "recorded" | "voided"; voidReason: string | null; voidedByName: string | null; voidedAt: string | null;
}
export interface CashDay { date: string; net: number }
export interface CashLimits { warnAt: number; limit: number; carryBand: number }
export interface CashBookInput {
  start: string; opening: number; bankFrom: string; today: string;
  days: CashDay[];                    // net Yarago cash per day from start to today
  deposits: CashDeposit[];            // all, voided too
  bank: BankLine[]; rules: BankRule[];
  limits: CashLimits;
  bankKnownUntil: string | null; bankTrusted: boolean;
}
export const BANK_DAYS = 3;
export type CheckState = "ok" | "short" | "excess";
export type BankState = "found" | "waiting" | "not_found" | "uncertain" | "no_bank_data";
export interface BankRef { transactionId: string; date: string; amount: number; description: string | null }
export interface DepositCheck extends CashDeposit {
  coversFrom: string; yaragoCash: number; carryIn: number; carryOut: number;
  check: CheckState; checkWords: string;
  bank: BankState; bankWords: string; credit: BankRef | null; possible: BankRef[];
}
export type Level = "ok" | "soon" | "over";
export interface CashBook {
  start: string; opening: number; coveredUntil: string | null;
  deposits: DepositCheck[];                         // recorded, oldest first
  voided: CashDeposit[]; beforeStart: CashDeposit[];
  inHand: { amount: number; since: string; firstCashDay: string | null; level: Level; levelWords: string;
            lastDeposit: { id: number; depositedOn: string; coversTo: string } | null; daysSinceLastDeposit: number | null };
  unrecorded: BankRef[];                            // cash-deposit credits in the bank no recorded deposit explains
  matchedCreditIds: string[];
  days: { date: string; net: number; depositId: number | null }[];
  limits: CashLimits;
}

const P = (r: number) => Math.round(Number(r) * 100);
const R = (p: number) => p / 100;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const ref = (b: BankLine): BankRef => ({ transactionId: b.transactionId, date: b.date, amount: Number(b.amount), description: b.description });

export function cashBook(inp: CashBookInput): CashBook {
  const band = P(inp.limits.carryBand);
  const recorded = inp.deposits.filter((d) => d.status === "recorded").sort((a, b) => a.coversTo.localeCompare(b.coversTo) || a.id - b.id);
  const live = recorded.filter((d) => d.coversTo >= inp.start);
  const net = new Map(inp.days.map((d) => [d.date, P(d.net)]));
  const cashIn = (from: string, to: string) => { let s = 0; for (const [d, v] of net) if (d >= from && d <= to) s += v; return s; };

  // ---- the bank side: cash-deposit credits, matched to recorded deposits unique both ways ----
  const cashCredits = inp.bank.filter((b) => b.debitOrCredit === "credit" && !b.missing && b.date >= inp.bankFrom && classify(b, inp.rules)?.class === "cash_deposit")
    .sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId));
  const fits = (d: CashDeposit, c: BankLine) => P(c.amount) === P(d.amount) && c.date >= d.depositedOn && c.date <= addDays(d.depositedOn, BANK_DAYS);
  const matched = new Map<number, BankLine>();
  const used = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const d of live) {
      if (matched.has(d.id)) continue;
      const cs = cashCredits.filter((c) => !used.has(c.transactionId) && fits(d, c));
      if (cs.length !== 1) continue;
      const rivals = live.filter((o) => !matched.has(o.id) && fits(o, cs[0]));
      if (rivals.length !== 1) continue;
      matched.set(d.id, cs[0]); used.add(cs[0].transactionId); changed = true;
    }
  }

  // ---- the deposits, in order, with the drawer's carry ----
  let carry = P(inp.opening);
  let prevTo: string | null = null;
  const deposits: DepositCheck[] = live.map((d) => {
    const coversFrom: string = prevTo ? addDays(prevTo, 1) : inp.start;
    const y = cashIn(coversFrom, d.coversTo);
    const carryIn = carry;
    const carryOut = carryIn + y - P(d.amount);
    carry = carryOut; prevTo = d.coversTo;
    const check: CheckState = carryOut > band ? "short" : carryOut < -band ? "excess" : "ok";
    const checkWords = check === "short" ? `${rupees(R(carryOut))} less banked than the cash in the drawer`
      : check === "excess" ? `${rupees(R(-carryOut))} more banked than Yarago shows collected`
      : carryOut === 0 ? "Exact" : carryOut > 0 ? `${rupees(R(carryOut))} kept in the drawer (rounding)` : `${rupees(R(-carryOut))} added (rounding)`;
    const credit = matched.get(d.id) ?? null;
    let bank: BankState, bankWords: string;
    const windowEnd = addDays(d.depositedOn, BANK_DAYS);
    const exact = cashCredits.filter((c) => !used.has(c.transactionId) && fits(d, c));
    const possible = cashCredits.filter((c) => !used.has(c.transactionId) && !fits(d, c) && c.date >= d.depositedOn && c.date <= windowEnd).map(ref);
    if (credit) { bank = "found"; bankWords = `In the bank on ${shortDate(credit.date)}`; }
    else if (exact.length) { bank = "uncertain"; bankWords = `${exact.length} bank credits of this amount could be this deposit`; }
    else if (!inp.bankTrusted || !inp.bankKnownUntil) { bank = "no_bank_data"; bankWords = "Bank data not available"; }
    else if (windowEnd > inp.bankKnownUntil) { bank = "waiting"; bankWords = `Bank lines known up to ${shortDate(inp.bankKnownUntil)}`; }
    else { bank = "not_found"; bankWords = possible.length ? `Not in the bank as ${rupees(Number(d.amount))}: the bank shows ${possible.map((p) => `${rupees(p.amount)} on ${shortDate(p.date)}`).join(", ")}` : "No cash deposit of this amount in the bank"; }
    return { ...d, amount: Number(d.amount), coversFrom, yaragoCash: R(y), carryIn: R(carryIn), carryOut: R(carryOut), check, checkWords,
             bank, bankWords, credit: credit ? ref(credit) : null, possible };
  });

  // ---- cash in hand now ----
  const since = prevTo ? addDays(prevTo, 1) : inp.start;
  const amountP = carry + cashIn(since, inp.today);
  const amount = R(amountP);
  const level: Level = amountP >= P(inp.limits.limit) ? "over" : amountP >= P(inp.limits.warnAt) ? "soon" : "ok";
  const levelWords = level === "over" ? `Over the ${rupees(inp.limits.limit)} limit: deposit today`
    : level === "soon" ? `Deposit soon: near the ${rupees(inp.limits.limit)} limit` : "Within the limit";
  const last = live.length ? [...live].sort((a, b) => a.depositedOn.localeCompare(b.depositedOn) || a.id - b.id).pop()! : null;
  const firstCashDay = [...net].filter(([d, v]) => d >= since && d <= inp.today && v !== 0).map(([d]) => d).sort()[0] ?? null;

  const coverOf = (date: string) => deposits.find((d) => date >= d.coversFrom && date <= d.coversTo)?.id ?? null;
  return {
    start: inp.start, opening: inp.opening, coveredUntil: prevTo,
    deposits,
    voided: inp.deposits.filter((d) => d.status === "voided"),
    beforeStart: recorded.filter((d) => d.coversTo < inp.start),
    inHand: { amount, since, firstCashDay, level, levelWords,
              lastDeposit: last ? { id: last.id, depositedOn: last.depositedOn, coversTo: last.coversTo } : null,
              daysSinceLastDeposit: last ? daysBetween(last.depositedOn, inp.today) : null },
    unrecorded: cashCredits.filter((c) => !used.has(c.transactionId)).map(ref),
    matchedCreditIds: [...used],
    days: inp.days.filter((d) => d.date >= inp.start && d.date <= inp.today).sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, net: Number(d.net), depositId: coverOf(d.date) })),
    limits: inp.limits,
  };
}

/** What the cash desk sees (blind, D-053): its deposits and the limit in words, never Yarago's cash or a difference. */
export function deskView(b: CashBook) {
  return {
    coveredUntil: b.coveredUntil, nextCoversFrom: b.inHand.since, start: b.start,
    inHand: { level: b.inHand.level, levelWords: b.inHand.levelWords, firstCashDay: b.inHand.firstCashDay,
              lastDeposit: b.inHand.lastDeposit, daysSinceLastDeposit: b.inHand.daysSinceLastDeposit },
    deposits: [...b.deposits].reverse().map((d) => ({ id: d.id, depositedOn: d.depositedOn, coversFrom: d.coversFrom, coversTo: d.coversTo, amount: d.amount,
      slipNo: d.slipNo, note: d.note, recordedByName: d.recordedByName, recordedAt: d.recordedAt,
      bank: d.bank, bankWords: d.bank === "not_found" ? "Not found in the bank: tell the admin" : d.bank === "found" ? d.bankWords : d.bank === "uncertain" ? "Being checked" : "Waiting for the bank" })),
    voided: b.voided.map((d) => ({ id: d.id, depositedOn: d.depositedOn, coversTo: d.coversTo, amount: Number(d.amount), voidReason: d.voidReason, voidedByName: d.voidedByName })),
  };
}
