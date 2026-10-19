// Triage: urgency assessment of a patient who calls or walks in, then the decision taken (book / declined / other).
// The category is always worked out here from the answers (services/triage.ts), never taken from the browser.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, setAuditSummary, withTx } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { todayIST } from "../lib/time.js";
import { guardImported } from "../lib/trial.js";
import { bookedDecision, scoreTriage, TRIAGE_DECISIONS, TRIAGE_QUESTIONS } from "../services/triage.js";

const COLS = `
  t.id, t.patient_id AS "patientId", t.mrd, t.patient_name AS "patientName", t.phone, t.age_years AS "ageYears", t.gender,
  t.patient_type AS "patientType", (t.legacy_id IS NOT NULL) AS "fromGoogle", t.assessed_at AS "assessedAt", t.answers, t.max_score AS "maxScore", t.category,
  coalesce(t.decision_status, 'Pending Action') AS decision, t.decision_remarks AS "decisionRemarks",
  du.full_name AS "decisionBy", t.decision_at AS "decisionAt", coalesce(cu.full_name, '') AS "assessedBy"`;
const FROM = `FROM app.triage t LEFT JOIN app.users du ON du.id = t.decision_by LEFT JOIN app.users cu ON cu.id = t.created_by`;
const who = (t: { patient_name: string; mrd: string | null }) => (t.mrd ? `${t.patient_name} (${t.mrd})` : t.patient_name);

export async function triageRoutes(app: FastifyInstance) {
  app.get("/api/triage/questions", async (req) => {
    need(req, "appointments.read");
    return { questions: TRIAGE_QUESTIONS, decisions: TRIAGE_DECISIONS };
  });

  // pending first (emergencies first), then the latest decided
  app.get("/api/triage", async (req) => {
    need(req, "appointments.read");
    const f = z.object({
      view: z.enum(["pending", "decided", "all"]).default("pending"),
      q: z.string().trim().max(60).optional(),
      days: z.coerce.number().int().min(1).max(730).default(60),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const p: unknown[] = [f.days];
    const where = [`t.assessed_at > now() - make_interval(days => $1)`];
    if (f.view === "pending") where.push(`coalesce(t.decision_status, 'Pending Action') = 'Pending Action'`);
    if (f.view === "decided") where.push(`coalesce(t.decision_status, 'Pending Action') <> 'Pending Action'`);
    if (f.q) { p.push(f.q); where.push(`(t.patient_name ILIKE '%' || $2 || '%' OR t.mrd ILIKE $2 || '%' OR t.phone LIKE '%' || $2)`); }
    p.push(f.limit);
    const rows = await q(
      `SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")}
        ORDER BY (coalesce(t.decision_status, 'Pending Action') = 'Pending Action') DESC,
                 CASE t.category WHEN 'Emergency' THEN 0 WHEN 'Urgent' THEN 1 ELSE 2 END, t.assessed_at DESC
        LIMIT $${p.length}`, p);
    const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM app.triage WHERE coalesce(decision_status, 'Pending Action') = 'Pending Action'
                                               AND assessed_at > now() - interval '60 days'`);
    return { assessments: rows, pending: pending?.n ?? 0 };
  });

  app.post("/api/triage", async (req) => {
    const me = need(req, "appointments.write");
    const b = z.object({
      patientId: z.number().int().positive().nullable().optional(),
      patientName: z.string().trim().min(1).max(150).optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      ageYears: z.number().int().min(0).max(130).nullable().optional(),
      gender: z.string().trim().max(20).nullable().optional(),
      answers: z.record(z.coerce.number().int()),
    }).parse(req.body);
    const s = scoreTriage(b.answers);
    if (s.missing.length) throw badRequest(`Answer every question (missing: ${s.missing.map((k) => TRIAGE_QUESTIONS.find((x) => x.key === k)!.text.toLowerCase()).join(", ")})`);
    let yp: any = null;
    if (b.patientId) {
      yp = await one(`SELECT patient_id, mrd, name, mobile, age_years, sex FROM clinical.patient WHERE patient_id = $1`, [b.patientId]);
      if (!yp) throw badRequest("That Yarago patient was not found");
    }
    const name = b.patientName ?? yp?.name;
    if (!name) throw badRequest("Patient name is required");
    const answers = Object.fromEntries(TRIAGE_QUESTIONS.map((x) => [x.key, Number(b.answers[x.key])]));
    return withTx(auditCtx(req, `Triage of ${who({ patient_name: name, mrd: yp?.mrd ?? null })}: ${s.category}`), async (c) => {
      const ins = (await c.query(
        `INSERT INTO app.triage (patient_id, mrd, patient_name, phone, age_years, gender, patient_type, answers, max_score, category,
                                 decision_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending Action',$11) RETURNING id`,
        [yp?.patient_id ?? null, yp?.mrd ?? null, name, b.phone ?? yp?.mobile ?? null, b.ageYears ?? yp?.age_years ?? null,
         b.gender ?? yp?.sex ?? null, yp ? "Old" : "New", JSON.stringify(answers), s.maxScore, s.category, me.id])).rows[0];
      return { assessment: await one(`SELECT ${COLS} ${FROM} WHERE t.id = $1`, [ins.id], c) };
    });
  });

  // the decision: chosen by staff, or worked out from a booking made for the patient (bookedFor)
  app.post("/api/triage/:id/decision", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({
      decision: z.enum(TRIAGE_DECISIONS).optional(),
      bookedFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
    }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = (await c.query(`SELECT id, patient_name, mrd, legacy_id, to_char(assessed_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day FROM app.triage WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Assessment");
      await guardImported(cur, "This assessment");
      const decision = b.bookedFor ? bookedDecision(b.bookedFor, cur.day ?? todayIST()) : b.decision;
      if (!decision) throw badRequest("Choose what was decided");
      if (decision === "Other Action (See Remarks)" && !b.remarks) throw badRequest("Write what was done in the remarks");
      await setAuditSummary(c, `Triage decision for ${who(cur)}: ${decision}${b.remarks ? ` (${b.remarks.slice(0, 120)})` : ""}`);
      await c.query(`UPDATE app.triage SET decision_status = $2, decision_remarks = $3, decision_by = $4, decision_at = now() WHERE id = $1`,
                    [id, decision, b.remarks ?? null, decision === "Pending Action" ? null : me.id]);
      return { assessment: await one(`SELECT ${COLS} ${FROM} WHERE t.id = $1`, [id], c) };
    });
  });
}
