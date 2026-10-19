// The 16 scheduling rules, one block of checks per rule (rule cards: analysis/sudarshan/rules/RULE_CARDS.md).
// Pure functions only: no database needed.   npm run test:rules
import assert from "node:assert/strict";
import {
  checkDay, consultStartOf, dayCode, DEFAULT_RULE_SETTINGS, findingsFor, isNewPatient, parseRuleSettings, planItems, procTags,
  type DayContext, type Finding, type RuleAppt, type RuleSettings,
} from "../src/services/rules.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

const TODAY = "2026-10-19";                        // Monday
const MON = "2026-10-26", TUE = "2026-10-27", WED = "2026-10-28", THU = "2026-10-29", FRI = "2026-10-30";
const PREP = new Map([["REF", 15], ["DIL", 45], ["AT", 5], ["GONIO", 5], ["HFA", 60], ["NEW", 45], ["FOCAL LASER", 5], ["DIRECT", 5], ["OCT", 30]]);

let nextId = 1;
function appt(p: Partial<RuleAppt> & { slotTime: string | null }): RuleAppt {
  return { id: nextId++, consultStart: null, mrd: "SPD100", patientType: "Old", patientName: `ZZ Test ${nextId}`, ageYears: 50,
           planOfAction: null, remarks: null, tags: [], familyGroup: null, ...p };
}
const newP = (p: Partial<RuleAppt> & { slotTime: string | null }) => appt({ mrd: null, patientType: "New", ...p });
function run(appts: RuleAppt[], date = MON, settings: Partial<RuleSettings> = {}, today = TODAY) {
  const ctx: DayContext = { date, today, prepMinutes: PREP, settings: { ...DEFAULT_RULE_SETTINGS, ...settings, on: { ...DEFAULT_RULE_SETTINGS.on, ...settings.on } } };
  return checkDay(appts, ctx);
}
const codes = (fs: Finding[], rule?: number) => fs.filter((f) => rule == null || f.rule === rule).map((f) => f.code);
const onlyRule = (rule: number) => {           // switch every other rule off, so a test sees one rule only
  const on: Record<string, boolean> = {};
  for (const k of Object.keys(DEFAULT_RULE_SETTINGS.on)) on[k] = false;
  const keys: Record<number, string[]> = { 1: ["RULE_NEW_TIMING"], 2: ["RULE_FAMILY_TIMING"], 3: ["RULE_FAMILY_MORNING"], 4: ["RULE_NEW_CONSECUTIVE"],
    5: ["RULE_NEW_AFTER_4PM"], 6: ["RULE_CONSULT_WINDOW"], 7: ["RULE_FAMILY_CONTINUOUS"],
    8: ["RULE_GONIO_AT_CONSECUTIVE", "RULE_GONIO_AT_CAP", "RULE_GONIO_TIMING", "RULE_AT_TIMING"], 9: ["RULE_HFA_SLOT"], 10: ["RULE_ROP_DAY"],
    11: ["RULE_LASER_DAY"], 12: ["RULE_WHEELCHAIR"], 13: ["RULE_LASER_DURATION"], 14: ["RULE_PLAN_DURATION"] };
  for (const k of keys[rule]) on[k] = true;
  return { on };
};

console.log("\nScheduling rules");

