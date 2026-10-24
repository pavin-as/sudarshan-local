// Doctor summary (Phase B, D-026): the facts for one patient on one clinic day, every item with the Yarago visit it
// came from. Pure data: nothing here is written by a model. The overview (services/overview.ts) is written FROM these.
// Layout agreed with Dr. Sameera 19 Oct: header, overview, alerts, findings by eye, vision and pressure, treatment,
// last visit.
import { createHash } from "node:crypto";
import { one, q, type Db } from "../db.js";

export interface Sourced<T> { value: T; date: string | null; visitId: number | null }

export interface SummaryFacts {
  forDate: string;
  patient: { patientId: number; mrd: string | null; name: string | null; ageYears: number | null; ageText?: string; sex: string | null;   // ageText only under a year
             language: string | null; visits: number; firstVisit: string | null };
  today: { slotTime: string | null; plan: string | null; doctor: string | null; token: string | null; appointmentId: number | null } | null;
  alerts: {
    systemic: Sourced<string> | null;            // coded systemic illness, latest visit that has it
    systemicNote: Sourced<string> | null;        // typed note, when no coded value
    allergies: Sourced<string> | null;           // null = not recorded (never "none")
    followups: { late: number; missed: number; last: { due: string; came: string | null } | null };
    dues: { total: number; pharmacy: number; opd: number; optical: number; ipd: number } | null;
  };
  findings: { date: string; visitId: number; rows: { part: string; re: string | null; le: string | null;
              reSince: string | null; leSince: string | null }[] } | null;
  vision: { rows: { visitId: number; date: string; bcvaRe: string | null; bcvaLe: string | null;
                    iopRe: number | null; iopLe: number | null }[];
            change: { re: VisionChange | null; le: VisionChange | null } };
  treatment: { rows: { date: string | null; visitId: number | null; eye: string | null; kind: "injection" | "laser";
                       what: string; number: number | null }[];
               next: { date: string; visitId: number } | null };
  lastVisit: { visitId: number; date: string; doctor: string | null; complaints: string | null; plan: string | null;
               remarks: string | null; medicines: string | null; followup: string | null } | null;
}

export interface VisionChange { from: string; to: string; lines: number; word: "better" | "worse" | "steady" }

// ---------- pure helpers (tested in test/summary.test.ts) ----------

