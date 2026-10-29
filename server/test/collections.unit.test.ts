// Day collection (D-057), no database.   npx tsx test/collections.unit.test.ts
import assert from "node:assert/strict";
import { daySummary, type DayBill, type DayInput, type DayLine, type DayPayment, type DayRefund } from "../src/services/collections.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

const D = "2026-10-28";
let n = 0;
const who = { mrd: "SPD1", name: "TEST Patient" };
const pay = (at: string | null, method: DayPayment["method"], amount: number, source = "clinic_bill", billKey = `b${++n}`, patientId = n): DayPayment =>
  ({ paymentId: `p${++n}`, source, sourceId: String(n), billNo: `B${n}`, onDate: D, patientId, method, amount, ref: null, at: at ? `${D}T${at}` : null, billKey, ...who });
const line = (group: string, item: string, amount: number, source = "clinic_bill", sourceId = String(++n)): DayLine =>
  ({ lineId: `l${++n}`, source, sourceId, billNo: null, onDate: D, patientId: 1, serviceGroup: group, item, amount, ...who });
const refund = (amount: number, source = "opd_refund", method: DayRefund["method"] = "cash"): DayRefund =>
  ({ refundId: `r${++n}`, source, sourceId: String(n), billNo: null, onDate: D, patientId: 1, method, amount, dateUncertain: method === "unrecorded", at: `${D}T12:00`, reason: null, ...who });
const bill = (discount: number, due: number, billKey = `k${++n}`, total = 1000): DayBill => ({ billKey, billNo: `B${n}`, patientId: 1, at: `${D}T10:00`, total, discount, due, ...who });
const MAP = { "Consultation & charges": "consultation", Injections: "procedure", Pharmacy: "pharmacy", Optical: "optical" } as const;

function day(p: Partial<DayInput> = {}): DayInput {
  return {
    date: D, categoryMap: { ...MAP }, bills: [bill(200, 0, "kc", 700), bill(0, 500, "ki", 9500)],
    lines: [line("Consultation & charges", "Consultation", 500, "clinic_bill", "kc"), line("Injections", "Razumab", 9000, "clinic_bill", "ki"), line("Injections", "Razumab", 9000),
            line("Injections", "Ozurdex", 21000), line("Pharmacy", "Eye Drops", 168.75, "pharmacy_order"), line("Optical", "Frames", 1200, "pharmacy_order")],
    payments: [pay("09:10", "cash", 500), pay("09:40", "upi", 9000, "clinic_bill", "bx", 7), pay("09:40", "cash", 9000, "clinic_bill", "bx", 7),
               pay("11:05", "card", 21000), pay("11:20", "cash", 168.75, "pharmacy_payment"), pay(null, "upi", 1200, "pharmacy_payment")],
    refunds: [refund(500), refund(100, "pharmacy_refund", "unrecorded")],
    ...p,
  };
}

check("totals: collected by source add up; refunds off; one bill paid two ways is one bill", () => {
  const s = daySummary(day());
  assert.equal(s.totals.collected, 40868.75);
  assert.deepEqual(s.totals.collectedBy, { clinic: 39500, pharmacy: 1368.75 });
  assert.equal(s.totals.refunds, 600);
  assert.deepEqual(s.totals.refundsBy, { clinic: 500, pharmacy: 100 });
  assert.equal(s.totals.net, 40268.75);
  assert.equal(s.totals.payments, 6);
  assert.equal(s.totals.bills, 5, "bill bx paid by UPI and cash counts once");
  assert.equal(s.totals.firstAt, `${D}T09:10`);
  assert.equal(s.totals.lastAt, `${D}T11:20`);
  assert.equal(s.totals.discount, 200);
  assert.equal(s.totals.due, 500);
});

check("methods in the usual order, each split by source, adding up to the total", () => {
  const s = daySummary(day());
  assert.deepEqual(s.byMethod.map((m) => [m.method, m.amount, m.count]), [["cash", 9668.75, 3], ["upi", 10200, 2], ["card", 21000, 1]]);
  assert.deepEqual(s.byMethod[0].by, { clinic: 9500, pharmacy: 168.75 });
  assert.equal(s.byMethod.reduce((x, m) => x + m.amount, 0), s.totals.collected);
});

check("what it was for: clinic groups first, largest first; items with their line counts", () => {
  const s = daySummary(day());
  assert.deepEqual(s.byService.map((g) => [g.source, g.group, g.amount]),
    [["clinic", "Injections", 39000], ["clinic", "Consultation & charges", 500], ["pharmacy", "Optical", 1200], ["pharmacy", "Pharmacy", 168.75]]);
  assert.deepEqual(s.byService[0].items, [{ item: "Ozurdex", amount: 21000, lines: 1 }, { item: "Razumab", amount: 18000, lines: 2 }]);
  assert.equal(s.byService[0].category, "procedure");
});

check("through the day: every hour from first to last, empty ones too; a payment with no time is counted but not placed", () => {
  const s = daySummary(day());
  assert.deepEqual(s.byHour.map((h) => [h.hour, h.amount, h.count]), [[9, 18500, 3], [10, 0, 0], [11, 21168.75, 2]]);
  assert.equal(s.untimed, 1);
  assert.equal(s.byHour.reduce((x, h) => x + h.amount, 0) + 1200, s.totals.collected);
});