// ---------- helpers ----------
test("helpers: dates used by the tests fall on the expected weekdays", () => {
  assert.deepEqual([MON, TUE, WED, THU, FRI].map(dayCode), ["MON", "TUE", "WED", "THU", "FRI"]);
});
test("helpers: plan of action read like the Google app (AT whole word, IVR not IVTA, eye notes dropped)", () => {
  assert.equal(procTags('["AT (BE)"]').AT, true);
  assert.equal(procTags('["REVIEW AFT CAT SUR"]').AT, false);
  assert.equal(procTags("IVTA").IVR, false);
  assert.equal(procTags('["BARRAGE LASER (LE)"]').LASER, true);
  assert.deepEqual(planItems('["OCT (LE)","REF","DIL"]'), ["OCT", "REF", "DIL"]);
  assert.deepEqual(planItems("REF / DIL"), ["REF", "DIL"]);
});
test("helpers: new = MRD starting N, or no MRD and type New/Guest; S MRD is old even when typed Guest", () => {
  assert.equal(isNewPatient({ mrd: "N1234", patientType: null }), true);
  assert.equal(isNewPatient({ mrd: "SPD99", patientType: "Guest" }), false);
  assert.equal(isNewPatient({ mrd: null, patientType: "New" }), true);
  assert.equal(isNewPatient({ mrd: null, patientType: "Old" }), false);
});
test("helpers: consult start = stored, else slot + longest prep time of the plan", () => {
  assert.equal(consultStartOf(appt({ slotTime: "09:30", planOfAction: '["REF","DIL"]' }), PREP), "10:15");
  assert.equal(consultStartOf(appt({ slotTime: "09:30", consultStart: "11:00" }), PREP), "11:00");
  assert.equal(consultStartOf(appt({ slotTime: "09:30", planOfAction: "UNKNOWN THING" }), PREP), "09:30");
  assert.equal(consultStartOf(appt({ slotTime: null }), PREP), null);
});
test("helpers: imported rule settings (Sheets day fractions) read as clock times; live gap of 20 kept", () => {
  const s = parseRuleSettings([
    { key: "rule.NEW_MORNING_START", value: { name: "x", value: "0.4166666666666667" } },
    { key: "rule.HFA_SLOT_1", value: { value: "0.3888888888888889" } },
    { key: "rule.NEW_CONSECUTIVE_GAP", value: { value: "20" } },
    { key: "rule.LASER_DAYS", value: { value: "TUE,FRI" } },
    { key: "rule.RULE_WHEELCHAIR", value: { value: "OFF" } },
  ]);
  assert.equal(s.newMorningStart, "10:00");
  assert.equal(s.hfaSlots[0], "09:20");
  assert.equal(s.newConsecutiveGap, 20);
  assert.deepEqual(s.laserDays, ["TUE", "FRI"]);
  assert.equal(s.on.RULE_WHEELCHAIR, false);
  assert.equal(s.on.RULE_PLAN_DURATION, false);            // rule 14 starts off
  assert.equal(s.consultStart, "10:30");                   // missing -> Google app default
});

// ---------- rule 1 ----------
test("rule 1: new patient before 10:00 is warned; at 10:00 or an old patient is not", () => {
  const a = newP({ slotTime: "09:50" }), b = newP({ slotTime: "10:00" }), c = appt({ slotTime: "09:00" });
  const f = run([a, b, c], MON, onlyRule(1)).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id]), [["NEW_PATIENT_BEFORE_TIME", "warning", a.id]]);
});

// ---------- rule 2 ----------
test("rule 2: family member before 11:30 is noted, unless a special case", () => {
  const a = appt({ slotTime: "11:00", familyGroup: "F1" }), b = appt({ slotTime: "11:10", familyGroup: "F1", tags: ["VIP"] }),
        c = appt({ slotTime: "11:30", familyGroup: "F1" }), d = appt({ slotTime: "09:00" });
  const f = run([a, b, c, d], MON, onlyRule(2)).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id]), [["FAMILY_BEFORE_CUTOFF", "info", a.id]]);
});

// ---------- rule 3 ----------
test("rule 3: more than 3 of one family in the morning is warned on each morning member", () => {
  const fam = ["09:00", "10:00", "10:30", "11:50", "14:00"].map((t) => appt({ slotTime: t, familyGroup: "F2" }));
  const f = run(fam, MON, onlyRule(3)).findings;
  assert.equal(f.length, 4);
  assert.ok(f.every((x) => x.code === "FAMILY_SIZE_MORNING" && x.level === "warning"));
  const ok = ["09:00", "10:00", "10:30", "14:00", "15:00"].map((t) => appt({ slotTime: t, familyGroup: "F3" }));
  assert.equal(run(ok, MON, onlyRule(3)).findings.length, 0);
});

