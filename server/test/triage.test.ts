// Triage scoring, as the Google app scored it (Code.js submitTriageAssessment). No database needed.
//   npm run test:rules   (runs this file too)
import assert from "node:assert/strict";
import { bookedDecision, scoreTriage, TRIAGE_DECISIONS, TRIAGE_QUESTIONS } from "../src/services/triage.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
const all = (n: number) => Object.fromEntries(TRIAGE_QUESTIONS.map((q) => [q.key, n]));

console.log("\nTriage");
test("seven questions, each with a serious (3), moderate (2) and mild (1) answer", () => {
  assert.equal(TRIAGE_QUESTIONS.length, 7);
  assert.deepEqual(TRIAGE_QUESTIONS.map((q) => q.key), ["onset", "vision", "pain", "floaters", "redness", "injury", "symptoms"]);
  for (const q of TRIAGE_QUESTIONS) assert.deepEqual(q.options.map((o) => o.score), [3, 2, 1]);
});
test("all mild = Not Urgent", () => assert.deepEqual(scoreTriage(all(1)), { maxScore: 1, category: "Not Urgent", missing: [] }));
test("the highest answer decides, not the sum: one moderate = Urgent", () => {
  assert.equal(scoreTriage({ ...all(1), pain: 2 }).category, "Urgent");
});
test("any serious answer = Emergency, whatever the others", () => {
  assert.deepEqual(scoreTriage({ ...all(1), floaters: 3 }), { maxScore: 3, category: "Emergency", missing: [] });
  assert.equal(scoreTriage({ ...all(2), injury: 3 }).category, "Emergency");
});
test("six moderate answers are still only Urgent (no adding up)", () => {
  assert.equal(scoreTriage({ ...all(2), symptoms: 1 }).category, "Urgent");
});
test("unanswered or invalid answers are reported as missing", () => {
  const r = scoreTriage({ onset: 3, vision: 5 });
  assert.deepEqual(r.missing, ["vision", "pain", "floaters", "redness", "injury", "symptoms"]);
});
test("decision after booking: today, tomorrow or a later date", () => {
  assert.equal(bookedDecision("2026-10-19", "2026-10-19"), "Booked: Today");
  assert.equal(bookedDecision("2026-10-20", "2026-10-19"), "Booked: Tomorrow");
  assert.equal(bookedDecision("2026-10-23", "2026-10-19"), "Booked: Later Date");
  assert.ok(TRIAGE_DECISIONS.includes("Declined: Wanted Today Only"));
});
console.log(`\n${passed} triage checks passed`);