check("payments listed by time (untimed last), with clinic / pharmacy; billed against collected per source", () => {
  const s = daySummary(day());
  assert.deepEqual(s.payments.map((p) => p.at?.slice(11) ?? null), ["09:10", "09:40", "09:40", "11:05", "11:20", null]);
  assert.equal(s.payments[4].source, "pharmacy");
  assert.equal(s.payments[4].yaragoSource, "pharmacy_payment");
  assert.deepEqual(s.billedVsCollected, [{ source: "clinic", billed: 39500, collected: 39500, gap: 0, notItemised: 0 },
                                         { source: "pharmacy", billed: 1368.75, collected: 1368.75, gap: 0, notItemised: 0 }]);
  assert.deepEqual(s.notItemised, []);
  assert.deepEqual(s.discounts.map((b) => b.discount), [200]);
  assert.deepEqual(s.dues.map((b) => b.due), [500]);
});

check("an empty day is empty, not an error; another day's records are left out", () => {
  const s = daySummary(day({ lines: [], payments: [{ ...pay("10:00", "cash", 99), onDate: "2026-10-27" }], refunds: [], bills: [] }));
  assert.equal(s.totals.collected, 0);
  assert.deepEqual([s.byMethod, s.byHour, s.byService, s.payments], [[], [], [], []]);
  assert.equal(s.totals.firstAt, null);
});

// D-058: 28 Oct 2026 in shape (synthetic): 39 consultation bills (18,750) and 11 investigation bills (OCT, ONH, perimetry;
// 22,700), every bill paid in full. On the day the investigation lines were not yet copied (they came with the nightly copy).
function oct28(withInvestigations: boolean): DayInput {
  const consult = Array.from({ length: 39 }, (_, i) => ({ key: `c${i}`, amount: i < 36 ? 500 : 250 }));   // 36 x 500 + 3 x 250 = 18,750
  const inv = Array.from({ length: 11 }, (_, i) => ({ key: `v${i}`, amount: i < 9 ? 2000 : 2350 }));      // 9 x 2,000 + 2 x 2,350 = 22,700
  const all = [...consult, ...inv];
  return { date: D, categoryMap: { ...MAP, Investigations: "procedure" },
           bills: all.map((b) => bill(0, 0, b.key, b.amount)),
           lines: [...consult.map((b) => line("Consultation & charges", "Consultation", b.amount, "clinic_bill", b.key)),
                   ...(withInvestigations ? inv.map((b) => line("Investigations", "OCT", b.amount, "clinic_bill", b.key)) : [])],
           payments: all.map((b, i) => pay(`${String(9 + (i % 8)).padStart(2, "0")}:00`, i % 2 ? "upi" : "cash", b.amount, "clinic_bill", b.key)),
           refunds: [] };
}

check("D-058: 28 Oct shape before the investigation lines are copied: billed short, and the 11 bills are named, not a bare gap", () => {
  const s = daySummary(oct28(false));
  assert.equal(s.totals.collected, 41450);
  assert.deepEqual(s.billedVsCollected, [{ source: "clinic", billed: 18750, collected: 41450, gap: -22700, notItemised: 22700 }]);
  assert.equal(s.notItemised.length, 11);
  assert.equal(s.totals.bills, 50);
});

check("D-058: 28 Oct shape with every line: billed = collected = 41,450, gap 0; investigations in the services; nothing counted twice", () => {
  const s = daySummary(oct28(true));
  assert.deepEqual(s.billedVsCollected, [{ source: "clinic", billed: 41450, collected: 41450, gap: 0, notItemised: 0 }]);
  assert.deepEqual(s.byService.map((g) => [g.group, g.amount, g.lines]), [["Investigations", 22700, 11], ["Consultation & charges", 18750, 39]]);
  assert.equal(s.byService[0].category, "procedure", "investigations count as procedures (recon.category_map)");
  assert.deepEqual([s.totals.discount, s.totals.due, s.totals.refunds], [0, 0, 0]);
});

check("D-058: one bill of consultation, investigation and procedure, paid two ways: each line once, the bill once, itemised", () => {
  const s = daySummary(day({ bills: [bill(500, 1000, "mix", 12200)],
    lines: [line("Consultation & charges", "Consultation", 500, "clinic_bill", "mix"), line("Investigations", "OCT", 1200, "clinic_bill", "mix"),
            line("Injections", "Razumab", 9000, "clinic_bill", "mix")],
    payments: [pay("10:00", "card", 9000, "clinic_bill", "mix"), pay("10:01", "upi", 1700, "clinic_bill", "mix")], refunds: [] }));
  assert.deepEqual(s.billedVsCollected, [{ source: "clinic", billed: 10700, collected: 10700, gap: 0, notItemised: 0 }]);
  assert.deepEqual([s.totals.bills, s.totals.payments, s.byService.length], [1, 2, 3]);
  assert.deepEqual([s.totals.discount, s.totals.due], [500, 1000], "discount and money due still come from the bill");
});

check("D-058: a bill with a zero total and no lines (a free review) is not flagged", () => {
  const s = daySummary(day({ bills: [bill(0, 0, "free", 0)], lines: [], payments: [], refunds: [] }));
  assert.deepEqual(s.notItemised, []);
});

console.log(`\n${passed} day collection checks passed`);
