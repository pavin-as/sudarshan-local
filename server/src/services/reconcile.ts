// Money reconciliation (D-052): Yarago revenue and payments against Zoho bank credits, plus approved adjustments.
// Pure: no database, no clock (today comes in), so every rule is tested in test/recon.unit.test.ts. The SQL readers are
// in services/reconData.ts. Amounts are worked in paise (integers) and returned in rupees.
//
// The rules, in order (METRICS.md "Reconciliation"):
//  1. Billed = Yarago bill lines and pharmacy/optical sale lines of the day, by category; approved revenue adjustments added.
//  2. Collected = payments by method on clinic bills and pharmacy/optical payments of the day.
//  3. Refunds = refunds by the method they were paid by; refunds whose method Yarago does not record are listed as
//     uncertain and taken off no method.
//  4. Net = collected - refunds + approved adjustments (collected / refund). Fees (approved) lower what reaches the bank.
//  5. Bank credits count only when a bank rule or an approved classification says they are clinic money.
//  6. A day's UPI / card money is matched to credits of its method dated within its settlement window: a single credit
//     equal to it, or less by no more than the dearest fee the bank could keep on the day's payments (D-053: HDFC settles
//     card money net), within tolerance; else one credit equal to a run of up to 3 consecutive days. A match is made only
//     when it is the only possibility both ways; otherwise the day is Uncertain and its candidates are listed. What the
//     bank kept is the day's bank fee: Settled less bank fee, or Fee higher than expected above the dearest usual rate.
//  7. A day without a match is a Difference only once its window has closed inside known bank data; before that it is
//     Waiting for settlement or Bank data not available. Cash is in hand until a recorded deposit covers its day (the
//     cash book, services/cashBook.ts, checks deposits against Yarago and the bank).
import { addDays } from "../lib/time.js";
import type { FeeBand } from "./bankFees.js";

export type Method = "cash" | "upi" | "card" | "cheque" | "other";
export const METHODS: Method[] = ["cash", "upi", "card", "cheque", "other"];
export const METHOD_WORDS: Record<Method, string> = { cash: "Cash", upi: "UPI", card: "Card", cheque: "Cheque", other: "Other" };
export type Category = "consultation" | "procedure" | "pharmacy" | "optical";
export const CATEGORIES: Category[] = ["consultation", "procedure", "pharmacy", "optical"];
export const CATEGORY_WORDS: Record<Category, string> = { consultation: "Consultation", procedure: "Procedure", pharmacy: "Pharmacy", optical: "Optical" };
export type BankClass = "upi_settlement" | "card_settlement" | "cash_deposit" | "online_settlement" | "not_clinic" | "bank_charge";

export interface RevenueLine { lineId: string; source: string; sourceId: string; billNo: string | null; onDate: string; patientId: number | null; serviceGroup: string; item: string | null; amount: number }
export interface PaymentRow { paymentId: string; source: string; sourceId: string; billNo: string | null; onDate: string; patientId: number | null; method: Method; amount: number; ref: string | null }
export interface RefundRow { refundId: string; source: string; sourceId: string; billNo: string | null; onDate: string; patientId: number | null; method: Method | "unrecorded"; amount: number; dateUncertain: boolean }
export interface BankLine { transactionId: string; accountId: string; date: string; amount: number; debitOrCredit: "credit" | "debit"; description: string | null; zohoStatus: string | null; missing: boolean }
export interface BankRule { id: number; position: number; pattern: string; class: BankClass; method: Method | null; windowDays: number; isActive: boolean }
export type Measure = "revenue" | "collected" | "refund" | "fee" | "deposit" | "excluded";
export interface Effect { adjustmentId: number; onDate: string; measure: Measure; category: Category | null; method: Method | null; amount: number; zohoTxnId: string | null; words: string; selfApproved?: boolean; kind?: string }
export interface ZohoState { configured: boolean; fetchedAt: string | null; feedRefreshedOn: string | null; stale: boolean }

export interface ReconInput {
  from: string; to: string; today: string;
  lines: RevenueLine[]; payments: PaymentRow[]; refunds: RefundRow[];
  bank: BankLine[]; rules: BankRule[]; effects: Effect[];       // effects: of APPROVED adjustments only
  categoryMap: Record<string, Category>;
  tolerance: Partial<Record<Method, number>>;
  zoho: ZohoState;
  feeBands?: Record<string, FeeBand>;       // "date|method": what the bank could keep on the day's card / UPI payments
  cash?: { deposits: { id: number; depositedOn: string; coversFrom: string; coversTo: string }[]; matchedCreditIds: string[] };   // from the cash book
}

export type RowStatus = "matched" | "within_tolerance" | "settled_less_fee" | "fee_high" | "awaiting" | "no_bank_data" | "uncertain" | "difference"
  | "cash_in_hand" | "cash_deposited" | "not_tracked" | "nothing_due";
