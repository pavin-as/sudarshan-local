// Money reconciliation rules (D-052), no database.   npx tsx test/recon.unit.test.ts
import assert from "node:assert/strict";
import { AdjustmentRefused, categoryOf, classify, effectsFor, reconcile, reversalEffects, type BankLine, type BankRule, type Effect,
         type EffectDraft, type PaymentRow, type ReconInput, type RefundRow, type RevenueLine } from "../src/services/reconcile.js";
import { dayBands, feeOn, feeReport, paymentBand, ratesOn, type FeeRate } from "../src/services/bankFees.js";
import { cashBook, deskView, type CashBookInput, type CashDeposit } from "../src/services/cashBook.js";
import { effectivePermissions, PERMISSIONS } from "../src/lib/permissions.js";
import { lineShape, splitRepeats } from "../src/services/reconcile.js";
import { booksAudit, DEFAULT_AUDIT, weakNarration, type AuditBankLine, type AuditInput } from "../src/services/booksAudit.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

const MAP = { "Consultation & charges": "consultation", Investigations: "procedure", Injections: "procedure", Lasers: "procedure",
              "Other procedures": "procedure", Others: "procedure", Pharmacy: "pharmacy", Optical: "optical" } as const;
const RULES: BankRule[] = [
  { id: 1, position: 10, pattern: "UPI SETTLEMENT\\s*-RYX181-", class: "upi_settlement", method: "upi", windowDays: 3, isActive: true },
  { id: 2, position: 20, pattern: "TERMINAL 1 CARDS SETTL", class: "card_settlement", method: "card", windowDays: 3, isActive: true },
  { id: 3, position: 30, pattern: "CASH DEP", class: "cash_deposit", method: "cash", windowDays: 7, isActive: false },
];
let n = 0;
const pay = (onDate: string, method: PaymentRow["method"], amount: number, source = "clinic_bill"): PaymentRow =>
  ({ paymentId: `p${++n}`, source, sourceId: String(n), billNo: `B${n}`, onDate, patientId: 1, method, amount, ref: null });
const line = (onDate: string, serviceGroup: string, amount: number, source = "clinic_bill"): RevenueLine =>
  ({ lineId: `l${++n}`, source, sourceId: String(n), billNo: null, onDate, patientId: 1, serviceGroup, item: null, amount });
const refund = (onDate: string, method: RefundRow["method"], amount: number, source = "opd_refund"): RefundRow =>
  ({ refundId: `r${++n}`, source, sourceId: String(n), billNo: null, onDate, patientId: 1, method, amount, dateUncertain: method === "unrecorded" });
const credit = (date: string, amount: number, description: string, id = `t${++n}`): BankLine =>
  ({ transactionId: id, accountId: "A", date, amount, debitOrCredit: "credit", description, zohoStatus: "uncategorized", missing: false });
const upi = (d: string) => `UPI SETTLEMENT -RYX181- ${d.slice(8, 10)}/${d.slice(5, 7)}/26 Ref Num: XXXX`;
const card = (d: string) => `XXXX7444TERMINAL 1 CARDS SETTL. ${d.slice(8, 10)}/${d.slice(5, 7)}/26`;
const effects = (id: number, drafts: EffectDraft[], selfApproved = false): Effect[] => drafts.map((x) => ({ ...x, adjustmentId: id, selfApproved }));

function input(p: Partial<ReconInput>): ReconInput {
  return { from: "2026-10-09", to: "2026-10-09", today: "2026-10-28", lines: [], payments: [], refunds: [], bank: [], rules: RULES, effects: [],
           categoryMap: { ...MAP }, tolerance: {}, zoho: { configured: true, fetchedAt: "2026-10-28T09:00:00+05:30", feedRefreshedOn: "2026-10-28", stale: false }, ...p };
}
const row = (r: ReturnType<typeof reconcile>, date: string, method: string) => r.rows.find((x) => x.date === date && x.method === method)!;

// The shape of 9 Oct 2026 (figures as in Yarago and Zoho that day): UPI 18,590 in Yarago, a 2,400 refund recorded as cash,
// and the next day's UPI settlement 16,190. Card 4,285 settled the next day in full.
const OCT9 = () => input({
  lines: [line("2026-10-09", "Consultation & charges", 8550), line("2026-10-09", "Investigations", 25000), line("2026-10-09", "Lasers", 14700),
          line("2026-10-09", "Others", 2400), line("2026-10-09", "Pharmacy", 14350.94, "pharmacy_order")],
  payments: [pay("2026-10-09", "cash", 33150), pay("2026-10-09", "card", 3850), pay("2026-10-09", "upi", 13650),
             pay("2026-10-09", "cash", 8963, "pharmacy_payment"), pay("2026-10-09", "card", 435, "pharmacy_payment"), pay("2026-10-09", "upi", 4940, "pharmacy_payment")],
  refunds: [refund("2026-10-09", "cash", 2400)],
  bank: [credit("2026-10-10", 16190, upi("2026-10-10"), "Z-UPI"), credit("2026-10-10", 4285, card("2026-10-10"), "Z-CARD"),
         credit("2026-10-10", 50000, "NEFT FROM SOMEONE", "Z-NEFT")],
});

check("categories come from the service-group map; unknown groups count as procedure", () => {
  assert.equal(categoryOf("Consultation & charges", { ...MAP }), "consultation");
  assert.equal(categoryOf("Lasers", { ...MAP }), "procedure");
  assert.equal(categoryOf("Pharmacy", { ...MAP }), "pharmacy");
  assert.equal(categoryOf("Something new", { ...MAP }), "procedure");
  const r = reconcile(OCT9());
  assert.deepEqual(r.byCategory.map((c) => [c.category, c.billed]), [["consultation", 8550], ["procedure", 42100], ["pharmacy", 14350.94]]);
  assert.equal(r.totals.billed, 65000.94);
});

check("collected by method and by source; billed against collected per source", () => {
  const r = reconcile(OCT9());
  assert.equal(r.totals.collected, 64988);
  const m = Object.fromEntries(r.byMethod.map((x) => [x.method, x.collected]));
  assert.deepEqual(m, { cash: 42113, upi: 18590, card: 4285 });
  assert.deepEqual(r.bySourceMethod.find((x) => x.source === "pharmacy_payment" && x.method === "upi")?.collected, 4940);
  assert.deepEqual(r.billedVsCollected.map((x) => [x.source, x.billed, x.collected, x.gap]), [["clinic_bill", 50650, 50650, 0], ["pharmacy", 14350.94, 14338, 12.94]]);
});

check("bank credits: rules classify; an unknown credit is never counted; inactive rules and debits classify nothing", () => {
  assert.equal(classify(credit("2026-10-10", 1, upi("2026-10-10")), RULES)?.method, "upi");
  assert.equal(classify(credit("2026-10-10", 1, "BY CASH DEPOSIT"), RULES), null, "cash rule is off");
  assert.equal(classify({ ...credit("2026-10-10", 1, upi("2026-10-10")), debitOrCredit: "debit" }, RULES), null);
  const r = reconcile(OCT9());
  assert.deepEqual(r.unclassified.map((u) => u.transactionId), ["Z-NEFT"]);
  assert.equal(r.totals.unclassifiedCredits, 50000);
  assert.ok(r.totals.depositsMatched < 50000 && !r.credits.some((c) => c.transactionId === "Z-NEFT"), "the NEFT credit is not counted anywhere");
});

