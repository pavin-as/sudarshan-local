// The cancel list (Google app "cancel" sheet): cancelled bookings to call back and rebook, until someone
// rebooks the patient (restore = POST /api/appointments/:id/move) or takes the booking off the list with a reason.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, setAuditSummary, withTx } from "../db.js";
import { conflict, notFound } from "../lib/errors.js";
import { dateStr, niceDate } from "../lib/time.js";
import { addEvent, describe } from "../services/booking.js";
import { guardImported } from "../lib/trial.js";

const COLS = `
  a.id, to_char(a.appointment_date,'YYYY-MM-DD') AS date, to_char(a.slot_time,'HH24:MI') AS "slotTime",
  a.patient_id AS "patientId", a.mrd, a.patient_name AS "patientName", a.phone, a.age_years AS "ageYears",
  a.plan_of_action AS "planOfAction", a.urgency, a.tags, d.name AS "doctorName",
  (a.legacy_id IS NOT NULL) AS "fromGoogle", a.cancelled_at AS "cancelledAt", coalesce(cu.full_name, '') AS "cancelledBy", a.cancel_reason AS "cancelReason",
  to_char(a.callback_on,'YYYY-MM-DD') AS "callbackOn",
  a.cancel_list_done_at AS "doneAt", du.full_name AS "doneBy", a.cancel_list_note AS "doneNote",
  lc.note AS "lastCallNote", lc.at AS "lastCallAt", coalesce(lc.by, '') AS "lastCallBy",
  nb.id AS "newBookingId", to_char(nb.appointment_date,'YYYY-MM-DD') AS "newBookingDate"`;
const FROM = `FROM app.appointments a
  LEFT JOIN app.doctors d ON d.id = a.doctor_id
  LEFT JOIN app.users cu ON cu.id = a.cancelled_by
  LEFT JOIN app.users du ON du.id = a.cancel_list_done_by
  LEFT JOIN LATERAL (SELECT e.note, e.at, coalesce(u.full_name, e.actor_name) AS by FROM app.appointment_events e
                       LEFT JOIN app.users u ON u.id = e.actor_id
                      WHERE e.appointment_id = a.id AND e.event_type = 'remark' AND e.note LIKE 'Call-back call:%'
                      ORDER BY e.at DESC LIMIT 1) lc ON true
  LEFT JOIN LATERAL (SELECT x.id, x.appointment_date FROM app.appointments x
                      WHERE a.patient_id IS NOT NULL AND x.patient_id = a.patient_id AND x.id <> a.id
                        AND x.appointment_date >= current_date AND x.status IN ('booked','confirmed','waitlist')
                      ORDER BY x.appointment_date LIMIT 1) nb ON true`;

export async function cancelListRoutes(app: FastifyInstance) {
  // to_call: on the list and due a call (no call-back date, or it has come); all: everything on the list; done: taken off
  app.get("/api/cancel-list", async (req) => {
    need(req, "appointments.read");
    const f = z.object({
      view: z.enum(["to_call", "all", "done"]).default("to_call"),
      q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(300),
    }).parse(req.query);
    const p: unknown[] = [];
    const where = ["a.status = 'cancelled'",
      f.view === "done" ? "a.cancel_list_done_at > now() - interval '120 days'" : "a.cancel_list_done_at IS NULL"];
    if (f.view === "to_call") where.push("(a.callback_on IS NULL OR a.callback_on <= current_date)");
    if (f.q) { p.push(f.q); where.push(`(a.patient_name ILIKE '%' || $1 || '%' OR a.mrd ILIKE $1 || '%' OR a.phone LIKE '%' || $1)`); }
    p.push(f.limit);
    const order = f.view === "done" ? "a.cancel_list_done_at DESC" : "a.callback_on NULLS FIRST, a.appointment_date";
    const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${p.length}`, p);
    const counts = (await one<any>(
      `SELECT count(*) FILTER (WHERE callback_on IS NULL OR callback_on <= current_date)::int AS to_call, count(*)::int AS all
         FROM app.appointments WHERE status = 'cancelled' AND cancel_list_done_at IS NULL`))!;
    return { appointments: rows, counts: { toCall: counts.to_call, all: counts.all } };
  });

  // a call to a patient on the cancel list: what happened, and when to call again
  app.post("/api/appointments/:id/callback", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ note: z.string().trim().min(2).max(500), callbackOn: dateStr.nullable().optional() }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = (await c.query(`SELECT id, patient_name, mrd, status, legacy_id, to_char(callback_on,'YYYY-MM-DD') AS callback_on FROM app.appointments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Appointment");
      await guardImported(cur);
      if (cur.status !== "cancelled") throw conflict("Only a cancelled booking is on the cancel list");
      await setAuditSummary(c, `Cancel list call to ${describe(cur)}: ${b.note.slice(0, 120)}${b.callbackOn ? `; call again ${niceDate(b.callbackOn)}` : ""}`);
      if (b.callbackOn !== undefined) await c.query(`UPDATE app.appointments SET callback_on = $2 WHERE id = $1`, [id, b.callbackOn]);
      await addEvent(c, id, me.id, "remark", null, null, `Call-back call: ${b.note}${b.callbackOn ? ` (call again ${niceDate(b.callbackOn)})` : ""}`);
      return { appointment: await one(`SELECT ${COLS} ${FROM} WHERE a.id = $1`, [id], c) };
    });
  });

  // take a cancelled booking off the list (no rebooking needed), or put it back
  app.post("/api/appointments/:id/cancel-list", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ onList: z.boolean(), note: z.string().trim().min(2).max(300).optional() }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = (await c.query(`SELECT id, patient_name, mrd, status, legacy_id, cancel_list_done_at FROM app.appointments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Appointment");
      await guardImported(cur);
      if (cur.status !== "cancelled") throw conflict("Only a cancelled booking is on the cancel list");
      if (!b.onList && !b.note) throw conflict("Say why no rebooking is needed");
      await setAuditSummary(c, b.onList ? `Put ${describe(cur)} back on the cancel list` : `Took ${describe(cur)} off the cancel list: ${b.note}`);
      await c.query(b.onList
        ? `UPDATE app.appointments SET cancel_list_done_at = NULL, cancel_list_done_by = NULL, cancel_list_note = NULL WHERE id = $1`
        : `UPDATE app.appointments SET cancel_list_done_at = now(), cancel_list_done_by = $2, cancel_list_note = $3 WHERE id = $1`,
        b.onList ? [id] : [id, me.id, b.note]);
      await addEvent(c, id, me.id, "remark", null, null, b.onList ? "Back on the cancel list" : `Off the cancel list: ${b.note}`);
      return { appointment: await one(`SELECT ${COLS} ${FROM} WHERE a.id = $1`, [id], c) };
    });
  });
}
