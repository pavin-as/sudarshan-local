// Day prints, as the Google app's Day Overview printed them (dayOverview.html printDayOverview / printPOA): the day's
// bookings with consult start (stored, else slot + longest preparation of the plan, as the rules work it out), the
// day's rule notes for the day print, and a record of who printed what (app.print_log). D-029.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { q, withTx } from "../db.js";
import { dateStr, todayIST } from "../lib/time.js";
import { APPT_AGE_TEXT } from "../lib/text.js";
import { checkDay, consultStartOf, loadDayAppts, loadRuleContext } from "../services/rules.js";

export async function printRoutes(app: FastifyInstance) {
  app.post("/api/print/day", async (req) => {
    const me = need(req, "appointments.read");
    const b = z.object({
      date: dateStr,
      kind: z.enum(["day_consult", "day_checkin", "poa"]),
      doctorStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      delayMin: z.number().int().min(-600).max(600).nullable().optional(),
      preview: z.boolean().optional(),          // the dialog's "work out the delay": not a print, not logged
    }).parse(req.body);
    const rows = await q<any>(
      `SELECT a.id, to_char(a.slot_time,'HH24:MI') AS "slotTime", to_char(a.consult_start,'HH24:MI') AS "storedConsultStart",
              a.mrd, a.patient_name AS "patientName", a.age_years AS "ageYears", ${APPT_AGE_TEXT} AS "ageText", a.gender, a.phone, a.patient_type AS "patientType",
              a.appointment_type AS "appointmentType", d.name AS "doctorName", a.plan_of_action AS "planOfAction", a.remarks, a.status,
              (a.confirmed_4day_at IS NOT NULL OR a.confirmed_1day_at IS NOT NULL) AS confirmed, a.patient_id AS "patientId"
         FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id
        WHERE a.appointment_date = $1 AND a.status IN ('booked','confirmed','waitlist','completed','no_show')
        ORDER BY a.slot_time NULLS LAST, a.id`, [b.date]);
    const ctx = await loadRuleContext(b.date, todayIST());
    const ruleAppts = await loadDayAppts(b.date);
    const byId = new Map(ruleAppts.map((a) => [a.id, a]));
    const appointments = rows.map((r) => {
      const ra = byId.get(Number(r.id));
      // no consult start without a slot: waitlist rows carry stray times from the Google app (00:05), and the
      // Google app left the waiting list out when it worked out the doctor's delay
      const consultStart = !r.slotTime ? null : ra ? consultStartOf(ra, ctx.prepMinutes) : r.storedConsultStart;
      return { ...r, consultStart, consultWorkedOut: !r.storedConsultStart && !!consultStart };
    });
    const rules = b.kind === "poa" ? null : checkDay(ruleAppts, ctx);
    if (!b.preview) await withTx(auditCtx(req), (c) => c.query(
      `INSERT INTO app.print_log (user_id, kind, for_date, rows, options) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [me.id, b.kind, b.date, appointments.length, JSON.stringify(b.doctorStart ? { doctorStart: b.doctorStart, delayMin: b.delayMin ?? null } : null)]));
    return { date: b.date, appointments, findings: rules?.findings ?? [], specialCases: rules?.specialCases ?? [], printedBy: me.fullName, printedAt: new Date().toISOString() };
  });
}