export const STATUS_WORDS: Record<RowStatus, string> = {
  matched: "Matched", within_tolerance: "Within tolerance", settled_less_fee: "Settled less bank fee", fee_high: "Fee higher than expected",
  awaiting: "Waiting for settlement", no_bank_data: "Bank data not available",
  uncertain: "Uncertain", difference: "Difference", cash_in_hand: "Cash not yet deposited", cash_deposited: "Deposited",
  not_tracked: "Not tracked in the bank", nothing_due: "Nothing due",
};

export interface CreditRef { transactionId: string; date: string; amount: number; description: string | null; how: "rule" | "approved"; adjustmentId?: number }
export interface DayMethodRow {
  date: string; method: Method;
  collected: number; refunds: number; adjCollected: number; adjRefunds: number; fees: number;
  net: number;                  // collected - refunds + adjustments
  expected: number;             // net - fees: what should reach the bank (UPI, card, ...) or be in hand (cash)
  deposited: number;            // credits matched to this day (a run's credit is shared out in proportion to the days' money)
  bankFee: number;              // what the bank kept from a matched settlement (expected - deposited, within the fee band)
  band: FeeBand | null;         // the fee the bank could keep on the day's payments (card, UPI)
  difference: number;           // expected - deposited, for matched / difference rows; 0 while awaiting or when it is a fee
  status: RowStatus; statusWords: string;
  matches: CreditRef[]; candidates: CreditRef[];
  windowEnd: string | null; note: string | null;
}
export interface CreditRow extends CreditRef { method: Method | null; class: BankClass | "approved_clinic" | "approved_not_clinic"; ruleId: number | null; matchedTo: string[]; state: "matched" | "unmatched" | "uncertain" | "excluded" | "before_period" }

export interface ReconResult {
  from: string; to: string;
  zoho: ZohoState & { bankKnownUntil: string | null };
  totals: {
    billed: number; billedAdjusted: number; collected: number; refunds: number; refundsUnrecorded: number;
    adjustments: { revenue: number; collected: number; refunds: number; fees: number; deposits: number; count: number };
    netCollected: number; expectedInBank: number; depositsMatched: number; notYetDue: number; cashInHand: number; cashDeposited: number;
    bankFees: number; feeHighDays: number;
    differenceToExplain: number; uncertain: number; unclassifiedCredits: number; unmatchedCredits: number;
  };
  byCategory: { category: Category; billed: number; adjustments: number; total: number }[];
  bySourceMethod: { source: string; method: Method; collected: number }[];
  billedVsCollected: { source: string; billed: number; collected: number; gap: number }[];
  byMethod: { method: Method; collected: number; refunds: number; adjustments: number; fees: number; net: number; deposited: number; bankFees: number; notYetDue: number; difference: number; uncertain: number }[];
  rows: DayMethodRow[];
  credits: CreditRow[];
  unclassified: (BankLine & { note: string })[];
  refundsUnrecordedList: RefundRow[];
  effects: Effect[];
  trackedMethods: Method[];
}