// ---------- rule 4 ----------
test("rule 4: two new patients close together with no old patient between are noted", () => {
  const a = newP({ slotTime: "10:00" }), b = newP({ slotTime: "10:10" });
  const f = run([a, b], MON, { ...onlyRule(4), newConsecutiveGap: 20 }).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id, x.ids]), [["NEW_CONSECUTIVE", "info", b.id, [a.id, b.id]]]);
});
test("rule 4: an old patient between them, a wide enough gap, or one family sharing a slot is fine", () => {
  const g = { ...onlyRule(4), newConsecutiveGap: 20 };
  assert.equal(run([newP({ slotTime: "10:00" }), appt({ slotTime: "10:10" }), newP({ slotTime: "10:15", consultStart: "10:15" })], MON, g).findings.length, 0);
  assert.equal(run([newP({ slotTime: "10:00" }), newP({ slotTime: "10:20" })], MON, g).findings.length, 0);
  assert.equal(run([newP({ slotTime: "10:00", familyGroup: "F4" }), newP({ slotTime: "10:00", familyGroup: "F4" })], MON, g).findings.length, 0);
});
test("rule 4: order is by consultation time (slot + preparation)", () => {
  // 10:00 with dilation consults at 10:45; 10:30 plain consults at 10:30; 11:00 consults 11:00 -> 10:30 and 10:45 are 15 min apart
  const a = newP({ slotTime: "10:00", planOfAction: "DIL" }), b = newP({ slotTime: "10:30" }), c = appt({ slotTime: "11:00" });
  const f = run([a, b, c], MON, { ...onlyRule(4), newConsecutiveGap: 20 }).findings;
  assert.deepEqual(f.map((x) => x.ids), [[b.id, a.id]]);
});

// ---------- rule 5 ----------
test("rule 5: new patient with dilation from 16:00 is an error; without, a warning", () => {
  const a = newP({ slotTime: "16:10", planOfAction: '["REF","DIL"]' }), b = newP({ slotTime: "16:00" }), c = newP({ slotTime: "15:50" });
  const f = run([a, b, c], MON, onlyRule(5)).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id]), [["NEW_AFTER_EVENING_DILATION", "error", a.id], ["NEW_AFTER_EVENING", "warning", b.id]]);
});
test("rule 5: children, direct OPD, VIP and BNI may come after 16:00 (unless dilating)", () => {
  const ok = [newP({ slotTime: "16:30", ageYears: 9 }), newP({ slotTime: "16:30", tags: ["Kids"], ageYears: null }),
              newP({ slotTime: "16:40", planOfAction: "DIRECT" }), newP({ slotTime: "16:50", remarks: "vip case" }), newP({ slotTime: "17:00", tags: ["BNI"] })];
  assert.equal(run(ok, MON, onlyRule(5)).findings.length, 0);
  assert.deepEqual(codes(run([newP({ slotTime: "16:30", ageYears: 9, planOfAction: "DIL" })], MON, onlyRule(5)).findings), ["NEW_AFTER_EVENING_DILATION"]);
});

// ---------- rule 6 ----------
test("rule 6: consultation before 10:30 or after 17:30 is warned, in lunch noted", () => {
  const early = appt({ slotTime: "09:30", planOfAction: "REF" }),            // consult 09:45
        lunch = appt({ slotTime: "13:40" }), edge = appt({ slotTime: "13:30" }), back = appt({ slotTime: "14:30" }),
        late = appt({ slotTime: "17:40" }), ok = appt({ slotTime: "10:00", planOfAction: "DIL" });   // consult 10:45
  const f = run([early, lunch, edge, back, late, ok], MON, onlyRule(6)).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id]),
    [["CONSULT_BEFORE_WINDOW", "warning", early.id], ["CONSULT_AFTER_HOURS", "warning", late.id], ["CONSULT_LUNCH_BREAK", "info", lunch.id]]);
});
test("rule 6: a stored consult start is used as it is", () => {
  assert.equal(run([appt({ slotTime: "09:00", consultStart: "10:40" })], MON, onlyRule(6)).findings.length, 0);
});

// ---------- rule 7 ----------
test("rule 7: family members one after another are noted; someone between them breaks it", () => {
  const a = appt({ slotTime: "12:00", familyGroup: "F5" }), b = appt({ slotTime: "12:10", familyGroup: "F5" }),
        c = appt({ slotTime: "12:20" }), d = appt({ slotTime: "12:30", familyGroup: "F5" });
  const f = run([a, b, c, d], MON, onlyRule(7)).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id]), [["FAMILY_CONTINUOUS", "info", a.id], ["FAMILY_CONTINUOUS", "info", b.id]]);
});

