// Month view (Google app monthOverview.html): each day of a month with its load - booked against maximum slots,
// waitlist, new patients, procedures planned, scheduling-rule warnings. Read only; days open on the day board.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { q } from "../db.js";
import { addDays, todayIST } from "../lib/time.js";
import { daysInfo } from "../services/calendar.js";
import { checkDay, isNewPatient, loadRuleContext, procTags, type RuleAppt } from "../services/rules.js";

export async function monthRoutes(app: FastifyInstance) {
  app.get("/api/month", async (req) => {
    need(req, "appointments.read");
    const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM").optional() }).parse(req.query);
    const m = month ?? todayIST().slice(0, 7);
    const from = `${m}-01`;
    const to = addDays(addDays(from, 32).slice(0, 7) + "-01", -1);           // last day of the month
    const today = todayIST();

    const days = await daysInfo(from, to);
    const appts = await q<RuleAppt & { date: string; status: string }>(
      `SELECT id::int AS id, to_char(appointment_date,'YYYY-MM-DD') AS date, status, to_char(slot_time,'HH24:MI') AS "slotTime",
              to_char(consult_start,'HH24:MI') AS "consultStart", mrd, patient_type AS "patientType", patient_name AS "patientName",
              age_years AS "ageYears", plan_of_action AS "planOfAction", remarks, tags, family_group AS "familyGroup"
         FROM app.appointments WHERE appointment_date BETWEEN $1 AND $2 AND status <> 'cancelled'`, [from, to]);
    const cancelled = await q<{ date: string; n: number }>(
      `SELECT to_char(appointment_date,'YYYY-MM-DD') AS date, count(*)::int AS n FROM app.appointments
        WHERE appointment_date BETWEEN $1 AND $2 AND status = 'cancelled' GROUP BY 1`, [from, to]);
    const cancelledBy = new Map(cancelled.map((c) => [c.date, c.n]));
    const byDay = new Map<string, typeof appts>();
    for (const a of appts) byDay.set(a.date, [...(byDay.get(a.date) ?? []), a]);

    const out = [];
    for (const d of days) {
      const list = byDay.get(d.date) ?? [];
      const timed = list.filter((a) => a.slotTime && a.status !== "waitlist");
      const count = (f: (t: ReturnType<typeof procTags>) => boolean) => timed.filter((a) => f(procTags(a.planOfAction))).length;
      // rule warnings only for days still to come (past days are history)
      let toCheck = 0, againstRule = 0;
      if (d.date >= today && list.length) {
        const { findings } = checkDay(list, await loadRuleContext(d.date, today));
        toCheck = findings.filter((f) => f.level === "warning").length;
        againstRule = findings.filter((f) => f.level === "error").length;
      }
      out.push({
        ...d,
        newPatients: timed.filter((a) => isNewPatient(a)).length,
        cancelled: cancelledBy.get(d.date) ?? 0,
        injections: count((t) => t.IVR || t.IVTA), lasers: count((t) => t.LASER || t.YAG), rop: count((t) => t.ROP),
        hfa: count((t) => t.HFA), atGonio: count((t) => t.AT || t.GONIO), dilation: count((t) => t.DIL),
        toCheck, againstRule,
      });
    }
    return { month: m, days: out };
  });
}
