// Doctor summary helpers (D-026). No database needed.
//   npm run test:rules   (runs this file too)
import assert from "node:assert/strict";
import { modelFacts } from "../src/services/overview.js";
import { drugName, numbersCheck, visionChange } from "../src/services/summary.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

console.log("\nDoctor summary");
test("the injected drug is read from Yarago's billing name when the drug field is empty", () => {
  assert.equal(drugName("INTRA VITREAL RAZUMAB(13000)", null), "Razumab");
  assert.equal(drugName("INTRA VITREAL TRIAMCINOLONE(11000)", null), "Triamcinolone");
  assert.equal(drugName("INTRA VITREAL OZURDEX(39000)", ""), "Ozurdex");
  assert.equal(drugName("PST(4000)", null), "PST");
  assert.equal(drugName("x", "EYLEA"), "Eylea", "a filled drug field wins");
  assert.equal(drugName("THEATRE CHARGES (6000)", null), null, "a charge is not a drug");
});
test("vision change is counted in logMAR lines, oldest to newest, 2 lines or more = better / worse", () => {
  assert.deepEqual(visionChange([{ va: "6/24", logmar: 0.6 }, { va: null, logmar: null }, { va: "6/9", logmar: 0.18 }]),
    { from: "6/24", to: "6/9", lines: 4, word: "better" });
  assert.equal(visionChange([{ va: "6/12", logmar: 0.3 }, { va: "6/18", logmar: 0.48 }])!.word, "worse");
  assert.equal(visionChange([{ va: "6/12", logmar: 0.3 }, { va: "6/12", logmar: 0.3 }])!.word, "steady");
  assert.equal(visionChange([{ va: "6/12", logmar: 0.3 }]), null, "one reading is no trend");
});
test("an overview with a number that is not in the facts fails the check", () => {
  const facts = { vision: { rows: [{ bcvaRe: "6/9", date: "2026-09-22", iopRe: 16 }] }, treatment: { rows: [{ number: 3 }] } };
  assert.equal(numbersCheck("Right eye 6/9 on 22 Sep after the 3rd injection; pressure 16.", facts).ok, true);
  const bad = numbersCheck("Right eye 6/6 after 4 injections.", facts);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ["6/6", "4"]);
  assert.equal(numbersCheck("Pressure 1 above last time.", { iop: 16 }).ok, false, "1 inside 16 does not count");
});
test("the model never sees the patient's name, MRD or record ids", () => {
  const f: any = { forDate: "2026-10-21", patient: { patientId: 9, mrd: "SPD1", name: "X Y", ageYears: 64, sex: "M", language: "Malayalam", visits: 3, firstVisit: "2024-01-01" },
    today: { appointmentId: 5, slotTime: "10:10", plan: null, doctor: "Dr. A", token: "14" },
    alerts: { systemic: { value: "DIABETES MELLITUS", date: "2026-06-11", visitId: 77 } } };
  const m = JSON.stringify(modelFacts(f));
  for (const s of ["X Y", "SPD1", "patientId", "visitId", "appointmentId", "Malayalam"]) assert.ok(!m.includes(s), s);
  assert.ok(m.includes("DIABETES MELLITUS") && m.includes("10:10"));
});
console.log(`${passed} doctor summary checks passed`);