check("card settled next day in full: matched; UPI short by the refund: a difference, the credit shown but not forced", () => {
  const r = reconcile(OCT9());
  const c = row(r, "2026-10-09", "card");
  assert.equal(c.status, "matched"); assert.equal(c.deposited, 4285); assert.deepEqual(c.matches.map((x) => x.transactionId), ["Z-CARD"]);
  const u = row(r, "2026-10-09", "upi");
  assert.equal(u.status, "difference"); assert.equal(u.expected, 18590); assert.equal(u.deposited, 0); assert.equal(u.difference, 18590);
  assert.deepEqual(u.candidates.map((x) => x.transactionId), ["Z-UPI"]);
  assert.match(u.note!, /16,190 on 10 Oct \(−₹2,400 against the day\)/);
  assert.equal(r.credits.find((x) => x.transactionId === "Z-UPI")?.state, "unmatched");
  const cash = row(r, "2026-10-09", "cash");
  assert.equal(cash.status, "cash_in_hand"); assert.equal(cash.expected, 39713, "42,113 collected less the 2,400 cash refund");
  assert.equal(r.totals.cashInHand, 39713);
});

check("UPI paid, refund in Yarago as cash but paid by UPI: after approval the UPI settlement matches and cash is whole", () => {
  const drafts = effectsFor({ kind: "refund_method", onDate: "2026-10-09", amount: 2400, sourceMethod: "upi", recordedMethod: "cash", actualMethod: "upi" });
  assert.deepEqual(drafts.map((x) => [x.measure, x.method, x.amount]), [["refund", "cash", -2400], ["refund", "upi", 2400]]);
  assert.ok(drafts.every((x) => !(x.measure === "collected")), "collections by the original method are untouched");
  const r = reconcile({ ...OCT9(), effects: effects(7, drafts) });
  const u = row(r, "2026-10-09", "upi");
  assert.equal(u.expected, 16190); assert.equal(u.status, "matched"); assert.deepEqual(u.matches.map((x) => x.transactionId), ["Z-UPI"]);
  assert.equal(row(r, "2026-10-09", "cash").expected, 42113, "what the bookkeeper recorded as cash that day");
  assert.equal(r.totals.differenceToExplain, 0);
  assert.equal(r.totals.adjustments.count, 1); assert.equal(r.effects.length, 2);
});

check("UPI or card paid, refund given in cash but not in Yarago: cash in hand falls, the bank expectation stays, revenue falls", () => {
  for (const paidBy of ["upi", "card"] as const) {
    const base = input({ lines: [line("2026-10-09", "Investigations", 1500)], payments: [pay("2026-10-09", paidBy, 1500), pay("2026-10-09", "cash", 5000)],
                         bank: [credit("2026-10-10", 1500, paidBy === "upi" ? upi("2026-10-10") : card("2026-10-10"))] });
    const drafts = effectsFor({ kind: "refund_method", onDate: "2026-10-09", amount: 500, sourceMethod: paidBy, recordedMethod: null, actualMethod: "cash", category: "procedure" });
    assert.deepEqual(drafts.map((x) => [x.measure, x.method ?? x.category, x.amount]), [["refund", "cash", 500], ["revenue", "procedure", -500]]);
    const before = reconcile(base), after = reconcile({ ...base, effects: effects(8, drafts) });
    assert.equal(row(after, "2026-10-09", paidBy).expected, 1500, `${paidBy}: the full payment still reaches the bank`);
    assert.equal(row(after, "2026-10-09", paidBy).status, "matched");
    assert.equal(row(before, "2026-10-09", "cash").expected - row(after, "2026-10-09", "cash").expected, 500, "cash in hand is 500 less");
    assert.equal(after.totals.billedAdjusted, 1000);
    assert.equal(after.totals.netCollected, before.totals.netCollected - 500, "totals balance: 500 left the clinic");
  }
  assert.throws(() => effectsFor({ kind: "refund_method", onDate: "2026-10-09", amount: 500, sourceMethod: "upi", recordedMethod: "cash", actualMethod: "cash" }),
                AdjustmentRefused, "already shown that way");
});

check("a pending or rejected adjustment is simply not passed in: the tally is unchanged without its effects", () => {
  const a = reconcile(OCT9()), b = reconcile({ ...OCT9(), effects: [] });
  assert.deepEqual(a.totals, b.totals);
});

check("method, amount, date corrections, missing entry and fees", () => {
  const mc = effectsFor({ kind: "method_correction", onDate: "2026-09-28", amount: 3700, recordedMethod: "upi", actualMethod: "cash" });
  assert.deepEqual(mc.map((x) => [x.method, x.amount]), [["upi", -3700], ["cash", 3700]]);
  const ac = effectsFor({ kind: "amount_correction", onDate: "2026-09-28", amount: 800, recordedAmount: 1000, category: "consultation", actualMethod: "cash" });
  assert.deepEqual(ac.map((x) => [x.measure, x.amount]), [["revenue", -200], ["collected", -200]]);
  const zero = effectsFor({ kind: "amount_correction", onDate: "2026-09-28", amount: 0, recordedAmount: 300, category: "consultation", actualMethod: "cash" });
  assert.equal(zero[0].amount, -300, "an entry that should not exist");
  const dc = effectsFor({ kind: "date_correction", onDate: "2026-09-28", otherDate: "2026-09-27", amount: 600, actualMethod: "upi" });
  assert.deepEqual(dc.map((x) => [x.onDate, x.amount]), [["2026-09-28", -600], ["2026-09-27", 600]]);
  const me = effectsFor({ kind: "missing_entry", onDate: "2026-09-28", amount: 350, category: "pharmacy", actualMethod: "upi" });
  assert.deepEqual(me.map((x) => [x.measure, x.amount]), [["revenue", 350], ["collected", 350]]);
  const fee = effectsFor({ kind: "payment_fee", onDate: "2026-10-09", amount: 85.7, actualMethod: "card", zohoTxnId: "Z-FEE" });
  assert.deepEqual(fee.map((x) => [x.measure, x.method, x.amount]), [["fee", "card", 85.7]]);
  // a card settlement short by the fee matches once the fee is approved
  const base = input({ payments: [pay("2026-10-09", "card", 4285)], bank: [credit("2026-10-10", 4199.3, card("2026-10-10"))] });
  assert.equal(row(reconcile(base), "2026-10-09", "card").status, "difference");
  const r = reconcile({ ...base, effects: effects(9, fee) });
  assert.equal(row(r, "2026-10-09", "card").status, "matched"); assert.equal(r.totals.adjustments.fees, 85.7);
  assert.throws(() => effectsFor({ kind: "method_correction", onDate: "2026-09-28", amount: 1, recordedMethod: "upi", actualMethod: "upi" }), AdjustmentRefused);
  assert.throws(() => effectsFor({ kind: "missing_entry", onDate: "2026-09-28", amount: 0, category: "pharmacy", actualMethod: "upi" }), AdjustmentRefused);
});

