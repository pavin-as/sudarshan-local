// Follow-up board ranking and team cards (Phase B). No database needed.
//   npm run test:rules   (runs this file too)
import assert from "node:assert/strict";
import { groupsFor, riskTier, type RiskInput } from "../src/services/followupRisk.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
const base: RiskInput = { ageYears: 60, condition: null, lastInjectionDays: null, lastInjection: null, lastLaserDays: null, lastLaser: null, diabetes: false };

console.log("\nFollow-up board");
test("an injection in the last 6 months is urgent; an older one is high", () => {
  const r = riskTier({ ...base, lastInjectionDays: 40, lastInjection: "Razumab RE, 3rd" });
  assert.equal(r.tier, 1); assert.deepEqual(r.reasons, ["Injection Razumab RE, 3rd 40 days ago"]);
  assert.equal(riskTier({ ...base, lastInjectionDays: 400 }).tier, 2);
});
test("ROP, retinal detachment and infants are urgent", () => {
  assert.equal(riskTier({ ...base, condition: "ROP / ROP screening" }).tier, 1);
  assert.equal(riskTier({ ...base, condition: "Retinal detachment" }).tier, 1);
  assert.equal(riskTier({ ...base, ageYears: 0 }).tier, 1);
});
test("laser in the last year and retinal disease under care are high", () => {
  assert.equal(riskTier({ ...base, lastLaserDays: 100, lastLaser: "Special PRP Laser LE" }).tier, 2);
  assert.equal(riskTier({ ...base, lastLaserDays: 500 }).tier, 4, "an old laser alone is routine");
  assert.equal(riskTier({ ...base, condition: "Diabetic retinopathy / DME" }).tier, 2);
  assert.equal(riskTier({ ...base, condition: "Age-related macular degeneration" }).tier, 2);
});
test("diabetes or a condition to watch is monitor; nothing else is routine", () => {
  assert.equal(riskTier({ ...base, diabetes: true }).tier, 3);
  assert.equal(riskTier({ ...base, condition: "Glaucoma / suspect" }).tier, 3);
  assert.equal(riskTier({ ...base, condition: "No specific finding" }).tier, 4);
});
test("the highest reason wins and every reason is listed once", () => {
  const r = riskTier({ ...base, diabetes: true, condition: "Diabetic retinopathy / DME", lastInjectionDays: 20, lastInjection: "Eylea LE" });
  assert.equal(r.tier, 1);
  assert.deepEqual(r.reasons, ["Injection Eylea LE 20 days ago", "Diabetic retinopathy / DME", "Diabetes"]);
});
test("ROP list replaces the finding guess: a mature retina is not urgent, and the reason names the last visit", () => {
  const on = riskTier({ ...base, ageYears: 0, rop: true, ropDays: 12 });
  assert.equal(on.tier, 1); assert.deepEqual(on.reasons, ["ROP, last ROP visit 12 days ago"]);
  const off = riskTier({ ...base, condition: "ROP / ROP screening", rop: false });
  assert.equal(off.tier, 4, "mature retina / over a year ago: off the ROP list");
});
test("each overdue patient is on the card of every team that cares, and on Routine only if on none", () => {
  assert.deepEqual(groupsFor({ ...base, rop: true, ageYears: 0 }), ["rop"]);
  assert.deepEqual(groupsFor({ ...base, lastInjectionDays: 90, condition: "Diabetic retinopathy / DME", lastLaserDays: 200 }), ["injection", "laser", "dr"]);
  assert.deepEqual(groupsFor({ ...base, condition: "Retinal vein occlusion" }), ["retina"]);
  assert.deepEqual(groupsFor({ ...base, lastInjectionDays: 400, lastLaserDays: 500 }), ["routine"], "old treatment alone is routine");
  assert.deepEqual(groupsFor({ ...base, diabetes: true, condition: "Glaucoma / suspect" }), ["routine"]);
  assert.deepEqual(groupsFor({ ...base, ageYears: 0 }), ["routine"], "an infant is on the ROP card only if ROP evidence says so");
});
console.log(`${passed} follow-up board checks passed`);
