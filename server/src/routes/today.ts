// The Today page (live figures for the front desk) and the printable huddle sheet for a day.
// Live parts read the Yarago station timer for today only; everything else reuses the day, rule and booking data.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { q } from "../db.js";
import { addDays, dateStr, isoWeekday, todayIST } from "../lib/time.js";
import { matchAll } from "../services/arrivalMatch.js";
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

    // Everyone who came today, ONE ROW PER PATIENT (Yarago can open two appointments for one patient on one day):
    // came = checked in on a station timer, or a Yarago appointment checked in / in examination / completed.
    // Done = checked out on any of the day's timers, or any of the day's appointments completed in Yarago.
    const came = await q<any>(
      `WITH tm AS (
         SELECT npatid AS patient_id,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 1) AS check_in_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 2) AS optometry_start_at,
                max(enddatetime)   FILTER (WHERE nmoduletimerid = 2) AS optometry_end_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid = 3) AS room_in_at,
                min(startdatetime) FILTER (WHERE nmoduletimerid IN (4, 6)) AS exam_start_at,
                max(enddatetime)   FILTER (WHERE nmoduletimerid = 8) AS check_out_at,
                max(startdatetime) AS last_move_at
           FROM yarago.tbltimerpatientwaiting
          WHERE coalesce(isdeleted, 0) = 0 AND startdatetime >= current_date AND startdatetime < current_date + 1
          GROUP BY npatid),
       ys AS (
         SELECT DISTINCT ON (y.npatient_id) y.npatient_id AS patient_id, y.aappoint_id AS visit_id, y.nstatus_id AS status_id,
                min(y.tappoint_date_time) OVER (PARTITION BY y.npatient_id) AS first_at, clinical.clean(d.tdoctorname) AS doctor
           FROM yarago.tblappointments y LEFT JOIN yarago.tbldoctor d ON d.adoctor_id = y.ndoctor_id
          WHERE y.tappoint_date_time >= current_date AND y.tappoint_date_time < current_date + 1 AND y.nstatus_id <> 4
          ORDER BY y.npatient_id, y.nstatus_id DESC, y.tappoint_date_time),
       c AS (
         SELECT coalesce(tm.patient_id, ys.patient_id) AS patient_id, tm.check_in_at, tm.optometry_start_at, tm.optometry_end_at,
                tm.room_in_at, tm.exam_start_at, tm.check_out_at, tm.last_move_at, ys.visit_id, ys.status_id, ys.first_at, ys.doctor
           FROM tm FULL JOIN ys ON ys.patient_id = tm.patient_id
          WHERE tm.check_in_at IS NOT NULL OR ys.status_id IN (1, 2, 3))
       SELECT c.patient_id AS "patientId", p.name AS "patientName", p.mrd, p.age_years AS "ageYears", p.mobile AS phone, c.doctor,
              to_char(coalesce(c.check_in_at, c.first_at), 'HH24:MI') AS "checkIn", to_char(c.check_out_at, 'HH24:MI') AS "checkOut",
              CASE WHEN c.check_out_at IS NOT NULL OR c.status_id = 3 THEN 'done'
                   WHEN c.exam_start_at IS NOT NULL OR c.status_id = 2 THEN 'with_doctor'
                   WHEN c.room_in_at IS NOT NULL OR c.optometry_end_at IS NOT NULL THEN 'waiting_for_doctor'
                   WHEN c.optometry_start_at IS NOT NULL THEN 'optometry'
                   ELSE 'arrived' END AS stage,
              round(extract(epoch FROM (localtimestamp - coalesce(c.check_in_at, c.first_at))) / 60)::int AS "minutesIn",
              round(extract(epoch FROM (localtimestamp - c.last_move_at)) / 60)::int AS "minutesAtStage",
              clinical.minutes_between(c.check_in_at, c.optometry_start_at) AS "waitOptometry",
              clinical.minutes_between(c.optometry_end_at, coalesce(c.room_in_at, c.exam_start_at)) AS "waitDoctor",
              clinical.minutes_between(c.check_in_at, c.check_out_at) AS "totalMin",
              b.id AS "appointmentId", b.slot AS "slotTime", b.plan AS "planOfAction"
         FROM c
         LEFT JOIN clinical.patient p ON p.patient_id = c.patient_id
         LEFT JOIN LATERAL (SELECT x.id, to_char(x.slot_time,'HH24:MI') AS slot, x.plan_of_action AS plan FROM app.appointments x
                             WHERE x.patient_id = c.patient_id AND x.appointment_date = current_date AND x.status <> 'cancelled'
                             ORDER BY x.slot_time NULLS LAST LIMIT 1) b ON true
        ORDER BY coalesce(c.check_in_at, c.first_at)`);

    // today's Sudarshan bookings with a time, and whether each patient has come
    const booked = (await q<any>(
      `SELECT a.id AS "appointmentId", to_char(a.slot_time,'HH24:MI') AS "slotTime", a.patient_id AS "patientId", a.patient_name AS "patientName",
              a.mrd, a.age_years AS "ageYears", a.phone, a.plan_of_action AS "planOfAction", d.name AS doctor, a.status,
              (a.confirmed_1day_at IS NOT NULL OR a.confirmed_4day_at IS NOT NULL) AS confirmed
         FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id
        WHERE a.appointment_date = current_date AND a.slot_time IS NOT NULL AND a.status IN ('booked','confirmed','completed','no_show')
        ORDER BY a.slot_time, a.id`));

    // who came with a booking (D-036): a new patient's booking has no Yarago patient yet, so it is matched by MRD, or
    // by mobile number and name; those matches are shown as "not linked yet" and never written
    const todays = await q<any>(
      `SELECT a.id, a.patient_id AS "patientId", a.mrd, a.phone, a.patient_name AS name, to_char(a.slot_time,'HH24:MI') AS "slotTime",
              a.plan_of_action AS "planOfAction"
         FROM app.appointments a WHERE a.appointment_date = current_date AND a.status <> 'cancelled'
        ORDER BY a.slot_time NULLS LAST, a.id`);
    const matches = matchAll(came.map((v) => ({ patientId: v.patientId, mrd: v.mrd, phone: v.phone, name: v.patientName })), todays);
    const cameByBooking = new Map<number, number>();
    for (const v of came) {
      const m = matches.get(v.patientId);
      v.hasBooking = !!m;
      v.bookingLinked = m ? m.kind !== "phone_name" && m.kind !== "mrd" : null;
      v.appointmentId = m?.booking.id ?? null; v.slotTime = m?.booking.slotTime ?? null; v.planOfAction = m?.booking.planOfAction ?? null;
      if (m) cameByBooking.set(m.booking.id, v.patientId);
    }
    for (const b of booked) {
      b.cameId = cameByBooking.get(b.appointmentId) ?? null;
      b.arrival = b.cameId != null ? "arrived" : b.patientId == null ? "unknown" : "not_arrived";
    }

    const inClinic = came.filter((v) => v.stage !== "done");
    const median = (xs: number[]) => {
      const s = xs.filter((x) => x != null).map(Number).sort((a, b) => a - b);
      return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
    };

    return {
      date: today,
      nextWorkDay: next,
      came, booked,
      inClinic: [...inClinic].sort((a, b) => b.minutesIn - a.minutesIn),
      waits: {
        optometry: median(came.map((v) => v.waitOptometry)),
        doctor: median(came.map((v) => v.waitDoctor)),
        total: median(came.map((v) => v.totalMin)),
        totalCount: came.filter((v) => v.totalMin != null).length,
      },
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