check("a classified bank credit counts for its day; a credit classified as not clinic money is never counted", () => {
  const base = input({ payments: [pay("2026-10-09", "upi", 2400)], bank: [credit("2026-10-11", 2400, "UPI/P2A/ABCD/SOMEONE", "Z-P2A"), credit("2026-10-11", 900, "UPI/REFUND", "Z-X")] });
  const r0 = reconcile(base);
  assert.equal(row(r0, "2026-10-09", "upi").status, "difference");
  assert.equal(r0.unclassified.length, 2);
  const yes = effectsFor({ kind: "bank_credit", onDate: "2026-10-09", amount: 2400, bankAmount: 2400, bankClass: "clinic", actualMethod: "upi", zohoTxnId: "Z-P2A" });
  const no = effectsFor({ kind: "bank_credit", onDate: "2026-10-09", amount: 900, bankAmount: 900, bankClass: "not_clinic", zohoTxnId: "Z-X" });
  const r = reconcile({ ...base, effects: [...effects(10, yes), ...effects(11, no)] });
  assert.equal(row(r, "2026-10-09", "upi").status, "matched");
  assert.equal(r.unclassified.length, 0);
  assert.equal(r.credits.find((c) => c.transactionId === "Z-X")?.state, "excluded");
  assert.equal(r.totals.depositsMatched, 2400);
  assert.throws(() => effectsFor({ kind: "bank_credit", onDate: "2026-10-09", amount: 2000, bankAmount: 2400, bankClass: "clinic", actualMethod: "upi", zohoTxnId: "Z" }),
                /classify the whole amount/);
});

check("settlement window: a credit inside it matches, one after it does not", () => {
  const inside = reconcile(input({ payments: [pay("2026-10-09", "upi", 1000)], bank: [credit("2026-10-12", 1000, upi("2026-10-12"))] }));
  assert.equal(row(inside, "2026-10-09", "upi").status, "matched");
  const after = reconcile(input({ payments: [pay("2026-10-09", "upi", 1000)], bank: [credit("2026-10-13", 1000, upi("2026-10-13"))] }));
  assert.equal(row(after, "2026-10-09", "upi").status, "difference");
  const before = reconcile(input({ payments: [pay("2026-10-09", "upi", 1000)], bank: [credit("2026-10-08", 1000, upi("2026-10-08"))] }));
  assert.equal(row(before, "2026-10-09", "upi").status, "difference", "money cannot settle before it is taken");
});

check("weekend: one credit for a run of consecutive days; earlier days settling inside the period are matched first", () => {
  const r = reconcile(input({ from: "2026-10-03", to: "2026-10-05",
    payments: [pay("2026-10-03", "card", 1200), pay("2026-10-04", "card", 800), pay("2026-10-05", "card", 400)],
    bank: [credit("2026-10-05", 2000, card("2026-10-05")), credit("2026-10-06", 400, card("2026-10-06"))] }));
  assert.equal(row(r, "2026-10-03", "card").status, "matched"); assert.equal(row(r, "2026-10-04", "card").status, "matched");
  assert.match(row(r, "2026-10-04", "card").note!, /covers 3 Oct, 4 Oct/);
  assert.equal(row(r, "2026-10-05", "card").status, "matched");
  // a day before the period settling inside it uses its credit, so the period's day is not matched to it by mistake
  const r2 = reconcile(input({ from: "2026-10-09", to: "2026-10-09", payments: [pay("2026-10-08", "upi", 500), pay("2026-10-09", "upi", 700)],
                               bank: [credit("2026-10-09", 500, upi("2026-10-09")), credit("2026-10-10", 700, upi("2026-10-10"))] }));
  assert.equal(row(r2, "2026-10-09", "upi").status, "matched");
  assert.equal(r2.credits.find((c) => c.amount === 500)?.state, "before_period");
  assert.equal(r2.rows.length, 1, "only the period's days are reported");
});

check("tolerance: a credit within it matches as within tolerance; outside it is a difference", () => {
  const base = { payments: [pay("2026-10-09", "card", 1000)], bank: [credit("2026-10-10", 998, card("2026-10-10"))] };
  assert.equal(row(reconcile(input(base)), "2026-10-09", "card").status, "difference");
  const r = reconcile(input({ ...base, tolerance: { card: 5 } }));
  assert.equal(row(r, "2026-10-09", "card").status, "within_tolerance"); assert.equal(row(r, "2026-10-09", "card").difference, 2);
});

check("two possible credits, or two days for one credit: uncertain, nothing forced", () => {
  const r = reconcile(input({ from: "2026-10-08", to: "2026-10-09", payments: [pay("2026-10-08", "upi", 1000), pay("2026-10-09", "upi", 1000)],
                              bank: [credit("2026-10-10", 1000, upi("2026-10-10"))] }));
  assert.equal(row(r, "2026-10-08", "upi").status, "uncertain"); assert.equal(row(r, "2026-10-09", "upi").status, "uncertain");
  assert.equal(r.totals.uncertain, 2000); assert.equal(r.totals.depositsMatched, 0);
  const r2 = reconcile(input({ payments: [pay("2026-10-09", "upi", 1000)], bank: [credit("2026-10-10", 1000, upi("2026-10-10")), credit("2026-10-11", 1000, upi("2026-10-11"))] }));
  assert.equal(row(r2, "2026-10-09", "upi").status, "uncertain"); assert.equal(row(r2, "2026-10-09", "upi").candidates.length, 2);
});

check("waiting for settlement and stale or missing bank data are not differences", () => {
  const waiting = reconcile(input({ from: "2026-10-27", to: "2026-10-27", today: "2026-10-28", payments: [pay("2026-10-27", "upi", 900)] }));
  assert.equal(row(waiting, "2026-10-27", "upi").status, "awaiting"); assert.equal(waiting.totals.differenceToExplain, 0); assert.equal(waiting.totals.notYetDue, 900);
  const feedBehind = reconcile(input({ from: "2026-10-20", to: "2026-10-20", zoho: { configured: true, fetchedAt: "2026-10-28T09:00:00+05:30", feedRefreshedOn: "2026-10-21", stale: false },
                                       payments: [pay("2026-10-20", "upi", 900)] }));
  assert.equal(row(feedBehind, "2026-10-20", "upi").status, "no_bank_data"); assert.match(row(feedBehind, "2026-10-20", "upi").note!, /up to 21 Oct/);
  const stale = reconcile({ ...OCT9(), zoho: { configured: true, fetchedAt: "2026-10-20T09:00:00+05:30", feedRefreshedOn: "2026-10-20", stale: true } });
  assert.equal(row(stale, "2026-10-09", "upi").status, "no_bank_data"); assert.match(row(stale, "2026-10-09", "upi").note!, /out of date/);
  const none = reconcile({ ...OCT9(), bank: [], zoho: { configured: false, fetchedAt: null, feedRefreshedOn: null, stale: false } });
  assert.equal(row(none, "2026-10-09", "upi").status, "no_bank_data"); assert.equal(none.totals.differenceToExplain, 0);
  assert.equal(row(none, "2026-10-09", "upi").note, "Zoho is not connected yet");
});

