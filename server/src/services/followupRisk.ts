// Follow-up board (Phase B): which overdue patients to call first, and what to say. Pure functions, tested in
// test/followups.test.ts. The condition group is the one the analytics use (analytics.categorise over the latest
// examination findings, rules approved by Dr. Sameera), so the board and the dashboards agree.

export type Tier = 1 | 2 | 3 | 4;
export const TIER_WORDS: Record<Tier, string> = {
  1: "Urgent: treatment course or ROP",
  2: "High: retinal disease under care",
  3: "Monitor: diabetes or a condition to watch",
  4: "Routine",
};

export interface RiskInput {
  ageYears: number | null;
  condition: string | null;          // analytics.categorise('diagnosis', latest findings)
  lastInjectionDays: number | null;  // days since the last injection given
  lastInjection: string | null;      // e.g. "Razumab RE, 3rd"
  lastLaserDays: number | null;
  lastLaser: string | null;          // e.g. "Special PRP Laser LE"
  diabetes: boolean;                 // coded systemic illness
}

const T1_CONDITIONS = ["ROP / ROP screening", "Retinal detachment"];
const T2_CONDITIONS = ["Diabetic retinopathy / DME", "Retinal vein occlusion", "Age-related macular degeneration",
  "Vitreous haemorrhage", "Uveitis", "Macular hole / ERM / VMT"];
const T3_CONDITIONS = ["Glaucoma / suspect", "CSCR", "Hypertensive retinopathy", "Myopic fundus / degeneration"];

export function riskTier(x: RiskInput): { tier: Tier; reasons: string[] } {
  const reasons: string[] = [];
  let tier: Tier = 4;
  const at = (t: Tier) => { if (t < tier) tier = t; };
  if (x.lastInjectionDays != null) {
    reasons.push(`Injection ${x.lastInjection ?? ""} ${ago(x.lastInjectionDays)}`.replace(/\s+/g, " ").trim());
    at(x.lastInjectionDays <= 180 ? 1 : 2);
  }
  if (x.condition && T1_CONDITIONS.includes(x.condition)) { reasons.push(x.condition); at(1); }
  else if (x.ageYears === 0) { reasons.push("Infant (ROP screening age)"); at(1); }
  if (x.lastLaserDays != null && x.lastLaserDays <= 365) { reasons.push(`Laser ${x.lastLaser ?? ""} ${ago(x.lastLaserDays)}`.replace(/\s+/g, " ").trim()); at(2); }
  if (x.condition && T2_CONDITIONS.includes(x.condition)) { reasons.push(x.condition); at(2); }
  if (x.condition && T3_CONDITIONS.includes(x.condition)) { reasons.push(x.condition); at(3); }
  if (x.diabetes) { reasons.push("Diabetes"); at(3); }
  return { tier, reasons: [...new Set(reasons)] };
}

function ago(days: number) {
  if (days < 45) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} year${days >= 548 ? "s" : ""} ago`;
}

// ---------- call scripts (Settings > Follow-up call scripts; staff may rewrite them in Malayalam) ----------
export const DEFAULT_SCRIPTS: Record<Tier, string> = {
  1: "Namaskaram, this is {clinic} calling about {name}. {doctor} asked to see {name} by {due} to continue the treatment ({treatment}). A missed or late dose can cause vision loss that may not come back. Can we book a time this week?",
  2: "Namaskaram, this is {clinic} calling about {name}. {doctor} asked to see {name} by {due} to check the eyes after the last treatment ({treatment}). This condition can get worse without any pain or symptoms. When can {name} come?",
  3: "Namaskaram, this is {clinic} calling about {name}. The doctor advised a check-up by {due}. With diabetes and some eye conditions the retina can change before vision changes, so a regular check matters. Shall we book a time?",
  4: "Namaskaram, this is {clinic} calling about {name}. The doctor advised a follow-up visit by {due}. Would you like to book a time?",
};

export function fillScript(template: string, v: { clinic: string; name: string; doctor: string | null; due: string; treatment: string | null }) {
  return template
    .replace(/\{clinic\}/g, v.clinic)
    .replace(/\{name\}/g, v.name)
    .replace(/\{doctor\}/g, v.doctor ?? "The doctor")
    .replace(/\{due\}/g, v.due)
    .replace(/\s*\(\{treatment\}\)/g, v.treatment ? ` (${v.treatment})` : "")
    .replace(/\{treatment\}/g, v.treatment ?? "the treatment");
}
