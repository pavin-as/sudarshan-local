// Temporary IDs for new patients and matching today's bookings to patients who came (D-036), no database.   npx tsx test/arrival.unit.test.ts
import assert from "node:assert/strict";
import { matchAll, matchBooking, namesAgree } from "../src/services/arrivalMatch.js";
import { isTempMrd, tempMrd } from "../src/services/tempMrd.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

check("temporary ID is NDC_ date_time_ booking id, in clinic time", () => {
  assert.equal(tempMrd(new Date("2026-10-12T08:24:40Z"), 117), "NDC_20261012_135440_117");     // 13:54:40 IST
  assert.equal(tempMrd(new Date("2026-10-12T18:40:00Z"), 5), "NDC_20261013_001000_5", "crosses midnight in IST");
  assert.ok(isTempMrd("NDC_20261012_135440_117") && isTempMrd("ndc_x") && !isTempMrd("SPD10231") && !isTempMrd(null));
});

check("names agree on a shared word, not on nothing", () => {
  assert.ok(namesAgree("Ayisha K", "AYISHA Kutty"));
  assert.ok(namesAgree("Mr. Rajan Nair", "Rajan"));
  assert.ok(!namesAgree("Ayisha", "Fathima"));
  assert.ok(!namesAgree(null, "Fathima"));
});

const came = [
  { patientId: 1, mrd: "SPD100", phone: "98470 12345", name: "Ayisha K" },
  { patientId: 2, mrd: "SPD200", phone: "9847099999", name: "Rajan Nair" },
  { patientId: 3, mrd: "SPD300", phone: null, name: "Walk In" },
];
const books = [
  { id: 10, patientId: null, mrd: "NDC_20261012_135440_10", phone: "+91 9847012345", name: "Ayisha Kutty" },
  { id: 11, patientId: 2, mrd: "SPD200", phone: "9847099999", name: "Rajan Nair" },
  { id: 12, patientId: null, mrd: "NDC_20261012_140000_12", phone: "9000000000", name: "Not Come" },
];

check("a new patient's booking matches by mobile and name; a linked one by Yarago ID; a true walk-in has none", () => {
  const m = matchAll(came, books);
  assert.equal(m.get(1)?.booking.id, 10); assert.equal(m.get(1)?.kind, "phone_name");
  assert.equal(m.get(2)?.booking.id, 11); assert.equal(m.get(2)?.kind, "linked");
  assert.equal(m.get(3), undefined, "no booking = without a booking");
});

check("same mobile but different name does not match (family phone); same MRD does", () => {
  assert.equal(matchBooking(came[0], { ...books[0], name: "Fathima" }), null);
  assert.equal(matchBooking(came[0], { ...books[0], mrd: "spd100", phone: null, name: "x" }), "mrd");
  assert.equal(matchBooking(came[0], { ...books[1] }), null, "booking linked to another patient");
});

check("one booking is used once", () => {
  const twin = { patientId: 4, mrd: null, phone: "9847012345", name: "Ayisha" };
  const m = matchAll([came[0], twin], [books[0]]);
  assert.equal(m.size, 1);
});

console.log(`${passed} checks passed`);
