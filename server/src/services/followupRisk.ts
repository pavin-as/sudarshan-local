// Follow-up board (Phase B): which team's list an overdue patient is on, and who to call first. Pure functions, tested in
// test/followups.test.ts. The condition group is the one the analytics use (analytics.categorise over the latest
// examination findings, rules approved by Dr. Sameera), so the board and the dashboards agree.

// Call order inside the list: 1 treatment course or ROP, 2 retinal disease under care, 3 diabetes or a condition to watch, 4 the rest
export type Tier = 1 | 2 | 3 | 4;

export interface RiskInput {
  ageYears: number | null;
  condition: string | null;          // analytics.categorise('diagnosis', latest findings)
  lastInjectionDays: number | null;  // days since the last injection given
  lastInjection: string | null;      // e.g. "Razumab RE, 3rd"
  lastLaserDays: number | null;
  lastLaser: string | null;          // e.g. "Special PRP Laser LE"
  diabetes: boolean;                 // coded systemic illness
  rop?: boolean;                     // on the ROP list (ropActive in the route); when given it replaces the exam-finding guess
  ropDays?: number | null;           // days since the last ROP visit
}

// ---------- groups: one card per team (a patient can be in more than one) ----------
export type Group = "rop" | "injection" | "laser" | "dr" | "retina" | "routine";
export const GROUPS: { key: Group; label: string; rule: string }[] = [
  { key: "rop", label: "ROP", rule: "ROP clinic or screening visit in the last 12 months, until the retina is mature" },
  { key: "injection", label: "Injection", rule: "injection given in the last 12 months" },
  { key: "laser", label: "Laser", rule: "laser done in the last 12 months" },
  { key: "dr", label: "Diabetic retinopathy", rule: "latest examination shows diabetic retinopathy or DME" },
  { key: "retina", label: "Other retina", rule: "vein occlusion, AMD, detachment, vitreous bleed, macular hole / ERM, uveitis, CSCR, hypertensive or myopic retina" },
  { key: "routine", label: "Routine", rule: "overdue, and in none of the groups above" },
];
const RETINA_CONDITIONS = ["Retinal detachment", "Retinal vein occlusion", "Age-related macular degeneration", "Vitreous haemorrhage",
  "Uveitis", "Macular hole / ERM / VMT", "CSCR", "Hypertensive retinopathy", "Myopic fundus / degeneration"];

export function groupsFor(x: RiskInput): Group[] {
  const g: Group[] = [];
  if (x.rop) g.push("rop");
  if (x.lastInjectionDays != null && x.lastInjectionDays <= 365) g.push("injection");
  if (x.lastLaserDays != null && x.lastLaserDays <= 365) g.push("laser");
  if (x.condition === "Diabetic retinopathy / DME") g.push("dr");
  if (x.condition && RETINA_CONDITIONS.includes(x.condition)) g.push("retina");
  return g.length ? g : ["routine"];
}

const T1_CONDITIONS = ["Retinal detachment"];
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
  const rop = x.rop ?? x.condition === "ROP / ROP screening";
  if (rop) { reasons.push(x.ropDays != null ? `ROP, last ROP visit ${ago(x.ropDays)}` : "ROP"); at(1); }
  if (x.condition && T1_CONDITIONS.includes(x.condition)) { reasons.push(x.condition); at(1); }
  else if (!rop && x.ageYears === 0) { reasons.push("Infant (ROP screening age)"); at(1); }
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
