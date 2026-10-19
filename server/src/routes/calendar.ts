import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { addDays, dateStr, niceDate, timeStr, todayIST } from "../lib/time.js";
import { daysInfo, doctorsOnDate, slotsOnDate } from "../services/calendar.js";
import { listItems } from "./settings.js";
import { guardCalendar } from "../lib/trial.js";

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function calendarRoutes(app: FastifyInstance) {
  // ---- lists the booking screens need ----
  app.get("/api/meta", async (req) => {
    need(req, "appointments.read");
    const [doctors, plans, settings, labels] = await Promise.all([
      q(`SELECT id, name, short_name AS "shortName", yarago_doctor_id AS "yaragoDoctorId", is_active AS "isActive" FROM app.doctors ORDER BY name`),
      q(`SELECT name, eye, prep_min AS "prepMin", consult_min AS "consultMin", priority FROM app.plan_of_action WHERE is_active ORDER BY priority NULLS LAST, name`),
      q(`SELECT key, value FROM app.settings WHERE key LIKE 'general.%' OR key LIKE 'booking.%' ORDER BY key`),
      q(`SELECT kind, code, regexp_replace(label, ' \\(to confirm\\)$', '') AS label, confirmed FROM app.code_labels ORDER BY kind, code`),
    ]);
    const lists: Record<string, unknown> = {};
    for (const s of settings as any[]) {
      const name = s.key.replace(/^general\./, "");
      lists[name] = ["Appointment Type List", "Patient Type"].includes(name) ? listItems(s.value) : s.value;
    }
    return { doctors, plansOfAction: plans, lists, codeLabels: labels, today: todayIST() };
  });

  // ---- days: open/closed, capacity, how full (month view, day picker) ----
  app.get("/api/days", async (req) => {
    need(req, "appointments.read");
    const f = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const from = f.from ?? todayIST(), to = f.to ?? addDays(from, 41);
    if (to < from) throw badRequest("'to' is before 'from'");
    if (addDays(from, 120) < to) throw badRequest("Ask for at most 120 days at a time");
    return { days: await daysInfo(from, to) };
  });

  // ---- one day: slot grid with who is in each slot, and which doctors sit ----
  app.get("/api/days/:date", async (req) => {
    need(req, "appointments.read");
    const { date } = z.object({ date: dateStr }).parse(req.params);
    const [slots, doctors] = await Promise.all([slotsOnDate(date), doctorsOnDate(date)]);
    return { ...slots, doctors };
  });

  // ---- clinic calendar management (manager/admin) ----
  app.put("/api/days/:date/capacity", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const { date } = z.object({ date: dateStr }).parse(req.params);
    const { maxSlots, notes } = z.object({ maxSlots: z.number().int().min(0).max(200), notes: z.string().trim().max(300).optional() }).parse(req.body);
    const [day] = await daysInfo(date, date);
    if (maxSlots > 0 && maxSlots < day.booked)
      throw badRequest(`${day.booked} slots are already booked on ${niceDate(date)}; maximum slots cannot go below that`);
    await withTx(auditCtx(req, `Set maximum slots for ${niceDate(date)} to ${maxSlots}`), (c) =>
      c.query(`INSERT INTO app.day_capacity (on_date, max_slots, notes) VALUES ($1,$2,$3)
               ON CONFLICT (on_date) DO UPDATE SET max_slots = EXCLUDED.max_slots, notes = coalesce(EXCLUDED.notes, app.day_capacity.notes)`,
              [date, maxSlots, notes ?? null]));
    return { day: (await daysInfo(date, date))[0] };
  });

  app.put("/api/holidays/:date", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const { date } = z.object({ date: dateStr }).parse(req.params);
    const { reason, remarks } = z.object({ reason: z.string().trim().min(2).max(100), remarks: z.string().trim().max(300).optional() }).parse(req.body);
    const [day] = await daysInfo(date, date);
    await withTx(auditCtx(req, `Marked ${niceDate(date)} as a holiday (${reason})`), (c) =>
      c.query(`INSERT INTO app.holidays (on_date, reason, remarks) VALUES ($1,$2,$3)
               ON CONFLICT (on_date) DO UPDATE SET reason = EXCLUDED.reason, remarks = EXCLUDED.remarks`, [date, reason, remarks ?? null]));
    return { ok: true, warning: day.booked + day.waitlist > 0 ? `${day.booked + day.waitlist} patients are booked that day and need to be moved` : null };
  });

  app.delete("/api/holidays/:date", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const { date } = z.object({ date: dateStr }).parse(req.params);
    await withTx(auditCtx(req, `Removed the holiday on ${niceDate(date)}`), (c) => c.query("DELETE FROM app.holidays WHERE on_date = $1", [date]));
    return { ok: true };
  });

  app.get("/api/holidays", async (req) => {
    need(req, "appointments.read");
    return { holidays: await q(`SELECT to_char(on_date,'YYYY-MM-DD') AS date, reason, remarks FROM app.holidays WHERE on_date >= current_date - 30 ORDER BY on_date`) };
  });

  // doctor leave / partial day / extra session
  app.post("/api/doctors/:id/exceptions", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({
      date: dateStr, kind: z.enum(["leave", "partial", "extra"]),
      start: timeStr.optional(), end: timeStr.optional(), reason: z.string().trim().max(200).optional(),
    }).refine((v) => v.kind === "leave" || (v.start && v.end && v.start < v.end), "Partial days and extra sessions need a start and end time")
      .parse(req.body);
    const doc = await one<any>("SELECT name FROM app.doctors WHERE id = $1", [id]);
    if (!doc) throw notFound("Doctor");
    const words = { leave: "on leave", partial: `available only ${b.start}-${b.end}`, extra: `extra session ${b.start}-${b.end}` }[b.kind];
    const booked = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status IN ('booked','confirmed','waitlist')`, [id, b.date]);
    const row = await withTx(auditCtx(req, `${doc.name}: ${words} on ${niceDate(b.date)}${b.reason ? ` (${b.reason})` : ""}`), async (c) =>
      (await c.query(`INSERT INTO app.doctor_exceptions (doctor_id, on_date, kind, start_time, end_time, reason)
                      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [id, b.date, b.kind, b.start ?? null, b.end ?? null, b.reason ?? null])).rows[0]);
    return { id: row.id, warning: b.kind === "leave" && booked!.n > 0 ? `${booked!.n} patients are booked with ${doc.name} that day` : null };
  });

  app.delete("/api/doctors/:id/exceptions/:exceptionId", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const p = z.object({ id: z.coerce.number().int(), exceptionId: z.coerce.number().int() }).parse(req.params);
    const ex = await one<any>(`SELECT e.kind, to_char(e.on_date,'YYYY-MM-DD') AS d, doc.name FROM app.doctor_exceptions e
                                 JOIN app.doctors doc ON doc.id = e.doctor_id WHERE e.id = $1 AND e.doctor_id = $2`, [p.exceptionId, p.id]);
    if (!ex) throw notFound("Leave or session change");
    await withTx(auditCtx(req, `Removed ${ex.name}'s ${ex.kind} on ${niceDate(ex.d)}`), (c) =>
      c.query("DELETE FROM app.doctor_exceptions WHERE id = $1", [p.exceptionId]));
    return { ok: true };
  });

  app.get("/api/doctors/:id/schedule", async (req) => {
    need(req, "appointments.read");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const weekly = await q(`SELECT id, weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end"
                              FROM app.doctor_schedule WHERE doctor_id = $1 AND (valid_to IS NULL OR valid_to >= current_date)
                             ORDER BY weekday, start_time`, [id]);
    const exceptions = await q(`SELECT id, to_char(on_date,'YYYY-MM-DD') AS date, kind, to_char(start_time,'HH24:MI') AS start,
                                       to_char(end_time,'HH24:MI') AS "end", reason
                                  FROM app.doctor_exceptions WHERE doctor_id = $1 AND on_date >= current_date - 7 ORDER BY on_date`, [id]);
    return { weekly, exceptions };
  });

  // Replace a doctor's weekly hours. Old rows end yesterday so past bookings keep their context.
  app.put("/api/doctors/:id/schedule", async (req) => {
    need(req, "settings.manage");
    await guardCalendar();
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { sessions } = z.object({
      sessions: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: timeStr, end: timeStr })
        .refine((s) => s.start < s.end, "Each session must end after it starts")).max(28),
    }).parse(req.body);
    const doc = await one<any>("SELECT name FROM app.doctors WHERE id = $1", [id]);
    if (!doc) throw notFound("Doctor");
    const text = sessions.length
      ? sessions.map((s) => `${WEEKDAYS[s.weekday].slice(0, 3)} ${s.start}-${s.end}`).join(", ") : "no regular sessions";
    await withTx(auditCtx(req, `Changed ${doc.name}'s weekly hours to: ${text}`), async (c) => {
      await c.query(`DELETE FROM app.doctor_schedule WHERE doctor_id = $1 AND valid_from >= current_date`, [id]);
      await c.query(`UPDATE app.doctor_schedule SET valid_to = current_date - 1
                      WHERE doctor_id = $1 AND (valid_to IS NULL OR valid_to >= current_date)`, [id]);
      for (const s of sessions)
        await c.query(`INSERT INTO app.doctor_schedule (doctor_id, weekday, start_time, end_time, valid_from) VALUES ($1,$2,$3,$4,current_date)`,
                      [id, s.weekday, s.start, s.end]);
    });
    return { ok: true };
  });
}