check("refunds without a recorded method are listed as uncertain and taken off no method", () => {
  const r = reconcile(input({ payments: [pay("2026-10-09", "cash", 1000, "pharmacy_payment")], refunds: [refund("2026-10-09", "unrecorded", 120, "pharmacy_refund")] }));
  assert.equal(r.totals.refundsUnrecorded, 120); assert.equal(r.refundsUnrecordedList.length, 1);
  assert.equal(row(r, "2026-10-09", "cash").expected, 1000);
});

check("cash stays in hand until a recorded deposit covers its day; a bank cash credit alone deposits nothing; cheque without a rule is not tracked", () => {
  const rules = RULES.map((x) => (x.id === 3 ? { ...x, isActive: true } : x));
  const base = input({ from: "2026-10-08", to: "2026-10-09", rules, payments: [pay("2026-10-08", "cash", 3000), pay("2026-10-09", "cash", 5000), pay("2026-10-09", "cheque", 700)],
                       bank: [credit("2026-10-10", 3000, "BY CASH DEP TIRUR", "Z-CASH")] });
  const r0 = reconcile(base);
  assert.equal(r0.totals.cashDeposited, 0); assert.equal(r0.totals.cashInHand, 8000);
  assert.equal(r0.credits.find((c) => c.transactionId === "Z-CASH")?.state, "unmatched", "shown to look at: not recorded by the cash desk");
  const r = reconcile({ ...base, cash: { deposits: [{ id: 4, depositedOn: "2026-10-10", coversFrom: "2026-10-01", coversTo: "2026-10-08" }], matchedCreditIds: ["Z-CASH"] } });
  assert.equal(row(r, "2026-10-08", "cash").status, "cash_deposited"); assert.match(row(r, "2026-10-08", "cash").note!, /deposit #4 of 10 Oct/);
  assert.equal(row(r, "2026-10-09", "cash").status, "cash_in_hand");
  assert.equal(r.totals.cashDeposited, 3000); assert.equal(r.totals.cashInHand, 5000);
  assert.equal(r.credits.find((c) => c.transactionId === "Z-CASH")?.state, "matched");
  assert.equal(row(r, "2026-10-09", "cheque").status, "not_tracked");
  // days before the cash book's start are not called cash in hand
  const early = reconcile({ ...base, cash: { start: "2026-10-09", deposits: [], matchedCreditIds: [] } });
  assert.equal(row(early, "2026-10-08", "cash").status, "not_tracked"); assert.match(row(early, "2026-10-08", "cash").note!, /Before the cash book/);
  assert.equal(early.totals.cashInHand, 5000);
});

// ---- D-053: net settlement and bank fees --------------------------------------------------------
const RATES: FeeRate[] = [
  { effectiveFrom: "2020-01-01", method: "card", kind: "rupay_debit", amountAbove: 0, amountUpto: null, ratePct: 0, capRupees: null, flatRupees: null },
  { effectiveFrom: "2020-01-01", method: "card", kind: "debit", amountAbove: 0, amountUpto: 2000, ratePct: 0.4, capRupees: null, flatRupees: null },
  { effectiveFrom: "2020-01-01", method: "card", kind: "debit", amountAbove: 2000, amountUpto: null, ratePct: 0.9, capRupees: 1000, flatRupees: null },
  { effectiveFrom: "2020-01-01", method: "card", kind: "credit", amountAbove: 0, amountUpto: null, ratePct: 1.85, capRupees: null, flatRupees: null },
  { effectiveFrom: "2020-01-01", method: "card", kind: "international", amountAbove: 0, amountUpto: null, ratePct: 3, capRupees: null, flatRupees: null },
  { effectiveFrom: "2020-01-01", method: "upi", kind: "upi", amountAbove: 0, amountUpto: null, ratePct: 0, capRupees: null, flatRupees: null },
  { effectiveFrom: "2026-10-15", method: "card", kind: "credit", amountAbove: 0, amountUpto: null, ratePct: 1.85, capRupees: null, flatRupees: null },
  { effectiveFrom: "2026-10-15", method: "upi", kind: "upi", amountAbove: 0, amountUpto: 2000, ratePct: 0, capRupees: null, flatRupees: null },
  { effectiveFrom: "2026-10-15", method: "upi", kind: "upi", amountAbove: 2000, amountUpto: null, ratePct: 0.4, capRupees: 300, flatRupees: null },
];
const withBands = (p: ReconInput) => ({ ...p, feeBands: dayBands(p.payments, RATES, 18) });

check("fee rates: the set in force on the day, bands per payment, caps, and UPI's fee from 15 Oct 2026", () => {
  assert.equal(ratesOn(RATES, "2026-10-14").length, 6); assert.equal(ratesOn(RATES, "2026-10-15").length, 3);
  assert.equal(feeOn(5000, "card", "debit", ratesOn(RATES, "2026-10-09")), 4500, "0.9% of ₹5,000 = ₹45 (paise)");
  assert.equal(feeOn(200000, "card", "debit", ratesOn(RATES, "2026-10-09")), 100000, "capped at ₹1,000");
  assert.equal(feeOn(1500, "card", "debit", ratesOn(RATES, "2026-10-09")), 600, "0.4% up to ₹2,000");
  const b = paymentBand(1000, "card", "2026-10-09", RATES, 18);
  assert.deepEqual(b, { low: 0, high: Math.round(1850 * 1.18), ceiling: Math.round(3000 * 1.18) }, "RuPay debit free; credit 1.85% + GST; international 3% + GST");
  assert.deepEqual(paymentBand(5000, "upi", "2026-10-14", RATES, 18), { low: 0, high: 0, ceiling: 0 }, "no UPI fee before 15 Oct");
  assert.equal(paymentBand(5000, "upi", "2026-10-16", RATES, 18).high, Math.round(2000 * 1.18), "0.4% above ₹2,000 from 15 Oct");
  assert.equal(paymentBand(100000, "upi", "2026-10-16", RATES, 18).high, Math.round(30000 * 1.18), "capped at ₹300 + GST");
  assert.equal(paymentBand(1500, "upi", "2026-10-16", RATES, 18).high, 0, "nothing up to ₹2,000");
  const bands = dayBands([pay("2026-10-09", "card", 1000), pay("2026-10-09", "card", 3000), pay("2026-10-09", "cash", 900)], RATES, 18);
  assert.deepEqual(Object.keys(bands), ["2026-10-09|card"]); assert.equal(bands["2026-10-09|card"].payments, 2);
});

check("HDFC card settles net (23 Sep 2026: ₹11,458 in Yarago, ₹11,391.74 in the bank): settled less the bank fee, not a difference", () => {
  const p = withBands(input({ from: "2026-09-23", to: "2026-09-23",
    payments: [pay("2026-09-23", "card", 2500), pay("2026-09-23", "card", 3958), pay("2026-09-23", "card", 5000)],
    bank: [credit("2026-09-24", 11391.74, card("2026-09-24"), "Z-NET")] }));
  const r = reconcile(p), c = row(r, "2026-09-23", "card");
  assert.equal(c.status, "settled_less_fee"); assert.equal(c.bankFee, 66.26); assert.equal(c.difference, 0); assert.equal(c.deposited, 11391.74);
  assert.match(c.note!, /Bank kept ₹66.26 \(0.58%\)/);
  assert.equal(r.totals.bankFees, 66.26); assert.equal(r.totals.differenceToExplain, 0);
  assert.equal(r.byMethod.find((m) => m.method === "card")?.bankFees, 66.26);
  // without the rates the same credit is a difference: the band is what explains it
  assert.equal(row(reconcile({ ...p, feeBands: {} }), "2026-09-23", "card").status, "difference");
});

check("a fee above the dearest usual card is flagged; one above the international ceiling is a difference", () => {
  const base = (amount: number) => withBands(input({ payments: [pay("2026-10-09", "card", 10000)], bank: [credit("2026-10-10", amount, card("2026-10-10"))] }));
  assert.equal(row(reconcile(base(9800)), "2026-10-09", "card").status, "settled_less_fee", "2% kept: within 1.85% + GST");
  const high = reconcile(base(9700));
  assert.equal(row(high, "2026-10-09", "card").status, "fee_high", "3% kept: above 2.18%, within 3.54%");
  assert.equal(high.totals.feeHighDays, 1);
  assert.equal(row(reconcile(base(9500)), "2026-10-09", "card").status, "difference", "5% short: not a fee");
  assert.equal(row(reconcile(base(10100)), "2026-10-09", "card").status, "difference", "more than the day's money is never a fee");
});

check("a weekend run settled net shares the fee by what each day could carry", () => {
  const r = reconcile(withBands(input({ from: "2026-10-03", to: "2026-10-04",
    payments: [pay("2026-10-03", "card", 6000), pay("2026-10-04", "card", 4000)], bank: [credit("2026-10-05", 9850, card("2026-10-05"))] })));
  const a = row(r, "2026-10-03", "card"), b = row(r, "2026-10-04", "card");
  assert.equal(a.status, "settled_less_fee"); assert.equal(b.status, "settled_less_fee");
  assert.equal(a.bankFee + b.bankFee, 150); assert.equal(a.bankFee, 90); assert.equal(a.deposited + b.deposited, 9850);
});

check("fee report: per day and month, effective rate, charges, late card batches", () => {
  const p = withBands(input({ from: "2026-09-23", to: "2026-09-26",
    payments: [pay("2026-09-23", "card", 11458), pay("2026-09-23", "upi", 42563), pay("2026-09-24", "card", 3200)],
    bank: [credit("2026-09-24", 11391.74, card("2026-09-24")), credit("2026-09-24", 42563, upi("2026-09-24"))] }));
  const r = reconcile(p);
  const settled = new Set(["matched", "within_tolerance", "settled_less_fee", "fee_high"]);
  const f = feeReport(r.rows.map((x) => ({ date: x.date, method: x.method, expected: x.expected, deposited: x.deposited, bankFee: x.bankFee, status: x.status, band: x.band, matched: settled.has(x.status) })),
                      [{ transactionId: "Z-SC", date: "2026-09-15", amount: 116.82, description: "Service Charges-SEP26" }],
                      { gstPct: 18, servicePerMonth: 99, perBatch: 1, lateSettleDays: 2 }, "2026-10-11");
  assert.equal(f.totals.cardFees, 66.26); assert.equal(f.totals.cardPct, 0.58); assert.equal(f.totals.upiFees, 0); assert.equal(f.totals.upiPct, 0);
  assert.equal(f.totals.charges, 116.82); assert.equal(f.upiFeesSeen, false);
  assert.deepEqual(f.months.map((m) => [m.month, m.method, m.sales, m.feesKept]), [["2026-09", "card", 14658, 66.26], ["2026-09", "upi", 42563, 0]]);
  assert.deepEqual(f.late.map((l) => l.date), ["2026-09-24"], "the ₹3,200 card day never settled");
  assert.equal(f.days.find((d) => d.date === "2026-09-23" && d.method === "card")?.state, "normal");
});

// ---- D-053: the cash book ------------------------------------------------------------------------
const CASH_RULES = RULES.map((x) => (x.id === 3 ? { ...x, pattern: "^CASH DEPOSIT BY\\b", isActive: true } : x));
let depId = 0;
const dep = (depositedOn: string, coversTo: string, amount: number, extra: Partial<CashDeposit> = {}): CashDeposit =>
  ({ id: ++depId, depositedOn, coversTo, amount, slipNo: null, note: null, recordedBy: 2, recordedByName: "Manager", recordedAt: `${depositedOn} 12:00`,
     status: "recorded", voidReason: null, voidedByName: null, voidedAt: null, ...extra });
const cashCredit = (date: string, amount: number, id = `c${++n}`) => credit(date, amount, "CASH DEPOSIT BY - SYAMILI - TIRUR", id);
const bookInput = (p: Partial<CashBookInput>): CashBookInput => ({
  start: "2026-10-11", opening: 0, bankFrom: "2026-10-18", today: "2026-10-28",
  days: [{ date: "2026-10-12", net: 42336 }, { date: "2026-10-13", net: 57772 }, { date: "2026-10-14", net: 48245 }, { date: "2026-10-15", net: 63828 },
         { date: "2026-10-16", net: 48327 }, { date: "2026-10-17", net: 43541 }, { date: "2026-10-19", net: 15085 }, { date: "2026-10-21", net: 23696 }],
  deposits: [], bank: [], rules: CASH_RULES, limits: { warnAt: 300000, limit: 400000, carryBand: 99 },
  bankKnownUntil: "2026-10-28", bankTrusted: true, ...p });

check("cash book: the drawer's carry rolls forward; rounding within ₹99 is normal; more is short or excess", () => {
  const b = cashBook(bookInput({ deposits: [dep("2026-10-15", "2026-10-14", 148300), dep("2026-10-20", "2026-10-17", 204000), dep("2026-10-23", "2026-10-21", 39000)] }));
  const [a, c, d] = b.deposits;
  assert.equal(a.coversFrom, "2026-10-11"); assert.equal(a.yaragoCash, 148353); assert.equal(a.carryOut, 53); assert.equal(a.check, "ok");
  assert.match(a.checkWords, /₹53 kept in the drawer/);
  assert.equal(c.coversFrom, "2026-10-15"); assert.equal(c.carryIn, 53); assert.equal(c.yaragoCash, 155696); assert.equal(c.carryOut, -48251);
  assert.equal(c.check, "excess", "₹2,04,000 banked against ₹1,55,749 in the drawer");
  assert.equal(d.carryIn, -48251); assert.equal(d.carryOut, -48470);
  const short = cashBook(bookInput({ deposits: [dep("2026-10-15", "2026-10-14", 148000)] }));
  assert.equal(short.deposits[0].check, "short"); assert.match(short.deposits[0].checkWords, /₹353 less banked/);
});

check("cash book: a deposit is found in the bank only by an exact, unique cash-deposit credit within 3 days; a near amount is shown, not matched", () => {
  const ok = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304049)], bank: [cashCredit("2026-10-20", 304049, "Z-D1")] }));
  assert.equal(ok.deposits[0].bank, "found"); assert.deepEqual(ok.matchedCreditIds, ["Z-D1"]); assert.equal(ok.unrecorded.length, 0);
  // 17 Oct 2026: the clinic remembered ₹3,53,150; the bank shows ₹3,52,150
  const typo = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304149)], bank: [cashCredit("2026-10-20", 304049, "Z-D2")] }));
  assert.equal(typo.deposits[0].bank, "not_found"); assert.match(typo.deposits[0].bankWords, /the bank shows ₹3,04,049 on 20 Oct/);
  assert.deepEqual(typo.unrecorded.map((u) => u.transactionId), ["Z-D2"]);
  const later = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304049)], bank: [cashCredit("2026-10-24", 304049)] }));
  assert.equal(later.deposits[0].bank, "not_found", "4 days later is outside the window");
  const waiting = cashBook(bookInput({ deposits: [dep("2026-10-27", "2026-10-21", 38781)], bankKnownUntil: "2026-10-27" }));
  assert.equal(waiting.deposits[0].bank, "waiting");
  const stale = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304049)], bankTrusted: false }));
  assert.equal(stale.deposits[0].bank, "no_bank_data");
  const two = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304049)], bank: [cashCredit("2026-10-20", 304049), cashCredit("2026-10-21", 304049)] }));
  assert.equal(two.deposits[0].bank, "uncertain");
  const early = cashBook(bookInput({ bank: [cashCredit("2026-10-17", 352150)] }));
  assert.equal(early.unrecorded.length, 0, "credits before bankFrom (the 17 Oct deposit of 1-10 Oct cash) are not expected in the book");
});

