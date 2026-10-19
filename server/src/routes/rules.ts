import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { one } from "../db.js";
import { notFound } from "../lib/errors.js";
import { dateStr, timeStr, todayIST } from "../lib/time.js";
import { checkDay, findingsFor, loadDayAppts, loadRuleContext, type RuleAppt } from "../services/rules.js";

const checkBody = z.object({
  date: dateStr,
  slotTime: timeStr.nullable().optional(),
  appointmentId: z.number().int().positive().nullable().optional(),   // moving an existing booking: its own details are used
  patientId: z.number().int().positive().nullable().optional(),
  mrd: z.string().trim().max(30).nullable().optional(),
  patientName: z.string().trim().max(150).nullable().optional(),
  patientType: z.string().trim().max(40).nullable().optional(),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  planOfAction: z.string().trim().max(300).nullable().optional(),
  familyGroup: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  remarks: z.string().trim().max(1000).nullable().optional(),
  appointmentType: z.string().trim().max(80).nullable().optional(),
  urgency: z.string().trim().max(40).nullable().optional(),
});

export async function ruleRoutes(app: FastifyInstance) {
  // ---- every rule finding for a day (the day board) ----
  app.get("/api/rules/day", async (req) => {
    need(req, "appointments.read");
    const { date } = z.object({ date: dateStr }).parse(req.query);
    const ctx = await loadRuleContext(date, todayIST());
    return { ...checkDay(await loadDayAppts(date), ctx), settings: ctx.settings };
  });

  // ---- what the rules say about one booking before it is made (booking dialog, reschedule) ----
  app.post("/api/rules/check", async (req) => {
    need(req, "appointments.read");
    const b = checkBody.parse(req.body);
    let cand: RuleAppt;
    if (b.appointmentId) {
      const cur = await one<any>(
        `SELECT id::int AS id, to_char(consult_start,'HH24:MI') AS "consultStart", mrd, patient_type AS "patientType",
                patient_name AS "patientName", age_years AS "ageYears", plan_of_action AS "planOfAction", remarks, tags,
                family_group AS "familyGroup", appointment_type AS "appointmentType", urgency, appointment_date = $2 AND slot_time IS NOT DISTINCT FROM $3::time AS same_place
           FROM app.appointments WHERE id = $1`, [b.appointmentId, b.date, b.slotTime ?? null]);
      if (!cur) throw notFound("Appointment");
      // a stored consult start belongs to the old time; work it out again for the new one
      cand = { ...cur, slotTime: b.slotTime ?? null, consultStart: cur.same_place ? cur.consultStart : null };
    } else {
      const yp = b.patientId ? await one<any>(`SELECT mrd, name, age_years FROM clinical.patient WHERE patient_id = $1`, [b.patientId]) : null;
      cand = {
        id: 0, slotTime: b.slotTime ?? null, consultStart: null,
        mrd: yp?.mrd ?? b.mrd ?? null, patientType: b.patientType ?? (yp || b.mrd ? "Old" : "New"),
        patientName: b.patientName || yp?.name || "This patient", ageYears: b.ageYears ?? yp?.age_years ?? null,
        planOfAction: b.planOfAction ?? null, familyGroup: b.familyGroup ?? null, tags: b.tags ?? [], remarks: b.remarks ?? null,
        appointmentType: b.appointmentType ?? null, urgency: b.urgency ?? null,
      };
    }
    const ctx = await loadRuleContext(b.date, todayIST());
    const day = await loadDayAppts(b.date, undefined, b.appointmentId ?? null);
    const { findings } = checkDay([...day, cand], ctx);
    return { findings: findingsFor(findings, cand.id) };
  });
}