// ---------- rule 8 ----------
test("rule 8A: AT/Gonio back to back is warned; an easy old patient between is fine", () => {
  const on = { on: { ...onlyRule(8).on, RULE_GONIO_AT_CAP: false, RULE_GONIO_TIMING: false, RULE_AT_TIMING: false } };
  const a = appt({ slotTime: "15:00", planOfAction: '["AT (BE)"]' }), b = appt({ slotTime: "15:10", planOfAction: '["GONIO (BE)","AT (BE)"]' });
  assert.deepEqual(run([a, b], MON, on).findings.map((x) => [x.code, x.level, x.id]), [["GONIO_AT_CONSECUTIVE", "warning", b.id]]);
  const c = appt({ slotTime: "15:00", planOfAction: "AT" }), easy = appt({ slotTime: "15:05", planOfAction: "REF", consultStart: "15:06" }),
        d = appt({ slotTime: "15:10", planOfAction: "AT" });
  assert.equal(run([c, easy, d], MON, on).findings.length, 0);
});
test("rule 8B: more than 3 AT/Gonio on a day is an error (waitlist counts)", () => {
  const on = { on: { ...onlyRule(8).on, RULE_GONIO_AT_CONSECUTIVE: false, RULE_GONIO_TIMING: false, RULE_AT_TIMING: false } };
  const three = ["15:00", "15:30", "16:00"].map((t) => appt({ slotTime: t, planOfAction: "AT" }));
  assert.equal(run(three, MON, on).findings.length, 0);
  const f = run([...three, appt({ slotTime: null, planOfAction: "GONIO" })], MON, on).findings;
  assert.deepEqual(f.map((x) => [x.code, x.level, x.id, x.ids.length]), [["GONIO_AT_DAILY_CAP", "error", null, 4]]);
});
test("rule 8C/8D: Gonio and AT before 14:30 are noted (AT+Gonio once, special cases skipped)", () => {
  const on = { on: { ...onlyRule(8).on, RULE_GONIO_AT_CONSECUTIVE: false, RULE_GONIO_AT_CAP: false } };
  const g = appt({ slotTime: "11:00", planOfAction: "GONIO" }), at = appt({ slotTime: "12:00", planOfAction: "AT" }),
        both = appt({ slotTime: "13:00", planOfAction: "GONIO, AT" }), vip = appt({ slotTime: "10:00", planOfAction: "AT", tags: ["VIP"] }),
        late = appt({ slotTime: "14:30", planOfAction: "AT" });
  const f = run([g, at, both, vip, late], MON, on).findings;
  assert.deepEqual(f.map((x) => [x.code, x.id]).sort(), [["AT_MORNING", at.id], ["GONIO_MORNING", both.id], ["GONIO_MORNING", g.id]].sort());
});

// ---------- rule 9 and 16 ----------
test("rule 9: a non-HFA patient in 09:20 or 09:40 is warned", () => {
  const a = appt({ slotTime: "09:20", planOfAction: "REF" }), b = appt({ slotTime: "09:40", planOfAction: '["HFA (BE)"]' });
  assert.deepEqual(run([a, b], MON, onlyRule(9)).findings.map((x) => [x.code, x.level, x.id]), [["HFA_SLOT_NON_HFA", "warning", a.id]]);
});
test("rule 9: an HFA patient outside the HFA slots is told about them more than a day ahead", () => {
  const a = appt({ slotTime: "10:00", planOfAction: "HFA" });
  assert.deepEqual(codes(run([a], MON, onlyRule(9), TODAY).findings), ["HFA_IN_NON_HFA_SLOT"]);   // 7 days ahead
});
test("rule 16: from the day before, an HFA patient may take another slot without a note", () => {
  const a = appt({ slotTime: "10:00", planOfAction: "HFA" });
  assert.equal(run([a], "2026-10-20", onlyRule(9), TODAY).findings.length, 0);                    // tomorrow
  assert.equal(run([a], TODAY, onlyRule(9), TODAY).findings.length, 0);                           // today
});

// ---------- rule 10 ----------
test("rule 10: ROP off a Wednesday is an error (waitlist too); on Wednesday fine", () => {
  const a = appt({ slotTime: "11:00", planOfAction: '["ROP"]' }), w = appt({ slotTime: null, planOfAction: "ROP" });
  assert.deepEqual(run([a, w], THU, onlyRule(10)).findings.map((x) => [x.code, x.level]), [["ROP_WRONG_DAY", "error"], ["ROP_WRONG_DAY", "error"]]);
  assert.equal(run([a, w], WED, onlyRule(10)).findings.length, 0);
});