check("cash in hand, its age and the ₹4,00,000 limit; voided deposits do not count", () => {
  const none = cashBook(bookInput({}));
  assert.equal(none.inHand.amount, 342830); assert.equal(none.inHand.level, "soon"); assert.equal(none.inHand.firstCashDay, "2026-10-12");
  assert.equal(none.inHand.daysSinceLastDeposit, null);
  const over = cashBook(bookInput({ days: [...bookInput({}).days, { date: "2026-10-22", net: 60000 }] }));
  assert.equal(over.inHand.level, "over"); assert.match(over.inHand.levelWords, /Over the ₹4,00,000 limit/);
  const after = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304000), dep("2026-10-19", "2026-10-16", 1, { status: "voided", voidReason: "typed wrong" })] }));
  assert.equal(after.deposits.length, 1); assert.equal(after.voided.length, 1);
  assert.equal(after.inHand.amount, 304049 - 304000 + 15085 + 23696); assert.equal(after.inHand.level, "ok");
  assert.equal(after.inHand.since, "2026-10-18"); assert.equal(after.inHand.daysSinceLastDeposit, 8);
  assert.equal(after.days.find((d) => d.date === "2026-10-13")?.depositId, after.deposits[0].id);
});

check("the cash desk's view is blind: no Yarago cash, carry, check or amount in hand", () => {
  const b = cashBook(bookInput({ deposits: [dep("2026-10-20", "2026-10-17", 304149)], bank: [cashCredit("2026-10-20", 304049)] }));
  const desk = JSON.stringify(deskView(b));
  for (const hidden of ["yaragoCash", "carryIn", "carryOut", "checkWords", "possible", "342830", "304049"])
    assert.ok(!desk.includes(hidden), `desk view must not include ${hidden}`);
  const v = deskView(b);
  assert.equal(v.deposits[0].amount, 304149, "the desk sees what it recorded");
  assert.equal(v.deposits[0].bankWords, "Not found in the bank: tell the admin");
  assert.equal(v.inHand.level, "ok"); assert.equal(v.nextCoversFrom, "2026-10-18");
  assert.equal(deskView(cashBook(bookInput({}))).inHand.level, "soon", "the desk sees the level in words, not the amount");
});

