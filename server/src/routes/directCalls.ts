// Direct calls: patients who phone the clinic (Google app directCall sheet). A call is logged, then booked
// (POST /api/appointments with source 'direct_call' marks it booked), or closed with a reason.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, setAuditSummary, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

export const CALL_TYPES = ["Appointment", "Enquiry"] as const;
export const CASE_TYPES = ["Referral", "Non referral"] as const;
export const CALL_URGENCY = ["Non-urgent", "Urgent", "Emergency"] as const;

const COLS = `
  c.id, c.patient_id AS "patientId", c.mrd, c.patient_name AS "patientName", c.phone, c.age_years AS "ageYears", c.gender,
  c.patient_type AS "patientType", c.call_type AS "callType", c.case_type AS "caseType", c.urgency, c.remarks, c.status,
  c.doctor_id AS "doctorId", d.name AS "doctorName",
  c.created_at AS "createdAt", coalesce(u.full_name, '') AS "createdBy",
  c.closed_at AS "closedAt", cu.full_name AS "closedBy", c.close_reason AS "closeReason",
  c.appointment_id AS "appointmentId", to_char(a.appointment_date,'YYYY-MM-DD') AS "appointmentDate",
  to_char(a.slot_time,'HH24:MI') AS "appointmentTime", a.status AS "appointmentStatus"`;
const FROM = `FROM app.direct_calls c
  LEFT JOIN app.users u ON u.id = c.created_by
  LEFT JOIN app.users cu ON cu.id = c.closed_by
  LEFT JOIN app.doctors d ON d.id = c.doctor_id
  LEFT JOIN app.appointments a ON a.id = c.appointment_id`;

const optText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v ? v : null));
const fields = {
  patientName: z.string().trim().min(1).max(150).optional(),
  phone: optText(30),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  gender: optText(20),
  callType: z.enum(CALL_TYPES).optional(),
  caseType: z.enum(CASE_TYPES).nullable().optional(),
  urgency: z.enum(CALL_URGENCY).optional(),
  remarks: optText(1000),
  doctorId: z.number().int().positive().nullable().optional(),
};
const EDIT_COLUMNS: Record<string, string> = {
  patientName: "patient_name", phone: "phone", ageYears: "age_years", gender: "gender", callType: "call_type",
  caseType: "case_type", urgency: "urgency", remarks: "remarks", doctorId: "doctor_id",
};
const who = (c: { patient_name: string; mrd: string | null }) => (c.mrd ? `${c.patient_name} (${c.mrd})` : c.patient_name);

async function lockCall(c: any, id: number) {
  const r = (await c.query(`SELECT id, patient_name, mrd, status FROM app.direct_calls WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw notFound("Direct call");
  return r;
}

export async function directCallRoutes(app: FastifyInstance) {
  app.get("/api/direct-calls", async (req) => {
    need(req, "appointments.read");
    const f = z.object({
      view: z.enum(["open", "booked", "closed"]).default("open"),
      q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const p: unknown[] = [];
    const where = [f.view === "open" ? "c.status = 'open'" : f.view === "booked" ? "c.status = 'booked'" : "c.status IN ('cancelled','archived')"];
    if (f.q) { p.push(f.q); where.push(`(c.patient_name ILIKE '%' || $1 || '%' OR c.mrd ILIKE $1 || '%' OR c.phone LIKE '%' || $1)`); }
    p.push(f.limit);
    // open calls: emergencies and urgent first, then oldest first (waiting longest); others newest first
    const order = f.view === "open"
      ? `CASE c.urgency WHEN 'Emergency' THEN 0 WHEN 'Urgent' THEN 1 ELSE 2 END, c.created_at`
      : `coalesce(c.closed_at, c.updated_at) DESC`;
    const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${p.length}`, p);
    const counts = await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM app.direct_calls GROUP BY status`);
    return { calls: rows, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])) };
  });

  app.post("/api/direct-calls", async (req) => {
    const me = need(req, "appointments.write");
    const b = z.object({ ...fields, patientId: z.number().int().positive().nullable().optional(), callType: z.enum(CALL_TYPES),
                         urgency: z.enum(CALL_URGENCY).default("Non-urgent") }).parse(req.body);
    let yp: any = null;
    if (b.patientId) {
      yp = await one(`SELECT patient_id, mrd, name, mobile, age_years, sex FROM clinical.patient WHERE patient_id = $1`, [b.patientId]);
      if (!yp) throw badRequest("That Yarago patient was not found");
    }
    const name = b.patientName ?? yp?.name;
    if (!name) throw badRequest("Patient name is required");
    if (!yp && !b.phone) throw badRequest("A phone number is needed for a new patient, to call them back");
    const row = { patient_name: name, mrd: yp?.mrd ?? null };
    return withTx(auditCtx(req, `Logged a direct call (${b.callType.toLowerCase()}, ${b.urgency.toLowerCase()}) from ${who(row)}`), async (c) => {
      const ins = (await c.query(
        `INSERT INTO app.direct_calls (patient_id, mrd, patient_name, phone, age_years, gender, patient_type, call_type, case_type,
                                       urgency, remarks, doctor_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13) RETURNING id`,
        [yp?.patient_id ?? null, yp?.mrd ?? null, name, b.phone ?? yp?.mobile ?? null, b.ageYears ?? yp?.age_years ?? null,
         b.gender ?? yp?.sex ?? null, yp ? "Old" : "New", b.callType, b.caseType ?? null, b.urgency, b.remarks ?? null,
         b.doctorId ?? null, me.id])).rows[0];
      return { call: await one(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [ins.id], c) };
    });
  });

  app.patch("/api/direct-calls/:id", async (req) => {
    need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object(fields).parse(req.body);
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) throw badRequest("Nothing to change");
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockCall(c, id);
      if (cur.status !== "open") throw conflict("Only open calls can be changed");
      await setAuditSummary(c, `Updated the direct call from ${who(cur)}`);
      await c.query(`UPDATE app.direct_calls SET ${keys.map((k, i) => `${EDIT_COLUMNS[k]} = $${i + 2}`).join(", ")} WHERE id = $1`,
                    [id, ...keys.map((k) => (b as any)[k])]);
      return { call: await one(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [id], c) };
    });
  });

  // close without a booking: 'answered' (enquiry dealt with) or 'not_booked' (patient did not want an appointment)
  app.post("/api/direct-calls/:id/close", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { outcome, reason } = z.object({ outcome: z.enum(["answered", "not_booked"]), reason: z.string().trim().min(2).max(300) }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockCall(c, id);
      if (cur.status !== "open") throw conflict(`This call is already ${cur.status}`);
      const status = outcome === "answered" ? "archived" : "cancelled";
      await setAuditSummary(c, `Closed the direct call from ${who(cur)}: ${outcome === "answered" ? "enquiry answered" : "not booked"} (${reason})`);
      await c.query(`UPDATE app.direct_calls SET status = $2, closed_at = now(), closed_by = $3, close_reason = $4 WHERE id = $1`,
                    [id, status, me.id, reason]);
      return { call: await one(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [id], c) };
    });
  });

  // a closed call opened again (closed by mistake)
  app.post("/api/direct-calls/:id/reopen", async (req) => {
    need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockCall(c, id);
      if (!["cancelled", "archived"].includes(cur.status)) throw conflict("Only a closed call can be opened again");
      await setAuditSummary(c, `Opened the direct call from ${who(cur)} again`);
      await c.query(`UPDATE app.direct_calls SET status = 'open', closed_at = NULL, closed_by = NULL, close_reason = NULL WHERE id = $1`, [id]);
      return { call: await one(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [id], c) };
    });
  });
}