// ---------- money in paise -------------------------------------------------------------------
const P = (r: number) => Math.round(r * 100);
const R = (p: number) => p / 100;
export function rupees(r: number): string {
  const neg = r < 0;
  const s = Math.abs(r).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
  return `${neg ? "−" : ""}₹${s}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** Which rule (if any) makes a bank credit clinic money. First active rule by position whose pattern matches. */
export function classify(line: BankLine, rules: BankRule[]): BankRule | null {
  if (line.debitOrCredit !== "credit" || line.missing) return null;
  return firstRule(line, rules.filter((r) => r.class !== "bank_charge"));
}

/** Which rule (if any) makes money out of the bank a bank charge (the card terminal's service charge). */
export function classifyCharge(line: BankLine, rules: BankRule[]): BankRule | null {
  if (line.debitOrCredit !== "debit" || line.missing) return null;
  return firstRule(line, rules.filter((r) => r.class === "bank_charge"));
}

function firstRule(line: BankLine, rules: BankRule[]): BankRule | null {
  for (const r of [...rules].sort((a, b) => a.position - b.position || a.id - b.id)) {
    if (!r.isActive) continue;
    let re: RegExp;
    try { re = new RegExp(r.pattern, "i"); } catch { continue; }
    if (re.test(line.description ?? "")) return r;
  }
  return null;
}

/** Category of a Yarago service group (the setting recon.category_map); unknown groups count as procedure. */
export function categoryOf(group: string, map: Record<string, Category>): Category {
  return map[group] ?? "procedure";
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

export function reconcile(inp: ReconInput): ReconResult {
  const tol = (m: Method) => P(inp.tolerance[m] ?? 0);
  const inRange = (d: string) => d >= inp.from && d <= inp.to;

  // ---- which methods reach the bank, and with what window ----
  const activeRules = inp.rules.filter((r) => r.isActive && r.class !== "not_clinic" && r.class !== "bank_charge" && r.method);
  const windowOf = new Map<Method, number>();
  for (const r of activeRules) windowOf.set(r.method!, Math.max(windowOf.get(r.method!) ?? 0, r.windowDays));
  const tracked = METHODS.filter((m) => windowOf.has(m) && m !== "cash");
  const cashTracked = windowOf.has("cash");
  const maxWindow = Math.max(0, ...windowOf.values());
  const bankKnownUntil = !inp.zoho.configured || !inp.zoho.fetchedAt ? null
    : [inp.zoho.feedRefreshedOn, inp.zoho.fetchedAt.slice(0, 10)].filter(Boolean).sort()[0] ?? null;
  const bankTrusted = bankKnownUntil != null && !inp.zoho.stale;

  // ---- day x method sums (the period plus the days before it whose settlement can fall inside it) ----
  type Acc = { collected: number; refunds: number; adjC: number; adjR: number; fees: number; manualDeposits: CreditRef[] };
  const acc = new Map<string, Acc>();
  const key = (d: string, m: Method) => `${d}|${m}`;
  const get = (d: string, m: Method) => { let a = acc.get(key(d, m)); if (!a) acc.set(key(d, m), a = { collected: 0, refunds: 0, adjC: 0, adjR: 0, fees: 0, manualDeposits: [] }); return a; };
  for (const p of inp.payments) get(p.onDate, p.method).collected += P(p.amount);
  const refundsUnrecordedList: RefundRow[] = [];
  for (const r of inp.refunds) {
    if (r.method === "unrecorded") { if (inRange(r.onDate)) refundsUnrecordedList.push(r); continue; }
    get(r.onDate, r.method).refunds += P(r.amount);
  }

  const excluded = new Map<string, Effect>();          // bank line -> approved "not clinic money"
  const manualByTxn = new Map<string, Effect[]>();     // bank line -> approved "clinic money for <day>, <method>"
  const adjTotals = { revenue: 0, collected: 0, refunds: 0, fees: 0, deposits: 0 };
  const revenueAdj = new Map<Category, number>();
  for (const e of inp.effects) {
    const inPeriod = inRange(e.onDate);
    switch (e.measure) {
      case "revenue": if (inPeriod && e.category) { revenueAdj.set(e.category, (revenueAdj.get(e.category) ?? 0) + P(e.amount)); adjTotals.revenue += P(e.amount); } break;
      case "collected": if (e.method) get(e.onDate, e.method).adjC += P(e.amount); if (inPeriod) adjTotals.collected += P(e.amount); break;
      case "refund": if (e.method) get(e.onDate, e.method).adjR += P(e.amount); if (inPeriod) adjTotals.refunds += P(e.amount); break;
      case "fee": if (e.method) get(e.onDate, e.method).fees += P(e.amount); if (inPeriod) adjTotals.fees += P(e.amount); break;
      case "deposit": if (e.zohoTxnId) manualByTxn.set(e.zohoTxnId, [...(manualByTxn.get(e.zohoTxnId) ?? []), e]); if (inPeriod) adjTotals.deposits += P(e.amount); break;
      case "excluded": if (e.zohoTxnId) excluded.set(e.zohoTxnId, e); break;
    }
  }

  // ---- bank credits: classified by approval first, then by rule ----
  const credits: CreditRow[] = [];
  const unclassified: (BankLine & { note: string })[] = [];
  const pool = new Map<Method, CreditRow[]>();
  for (const b of [...inp.bank].sort((a, c) => a.date.localeCompare(c.date) || a.transactionId.localeCompare(c.transactionId))) {
    if (b.debitOrCredit !== "credit") continue;
    const ref: CreditRef = { transactionId: b.transactionId, date: b.date, amount: b.amount, description: b.description, how: "rule" };
    const ex = excluded.get(b.transactionId);
    if (ex) { credits.push({ ...ref, how: "approved", adjustmentId: ex.adjustmentId, method: null, class: "approved_not_clinic", ruleId: null, matchedTo: [], state: "excluded" }); continue; }
    const manual = manualByTxn.get(b.transactionId);
    if (manual) {
      const c: CreditRow = { ...ref, how: "approved", adjustmentId: manual[0].adjustmentId, method: manual[0].method, class: "approved_clinic", ruleId: null,
                             matchedTo: manual.map((e) => e.onDate), state: "matched" };
      credits.push(c);
      for (const e of manual) if (e.method) get(e.onDate, e.method).manualDeposits.push({ ...ref, amount: e.amount, how: "approved", adjustmentId: e.adjustmentId });
      continue;
    }
    if (b.missing) continue;
    const rule = classify(b, inp.rules);
    if (!rule) { if (b.date >= inp.from && b.date <= addDays(inp.to, maxWindow)) unclassified.push({ ...b, note: "Not counted until classified" }); continue; }
    if (rule.class === "not_clinic") { credits.push({ ...ref, method: null, class: rule.class, ruleId: rule.id, matchedTo: [], state: "excluded" }); continue; }
    const c: CreditRow = { ...ref, method: rule.method, class: rule.class, ruleId: rule.id, matchedTo: [], state: "unmatched" };
    credits.push(c);
    if (rule.method) pool.set(rule.method, [...(pool.get(rule.method) ?? []), c]);
  }

  // ---- rows ----
  const firstDay = addDays(inp.from, -maxWindow);
  const rows: DayMethodRow[] = [];
  for (const [k, a] of acc) {
    const [date, m] = k.split("|") as [string, Method];
    if (date < firstDay || date > inp.to) continue;
    const net = a.collected - a.refunds + a.adjC - a.adjR;
    const expected = net - a.fees;
    if (net === 0 && a.fees === 0 && !a.manualDeposits.length && a.collected === 0 && a.refunds === 0) continue;
    const manualSum = a.manualDeposits.reduce((s, c) => s + P(c.amount), 0);
    rows.push({ date, method: m, collected: R(a.collected), refunds: R(a.refunds), adjCollected: R(a.adjC), adjRefunds: R(a.adjR), fees: R(a.fees),
                net: R(net), expected: R(expected), deposited: R(manualSum), bankFee: 0, band: inp.feeBands?.[k] ?? null, difference: 0,
                status: "nothing_due", statusWords: "", matches: [...a.manualDeposits], candidates: [], windowEnd: null, note: null });
  }
  rows.sort((x, y) => x.date.localeCompare(y.date) || METHODS.indexOf(x.method) - METHODS.indexOf(y.method));

  // ---- matching per tracked method ----
  for (const m of tracked) {
    const w = windowOf.get(m)!;
    const t = tol(m);
    const days = rows.filter((r) => r.method === m);
    for (const r of days) r.windowEnd = addDays(r.date, w);
    const open = () => days.filter((r) => r.matches.length === 0 && P(r.expected) > 0);
    const free = () => (pool.get(m) ?? []).filter((c) => c.state !== "matched");
    const ceiling = (r: DayMethodRow) => P(r.band?.ceiling ?? 0);
    // the credit is the day's money, or less by no more than the dearest fee the bank could keep (net settlement)
    const inBand = (amount: number, expected: number, ceil: number) => amount <= expected + t && amount >= expected - ceil - t;
    const fits = (r: DayMethodRow, c: CreditRow) => c.date >= r.date && c.date <= r.windowEnd! && inBand(P(c.amount), P(r.expected), ceiling(r));

    // (a) single credit = single day, accepted only when the pairing is unique both ways; repeat until nothing changes
    for (let changed = true; changed;) {
      changed = false;
      for (const r of open()) {
        const cs = free().filter((c) => fits(r, c));
        if (cs.length !== 1) continue;
        const c = cs[0];
        const rivals = open().filter((o) => fits(o, c));
        if (rivals.length !== 1) continue;
        c.state = "matched"; c.matchedTo = [r.date];
        r.matches.push(c); r.deposited = c.amount; changed = true;
      }
    }
    // (b) one credit = a run of 2-3 consecutive open days (no more than 3 calendar days apart in total), unique both ways
    const runsFor = (c: CreditRow) => {
      const od = open().filter((r) => r.date <= c.date);
      const out: DayMethodRow[][] = [];
      for (let i = 0; i < od.length; i++) for (let n = 2; n <= 3 && i + n <= od.length; n++) {
        const run = od.slice(i, i + n);
        if (daysBetween(run[0].date, run[n - 1].date) > 3) continue;
        const last = run[n - 1];
        if (c.date > addDays(last.date, w) || c.date < last.date) continue;
        if (inBand(P(c.amount), run.reduce((s, r) => s + P(r.expected), 0), run.reduce((s, r) => s + ceiling(r), 0))) out.push(run);
      }
      return out;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const c of free()) {
        const runs = runsFor(c);
        if (runs.length !== 1) continue;
        const run = runs[0];
        const otherCredits = free().filter((o) => o !== c && runsFor(o).some((x) => x.some((r) => run.includes(r))));
        if (otherCredits.length) continue;
        c.state = "matched"; c.matchedTo = run.map((r) => r.date);
        // what the bank kept is shared out in proportion to the fee each day could carry (its money when none could),
        // the last day taking the rounding
        const total = run.reduce((s, r) => s + P(r.expected), 0);
        const ceil = run.reduce((s, r) => s + ceiling(r), 0);
        const kept = total - P(c.amount);
        let left = kept;
        run.forEach((r, i) => {
          const part = i === run.length - 1 ? left : Math.round(kept * (ceil > 0 ? ceiling(r) / ceil : P(r.expected) / total));
          left -= part;
          r.matches.push(c); r.deposited = R(P(r.expected) - part);
          r.note = `One credit of ${rupees(c.amount)} on ${shortDate(c.date)} covers ${run.map((x) => shortDate(x.date)).join(", ")}`;
        });
        changed = true;
      }
    }
    // (c) what is left: candidates (uncertain), waiting, no data, or a difference
    for (const r of days) {
      if (r.matches.length) {
        const diff = P(r.expected) - P(r.deposited);
        if (diff > t && diff <= ceiling(r) + t) {
          // the bank kept a fee: explained, not a difference
          r.bankFee = R(diff); r.difference = 0;
          r.status = diff <= P(r.band?.high ?? 0) + t ? "settled_less_fee" : "fee_high";
          const pctKept = Math.round(diff / P(r.expected) * 10000) / 100;
          r.note = `${r.note ? `${r.note}. ` : ""}Bank kept ${rupees(R(diff))} (${pctKept}%)${r.status === "fee_high" ? `: more than the ${rupees(r.band!.high)} the dearest usual card would cost` : ""}`;
          continue;
        }
        r.difference = R(diff);
        r.status = diff === 0 ? "matched" : Math.abs(diff) <= t ? "within_tolerance" : "difference";
        if (r.status === "difference" && r.matches.every((c) => c.how === "approved")) r.note = "Classified bank credit does not equal the day's money";
        continue;
      }
      if (P(r.expected) <= 0) { r.status = P(r.expected) === 0 ? "nothing_due" : "difference"; r.difference = r.expected; if (r.status === "difference") r.note = "Refunds and adjustments are more than the day's collections"; continue; }
      const exact = free().filter((c) => fits(r, c));
      if (exact.length) {
        r.status = "uncertain"; r.candidates = exact.map(({ transactionId, date, amount, description, how }) => ({ transactionId, date, amount, description, how }));
        for (const c of exact) c.state = "uncertain";
        r.note = `${exact.length} bank credits could be this day's ${METHOD_WORDS[m]}: check which before classifying`;
        continue;
      }
      if (!bankTrusted || r.windowEnd! > bankKnownUntil!) {
        r.status = !bankTrusted ? "no_bank_data" : r.windowEnd! >= inp.today ? "awaiting" : "no_bank_data";
        r.note = !inp.zoho.configured ? "Zoho is not connected yet" : !inp.zoho.fetchedAt ? "Zoho has not been read yet"
          : inp.zoho.stale ? "The Zoho copy is out of date: fetch again" : `Bank lines known up to ${shortDate(bankKnownUntil!)}`;
        continue;
      }
      r.status = "difference"; r.difference = r.expected;
      const near = free().filter((c) => c.date >= r.date && c.date <= r.windowEnd!);
      r.candidates = near.map(({ transactionId, date, amount, description, how }) => ({ transactionId, date, amount, description, how }));
      r.note = near.length === 1 ? `Nearest credit ${rupees(near[0].amount)} on ${shortDate(near[0].date)} (${rupees(R(P(near[0].amount) - P(r.expected)))} against the day): not matched`
        : near.length ? `${near.length} credits in the window, none equal to the day or short of it by a possible fee` : "No bank credit in the settlement window";
    }
  }
  // cash: in hand until a recorded deposit covers the day (the cash book checks the deposit as a whole, not per day)
  const cashDeps = inp.cash?.deposits ?? [];
  for (const r of rows) {
    if (r.method === "cash") {
      const dep = cashDeps.find((d) => r.date >= d.coversFrom && r.date <= d.coversTo);
      if (dep) { r.status = "cash_deposited"; r.deposited = r.expected; r.note = `In deposit #${dep.id} of ${shortDate(dep.depositedOn)}`; }
      else r.status = P(r.expected) === 0 && !r.matches.length ? "nothing_due" : "cash_in_hand";
      continue;
    }
    if (!tracked.includes(r.method)) { r.status = P(r.expected) === 0 ? "nothing_due" : "not_tracked"; r.note = "No bank rule for this method"; }
  }
  for (const r of rows) r.statusWords = STATUS_WORDS[r.status];
  for (const c of credits) if (c.state === "matched" && c.matchedTo.length && c.matchedTo.every((d) => d < inp.from)) c.state = "before_period";

  // cash-deposit credits are matched by the cash book; one it did not match is shown to look at
  const cashMatched = new Set(inp.cash?.matchedCreditIds ?? []);
  const cashCredits = cashTracked ? (pool.get("cash") ?? []) : [];
  for (const c of cashCredits) { c.state = cashMatched.has(c.transactionId) ? "matched" : "unmatched"; c.matchedTo = []; }
  const cashManual = rows.filter((r) => r.method === "cash" && inRange(r.date) && r.status !== "cash_deposited").reduce((s, r) => s + P(r.deposited), 0);

  // ---- totals, period only ----
  const period = rows.filter((r) => inRange(r.date));
  const sum = (xs: DayMethodRow[], f: (r: DayMethodRow) => number) => xs.reduce((s, r) => s + P(f(r)), 0);
  const lines = inp.lines.filter((l) => inRange(l.onDate));
  const byCatP = new Map<Category, number>();
  for (const l of lines) { const c = categoryOf(l.serviceGroup, inp.categoryMap); byCatP.set(c, (byCatP.get(c) ?? 0) + P(l.amount)); }
  const billedP = lines.reduce((s, l) => s + P(l.amount), 0);
  const payP = inp.payments.filter((p) => inRange(p.onDate));
  const srcMethod = new Map<string, number>();
  for (const p of payP) srcMethod.set(`${p.source}|${p.method}`, (srcMethod.get(`${p.source}|${p.method}`) ?? 0) + P(p.amount));
  // billed against collected per source: clinic bill lines with clinic bill payments, sale lines with pharmacy payments
  const billedVsCollected = ([["clinic_bill", "clinic_bill", "clinic_bill"], ["pharmacy", "pharmacy_order", "pharmacy_payment"]] as const).map(([s, ls, ps]) => {
    const b = lines.filter((l) => l.source === ls).reduce((x, l) => x + P(l.amount), 0);
    const c = payP.filter((p) => p.source === ps).reduce((x, p) => x + P(p.amount), 0);
    return { source: s, billed: R(b), collected: R(c), gap: R(b - c) };
  }).filter((x) => x.billed || x.collected);

  const tracksRow = (r: DayMethodRow) => tracked.includes(r.method);
  const awaitingRows = period.filter((r) => r.status === "awaiting" || r.status === "no_bank_data");
  const diffRows = period.filter((r) => r.status === "difference");
  const uncertainRows = period.filter((r) => r.status === "uncertain");
  const cashRows = period.filter((r) => r.method === "cash");
  const cashDeposited = sum(cashRows.filter((r) => r.status === "cash_deposited"), (r) => r.expected) + cashManual;
  const cashInHand = sum(cashRows.filter((r) => r.status !== "cash_deposited"), (r) => r.expected) - cashManual;
  const depositsMatched = sum(period.filter(tracksRow), (r) => r.deposited) + cashDeposited;
  const feeRows = period.filter((r) => r.status === "settled_less_fee" || r.status === "fee_high");

  const byMethod = METHODS.map((m) => {
    const xs = period.filter((r) => r.method === m);
    return { method: m, collected: R(sum(xs, (r) => r.collected)), refunds: R(sum(xs, (r) => r.refunds)), adjustments: R(sum(xs, (r) => r.adjCollected) - sum(xs, (r) => r.adjRefunds)),
             fees: R(sum(xs, (r) => r.fees)), net: R(sum(xs, (r) => r.net)),
             deposited: R(m === "cash" ? cashDeposited : sum(xs, (r) => r.deposited)), bankFees: R(sum(xs, (r) => r.bankFee)),
             notYetDue: R(sum(xs.filter((r) => r.status === "awaiting" || r.status === "no_bank_data"), (r) => r.expected)),
             difference: R(sum(xs.filter((r) => r.status === "difference" || r.status === "within_tolerance"), (r) => r.difference)),
             uncertain: R(sum(xs.filter((r) => r.status === "uncertain"), (r) => r.expected)) };
  }).filter((x) => x.collected || x.refunds || x.adjustments || x.fees || x.deposited);

  const revAdjTotal = [...revenueAdj.values()].reduce((s, v) => s + v, 0);
  return {
    from: inp.from, to: inp.to,
    zoho: { ...inp.zoho, bankKnownUntil },
    totals: {
      billed: R(billedP), billedAdjusted: R(billedP + revAdjTotal),
      collected: R(payP.reduce((s, p) => s + P(p.amount), 0)),
      refunds: R(sum(period, (r) => r.refunds)), refundsUnrecorded: R(refundsUnrecordedList.reduce((s, r) => s + P(r.amount), 0)),
      adjustments: { revenue: R(adjTotals.revenue), collected: R(adjTotals.collected), refunds: R(adjTotals.refunds), fees: R(adjTotals.fees), deposits: R(adjTotals.deposits),
                     count: new Set(inp.effects.filter((e) => inRange(e.onDate)).map((e) => e.adjustmentId)).size },
      netCollected: R(sum(period, (r) => r.net)),
      expectedInBank: R(sum(period.filter(tracksRow), (r) => r.expected)),
      depositsMatched: R(depositsMatched),
      notYetDue: R(sum(awaitingRows, (r) => r.expected)),
      cashInHand: R(cashInHand), cashDeposited: R(cashDeposited),
      bankFees: R(sum(feeRows, (r) => r.bankFee)), feeHighDays: feeRows.filter((r) => r.status === "fee_high").length,
      differenceToExplain: R(sum(diffRows, (r) => r.difference)),
      uncertain: R(sum(uncertainRows, (r) => r.expected)),
      unclassifiedCredits: R(unclassified.reduce((s, b) => s + P(b.amount), 0)),
      unmatchedCredits: R(credits.filter((c) => (c.state === "unmatched" || c.state === "uncertain") && inRange(c.date) && c.method !== "cash").reduce((s, c) => s + P(c.amount), 0)),
    },
    byCategory: CATEGORIES.map((c) => ({ category: c, billed: R(byCatP.get(c) ?? 0), adjustments: R(revenueAdj.get(c) ?? 0), total: R((byCatP.get(c) ?? 0) + (revenueAdj.get(c) ?? 0)) }))
      .filter((x) => x.billed || x.adjustments),
    bySourceMethod: [...srcMethod].map(([k, v]) => { const [source, method] = k.split("|"); return { source, method: method as Method, collected: R(v) }; })
      .sort((a, b) => a.source.localeCompare(b.source) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method)),
    billedVsCollected,
    byMethod,
    rows: period,
    credits: credits.filter((c) => c.date >= inp.from && c.date <= addDays(inp.to, maxWindow)),
    unclassified,
    refundsUnrecordedList,
    effects: inp.effects.filter((e) => inRange(e.onDate)),
    trackedMethods: [...tracked, ...(cashTracked ? ["cash" as Method] : [])],
  };
}

