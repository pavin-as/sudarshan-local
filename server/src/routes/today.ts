// The Today page (live figures for the front desk) and the printable huddle sheet for a day.
// Live parts read the Yarago station timer for today only; everything else reuses the day, rule and booking data.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { q } from "../db.js";
import { addDays, dateStr, isoWeekday, todayIST } from "../lib/time.js";
import { checkDay, isNewPatient, loadDayAppts, loadRuleContext, procTags } from "../services/rules.js";

/** The next day the clinic is open for booking after a date (maximum slots set, not a holiday), within two weeks;
 *  otherwise the next day that is not a Sunday. */
export async function nextOpenDay(d: string): Promise<string> {
  const r = await q<{ d: string }>(
    `SELECT to_char(min(c.on_date), 'YYYY-MM-DD') AS d FROM app.day_capacity c
      WHERE c.on_date > $1::date AND c.on_date <= $1::date + 14 AND c.max_slots > 0
        AND NOT EXISTS (SELECT 1 FROM app.holidays h WHERE h.on_date = c.on_date)`, [d]);
  if (r[0]?.d) return r[0].d;
  let n = addDays(d, 1);
  while (isoWeekday(n) === 7) n = addDays(n, 1);
  return n;
}

async function ruleCounts(date: string, today: string) {
  const { findings } = checkDay(await loadDayAppts(date), await loadRuleContext(date, today));
  return { date, toCheck: findings.filter((f) => f.level !== "info").length, notes: findings.filter((f) => f.level === "info").length };
}