// ---- D-053: access per login ---------------------------------------------------------------------
check("access: role defaults with a login's own changes; finance only by name; admins always have everything", () => {
  assert.ok(!effectivePermissions("manager").includes("reconciliation.read"), "managers no longer get finance by role");
  assert.ok(!effectivePermissions("doctor").includes("reconciliation.read"));
  const sameera = effectivePermissions("doctor", { "reconciliation.read": true, "adjustments.submit": true });
  assert.ok(sameera.includes("reconciliation.read") && sameera.includes("fundus.report"));
  const desk = effectivePermissions("manager", { "cash.deposit": true, "audit.read": false });
  assert.ok(desk.includes("cash.deposit") && !desk.includes("reconciliation.read") && !desk.includes("audit.read"));
  assert.deepEqual(effectivePermissions("admin", { "users.manage": false, "fundus.report": true }), PERMISSIONS.filter((p) => p !== "fundus.report"),
                   "an admin cannot be limited, nor given fundus reports (D-042)");
  assert.ok(!effectivePermissions("staff", { "nonsense.perm": true } as any).includes("nonsense.perm" as any));
});

check("a reversal's effects cancel the original exactly", () => {
  const orig = effectsFor({ kind: "method_correction", onDate: "2026-09-28", amount: 3700, recordedMethod: "upi", actualMethod: "cash" });
  const rev = reversalEffects(12, orig);
  assert.deepEqual(rev.map((x) => x.amount), [3700, -3700]); assert.match(rev[0].words, /^Reverses #12: /);
  const base = input({ from: "2026-09-28", to: "2026-09-28", payments: [pay("2026-09-28", "upi", 17695), pay("2026-09-28", "cash", 42935)] });
  const both = reconcile({ ...base, effects: [...effects(12, orig), ...effects(13, rev)] });
  assert.deepEqual(both.byMethod.map((m) => m.net), reconcile(base).byMethod.map((m) => m.net));
});

check("same input, same answer (no hidden state, no clock)", () => {
  assert.deepEqual(reconcile(OCT9()), reconcile(OCT9()));
});

// ---------- a statement imported by PDF over the feed (28 Oct 2026), and the Books audit (D-054) ----------
check("a PDF statement's lines match the rules (double spaces, RY9181 spelt out) and a line imported twice counts once", () => {
  const rules: BankRule[] = [{ ...RULES[0], pattern: "UPI SETTLEMENT\\s*-RY[X9]181-" }, RULES[1]];
  const pdfUpi = credit("2026-10-22", 20901.79, "UPI  SETTLEMENT  -RY9181-  22/10/26");
  const pdfCard = credit("2026-10-22", 18599.6, "66027444TERMINAL  1  CARDS  SETTL.  22/10/26");
  assert.equal(classify(pdfUpi, rules)?.class, "upi_settlement"); assert.equal(classify(pdfCard, rules)?.class, "card_settlement");
  assert.equal(lineShape("UPI SETTLEMENT -RYX181- 21/10/26 Ref Num: XXXXXXXXXXX0000"), lineShape("UPI  SETTLEMENT  -RY9181-  21/10/26"));
  assert.equal(lineShape("XXXX7444TERMINAL 1 CARDS SETTL. 02/09/26 Ref Num: X"), lineShape("66027444TERMINAL 1 CARDS SETTL. 02/09/26"));
  assert.notEqual(lineShape("NEFT DR-KLGBXXXX157-LEELA K T-NETBANK"), lineShape("NEFT DR-IDIB000T139-DIVYA OPTOMETRY-NETBANK"), "two people paid the same amount are not one line");
  const feed = { ...credit("2026-10-21", 281, "UPI SETTLEMENT -RYX181- 21/10/26 Ref Num: XXXXXXXXXXX0000", "1274340000002395002"), zohoStatus: "categorized" };
  const pdf = credit("2026-10-21", 281, "UPI  SETTLEMENT  -RY9181-  21/10/26", "1274340000002399001");
  const { lines, repeats } = splitRepeats([pdf, feed, pdfUpi]);
  assert.deepEqual(lines.map((l) => l.transactionId).sort(), [feed.transactionId, pdfUpi.transactionId].sort(), "the categorised copy is kept");
  assert.equal(repeats.length, 1); assert.equal(repeats[0].copy.transactionId, pdf.transactionId);
  // counted once by the reconciliation: one exact match, not "uncertain"
  const r = reconcile(input({ from: "2026-10-20", to: "2026-10-20", rules, payments: [pay("2026-10-20", "upi", 281)], bank: lines }));
  assert.equal(row(r, "2026-10-20", "upi").status, "matched");
});

const AL = (date: string, amount: number, side: "credit" | "debit", description: string, extra: Partial<AuditBankLine> = {}): AuditBankLine =>
  ({ transactionId: `a${++n}`, accountId: "A", date, amount, debitOrCredit: side, description, zohoStatus: "uncategorized", missing: false, type: "uncategorized", offsetAccount: null, ...extra });
const AUDIT_RULES: BankRule[] = [{ ...RULES[0], pattern: "UPI SETTLEMENT\\s*-RY[X9]181-" }, RULES[1],
  { id: 3, position: 30, pattern: "^CASH DEPOSIT BY\\b", class: "cash_deposit", method: "cash", windowDays: 3, isActive: true },
  { id: 4, position: 40, pattern: "^(SERVICE|LOW USAGE|SETTLEMENT) CHARGES?-[A-Z]{3}[0-9X]{2}-", class: "bank_charge", method: "card", windowDays: 0, isActive: true }];
const audit = (p: Partial<AuditInput>) => booksAudit({ today: "2026-10-30", settings: { ...DEFAULT_AUDIT, from: "2026-10-01", qualityFrom: "2026-10-01" },
  rules: AUDIT_RULES, bank: [], clinicDays: [], invoices: [], expenses: [], ...p });
const C = (r: ReturnType<typeof booksAudit>, key: string) => r.checks.find((c) => c.key === key)!;

check("books audit: only work older than a week is due (Basith comes weekly); newer work is 'not due yet', never amber or red", () => {
  const r = audit({ bank: [AL("2026-10-29", 9851.96, "credit", "UPI  SETTLEMENT  -RY9181-  29/10/26"), AL("2026-10-17", 352150, "credit", "CASH DEPOSIT BY - SYAMILI - TIRUR"),
                           AL("2026-10-15", 116.82, "debit", "SERVICE CHARGES-SEPXX-XXXXX444-RY9181 Ref Num: X")] });
  assert.equal(r.dueBefore, "2026-10-23");
  const inn = C(r, "uncat_in");
  assert.deepEqual([inn.due, inn.notDue, inn.level], [1, 1, "amber"]);
  assert.match(inn.items[0].todo, /Transfer from Petty Cash/, "a cash deposit is a transfer from Petty Cash");
  assert.match(C(r, "uncat_out").items[0].todo, /Bank Fees and Charges/, "the masked terminal charge is a bank charge");
  const fresh = audit({ bank: [AL("2026-10-29", 9851.96, "credit", "UPI SETTLEMENT -RYX181- 29/10/26")] });
  assert.equal(C(fresh, "uncat_in").level, "green");
});

check("books audit: bank behind, days missing from the statement, lines twice, clinic money of the wrong kind", () => {
  const days = [{ date: "2026-10-05", collected: 50000, upiCard: 20000 }, { date: "2026-10-06", collected: 40000, upiCard: 15000 }];
  const bank = [AL("2026-10-05", 100, "debit", "X"), AL("2026-10-06", 100, "debit", "Y"), AL("2026-10-09", 100, "debit", "Z"), AL("2026-10-20", 5, "debit", "LAST"),
                AL("2026-10-12", 30887.83, "credit", "UPI SETTLEMENT -RYX181- 11/10/26", { zohoStatus: "categorized", type: "deposit", offsetAccount: "General Income" }),
                AL("2026-10-02", 2897, "credit", "UPI SETTLEMENT -RYX181- 01/10/26 Ref Num: X", { zohoStatus: "categorized", type: "customer_payment" }),
                AL("2026-10-02", 2897, "credit", "UPI SETTLEMENT -RY9181- 01/10/26")];
  const r = audit({ clinicDays: days, bank });
  assert.equal(C(r, "bank_current").level, "red", "10 days behind");
  assert.match(C(r, "bank_current").items[0].todo, /from 21 Oct/);
  assert.deepEqual(C(r, "bank_gaps").items.map((i) => i.date), ["2026-10-07"], "6 Oct's UPI and card had no bank line on 7 or 8 Oct; 5 Oct's settled on 6 Oct");
  assert.equal(C(r, "repeats").due, 1); assert.equal(C(r, "repeats").level, "red");
  assert.match(C(r, "repeats").items[0].todo, /uncategorised copy.*categorised already/);
  assert.equal(C(r, "uncat_in").due, 0, "the copy is a repeat, not money to categorise");
  assert.match(C(r, "wrong_type").items[0].what, /UPI settlement ₹30,887.83 booked as deposit \(General Income\)/);
});

check("books audit: daily Patients invoice missing, differing from Yarago, unpaid, entered late; not measured without the scope", () => {
  const days = [{ date: "2026-10-08", collected: 66864, upiCard: 20000 }, { date: "2026-10-09", collected: 64988, upiCard: 22875 }, { date: "2026-10-10", collected: 80128, upiCard: 30000 }];
  const inv = (number: string, date: string, total: number, balance: number, createdOn: string) =>
    ({ id: number, number, date, customer: "Patients", status: balance ? "overdue" : "paid", total, balance, createdOn });
  const r = audit({ clinicDays: days, invoices: [inv("INV-0784", "2026-10-08", 66864, 0, "2026-10-22"), inv("INV-0785", "2026-10-09", 62588, 0, "2026-10-22"),
                                                 { ...inv("X", "2026-10-10", 5, 5, "2026-10-22"), customer: "Eyegear Optics" }] });
  assert.deepEqual(C(r, "invoice_missing").items.map((i) => i.date), ["2026-10-10"], "another customer's invoice is not the Patients invoice");
  assert.match(C(r, "invoice_amount").items[0].what, /INV-0785 9 Oct: ₹62,588 in Zoho, ₹64,988 collected in Yarago \(less by ₹2,400\)/);
  assert.equal(C(r, "invoice_unpaid").due, 0);
  assert.match(C(r, "invoice_lag").summary, /^14 days late on average/); assert.equal(C(r, "invoice_lag").level, "amber");
  const unpaid = audit({ clinicDays: days, invoices: [inv("INV-0774", "2026-10-08", 259074, 259074, "2026-10-15")] });
  assert.match(C(unpaid, "invoice_unpaid").items[0].todo, /Record the day's payments/);
  const none = audit({ invoices: null, expenses: null });
  assert.equal(none.checks.filter((c) => c.level === "not_measured").length, 9);
  assert.ok(none.score != null, "the score counts only what is measured");
});

check("books audit: expense narration, vendor, receipt, vague account, Petty Cash; and the score", () => {
  assert.ok(weakNarration("ME DC SI 514834XXXXXX0502 SPOTIFYINDIA") && weakNarration("misc") && weakNarration(null)
            && weakNarration("RTGS DR-SBIN0017873-DR SAMEERA SBI-NETBA NK (Ref# HDFCR52026)"));
  assert.ok(!weakNarration("fuel exp amaze 05/09/2026") && !weakNarration("staff onam celebration expense(flower,banana,lemon)"));
  const ex = (date: string, total: number, o: Record<string, unknown>) => ({ id: `e${++n}`, date, account: "Itemized", paidThrough: "Current Account",
    description: "printer toner for OCT room", vendor: "Sri Ram Stores" as string | null, total, hasAttachment: true, ...o });
  const r = audit({ expenses: [ex("2026-10-02", 4194, { paidThrough: "Petty Cash", description: "food exp (daksh) 07/09/2026", vendor: null, hasAttachment: false }),
                               ex("2026-10-03", 139, { description: "ME DC SI 514834XXXXXX0502 SPOTIFYINDIA", account: "Miscellaneous Expenses", vendor: null }),
                               ex("2026-09-20", 9999, { vendor: null, hasAttachment: false })] });
  assert.deepEqual([C(r, "exp_narration").due, C(r, "exp_vendor").due, C(r, "exp_receipt").due, C(r, "exp_account").due, C(r, "exp_petty").due], [1, 1, 1, 1, 1],
                   "the 20 Sep expense is before the rules start; the ₹139 one is under the vendor and receipt amounts");
  assert.equal(C(r, "exp_petty").level, "red", "Pavin: all cash is banked, so any Petty Cash expense is off target");
  // no bank lines at all is the one check off target: 2 points for each of the other 13, of 28
  const empty = audit({});
  assert.deepEqual(empty.checks.filter((c) => c.level !== "green").map((c) => c.key), ["bank_current"]);
  assert.equal(empty.score, Math.round((26 / 28) * 100));
});

// ---------- several merchant ids, lines the bookkeeper combined, Bharat QR, the bank's cut-off (28 Oct 2026) ----------
const ANY_UPI: BankRule[] = [{ ...RULES[0], pattern: "UPI SETTLEMENT\\s*-[A-Z0-9]{6}-" }, RULES[1]];
check("a day's UPI in two settlements (one per merchant id) is matched; a line Zoho gives without a description is known by the bookkeeper's payment mode", () => {
  const two = reconcile(input({ from: "2026-10-05", to: "2026-10-05", rules: ANY_UPI, payments: [pay("2026-10-05", "upi", 36600), pay("2026-10-05", "upi", 7848)],
    bank: [credit("2026-10-06", 2400, "UPI SETTLEMENT -EHD956- 06/10/26"), credit("2026-10-06", 42048, "UPI SETTLEMENT -RY9181- 06/10/26")] }));
  assert.equal(row(two, "2026-10-05", "upi").status, "matched");
  assert.match(row(two, "2026-10-05", "upi").note!, /2 settlements on 6 Oct together: ₹2,400 \+ ₹42,048/);
  const combined = { ...credit("2026-10-06", 44448, ""), description: null, zohoStatus: "categorized", zohoMode: "UPI Payment" };
  assert.equal(classify(combined, ANY_UPI)?.class, "upi_settlement");
  assert.equal(classify({ ...combined, zohoMode: "Card Swipe" }, ANY_UPI)?.class, "card_settlement");
  assert.equal(classify({ ...combined, zohoMode: "Cash" }, ANY_UPI), null, "cash is not a settlement");
  const one = reconcile(input({ from: "2026-10-05", to: "2026-10-05", rules: ANY_UPI, payments: [pay("2026-10-05", "upi", 44448)], bank: [combined] }));
  assert.equal(row(one, "2026-10-05", "upi").status, "matched");
});

check("Bharat QR: card money settled with the UPI, less the card fee, is taken together with the day's card (3 Oct 2026)", () => {
  const D = "2026-10-03", N = "2026-10-04";
  const r = reconcile(input({ from: D, to: D, rules: ANY_UPI, payments: [pay(D, "upi", 20117), pay(D, "card", 32739)],
    // UPI's band: payments above ₹2,000 could be a RuPay credit card on UPI (1.60% + GST)
    feeBands: { [`${D}|card`]: { low: 0, high: 618.12, ceiling: 1062.4, payments: 10 }, [`${D}|upi`]: { low: 0, high: 302.11, ceiling: 302.11, payments: 23 } },
    bank: [credit(N, 20128.85, "UPI SETTLEMENT -RYX181- 04/10/26"), credit(N, 31897.77, "XXXX7444TERMINAL 1 CARDS SETTL. 04/10/26")] }));
  const u = row(r, D, "upi"), k = row(r, D, "card");
  assert.deepEqual([u.status, k.status], ["settled_less_fee", "settled_less_fee"], "not a UPI difference and a card fee above expected");
  assert.equal(Math.round((u.bankFee + k.bankFee) * 100) / 100, 829.38);
  assert.match(u.note!, /Card and UPI settled together \(Bharat QR\).*Bank kept ₹829.38 \(1.57%\)/);
  // a UPI settlement short of the day is never taken together with the card: that is a difference to explain
  const short = reconcile(input({ from: D, to: D, rules: ANY_UPI, payments: [pay(D, "upi", 20117), pay(D, "card", 32739)],
    feeBands: { [`${D}|card`]: { low: 0, high: 618.12, ceiling: 1062.4, payments: 10 } },
    bank: [credit(N, 19717, "UPI SETTLEMENT -RYX181- 04/10/26"), credit(N, 32339, "XXXX7444TERMINAL 1 CARDS SETTL. 04/10/26")] }));
  assert.equal(row(short, D, "upi").status, "difference");
});

check("the bank's cut-off: two days settled by two credits that together equal them (2 and 3 Sep 2026)", () => {
  const r = reconcile(input({ from: "2026-09-02", to: "2026-09-03", rules: ANY_UPI, payments: [pay("2026-09-02", "upi", 596), pay("2026-09-03", "upi", 793)],
    bank: [credit("2026-09-03", 691, "UPI SETTLEMENT -RYX181- 03/09/26"), credit("2026-09-04", 698, "UPI SETTLEMENT -RYX181- 04/09/26")] }));
  assert.deepEqual([row(r, "2026-09-02", "upi").status, row(r, "2026-09-03", "upi").status], ["matched", "matched"]);
  assert.match(row(r, "2026-09-02", "upi").note!, /₹95 went into the first day's settlement/);
  // not when they do not add up
  const off = reconcile(input({ from: "2026-09-02", to: "2026-09-03", rules: ANY_UPI, payments: [pay("2026-09-02", "upi", 596), pay("2026-09-03", "upi", 793)],
    bank: [credit("2026-09-03", 691, "UPI SETTLEMENT -RYX181- 03/09/26"), credit("2026-09-04", 650, "UPI SETTLEMENT -RYX181- 04/09/26")] }));
  assert.equal(row(off, "2026-09-02", "upi").status, "difference");
});

console.log(`\n${passed} reconciliation checks passed`);
