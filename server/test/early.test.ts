// Early booking limit (D-030), as the Google app applied it. No database needed.
//   npm run test:rules   (runs this file too)
import assert from "node:assert/strict";
import { customRound, DEFAULT_THRESHOLDS as T, earlyStatus, selectThreshold, validateThresholds } from "../src/services/earlyBooking.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

console.log("\nEarly booking limit");
test("the band by days ahead: 10+ 51%, 5-9 79%, 4 85%, 1-3 95%, same day 100%", () => {
  assert.deepEqual([12, 10, 9, 5, 4, 3, 1, 0].map((d) => selectThreshold(d, T).percentage), [51, 51, 79, 79, 85, 95, 95, 100]);
});
test("% used rounds as the Google app did: above .5 up, .5 or below down", () => {
  assert.equal(customRound(50.5), 50); assert.equal(customRound(50.51), 51); assert.equal(customRound(63.2), 63);
});
test("restricted once % used reaches the limit (not before)", () => {
  // 38 slots, 12 days ahead: 51%. 19 booked = 50% -> open; 20 booked = 52.6% -> 53% -> restricted
  assert.equal(earlyStatus("2026-06-02", "2026-05-21", 19, 38, T).restricted, false);
  assert.equal(earlyStatus("2026-06-02", "2026-05-21", 20, 38, T).restricted, true);
  assert.equal(earlyStatus("2026-06-02", "2026-06-02", 37, 38, T).restricted, false, "same day: up to 100%");
  assert.equal(earlyStatus("2026-06-02", "2026-05-21", 0, 0, T).restricted, false, "a day with no maximum is not this rule's business");
});
test("the unlock table: dates, capacity and new slots, as in the Google app's example", () => {
  const e = earlyStatus("2026-06-02", "2026-05-21", 25, 38, T);
  assert.deepEqual(e.unlocks.map((u) => [u.days, u.from, u.percentage, u.slotsAllowed, u.newSlots]), [
    [5, "2026-05-28", 79, 30, 11], [4, "2026-05-29", 85, 32, 2], [1, "2026-06-01", 95, 36, 4], [0, "2026-06-02", 100, 38, 2]]);
});
test("an unlock day that is a Sunday moves to the Saturday before", () => {
  // Monday 26 Oct 2026: "1 day before" is Sunday 25 Oct -> Saturday 24 Oct
  const e = earlyStatus("2026-10-26", "2026-10-12", 30, 38, T);
  assert.equal(e.unlocks.find((u) => u.days === 1)!.from, "2026-10-24");
});
test("settings: 10-100%, rising as the day gets closer, one band per day count, a same-day band", () => {
  assert.equal(validateThresholds(T), null);
  assert.match(validateThresholds([{ days: 10, percentage: 90 }, { days: 0, percentage: 80 }])!, /rise/);
  assert.match(validateThresholds([{ days: 10, percentage: 5 }, { days: 0, percentage: 100 }])!, /between 10 and 100/);
  assert.match(validateThresholds([{ days: 10, percentage: 50 }])!, /same-day/);
});
console.log(`${passed} early booking checks passed`);