// ---------- adjustments: what each kind changes ------------------------------------------------
export type AdjKind = "refund_method" | "method_correction" | "amount_correction" | "date_correction" | "missing_entry" | "payment_fee" | "bank_credit" | "reversal";
export const KIND_WORDS: Record<AdjKind, string> = {
  refund_method: "Refund by another method", method_correction: "Payment method correction", amount_correction: "Amount correction",
  date_correction: "Date correction", missing_entry: "Payment missing from Yarago", payment_fee: "Payment fee or bank charge",
  bank_credit: "Classify a bank credit", reversal: "Reversal",
};
export interface AdjInput {
  kind: AdjKind; onDate: string; otherDate?: string | null; amount: number; recordedAmount?: number | null;
  category?: Category | null; sourceMethod?: Method | null; recordedMethod?: Method | null; actualMethod?: Method | null;
  bankClass?: "clinic" | "not_clinic" | null; zohoTxnId?: string | null; bankAmount?: number | null;
}
export type EffectDraft = Omit<Effect, "adjustmentId" | "selfApproved" | "kind">;
export class AdjustmentRefused extends Error {}

/** The signed effects of an adjustment, worked out once when it is sent. Throws AdjustmentRefused with a plain sentence. */
export function effectsFor(a: AdjInput): EffectDraft[] {
  const no = (msg: string): never => { throw new AdjustmentRefused(msg); };
  const amt = Math.round(a.amount * 100) / 100;
  if (!(amt > 0) && a.kind !== "amount_correction") no("The amount must be more than ₹0");
  const d = shortDate(a.onDate);
  const M = (m: Method | null | undefined) => (m ? METHOD_WORDS[m] : "");
  const m = (x: Method | null | undefined) => (x === "upi" ? "UPI" : M(x).toLowerCase());     // inside a sentence
  const e = (measure: Measure, amount: number, words: string, x: Partial<EffectDraft> = {}): EffectDraft =>
    ({ onDate: a.onDate, measure, category: null, method: null, amount, zohoTxnId: null, words, ...x });
  switch (a.kind) {
    case "refund_method": {
      if (!a.actualMethod) no("Say how the refund was actually paid");
      if (!a.sourceMethod) no("Say how the patient originally paid");
      const kept = `${M(a.sourceMethod)} payment stays as collected`;
      if (a.recordedMethod) {
        if (a.recordedMethod === a.actualMethod) no(`Yarago already shows this refund as ${M(a.actualMethod)}: there is nothing to adjust`);
        return [e("refund", -amt, `${M(a.recordedMethod)} refunds on ${d}: −${rupees(amt)} (Yarago shows it as ${m(a.recordedMethod)}, but it was not paid that way). ${kept}`, { method: a.recordedMethod }),
                e("refund", amt, `${M(a.actualMethod)} refunds on ${d}: +${rupees(amt)} (paid by ${m(a.actualMethod)})`, { method: a.actualMethod })];
      }
      if (!a.category) no("Say which category the refunded money was for");
      return [e("refund", amt, `${M(a.actualMethod)} refunds on ${d}: +${rupees(amt)} (refund not in Yarago). ${kept}`, { method: a.actualMethod }),
              e("revenue", -amt, `${CATEGORY_WORDS[a.category!]} revenue on ${d}: −${rupees(amt)} (refunded)`, { category: a.category })];
    }
    case "method_correction":
      if (!a.recordedMethod || !a.actualMethod) no("Say the method Yarago shows and the method actually used");
      if (a.recordedMethod === a.actualMethod) no("The two methods are the same: there is nothing to correct");
      return [e("collected", -amt, `${M(a.recordedMethod)} collected on ${d}: −${rupees(amt)} (entered as ${m(a.recordedMethod)} in Yarago)`, { method: a.recordedMethod }),
              e("collected", amt, `${M(a.actualMethod)} collected on ${d}: +${rupees(amt)} (actually paid by ${m(a.actualMethod)})`, { method: a.actualMethod })];
    case "amount_correction": {
      if (a.recordedAmount == null) no("Give the amount Yarago shows");
      if (!a.actualMethod) no("Say how the money was paid");
      if (!a.category) no("Say which category the bill was for");
      if (amt < 0) no("The correct amount cannot be below ₹0");
      const diff = Math.round((amt - a.recordedAmount!) * 100) / 100;
      if (diff === 0) no("The correct amount is the same as Yarago's: there is nothing to correct");
      const sign = diff > 0 ? "+" : "−";
      const abs = rupees(Math.abs(diff));
      return [e("revenue", diff, `${CATEGORY_WORDS[a.category!]} revenue on ${d}: ${sign}${abs} (Yarago ${rupees(a.recordedAmount!)}, correct ${rupees(amt)})`, { category: a.category }),
              e("collected", diff, `${M(a.actualMethod)} collected on ${d}: ${sign}${abs}`, { method: a.actualMethod })];
    }
    case "date_correction": {
      if (!a.otherDate) no("Give the day the money was actually received");
      if (a.otherDate === a.onDate) no("The two days are the same: there is nothing to correct");
      if (!a.actualMethod) no("Say how the money was paid");
      const d2 = shortDate(a.otherDate!);
      const out = [e("collected", -amt, `${M(a.actualMethod)} collected on ${d}: −${rupees(amt)} (entered on the wrong day)`, { method: a.actualMethod }),
                   e("collected", amt, `${M(a.actualMethod)} collected on ${d2}: +${rupees(amt)} (the day it was received)`, { method: a.actualMethod, onDate: a.otherDate! })];
      if (a.category) out.push(e("revenue", -amt, `${CATEGORY_WORDS[a.category]} revenue on ${d}: −${rupees(amt)}`, { category: a.category }),
                               e("revenue", amt, `${CATEGORY_WORDS[a.category]} revenue on ${d2}: +${rupees(amt)}`, { category: a.category, onDate: a.otherDate! }));
      return out;
    }
    case "missing_entry":
      if (!a.actualMethod || !a.category) no("Say the category and how the money was paid");
      return [e("revenue", amt, `${CATEGORY_WORDS[a.category!]} revenue on ${d}: +${rupees(amt)} (not in Yarago)`, { category: a.category }),
              e("collected", amt, `${M(a.actualMethod)} collected on ${d}: +${rupees(amt)} (not in Yarago)`, { method: a.actualMethod })];
    case "payment_fee":
      if (!a.actualMethod) no("Say which method the fee was charged on");
      return [e("fee", amt, `${M(a.actualMethod)} fees on ${d}: +${rupees(amt)}, so ${rupees(amt)} less is expected in the bank`, { method: a.actualMethod, zohoTxnId: a.zohoTxnId ?? null })];
    case "bank_credit":
      if (!a.zohoTxnId) no("Choose the Zoho bank line");
      if (a.bankAmount != null && Math.round(a.bankAmount * 100) !== Math.round(amt * 100)) no(`The bank line is ${rupees(a.bankAmount)}: classify the whole amount`);
      if (a.bankClass === "not_clinic") return [e("excluded", amt, `Bank credit of ${rupees(amt)} is not clinic money: never counted`, { zohoTxnId: a.zohoTxnId })];
      if (a.bankClass !== "clinic" || !a.actualMethod) no("Say whether the credit is clinic money and, if so, for which method");
      return [e("deposit", amt, `${M(a.actualMethod)} reaching the bank for ${d}: +${rupees(amt)} (bank credit classified)`, { method: a.actualMethod, zohoTxnId: a.zohoTxnId })];
    case "reversal":
      return no("A reversal is made from the adjustment it reverses");
  }
}

/** The effects of a reversal: the original's, negated. */
export function reversalEffects(originalId: number, original: EffectDraft[]): EffectDraft[] {
  return original.map((x) => ({ ...x, amount: -x.amount, words: `Reverses #${originalId}: ${x.words}` }));
}