const KEEP_UPPER = /^(PST|IVTA|IVR|PRP|YAG|PI|AC|BE|RE|LE|OCT|CSME|NPDR|PDR|AMD|CNVM|BRVO|CRVO)$/;
const titleCase = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean)
  .map((w) => (KEEP_UPPER.test(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

/** The injected drug: Yarago's drug field is never filled, so it is read from the billing name ("INTRA VITREAL RAZUMAB(13000)"). */
export function drugName(procedure: string | null, drug: string | null): string | null {
  if (drug?.trim()) return titleCase(drug.trim());
  if (!procedure) return null;
  const p = procedure.toUpperCase();
  if (/THEATRE|CHARGE/.test(p)) return null;
  const name = p.replace(/\(.*?\)/g, " ").replace(/\b(INTRA\s*VITREAL|INTRAVITREAL|INTRA\s*VITREOUS|INJECTION|INJ)\b\.?/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return name ? titleCase(name) : null;
}

/** Change in best-corrected vision across the shown visits (oldest -> newest), in lines of logMAR 0.1. */
export function visionChange(points: { va: string | null; logmar: number | null }[]): VisionChange | null {
  const ok = points.filter((p) => p.va && p.logmar != null);
  if (ok.length < 2) return null;
  const a = ok[0], b = ok[ok.length - 1];
  const lines = Math.round(((a.logmar! - b.logmar!) / 0.1) * 10) / 10;
  const whole = Math.round(lines);
  return { from: a.va!, to: b.va!, lines: Math.abs(whole), word: whole >= 2 ? "better" : whole <= -2 ? "worse" : "steady" };
}

/** Every number in the overview must appear in the facts; otherwise the overview is not shown. */
export function numbersCheck(overview: string, facts: unknown): { ok: boolean; unknown: string[] } {
  const hay = JSON.stringify(facts);
  const nums = overview.match(/\d+(?:[./]\d+)*/g) ?? [];
  const unknown = nums.filter((n) => !new RegExp(`(^|[^0-9])${n.replace(/[./]/g, (c) => `\\${c}`)}([^0-9]|$)`).test(hay));
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}

export function factsHash(f: SummaryFacts): string {
  return createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 16);
}

const PLACEHOLDER = /^(0\$?)+$|^null$|^nil$|^-+$/i;
const meaningful = (s: string | null | undefined) => (s && !PLACEHOLDER.test(s.trim()) ? s.trim() : null);

// ---------- the facts ----------

export async function buildFacts(patientId: number, forDate: string, db?: Db): Promise<SummaryFacts | null> {
  const p = await one<any>(`SELECT patient_id, mrd, name, age_years, age_text, sex, language FROM clinical.patient WHERE patient_id = $1`, [patientId], db);
  if (!p) return null;
  const [counts, booking, yToday, visits, findingRows, trend, inj, las, fups, due] = await Promise.all([
    one<any>(`SELECT count(*)::int n, to_char(min(visit_date),'YYYY-MM-DD') first FROM clinical.visit WHERE patient_id = $1 AND status_id = 3`, [patientId], db),
    one<any>(`SELECT a.id, to_char(a.slot_time,'HH24:MI') slot, a.plan_of_action plan, d.name doctor FROM app.appointments a
                LEFT JOIN app.doctors d ON d.id = a.doctor_id
               WHERE a.patient_id = $1 AND a.appointment_date = $2 AND a.status IN ('booked','confirmed','waitlist','completed')
               ORDER BY a.slot_time NULLS LAST LIMIT 1`, [patientId, forDate], db),
    one<any>(`SELECT token::text token, doctor FROM clinical.visit WHERE patient_id = $1 AND visit_date = $2 AND status_id <> 4
               ORDER BY visit_at LIMIT 1`, [patientId, forDate], db),
    q<any>(`SELECT visit_id, to_char(visit_date,'YYYY-MM-DD') date, doctor, systemic_illness, systemic_notes, drug_allergies,
                   complaints, complaint_notes, diagnosis, doctor_remarks, medicines,
                   to_char(coalesce(followup_date, visit_date + coalesce(followup_in_days, 0) + coalesce(followup_in_months, 0) * 30),'YYYY-MM-DD') AS fu,
                   (followup_date IS NOT NULL OR followup_in_days IS NOT NULL OR followup_in_months IS NOT NULL) AS has_fu
              FROM clinical.visit WHERE patient_id = $1 AND status_id = 3 AND visit_date < $2
             ORDER BY visit_at DESC LIMIT 60`, [patientId, forDate], db),
    q<any>(`SELECT f.visit_id, to_char(v.visit_date,'YYYY-MM-DD') date, f.position, f.eye_part, f.finding, f.eye
              FROM clinical.visit_exam_finding f JOIN clinical.visit v ON v.visit_id = f.visit_id
             WHERE f.patient_id = $1 AND v.visit_date <= $2 AND f.finding IS NOT NULL
             ORDER BY v.visit_at, f.position`, [patientId, forDate], db),
    q<any>(`SELECT visit_id, to_char(visit_date,'YYYY-MM-DD') date, bcva_re, bcva_le, bcva_logmar_re, bcva_logmar_le, iop_re, iop_le
              FROM clinical.va_iop_trend WHERE patient_id = $1 AND visit_date <= $2
               AND coalesce(bcva_re, bcva_le, iop_re::text, iop_le::text) IS NOT NULL
             ORDER BY visit_date DESC, visit_id DESC LIMIT 5`, [patientId, forDate], db),
    q<any>(`SELECT to_char(treated_at,'YYYY-MM-DD') date, coalesce(visit_id, advised_at_visit_id) visit_id, eye, procedure, drug,
                   injection_number_for_eye n
              FROM clinical.injection WHERE patient_id = $1 AND given AND treated_at::date <= $2
             ORDER BY treated_at DESC LIMIT 12`, [patientId, forDate], db),
    q<any>(`SELECT to_char(treated_at,'YYYY-MM-DD') date, coalesce(visit_id, advised_at_visit_id) visit_id, eye, coalesce(done, advised) what
              FROM clinical.laser WHERE patient_id = $1 AND done IS NOT NULL AND treated_at::date <= $2
             ORDER BY treated_at DESC LIMIT 8`, [patientId, forDate], db),
    q<any>(`SELECT to_char(due_date,'YYYY-MM-DD') due, to_char(next_visit_date,'YYYY-MM-DD') came, came_back, days_overdue,
                   (next_visit_date - due_date) AS late_by
              FROM clinical.followup WHERE patient_id = $1 AND due_date BETWEEN $2::date - 365 AND $2::date
             ORDER BY due_date DESC`, [patientId, forDate], db),
    one<any>(`SELECT due_total, due_pharmacy, due_opd, due_optical, due_ipd FROM clinical.patient_due WHERE patient_id = $1 AND due_total > 0`, [patientId], db),
  ]);

  const firstWith = (key: string) => visits.find((v: any) => meaningful(v[key]));
  const src = (v: any, key: string): Sourced<string> | null => (v ? { value: meaningful(v[key])!, date: v.date, visitId: v.visit_id } : null);
  const sys = firstWith("systemic_illness");
  const late = fups.filter((f: any) => f.came_back && f.late_by > 7);
  const missed = fups.filter((f: any) => !f.came_back && (f.days_overdue ?? 0) > 7);
  const lastLate = late[0] ?? missed[0];

  // findings: the latest visit that has any; "since" = first visit where the same part showed the same finding in that eye
  let findings: SummaryFacts["findings"] = null;
  if (findingRows.length) {
    const lastVisitId = findingRows[findingRows.length - 1].visit_id;
    const latest = findingRows.filter((r: any) => r.visit_id === lastVisitId);
    const since = (part: string, finding: string, eye: "RE" | "LE") =>
      findingRows.find((r: any) => r.eye_part === part && r.finding === finding && (r.eye === eye || r.eye === "BE"))?.date ?? null;
    const byPart = new Map<string, { re: string[]; le: string[] }>();
    for (const r of latest) {
      const part = r.eye_part ?? "Other";
      const e = byPart.get(part) ?? { re: [], le: [] };
      if (r.eye === "RE" || r.eye === "BE") e.re.push(r.finding);
      if (r.eye === "LE" || r.eye === "BE") e.le.push(r.finding);
      byPart.set(part, e);
    }
    findings = { date: latest[0].date, visitId: lastVisitId, rows: [...byPart].map(([part, e]) => ({
      part: titleCase(part), re: e.re.join(", ") || null, le: e.le.join(", ") || null,
      reSince: e.re.length ? since(part, e.re[0], "RE") : null, leSince: e.le.length ? since(part, e.le[0], "LE") : null })) };
  }

  const chrono = [...trend].reverse();
  // the last CONSULTATION: an injection or laser is its own Yarago appointment with an empty history record
  const consulted = (v: any) => !!(meaningful(v.complaints) || meaningful(v.complaint_notes) || meaningful(v.diagnosis)
    || meaningful(v.doctor_remarks) || meaningful(v.medicines) || v.has_fu || findingRows.some((r: any) => r.visit_id === v.visit_id));
  const last = visits.find(consulted);
  const nextFrom = visits.find((v: any) => v.has_fu);
  const treatment = [
    ...inj.map((r: any) => ({ date: r.date, visitId: r.visit_id, eye: r.eye, kind: "injection" as const,
                              what: drugName(r.procedure, r.drug) ?? "Injection (drug not recorded)", number: r.n ?? null })),
    ...las.map((r: any) => ({ date: r.date, visitId: r.visit_id, eye: r.eye, kind: "laser" as const, what: titleCase(r.what), number: null })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 8);

  return {
    forDate,
    patient: { patientId, mrd: p.mrd, name: p.name, ageYears: p.age_years, ...(p.age_text ? { ageText: p.age_text } : {}), sex: p.sex, language: p.language,
               visits: counts?.n ?? 0, firstVisit: counts?.first ?? null },
    today: booking || yToday ? { slotTime: booking?.slot ?? null, plan: booking?.plan ?? null, doctor: booking?.doctor ?? yToday?.doctor ?? null,
                                 token: yToday?.token ?? null, appointmentId: booking?.id ?? null } : null,
    alerts: {
      systemic: sys ? src(sys, "systemic_illness") : null,
      systemicNote: sys ? null : src(firstWith("systemic_notes"), "systemic_notes"),
      allergies: src(firstWith("drug_allergies"), "drug_allergies"),
      followups: { late: late.length, missed: missed.length, last: lastLate ? { due: lastLate.due, came: lastLate.came } : null },
      dues: due ? { total: due.due_total, pharmacy: due.due_pharmacy ?? 0, opd: due.due_opd ?? 0, optical: due.due_optical ?? 0, ipd: due.due_ipd ?? 0 } : null,
    },
    findings,
    vision: {
      rows: trend.map((r: any) => ({ visitId: r.visit_id, date: r.date, bcvaRe: r.bcva_re, bcvaLe: r.bcva_le, iopRe: r.iop_re, iopLe: r.iop_le })),
      change: { re: visionChange(chrono.map((r: any) => ({ va: r.bcva_re, logmar: r.bcva_logmar_re }))),
                le: visionChange(chrono.map((r: any) => ({ va: r.bcva_le, logmar: r.bcva_logmar_le }))) },
    },
    treatment: { rows: treatment, next: nextFrom ? { date: nextFrom.fu, visitId: nextFrom.visit_id } : null },
    lastVisit: last ? { visitId: last.visit_id, date: last.date, doctor: last.doctor,
                        complaints: meaningful(last.complaints) ?? meaningful(last.complaint_notes), plan: meaningful(last.diagnosis),
                        remarks: meaningful(last.doctor_remarks), medicines: meaningful(last.medicines),
                        followup: last.has_fu ? last.fu : null } : null,
  };
}

/** Patients to prepare for a day: Sudarshan bookings linked to a Yarago patient, and Yarago appointments that day. */
export async function patientsForDay(date: string, db?: Db): Promise<number[]> {
  const r = await q<{ patient_id: number }>(
    `SELECT patient_id FROM app.appointments WHERE appointment_date = $1 AND patient_id IS NOT NULL
        AND status IN ('booked','confirmed','completed')
     UNION
     SELECT npatient_id FROM yarago.tblappointments WHERE tappoint_date_time::date = $1 AND nstatus_id <> 4`, [date], db);
  return r.map((x) => x.patient_id);
}
