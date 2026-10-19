// The 16 scheduling rules from the Google app (legacy/sudarshan/RuleEngine.js, checks.md), as warnings.
// Nothing here refuses a booking (D-010): the result is shown in the booking dialog and on the day board.
// Rule cards with the legacy line references: analysis/sudarshan/rules/RULE_CARDS.md.
// The checks are pure functions over one day's appointments so each rule can be tested without a database.
import type { Db } from "../db.js";
import { q } from "../db.js";
import { fromMin, toMin } from "../lib/time.js";
import { blocksAt, BLOCK_WORDS, HFA_OPEN_DAYS_BEFORE, loadBlocks, type Block, type BlockKind } from "./reserved.js";

export type Level = "error" | "warning" | "info";

export interface RuleAppt {
  id: number;                     // 0 = the booking being checked (not saved yet)
  slotTime: string | null;        // null = waitlist
  consultStart: string | null;    // stored value; when empty it is worked out from the plan of action
  mrd: string | null;
  patientType: string | null;
  patientName: string;
  ageYears: number | null;
  planOfAction: string | null;
  remarks: string | null;
  tags: string[];
  familyGroup: string | null;
  appointmentType?: string | null; // visit type (GENERAL, HFA, INJECTION...), for the reserved slot blocks
  urgency?: string | null;
}

export interface Finding {
  rule: number;                   // 1-16, as numbered in checks.md
  code: string;                   // the Google app's rule code, e.g. NEW_PATIENT_BEFORE_TIME
  level: Level;
  id: number | null;              // the appointment the finding is shown on (null = whole day)
  ids: number[];                  // every appointment involved
  message: string;
  suggestion: string;
}

export interface SpecialCase { id: number; types: string[] }

export interface RuleSettings {
  on: Record<string, boolean>;
  newMorningStart: string; newEveningCutoff: string; newConsecutiveGap: number;
  familyMorningCutoff: string; familyMorningMax: number;
  consultStart: string; lunchStart: string; lunchEnd: string; consultEnd: string;
  hfaSlots: [string, string]; ropDay: string; laserDays: string[]; laserDuration: number;
  wheelchairMorningEnd: string; wheelchairEveningStart: string;
  gonioAtMaxPerDay: number; gonioEveningStart: string; atEveningStart: string;
}

/** Rule switches. All ON in the Google app; RULE_PLAN_DURATION (rule 14) was never built there, so it starts OFF. */
export const RULE_SWITCHES: Record<string, boolean> = {
  RULE_NEW_TIMING: true, RULE_FAMILY_TIMING: true, RULE_FAMILY_MORNING: true, RULE_NEW_CONSECUTIVE: true,
  RULE_NEW_AFTER_4PM: true, RULE_CONSULT_WINDOW: true, RULE_FAMILY_CONTINUOUS: true, RULE_GONIO_AT_CONSECUTIVE: true,
  RULE_GONIO_AT_CAP: true, RULE_GONIO_TIMING: true, RULE_AT_TIMING: true, RULE_HFA_SLOT: true, RULE_ROP_DAY: true,
  RULE_LASER_DAY: true, RULE_LASER_DURATION: true, RULE_WHEELCHAIR: true, RULE_PLAN_DURATION: false, RULE_RESERVED_SLOTS: true,
};