// ---------- rule 11 ----------
test("rule 11: laser off Tuesday/Friday is an error unless SVV advised", () => {
  const a = appt({ slotTime: "11:00", planOfAction: '["FOCAL LASER (RE)"]' }), svv = appt({ slotTime: "12:00", planOfAction: "PRP LASER", remarks: "SVV told to give" }),
        tag = appt({ slotTime: "12:10", planOfAction: "LASER", tags: ["SVV advised"] });
  assert.deepEqual(run([a, svv, tag], MON, onlyRule(11)).findings.map((x) => [x.code, x.level, x.id]), [["LASER_WRONG_DAY", "error", a.id]]);
  assert.equal(run([a], TUE, onlyRule(11)).findings.length, 0);
  assert.equal(run([a], FRI, onlyRule(11)).findings.length, 0);
});

// ---------- rule 12 ----------
test("rule 12: wheelchair between 10:00 and 15:59 is noted", () => {
  const mk = (t: string, x: Partial<RuleAppt> = {}) => appt({ slotTime: t, tags: ["Wheelchair"], ...x });
  const a = mk("09:50"), b = mk("10:00"), c = mk("15:50"), d = mk("16:00"), e = appt({ slotTime: "12:00", remarks: "WHEEL CHAIR" });
  const f = run([a, b, c, d, e], MON, onlyRule(12)).findings;
  assert.deepEqual(f.map((x) => x.id).sort(), [b.id, c.id, e.id].sort());
  assert.ok(f.every((x) => x.code === "WHEELCHAIR_TIMING" && x.level === "info"));
});

// ---------- rule 13 ----------
test("rule 13: less than 20 minutes after a laser consultation is warned", () => {
  const a = appt({ slotTime: "11:00", planOfAction: "FOCAL LASER" }),     // consult 11:05
        b = appt({ slotTime: "11:10" }), c = appt({ slotTime: "11:40", planOfAction: "FOCAL LASER" }), d = appt({ slotTime: "12:10" });
  assert.deepEqual(run([a, b, c, d], TUE, onlyRule(13)).findings.map((x) => [x.code, x.level, x.id, x.ids]), [["LASER_DURATION", "warning", b.id, [a.id, b.id]]]);
});

// ---------- rule 14 ----------
test("rule 14: off unless switched on; when on, too little time for the plan is warned", () => {
  const a = appt({ slotTime: "10:00", planOfAction: '["REF","DIL"]' }), b = appt({ slotTime: "10:10" }), c = appt({ slotTime: "10:30", planOfAction: "REF" }), d = appt({ slotTime: "10:40" });
  assert.equal(run([a, b, c, d]).findings.filter((x) => x.rule === 14).length, 0);
  assert.deepEqual(run([a, b, c, d], MON, onlyRule(14)).findings.map((x) => [x.code, x.id]), [["PLAN_DURATION", b.id]]);
});

// ---------- rule 15 ----------
test("rule 15: special cases are listed from remarks and tags, not as warnings", () => {
  const a = appt({ slotTime: "10:00", remarks: "vip - MD's relative" }), b = appt({ slotTime: null, tags: ["Wheelchair", "BNI"] }), c = appt({ slotTime: "11:00" });
  const r = run([a, b, c], MON, { on: {} });
  assert.deepEqual(r.specialCases, [{ id: a.id, types: ["VIP"] }, { id: b.id, types: ["BNI", "Wheelchair"] }]);
});

// ---------- switches and the booking-dialog view ----------
test("switches: a rule set OFF in settings reports nothing", () => {
  const a = newP({ slotTime: "09:00" });
  assert.deepEqual(codes(run([a], MON, onlyRule(1)).findings), ["NEW_PATIENT_BEFORE_TIME"]);
  assert.equal(run([a], MON, { on: { ...onlyRule(1).on, RULE_NEW_TIMING: false } }).findings.length, 0);
});
test("booking dialog: only findings that involve the booking being made are shown", () => {
  const other = newP({ slotTime: "09:00" }), cand = { ...newP({ slotTime: "16:20", planOfAction: "DIL" }), id: 0 };
  const all = run([other, cand]).findings;
  const mine = findingsFor(all, 0);
  assert.ok(all.some((x) => x.id === other.id));
  assert.ok(mine.length > 0 && mine.every((x) => x.ids.includes(0)));
  assert.equal(mine[0].level, "error");                    // errors first
});

console.log(`\n${passed} rule checks passed`);