export async function todayRoutes(app: FastifyInstance) {
  app.get("/api/today", async (req) => {
    need(req, "appointments.read");
    const today = todayIST(), next = await nextOpenDay(today);

    // patients in the clinic now: checked in today, not checked out (timers older than 10 hours are ignored). Per PATIENT,
    // not per Yarago appointment: Yarago sometimes opens a second appointment and checks the patient out on that one.
    // Done = checked out on any of the day's appointments, or any of them completed in Yarago.
    const visits = await q<any>(
      `WITH t AS (
         SELECT max(napptid) AS visit_id, npatid AS patient_id,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 1) AS check_in_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 2) AS optometry_start_at,
                max(enddatetime)   FILTER (WHERE nmoduletimerid = 2) AS optometry_end_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 3) AS room_in_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid IN (4, 6)) AS exam_start_at,
                max(enddatetime)   FILTER (WHERE nmoduletimerid = 8) AS check_out_at,
                max(startdatetime) AS last_move_at
           FROM yarago.tbltimerpatientwaiting
          WHERE coalesce(isdeleted, 0) = 0 AND startdatetime >= current_date AND startdatetime < current_date + 1
          GROUP BY npatid)
       SELECT t.visit_id AS "visitId", t.patient_id AS "patientId", p.name AS "patientName", p.mrd,
              to_char(t.check_in_at, 'HH24:MI') AS "checkIn", to_char(t.check_out_at, 'HH24:MI') AS "checkOut",
              CASE WHEN t.check_out_at IS NOT NULL OR EXISTS (SELECT 1 FROM yarago.tblappointments y WHERE y.npatient_id = t.patient_id
                     AND y.tappoint_date_time >= current_date AND y.tappoint_date_time < current_date + 1 AND y.nstatus_id = 3) THEN 'done'
                   WHEN t.exam_start_at IS NOT NULL THEN 'with_doctor'
                   WHEN t.room_in_at IS NOT NULL OR t.optometry_end_at IS NOT NULL THEN 'waiting_for_doctor'
                   WHEN t.optometry_start_at IS NOT NULL THEN 'optometry'
                   ELSE 'arrived' END AS stage,
              round(extract(epoch FROM (localtimestamp - t.check_in_at)) / 60)::int AS "minutesIn",
              round(extract(epoch FROM (localtimestamp - t.last_move_at)) / 60)::int AS "minutesAtStage",
              clinical.minutes_between(t.check_in_at, t.optometry_start_at) AS "waitOptometry",
              clinical.minutes_between(t.optometry_end_at, coalesce(t.room_in_at, t.exam_start_at)) AS "waitDoctor",
              clinical.minutes_between(t.check_in_at, t.check_out_at) AS "totalMin",
              a.id AS "appointmentId"
         FROM t
         LEFT JOIN clinical.patient p ON p.patient_id = t.patient_id
         LEFT JOIN LATERAL (SELECT id FROM app.appointments x WHERE x.patient_id = t.patient_id AND x.appointment_date = current_date
                             AND x.status <> 'cancelled' ORDER BY x.slot_time NULLS LAST LIMIT 1) a ON true
        WHERE t.check_in_at IS NOT NULL`);
    const inClinic = visits.filter((v) => v.stage !== "done" && v.minutesIn <= 600);
    const median = (xs: number[]) => {
      const s = xs.filter((x) => x != null).map(Number).sort((a, b) => a - b);
      return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
    };

    // arrived without a Sudarshan booking today (walk-ins, or booked straight in Yarago)
    const walkIns = await q<{ n: number }>(
      `SELECT count(DISTINCT y.npatient_id)::int AS n FROM yarago.tblappointments y
        WHERE y.tappoint_date_time >= current_date AND y.tappoint_date_time < current_date + 1 AND y.nstatus_id IN (1, 2, 3)
          AND NOT EXISTS (SELECT 1 FROM app.appointments a WHERE a.patient_id = y.npatient_id
                            AND a.appointment_date = current_date AND a.status <> 'cancelled')`);

    return {
      date: today,
      nextWorkDay: next,
      inClinic: inClinic.sort((a, b) => b.minutesIn - a.minutesIn).slice(0, 12),
      inClinicCount: inClinic.length,
      checkedOut: visits.filter((v) => v.stage === "done").length,
      waits: {
        optometry: median(visits.map((v) => v.waitOptometry)),
        doctor: median(visits.map((v) => v.waitDoctor)),
        total: median(visits.map((v) => v.totalMin)),
        totalCount: visits.filter((v) => v.totalMin != null).length,
      },
      walkIns: walkIns[0]?.n ?? 0,
      rules: [await ruleCounts(today, today), await ruleCounts(next, today)],
    };
  });

  // ---- huddle sheet: one day on one page, for the morning meeting ----
  app.get("/api/huddle", async (req) => {
    need(req, "appointments.read");
    const today = todayIST();
    const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
    const day = date ?? await nextOpenDay(today);
    const rows = await q<any>(
      `SELECT a.id, to_char(a.slot_time,'HH24:MI') AS "slotTime", a.patient_name AS "patientName", a.mrd, a.age_years AS "ageYears",
              a.patient_type AS "patientType", a.plan_of_action AS "planOfAction", a.tags, a.remarks, a.status, a.family_group AS "familyGroup",
              d.name AS "doctorName", a.confirmed_4day_at IS NOT NULL AS "confirmed4day", a.confirmed_1day_at IS NOT NULL AS "confirmed1day"
         FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id
        WHERE a.appointment_date = $1 AND a.status <> 'cancelled'
        ORDER BY a.slot_time NULLS LAST, a.id`, [day]);
    const ruleAppts = await loadDayAppts(day);
    const { findings, specialCases } = checkDay(ruleAppts, await loadRuleContext(day, today));
    const timed = rows.filter((r) => r.slotTime);
    const count = (f: (t: ReturnType<typeof procTags>) => boolean) => timed.filter((r) => f(procTags(r.planOfAction))).length;
    return {
      date: day,
      appointments: rows,
      findings,
      specialCases,
      summary: {
        booked: timed.length,
        waitlist: rows.length - timed.length,
        newPatients: timed.filter((r) => isNewPatient(r)).length,
        notConfirmed: timed.filter((r) => !r.confirmed1day && r.status === "booked").length,
        dilation: count((t) => t.DIL),
        injections: count((t) => t.IVR || t.IVTA),
        lasers: count((t) => t.LASER || t.YAG),
        atGonio: count((t) => t.AT || t.GONIO),
        hfa: count((t) => t.HFA),
        rop: count((t) => t.ROP),
      },
    };
  });
}