/** What the settings screen shows: each switch in plain words, and each number with its kind and setting key. */
export const RULE_SWITCH_LABELS: Record<string, string> = {
  RULE_NEW_TIMING: "1. New patients not before the morning start", RULE_FAMILY_TIMING: "2. Family members not before the family cutoff",
  RULE_FAMILY_MORNING: "3. A large family not all in the morning", RULE_NEW_CONSECUTIVE: "4. No two new patients one after another",
  RULE_NEW_AFTER_4PM: "5. No new patients after the evening cutoff", RULE_CONSULT_WINDOW: "6. Consultation within the doctor's hours",
  RULE_FAMILY_CONTINUOUS: "7. Family members not one after another", RULE_GONIO_AT_CONSECUTIVE: "8a. AT / Gonio not one after another",
  RULE_GONIO_AT_CAP: "8b. AT / Gonio daily maximum", RULE_GONIO_TIMING: "8c. Gonio best in the afternoon", RULE_AT_TIMING: "8d. AT best in the afternoon",
  RULE_HFA_SLOT: "9. HFA slots kept for HFA patients", RULE_ROP_DAY: "10. ROP only on the ROP day", RULE_LASER_DAY: "11. Laser only on laser days",
  RULE_WHEELCHAIR: "12. Wheelchair patients early or late", RULE_LASER_DURATION: "13. Time after a laser",
  RULE_PLAN_DURATION: "14. Time for each plan of action (never used in the Google app)",
  RULE_RESERVED_SLOTS: "17. Visit types booked in their own times (the Google app's reserved blocks)",
};
export type RuleFieldKind = "time" | "number" | "day" | "days";
export const RULE_FIELDS: { key: string; label: string; kind: RuleFieldKind; setting: keyof RuleSettings; index?: number }[] = [
  { key: "NEW_MORNING_START", label: "New patients from", kind: "time", setting: "newMorningStart" },
  { key: "NEW_EVENING_CUTOFF", label: "No new patients from", kind: "time", setting: "newEveningCutoff" },
  { key: "NEW_CONSECUTIVE_GAP", label: "Two new patients at least (minutes apart)", kind: "number", setting: "newConsecutiveGap" },
  { key: "FAMILY_MORNING_CUTOFF", label: "Family members from", kind: "time", setting: "familyMorningCutoff" },
  { key: "FAMILY_MORNING_MAX", label: "Most family members in one morning", kind: "number", setting: "familyMorningMax" },
  { key: "CONSULT_WINDOW_START", label: "Doctor starts", kind: "time", setting: "consultStart" },
  { key: "CONSULT_WINDOW_LUNCH_START", label: "Lunch from", kind: "time", setting: "lunchStart" },
  { key: "CONSULT_WINDOW_LUNCH_END", label: "Lunch until", kind: "time", setting: "lunchEnd" },
  { key: "CONSULT_WINDOW_END", label: "Doctor ends", kind: "time", setting: "consultEnd" },
  { key: "HFA_SLOT_1", label: "HFA slot 1", kind: "time", setting: "hfaSlots", index: 0 },
  { key: "HFA_SLOT_2", label: "HFA slot 2", kind: "time", setting: "hfaSlots", index: 1 },
  { key: "ROP_DAY", label: "ROP day", kind: "day", setting: "ropDay" },
  { key: "LASER_DAYS", label: "Laser days", kind: "days", setting: "laserDays" },
  { key: "LASER_DURATION", label: "Minutes after a laser", kind: "number", setting: "laserDuration" },
  { key: "WHEELCHAIR_MORNING_END", label: "Wheelchair: morning until", kind: "time", setting: "wheelchairMorningEnd" },
  { key: "WHEELCHAIR_EVENING_START", label: "Wheelchair: evening from", kind: "time", setting: "wheelchairEveningStart" },
  { key: "GONIO_AT_MAX_PER_DAY", label: "Most AT / Gonio in a day", kind: "number", setting: "gonioAtMaxPerDay" },
  { key: "GONIO_EVENING_START", label: "Gonio best from", kind: "time", setting: "gonioEveningStart" },
  { key: "AT_EVENING_START", label: "AT best from", kind: "time", setting: "atEveningStart" },
];

/** The Google app's defaults (Code.js initializeRuleSettingsSheet). */
export const DEFAULT_RULE_SETTINGS: RuleSettings = {
  on: { ...RULE_SWITCHES },
  newMorningStart: "10:00", newEveningCutoff: "16:00", newConsecutiveGap: 30,
  familyMorningCutoff: "11:30", familyMorningMax: 3,
  consultStart: "10:30", lunchStart: "13:30", lunchEnd: "14:30", consultEnd: "17:30",
  hfaSlots: ["09:20", "09:40"], ropDay: "WED", laserDays: ["TUE", "FRI"], laserDuration: 20,
  wheelchairMorningEnd: "10:00", wheelchairEveningStart: "16:00",
  gonioAtMaxPerDay: 3, gonioEveningStart: "14:30", atEveningStart: "14:30",
};

export interface DayContext {
  date: string;                   // YYYY-MM-DD
  today: string;                  // YYYY-MM-DD in clinic time
  settings: RuleSettings;
  prepMinutes: Map<string, number>;   // plan of action name (upper case) -> PrepMin
  blocks?: Block[];                   // reserved slot blocks (services/reserved.ts); none = rule 9 uses the HFA times
}

// ---------- helpers (same matching as RuleEngine.js, so a plan reads the same way it did) ----------

export interface ProcTags { HFA: boolean; LASER: boolean; ROP: boolean; GONIO: boolean; AT: boolean; OCT: boolean; DIL: boolean;
  REF: boolean; DIRECT: boolean; SQUINT: boolean; IVR: boolean; IVTA: boolean; HOMIDE: boolean; YAG: boolean; BYNOCS: boolean; REVIEW: boolean }

