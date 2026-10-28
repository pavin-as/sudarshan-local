// Money reconciliation rules (D-052), no database.   npx tsx test/recon.unit.test.ts
import assert from "node:assert/strict";
import { AdjustmentRefused, categoryOf, classify, effectsFor, reconcile, reversalEffects, type BankLine, type BankRule, type Effect,
         type EffectDraft, type PaymentRow, type ReconInput, type RefundRow, type RevenueLine } from "../src/services/reconcile.js";

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

check("cash stays in hand until a cash deposit is matched; cheque without a rule is not tracked", () => {
  const rules = RULES.map((x) => (x.id === 3 ? { ...x, isActive: true } : x));
  const r = reconcile(input({ rules, payments: [pay("2026-10-09", "cash", 5000), pay("2026-10-09", "cheque", 700)], bank: [credit("2026-10-09", 3000, "BY CASH DEP TIRUR")] }));
  assert.equal(r.totals.cashDeposited, 3000); assert.equal(r.totals.cashInHand, 2000);
  assert.equal(row(r, "2026-10-09", "cheque").status, "not_tracked");
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

console.log(`\n${passed} reconciliation checks passed`);