/** RuleEngine.js:13 parseProcedureTags: plain substring match on the upper-cased plan; AT as a whole word. */
export function procTags(plan: string | null): ProcTags {
  const p = (plan ?? "").toUpperCase();
  const has = (s: string) => p.includes(s);
  return {
    HFA: has("HFA"), LASER: has("LASER"), ROP: has("ROP"), GONIO: has("GONIO"), AT: /\bAT\b/.test(p) || has("A-SCAN"),
    OCT: has("OCT"), DIL: has("DIL"), REF: has("REF"), DIRECT: has("DIRECT"), SQUINT: has("SQUINT"),
    IVR: has("IVR") && !has("IVTA"), IVTA: has("IVTA"), HOMIDE: has("HOMIDE"), YAG: has("YAG"), BYNOCS: has("BYNOCS"), REVIEW: has("REVIEW"),
  };
}

/** RuleEngine.js:47 parseRemarksFlags, reading the special-case tags as well as the remarks. */
export function specialFlags(a: Pick<RuleAppt, "remarks" | "tags">) {
  const t = `${a.remarks ?? ""} ${a.tags.join(" ")}`.toUpperCase();
  const isVIP = t.includes("VIP"), isBNI = t.includes("BNI"), isSVV = t.includes("SVV");
  const isWheelchair = t.includes("WHEEL CHAIR") || t.includes("WHEELCHAIR");
  return { isVIP, isBNI, isWheelchair, isSVV, isSpecial: isVIP || isBNI || isWheelchair || isSVV };
}

/** Is this booking the kind a reserved block is kept for? Visit type, plan of action or urgency decide. */
export function isKind(kind: BlockKind, a: Pick<RuleAppt, "planOfAction" | "appointmentType" | "urgency" | "mrd" | "patientType">): boolean {
  const t = procTags(a.planOfAction), type = (a.appointmentType ?? "").toUpperCase(), urg = (a.urgency ?? "").toUpperCase();
  const plan = (a.planOfAction ?? "").toUpperCase();
  switch (kind) {
    case "HFA": return t.HFA || type === "HFA";
    case "ROP": return t.ROP || type === "ROP";
    case "INJECTION": return t.IVR || t.IVTA || /\bINJ|OZURDEX|EYLEA|FARICIMAB|RAZUMAB|RANIBIZUMAB|AVASTIN/.test(plan) || type === "INJECTION";
    case "LASER": return t.LASER || t.YAG || type === "LASER";
    case "DILATION": return t.DIL || type === "DILATION";
    case "EMERGENCY": return urg === "EMERGENCY" || type === "EMERGENCY";
    case "URGENT NEW": return type === "URGENT NEW" || (urg === "URGENT" && isNewPatient(a));
  }
}

/** RuleEngine.js:159: new = MRD starts with N; no MRD yet = patient type says New or Guest. */
export function isNewPatient(a: Pick<RuleAppt, "mrd" | "patientType">): boolean {
  const mrd = (a.mrd ?? "").trim();
  if (!mrd) { const pt = (a.patientType ?? "").toLowerCase(); return pt === "guest" || pt.includes("new"); }
  return /^n/i.test(mrd);
}
/** RuleEngine.js:173: old = MRD starts with S. */
export const isOldPatient = (a: Pick<RuleAppt, "mrd">) => /^s/i.test((a.mrd ?? "").trim());

/** Under 18, or tagged Kids. */
export const isChild = (a: Pick<RuleAppt, "ageYears" | "tags">) =>
  (a.ageYears != null && a.ageYears < 18) || a.tags.some((t) => t.toLowerCase() === "kids");

/** Plan of action items, as Code.js:8661 reads them: JSON list or text split on / , ; with "(RE)" style eye notes removed. */
export function planItems(plan: string | null): string[] {
  if (!plan) return [];
  let items: unknown[] = [];
  const s = plan.trim();
  if (s.startsWith("[")) { try { items = JSON.parse(s); } catch { items = []; } }
  else items = s.split(/[/,;]/);
  return items.map((x) => String(typeof x === "object" && x ? (x as any).name : x).replace(/\s*\([^)]*\)\s*/, "").trim().toUpperCase()).filter(Boolean);
}

/** Consult start: stored value, or slot + the longest PrepMin of the plan's procedures (Code.js:8661). */
export function consultStartOf(a: RuleAppt, prep: Map<string, number>): string | null {
  if (a.consultStart) return a.consultStart;
  if (!a.slotTime) return null;
  const extra = Math.max(0, ...planItems(a.planOfAction).map((n) => prep.get(n) ?? 0));
  return fromMin(toMin(a.slotTime) + extra);
}

/** Rule 14 durations (checks.md; RuleEngine.js:225 getMaxProcedureDuration, never called by the Google app). */
export function planDuration(plan: string | null): number {
  const t = procTags(plan), d: number[] = [];
  if (t.HFA || t.LASER) d.push(20);
  if (t.GONIO || t.DIL || t.ROP || t.SQUINT || t.IVR || t.IVTA) d.push(15);
  if (t.OCT || t.AT || t.REF || t.YAG || t.REVIEW || t.BYNOCS) d.push(10);
  if (t.DIRECT || t.HOMIDE) d.push(5);
  return d.length ? Math.max(...d) : 0;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_WORDS: Record<string, string> = { SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday" };
export const dayCode = (d: string) => DAYS[new Date(d + "T00:00:00Z").getUTCDay()];
const dayWords = (codes: string[]) => codes.map((c) => DAY_WORDS[c] ?? c).join(" or ");
const DAY_NAMES: Record<string, string> = { M: "Mon", Tu: "Tue", W: "Wed", Th: "Thu", F: "Fri", Sa: "Sat", Su: "Sun" };
const dayCodeMin = (d: string) => ["Su", "M", "Tu", "W", "Th", "F", "Sa"][new Date(d + "T00:00:00Z").getUTCDay()];
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
const hourOf = (t: string) => Number(t.slice(0, 2));

// ---------- the day check ----------

export function checkDay(appts: RuleAppt[], ctx: DayContext): { findings: Finding[]; specialCases: SpecialCase[] } {
  const s = ctx.settings, on = (k: string) => s.on[k] ?? RULE_SWITCHES[k] ?? false;
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const name = (a: RuleAppt) => a.patientName;
  const slotted = appts.filter((a) => a.slotTime);
  const cs = new Map(appts.map((a) => [a.id, consultStartOf(a, ctx.prepMinutes)]));
  // consult order: consult start, else slot (RuleEngine.js:353)
  const byConsult = slotted.map((a) => ({ a, m: toMin(cs.get(a.id) ?? a.slotTime!) })).sort((x, y) => x.m - y.m);
  const bySlot = [...slotted].sort((x, y) => toMin(x.slotTime!) - toMin(y.slotTime!));
  const families = new Map<string, RuleAppt[]>();
  for (const a of appts) {
    const f = a.familyGroup?.trim();
    if (f && f.toLowerCase() !== "null") families.set(f, [...(families.get(f) ?? []), a]);
  }

  // 1. New patients only from 10:00
  if (on("RULE_NEW_TIMING")) for (const a of slotted)
    if (isNewPatient(a) && toMin(a.slotTime!) < toMin(s.newMorningStart))
      add({ rule: 1, code: "NEW_PATIENT_BEFORE_TIME", level: "warning", id: a.id, ids: [a.id],
        message: `New patient ${name(a)} at ${a.slotTime}, before ${s.newMorningStart}`, suggestion: `Move to ${s.newMorningStart} or later` });

  // 2. Family members not before 11:30, except special cases
  if (on("RULE_FAMILY_TIMING")) for (const [fid, members] of families) for (const a of members)
    if (a.slotTime && !specialFlags(a).isSpecial && toMin(a.slotTime) < toMin(s.familyMorningCutoff))
      add({ rule: 2, code: "FAMILY_BEFORE_CUTOFF", level: "info", id: a.id, ids: [a.id],
        message: `Family member ${name(a)} (family ${fid}) at ${a.slotTime}, before ${s.familyMorningCutoff}`, suggestion: `Consider ${s.familyMorningCutoff} or later` });

  // 3. A family of more than 3 should not all come in the morning
  if (on("RULE_FAMILY_MORNING")) for (const [fid, members] of families) {
    if (members.length <= s.familyMorningMax) continue;
    const morning = members.filter((a) => a.slotTime && hourOf(a.slotTime) < 12);
    if (morning.length > s.familyMorningMax) for (const a of morning)
      add({ rule: 3, code: "FAMILY_SIZE_MORNING", level: "warning", id: a.id, ids: morning.map((m) => m.id),
        message: `Family ${fid} has ${members.length} members, ${morning.length} of them in the morning (most ${s.familyMorningMax})`, suggestion: "Spread them across morning and afternoon" });
  }

  // 4. No two new patients in a row: an old patient between them, unless they are far enough apart
  if (on("RULE_NEW_CONSECUTIVE")) {
    const news = byConsult.filter((x) => isNewPatient(x.a));
    for (let i = 0; i < news.length - 1; i++) {
      const c = news[i], n = news[i + 1], gap = n.m - c.m;
      if (gap >= s.newConsecutiveGap) continue;
      const sameFamilySameSlot = c.a.familyGroup?.trim() && c.a.familyGroup.trim() === n.a.familyGroup?.trim() && c.a.slotTime === n.a.slotTime;
      if (sameFamilySameSlot) continue;
      if (byConsult.some((x) => x.a !== c.a && x.a !== n.a && x.m > c.m && x.m < n.m && isOldPatient(x.a))) continue;
      add({ rule: 4, code: "NEW_CONSECUTIVE", level: "info", id: n.a.id, ids: [c.a.id, n.a.id],
        message: `New patients ${name(c.a)} (consult ${fromMin(c.m)}) and ${name(n.a)} (consult ${fromMin(n.m)}) are only ${gap} min apart with no old patient between`,
        suggestion: "Put an old patient between them" });
    }
  }

  // 5. No new patients from 16:00 (children, direct OPD, VIP and BNI may); never a new patient with dilation
  if (on("RULE_NEW_AFTER_4PM")) for (const a of slotted) {
    if (!isNewPatient(a) || hourOf(a.slotTime!) < hourOf(s.newEveningCutoff)) continue;
    const t = procTags(a.planOfAction), f = specialFlags(a);
    if (t.DIL) add({ rule: 5, code: "NEW_AFTER_EVENING_DILATION", level: "error", id: a.id, ids: [a.id],
      message: `New patient ${name(a)} with dilation at ${a.slotTime}, after ${s.newEveningCutoff}`, suggestion: `New patients needing dilation should come before ${s.newEveningCutoff}` });
    else if (!isChild(a) && !t.DIRECT && !f.isVIP && !f.isBNI) add({ rule: 5, code: "NEW_AFTER_EVENING", level: "warning", id: a.id, ids: [a.id],
      message: `New patient ${name(a)} at ${a.slotTime}, after ${s.newEveningCutoff}`, suggestion: "Only children, direct OPD or special cases after this time" });
  }

  // 6. Consultation 10:30-13:30 and 14:30-17:30
  if (on("RULE_CONSULT_WINDOW")) for (const a of slotted) {
    const c = cs.get(a.id)!, m = toMin(c);
    if (m < toMin(s.consultStart)) add({ rule: 6, code: "CONSULT_BEFORE_WINDOW", level: "warning", id: a.id, ids: [a.id],
      message: `${name(a)}'s consultation would start at ${c}, before the doctor starts at ${s.consultStart}`, suggestion: `Doctor available from ${s.consultStart}` });
    else if (m > toMin(s.lunchStart) && m < toMin(s.lunchEnd)) add({ rule: 6, code: "CONSULT_LUNCH_BREAK", level: "info", id: a.id, ids: [a.id],
      message: `${name(a)}'s consultation would start at ${c}, in the lunch break ${s.lunchStart}-${s.lunchEnd}`, suggestion: "Check this is intended" });
    else if (m > toMin(s.consultEnd)) add({ rule: 6, code: "CONSULT_AFTER_HOURS", level: "warning", id: a.id, ids: [a.id],
      message: `${name(a)}'s consultation would start at ${c}, after ${s.consultEnd}`, suggestion: "Check this is intended" });
  }

  // 7. Family members not one after another
  if (on("RULE_FAMILY_CONTINUOUS")) {
    let prev: string | null = null, streak: RuleAppt[] = [];
    const report = () => {
      if (streak.length < 2) return;
      const names = streak.map((m) => `${name(m)} (${m.slotTime})`).join(", ");
      for (const m of streak) add({ rule: 7, code: "FAMILY_CONTINUOUS", level: "info", id: m.id, ids: streak.map((x) => x.id),
        message: `Family ${prev} booked one after another: ${names}`, suggestion: "Separate them with other patients" });
    };
    for (const a of bySlot) {
      const f = a.familyGroup?.trim() && a.familyGroup.trim().toLowerCase() !== "null" ? a.familyGroup.trim() : null;
      if (f && f === prev) streak.push(a);
      else { report(); streak = f ? [a] : []; prev = f; }
    }
    report();
  }

  // 8. AT / Gonio: A not back to back, B at most 3 a day, C Gonio and D AT best after 14:30
  const atg = (a: RuleAppt) => { const t = procTags(a.planOfAction); return t.AT || t.GONIO; };
  if (on("RULE_GONIO_AT_CONSECUTIVE")) for (let i = 0; i < byConsult.length - 1; i++) {
    const c = byConsult[i], n = byConsult[i + 1];
    if (!atg(c.a) || !atg(n.a)) continue;
    const easyOldBetween = byConsult.some((x) => x.a !== c.a && x.a !== n.a && x.m > c.m && x.m < n.m && isOldPatient(x.a) &&
      ((t) => !t.AT && !t.GONIO && !t.HFA && !t.LASER && !t.OCT)(procTags(x.a.planOfAction)));
    if (!easyOldBetween) add({ rule: 8, code: "GONIO_AT_CONSECUTIVE", level: "warning", id: n.a.id, ids: [c.a.id, n.a.id],
      message: `AT/Gonio patients back to back: ${name(c.a)} (consult ${fromMin(c.m)}) and ${name(n.a)} (consult ${fromMin(n.m)})`,
      suggestion: "Put an old patient without AT, Gonio, HFA, laser or OCT between them" });
  }
  if (on("RULE_GONIO_AT_CAP")) {
    const all = appts.filter(atg);
    if (all.length > s.gonioAtMaxPerDay) add({ rule: 8, code: "GONIO_AT_DAILY_CAP", level: "error", id: null, ids: all.map((a) => a.id),
      message: `${all.length} AT/Gonio appointments on this day, at most ${s.gonioAtMaxPerDay} allowed`, suggestion: `Keep AT/Gonio to ${s.gonioAtMaxPerDay} or fewer a day` });
  }
  for (const [key, code, which, after] of [["RULE_GONIO_TIMING", "GONIO_MORNING", "Gonio", s.gonioEveningStart],
                                           ["RULE_AT_TIMING", "AT_MORNING", "AT", s.atEveningStart]] as const) {
    if (!on(key)) continue;
    for (const a of slotted) {
      const t = procTags(a.planOfAction);
      if (which === "Gonio" ? !t.GONIO : !t.AT || t.GONIO) continue;
      if (specialFlags(a).isSpecial) continue;
      const c = cs.get(a.id)!;
      if (toMin(c) < toMin(after)) add({ rule: 8, code, level: "info", id: a.id, ids: [a.id],
        message: `${which} for ${name(a)} with consultation at ${c}; best after ${after}`, suggestion: `Consider a slot after ${after}` });
    }
  }

  // 9 and 16. HFA slots are for HFA patients until 2 days before (the Google app's HFA block days and times; without
  // blocks, 09:20 and 09:40 every day). From then other plans may have them, and an HFA patient elsewhere is fine.
  if (on("RULE_HFA_SLOT")) {
    const daysAhead = daysBetween(ctx.today, ctx.date);
    const hfaBlocks = (ctx.blocks ?? []).filter((b) => b.kind === "HFA");
    const isHfaSlot = (t: string) => (hfaBlocks.length ? blocksAt(hfaBlocks, ctx.date, t).length > 0 : s.hfaSlots.includes(t));
    const hfaTimes = hfaBlocks.length ? [...new Set(hfaBlocks.filter((b) => b.day === "D" || b.day === dayCodeMin(ctx.date)).map((b) => b.start))] : s.hfaSlots;
    for (const a of slotted) {
      const inSlot = isHfaSlot(a.slotTime!), hfa = isKind("HFA", a);
      if (inSlot && !hfa && daysAhead > HFA_OPEN_DAYS_BEFORE) add({ rule: 9, code: "HFA_SLOT_NON_HFA", level: "error", id: a.id, ids: [a.id],
        message: `${a.slotTime} is kept for HFA patients until ${HFA_OPEN_DAYS_BEFORE} days before; ${name(a)} is not an HFA patient`,
        suggestion: `Choose another time, or book it from ${HFA_OPEN_DAYS_BEFORE} days before the day (a manager can book now with a reason)` });
      else if (!inSlot && hfa && daysAhead > HFA_OPEN_DAYS_BEFORE && hfaTimes.length) add({ rule: 9, code: "HFA_IN_NON_HFA_SLOT", level: "info", id: a.id, ids: [a.id],
        message: `HFA patient ${name(a)} at ${a.slotTime}, not in an HFA slot (${daysAhead} days ahead)`, suggestion: `Move to ${hfaTimes.join(" or ")} if free` });
    }
  }

  // 10. ROP only on Wednesday
  const weekday = dayCode(ctx.date);
  if (on("RULE_ROP_DAY") && weekday !== s.ropDay) for (const a of appts)
    if (procTags(a.planOfAction).ROP) add({ rule: 10, code: "ROP_WRONG_DAY", level: "error", id: a.id, ids: [a.id],
      message: `ROP patient ${name(a)} on a ${DAY_WORDS[weekday]}; ROP is on ${dayWords([s.ropDay])}`, suggestion: `Move to a ${dayWords([s.ropDay])}` });

  // 11. Laser only on Tuesday and Friday, unless SVV advised
  if (on("RULE_LASER_DAY") && !s.laserDays.includes(weekday)) for (const a of appts)
    if (procTags(a.planOfAction).LASER && !specialFlags(a).isSVV) add({ rule: 11, code: "LASER_WRONG_DAY", level: "error", id: a.id, ids: [a.id],
      message: `Laser patient ${name(a)} on a ${DAY_WORDS[weekday]}; laser is on ${dayWords(s.laserDays)} unless SVV advised`, suggestion: `Move to a ${dayWords(s.laserDays)}` });

  // 12. Wheelchair patients early morning or evening
  if (on("RULE_WHEELCHAIR")) for (const a of slotted) {
    if (!specialFlags(a).isWheelchair) continue;
    const h = hourOf(a.slotTime!);
    if (h >= hourOf(s.wheelchairMorningEnd) && h < hourOf(s.wheelchairEveningStart)) add({ rule: 12, code: "WHEELCHAIR_TIMING", level: "info", id: a.id, ids: [a.id],
      message: `Wheelchair patient ${name(a)} at ${a.slotTime}, in the busy middle of the day`, suggestion: `Early morning (before ${s.wheelchairMorningEnd}) or evening (from ${s.wheelchairEveningStart})` });
  }

  // 13. Laser needs 20 minutes before the next consultation
  if (on("RULE_LASER_DURATION")) for (let i = 0; i < byConsult.length - 1; i++) {
    const c = byConsult[i], n = byConsult[i + 1], gap = n.m - c.m;
    if (!procTags(c.a.planOfAction).LASER || gap < 0 || gap >= s.laserDuration) continue;
    add({ rule: 13, code: "LASER_DURATION", level: "warning", id: n.a.id, ids: [c.a.id, n.a.id],
      message: `Laser for ${name(c.a)} needs ${s.laserDuration} min but ${name(n.a)}'s consultation is ${gap} min later`, suggestion: `Leave at least ${s.laserDuration} minutes after a laser` });
  }

  // 14. Time for the plan of action before the next booking (planned in checks.md, never switched on in the Google app)
  if (on("RULE_PLAN_DURATION")) for (let i = 0; i < bySlot.length - 1; i++) {
    const c = bySlot[i], n = bySlot[i + 1], need = planDuration(c.planOfAction), gap = toMin(n.slotTime!) - toMin(c.slotTime!);
    if (need > 0 && gap < need) add({ rule: 14, code: "PLAN_DURATION", level: "warning", id: n.id, ids: [c.id, n.id],
      message: `${name(c)}'s plan (${planItems(c.planOfAction).join(", ")}) needs ${need} min but ${name(n)} is booked ${gap} min later`, suggestion: `Leave ${need} minutes after this patient` });
  }

  // 17. Reserved slot blocks, as the Google app used them (Code.js getAllowedSlots): a booking whose VISIT TYPE is ROP,
  // INJECTION, LASER, DILATION, URGENT NEW or EMERGENCY belongs in that type's times. Other bookings may use those slots.
  // Outside them is a warning that can be ignored (Pavin, 19 Oct). HFA is rule 9 and the booking hold.
  if (on("RULE_RESERVED_SLOTS") && ctx.blocks?.length) {
    const code = dayCodeMin(ctx.date);
    for (const a of slotted) {
      const kind = (a.appointmentType ?? "").trim().toUpperCase() as BlockKind;
      if (!(kind in BLOCK_WORDS) || kind === "HFA") continue;
      const all = ctx.blocks.filter((b) => b.kind === kind);
      if (!all.length) continue;
      const today = all.filter((b) => b.day === "D" || b.day === code);
      if (blocksAt(today, ctx.date, a.slotTime!).length) continue;
      const where = (bs: Block[]) => bs.map((b) => `${b.day === "D" ? "" : `${DAY_NAMES[b.day] ?? b.day} `}${b.start}-${b.end}`).join(", ");
      add({ rule: 17, code: "OUTSIDE_RESERVED", level: "warning", id: a.id, ids: [a.id],
        message: today.length
          ? `${name(a)} is booked as ${BLOCK_WORDS[kind]} at ${a.slotTime}, outside the ${BLOCK_WORDS[kind]} time (${where(today)})`
          : `${name(a)} is booked as ${BLOCK_WORDS[kind]}, but there is no ${BLOCK_WORDS[kind]} time on this day (${where(all)})`,
        suggestion: "Book it anyway if the doctor agreed, or choose a time in the block" });
    }
  }

  // 15. Special cases are marked on the list (not a warning)
  const specialCases: SpecialCase[] = [];
  for (const a of appts) {
    const f = specialFlags(a), types = [f.isVIP && "VIP", f.isBNI && "BNI", f.isWheelchair && "Wheelchair", f.isSVV && "SVV"].filter(Boolean) as string[];
    if (types.length) specialCases.push({ id: a.id, types });
  }

  const order: Record<Level, number> = { error: 0, warning: 1, info: 2 };
  out.sort((x, y) => order[x.level] - order[y.level] || x.rule - y.rule);
  return { findings: out, specialCases };
}

/** Findings that concern one appointment (the booking being made or moved). */
export const findingsFor = (findings: Finding[], id: number) => findings.filter((f) => f.ids.includes(id));

// ---------- loading from the database ----------

/** A rule setting as imported from the RuleSettings sheet: "10:00", a Sheets day fraction (0.4166...), a number or ON/OFF. */
function asTime(v: unknown, dflt: string): string {
  const x = typeof v === "object" && v ? (v as any).value : v;
  if (typeof x === "string" && /^\d{1,2}:\d{2}/.test(x.trim())) return x.trim().padStart(5, "0").slice(0, 5);
  const n = Number(x);
  if (x !== "" && x != null && Number.isFinite(n) && n >= 0 && n < 1) return fromMin(Math.round(n * 1440));
  return dflt;
}
function asNum(v: unknown, dflt: number): number {
  const x = typeof v === "object" && v ? (v as any).value : v;
  const n = parseInt(String(x), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function asText(v: unknown): string | null {
  const x = typeof v === "object" && v ? (v as any).value : v;
  return typeof x === "string" && x.trim() ? x.trim().toUpperCase() : null;
}

export function parseRuleSettings(rows: { key: string; value: unknown }[]): RuleSettings {
  const m = new Map(rows.map((r) => [r.key.replace(/^rule\./, ""), r.value]));
  const d = DEFAULT_RULE_SETTINGS;
  const on: Record<string, boolean> = {};
  for (const [k, dflt] of Object.entries(RULE_SWITCHES)) { const t = asText(m.get(k)); on[k] = t ? t === "ON" : dflt; }
  return {
    on,
    newMorningStart: asTime(m.get("NEW_MORNING_START"), d.newMorningStart), newEveningCutoff: asTime(m.get("NEW_EVENING_CUTOFF"), d.newEveningCutoff),
    newConsecutiveGap: asNum(m.get("NEW_CONSECUTIVE_GAP"), d.newConsecutiveGap),
    familyMorningCutoff: asTime(m.get("FAMILY_MORNING_CUTOFF"), d.familyMorningCutoff), familyMorningMax: asNum(m.get("FAMILY_MORNING_MAX"), d.familyMorningMax),
    consultStart: asTime(m.get("CONSULT_WINDOW_START"), d.consultStart), lunchStart: asTime(m.get("CONSULT_WINDOW_LUNCH_START"), d.lunchStart),
    lunchEnd: asTime(m.get("CONSULT_WINDOW_LUNCH_END"), d.lunchEnd), consultEnd: asTime(m.get("CONSULT_WINDOW_END"), d.consultEnd),
    hfaSlots: [asTime(m.get("HFA_SLOT_1"), d.hfaSlots[0]), asTime(m.get("HFA_SLOT_2"), d.hfaSlots[1])],
    ropDay: asText(m.get("ROP_DAY")) ?? d.ropDay,
    laserDays: (asText(m.get("LASER_DAYS")) ?? d.laserDays.join(",")).split(",").map((x) => x.trim()).filter(Boolean),
    laserDuration: asNum(m.get("LASER_DURATION"), d.laserDuration),
    wheelchairMorningEnd: asTime(m.get("WHEELCHAIR_MORNING_END"), d.wheelchairMorningEnd),
    wheelchairEveningStart: asTime(m.get("WHEELCHAIR_EVENING_START"), d.wheelchairEveningStart),
    gonioAtMaxPerDay: asNum(m.get("GONIO_AT_MAX_PER_DAY"), d.gonioAtMaxPerDay),
    gonioEveningStart: asTime(m.get("GONIO_EVENING_START"), d.gonioEveningStart), atEveningStart: asTime(m.get("AT_EVENING_START"), d.atEveningStart),
  };
}

export async function loadRuleContext(date: string, today: string, db?: Db): Promise<DayContext> {
  const rows = await q<{ key: string; value: unknown }>(`SELECT key, value FROM app.settings WHERE key LIKE 'rule.%'`, [], db);
  const prep = await q<{ name: string; prep_min: number | null }>(`SELECT name, prep_min FROM app.plan_of_action WHERE is_active`, [], db);
  return { date, today, settings: parseRuleSettings(rows), prepMinutes: new Map(prep.map((p) => [p.name.trim().toUpperCase(), p.prep_min ?? 0])),
           blocks: await loadBlocks(db) };
}

/** Everything that holds or waits for a place that day (cancelled bookings are not checked). */
export async function loadDayAppts(date: string, db?: Db, excludeId: number | null = null): Promise<RuleAppt[]> {
  return q<RuleAppt>(
    `SELECT id::int AS id, to_char(slot_time,'HH24:MI') AS "slotTime", to_char(consult_start,'HH24:MI') AS "consultStart",
            mrd, patient_type AS "patientType", patient_name AS "patientName", age_years AS "ageYears",
            plan_of_action AS "planOfAction", remarks, tags, family_group AS "familyGroup",
            appointment_type AS "appointmentType", urgency
       FROM app.appointments
      WHERE appointment_date = $1 AND status <> 'cancelled' AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY slot_time NULLS LAST, id`, [date, excludeId], db);
}
