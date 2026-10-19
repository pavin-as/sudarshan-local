import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { can } from "../lib/permissions.js";
import { dateStr, niceDate, timeStr } from "../lib/time.js";
import { doctorsOnDate } from "../services/calendar.js";
import { FromGoogle, googleIsMaster, guardImported } from "../lib/trial.js";
import { addEvent, checkPlacement, describe, setAuditSummary, whenText, type Override } from "../services/booking.js";

// Live state from Yarago for a booking on its day: has the patient arrived, where are they now.
const LIVE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT ya.aappoint_id AS visit_id, ya.nstatus_id AS status_id
      FROM yarago.tblappointments ya
     WHERE ya.npatient_id = a.patient_id
       AND ya.tappoint_date_time >= a.appointment_date AND ya.tappoint_date_time < a.appointment_date + 1
     ORDER BY (ya.nstatus_id = 4), ya.tappoint_date_time
     LIMIT 1) yv ON a.patient_id IS NOT NULL
  LEFT JOIN app.code_labels yl ON yl.kind = 'appointment_status' AND yl.code = yv.status_id
  LEFT JOIN clinical.visit_timeline tl ON tl.visit_id = yv.visit_id`;

const APPT_COLS = `
  a.id, to_char(a.appointment_date,'YYYY-MM-DD') AS "date", to_char(a.slot_time,'HH24:MI') AS "slotTime",
  a.duration_min AS "durationMin", a.doctor_id AS "doctorId", d.name AS "doctorName",
  a.patient_id AS "patientId", a.mrd, a.patient_name AS "patientName", a.phone, a.age_years AS "ageYears", a.gender,
  a.patient_type AS "patientType", a.appointment_type AS "appointmentType", a.plan_of_action AS "planOfAction",
  a.urgency, a.family_group AS "familyGroup", a.fixed_slot AS "fixedSlot", to_char(a.consult_start,'HH24:MI') AS "consultStart",
  a.tags, a.remarks, a.status, a.source, a.source_ref AS "sourceRef",
  a.confirmed_4day_at AS "confirmed4dayAt", a.confirmed_1day_at AS "confirmed1dayAt",
  a.cancelled_at AS "cancelledAt", a.cancel_reason AS "cancelReason",
  bu.full_name AS "bookedBy", a.booked_at AS "bookedAt", a.legacy_id AS "legacyId", (a.legacy_id IS NOT NULL) AS "fromGoogle",
  yv.visit_id AS "yaragoVisitId", regexp_replace(yl.label, ' \\(to confirm\\)$', '') AS "yaragoStatus",
  tl.check_in_at AS "checkInAt", tl.check_out_at AS "checkOutAt",
  CASE WHEN tl.check_out_at IS NOT NULL OR yv.status_id = 3 THEN 'done'
       WHEN tl.exam_start_at IS NOT NULL OR tl.exam_after_dilatation_at IS NOT NULL OR yv.status_id = 2 THEN 'with_doctor'
       WHEN tl.room_in_at IS NOT NULL OR tl.optometry_end_at IS NOT NULL THEN 'waiting_for_doctor'
       WHEN tl.optometry_start_at IS NOT NULL THEN 'optometry'
       WHEN tl.check_in_at IS NOT NULL OR yv.status_id = 1 THEN 'arrived'
       WHEN yv.status_id = 4 THEN 'cancelled_in_yarago'
       WHEN yv.visit_id IS NOT NULL THEN 'registered_not_arrived'
  END AS "liveStage"`;

const FROM = `FROM app.appointments a
  LEFT JOIN app.doctors d ON d.id = a.doctor_id
  LEFT JOIN app.users bu ON bu.id = a.booked_by ${LIVE_JOIN}`;
// Lists spanning many days skip the per-booking Yarago lookup (the live stage only matters on the day).
const FROM_LIGHT = `FROM app.appointments a
  LEFT JOIN app.doctors d ON d.id = a.doctor_id
  LEFT JOIN app.users bu ON bu.id = a.booked_by
  LEFT JOIN (SELECT NULL::int AS visit_id, NULL::int AS status_id) yv ON false
  LEFT JOIN app.code_labels yl ON false
  LEFT JOIN (SELECT NULL::timestamp AS check_in_at, NULL::timestamp AS check_out_at, NULL::timestamp AS exam_start_at,
                    NULL::timestamp AS exam_after_dilatation_at, NULL::timestamp AS room_in_at, NULL::timestamp AS optometry_end_at,
                    NULL::timestamp AS optometry_start_at) tl ON false`;

const idParam = z.object({ id: z.coerce.number().int().positive() });
// absent stays undefined (not changed); "" or null clears the field
const optText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v ? v : null));
const overrideSchema = z.object({ reason: z.string().trim().min(3).max(300) }).optional().nullable();

const createBody = z.object({
  date: dateStr,
  slotTime: timeStr.nullable().optional(),        // empty = waitlist
  doctorId: z.number().int().positive().nullable().optional(),
  patientId: z.number().int().positive().nullable().optional(),
  mrd: optText(30),
  patientName: optText(150),
  phone: optText(30),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  gender: optText(20),
  patientType: optText(40),
  appointmentType: optText(80),
  planOfAction: optText(300),
  urgency: optText(40),
  familyGroup: optText(80),
  fixedSlot: z.boolean().optional(),
  consultStart: timeStr.nullable().optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  remarks: optText(1000),
  source: z.enum(["booking", "direct_call", "followup", "cancel_list"]).optional(),
  sourceRef: optText(80),
  override: overrideSchema,
});

const editBody = z.object({
  doctorId: z.number().int().positive().nullable().optional(),
  patientName: z.string().trim().min(1).max(150).optional(),
  phone: optText(30),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  gender: optText(20),
  patientType: optText(40),
  appointmentType: optText(80),
  planOfAction: optText(300),
  urgency: optText(40),
  familyGroup: optText(80),
  fixedSlot: z.boolean().optional(),
  consultStart: timeStr.nullable().optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  remarks: optText(1000),
});

const moveBody = z.object({
  date: dateStr,
  slotTime: timeStr.nullable().optional(),
  doctorId: z.number().int().positive().nullable().optional(),
  reason: optText(300),
  override: overrideSchema,
});

const EDIT_COLUMNS: Record<string, string> = {
  doctorId: "doctor_id", patientName: "patient_name", phone: "phone", ageYears: "age_years", gender: "gender",
  patientType: "patient_type", appointmentType: "appointment_type", planOfAction: "plan_of_action", urgency: "urgency",
  familyGroup: "family_group", fixedSlot: "fixed_slot", consultStart: "consult_start", durationMin: "duration_min",
  tags: "tags", remarks: "remarks",
};

async function loadOne(id: number, db?: PoolClient) {
  return one<any>(`SELECT ${APPT_COLS} ${FROM} WHERE a.id = $1`, [id], db);
}

async function lockRow(c: PoolClient, id: number) {
  const r = await one<any>(
    `SELECT id, to_char(appointment_date,'YYYY-MM-DD') AS appointment_date, to_char(slot_time,'HH24:MI') AS slot_time,
            doctor_id, patient_id, mrd, phone, patient_name, status, tags, plan_of_action, appointment_type, urgency, legacy_id
       FROM app.appointments WHERE id = $1 FOR UPDATE`, [id], c);
  if (!r) throw notFound("Appointment");
  await guardImported(r);
  return r;
}

function overrideFor(req: FastifyRequest, o: { reason: string } | null | undefined): Override | null {
  if (!o) return null;
  if (!can(req.user!.role, "settings.manage")) throw badRequest("Only a manager or admin can book over a full day, a taken slot or a held HFA slot");
  return o;
}

export async function appointmentRoutes(app: FastifyInstance) {
  // ---- day list (the appointment board) ----
  app.get("/api/appointments", async (req) => {
    need(req, "appointments.read");
    const f = z.object({
      date: dateStr.optional(), from: dateStr.optional(), to: dateStr.optional(),
      status: z.string().optional(), doctorId: z.coerce.number().int().optional(),
      patientId: z.coerce.number().int().optional(), q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(300),
    }).parse(req.query);
    const where: string[] = [], p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace("?", `$${p.length}`)); };
    if (f.date) add("a.appointment_date = ?", f.date);
    if (f.from) add("a.appointment_date >= ?", f.from);
    if (f.to) add("a.appointment_date <= ?", f.to);
    if (f.status) add("a.status = ANY(?)", f.status.split(","));
    if (f.doctorId) add("a.doctor_id = ?", f.doctorId);
    if (f.patientId) add("a.patient_id = ?", f.patientId);
    if (f.q) { p.push(f.q); const n = `$${p.length}`; where.push(`(a.patient_name ILIKE '%' || ${n} || '%' OR a.mrd ILIKE ${n} || '%' OR a.phone LIKE '%' || ${n})`); }
    if (!where.length) throw badRequest("Give a date, a date range, a patient or a search");
    p.push(f.limit);
    const order = f.date ? "a.slot_time NULLS LAST, a.id" : "a.appointment_date DESC, a.slot_time NULLS LAST";
    const live = !!f.date || !!f.patientId;
    return { appointments: await q(`SELECT ${APPT_COLS} ${live ? FROM : FROM_LIGHT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${p.length}`, p) };
  });

  // ---- one appointment with its story ----
  app.get("/api/appointments/:id", async (req) => {
    need(req, "appointments.read");
    const { id } = idParam.parse(req.params);
    const appointment = await loadOne(id);
    if (!appointment) throw notFound("Appointment");
    const events = await q(
      `SELECT e.id, e.at, e.event_type AS "type", coalesce(u.full_name, e.actor_name) AS "by",
              e.from_value AS "from", e.to_value AS "to", e.note
         FROM app.appointment_events e LEFT JOIN app.users u ON u.id = e.actor_id
        WHERE e.appointment_id = $1 ORDER BY e.at, e.id`, [id]);
    return { appointment, events };
  });

  // ---- book ----
  app.post("/api/appointments", async (req) => {
    const me = need(req, "appointments.write");
    const b = createBody.parse(req.body);
    const override = overrideFor(req, b.override);

    // fill patient details from Yarago when we know who it is
    let patientId = b.patientId ?? null, mrd = b.mrd?.toUpperCase() ?? null;
    let yp: any;
    if (patientId) yp = await one(`SELECT patient_id, mrd, name, mobile, age_years, sex FROM clinical.patient WHERE patient_id = $1`, [patientId]);
    else if (mrd) yp = await one(`SELECT patient_id, mrd, name, mobile, age_years, sex FROM clinical.patient WHERE upper(mrd) = $1`, [mrd]);
    if (patientId && !yp) throw badRequest("That Yarago patient was not found");
    if (yp) { patientId = yp.patient_id; mrd = yp.mrd; }
    const name = b.patientName ?? yp?.name;
    if (!name) throw badRequest("Patient name is required");
    const phone = b.phone ?? yp?.mobile ?? null;
    const slot = b.slotTime ?? null;
    const status = slot ? "booked" : "waitlist";
    if (b.source === "direct_call" && b.sourceRef && /^\d+$/.test(b.sourceRef) && (await googleIsMaster())) {
      const dc = await one<any>(`SELECT legacy_id FROM app.direct_calls WHERE id = $1`, [Number(b.sourceRef)]);
      if (dc?.legacy_id) throw new FromGoogle("This direct call");
    }
    const who = describe({ patient_name: name, mrd });

    return withTx(auditCtx(req), async (c) => {
      const warnings = await checkPlacement(c, { date: b.date, slotTime: slot, doctorId: b.doctorId ?? null,
                                                 planOfAction: b.planOfAction, appointmentType: b.appointmentType, urgency: b.urgency },
        { patientId, mrd, phone, name }, null, override);
      const docName = b.doctorId ? (await one<any>("SELECT name FROM app.doctors WHERE id = $1", [b.doctorId], c))?.name : null;
      await setAuditSummary(c, `Booked ${who} for ${whenText(b.date, slot)}${docName ? ` with ${docName}` : ""}`);
      const ins = await one<{ id: number }>(
        `INSERT INTO app.appointments (appointment_date, slot_time, duration_min, doctor_id, patient_id, mrd, patient_name, phone,
            age_years, gender, patient_type, appointment_type, plan_of_action, urgency, family_group, fixed_slot, consult_start,
            tags, remarks, status, source, source_ref, booked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
        [b.date, slot, b.durationMin ?? 10, b.doctorId ?? null, patientId, mrd, name, phone,
         b.ageYears ?? yp?.age_years ?? null, b.gender ?? yp?.sex ?? null, b.patientType ?? (patientId ? "Old" : "New"),
         b.appointmentType, b.planOfAction, b.urgency, b.familyGroup, b.fixedSlot ?? false, b.consultStart ?? null,
         b.tags ?? [], b.remarks, status, b.source ?? "booking", b.sourceRef, me.id], c);
      await addEvent(c, ins!.id, me.id, "booked", null, { date: b.date, slot }, override ? `Override: ${override.reason}` : null);
      if (b.source === "direct_call" && b.sourceRef && /^\d+$/.test(b.sourceRef))
        await c.query(`UPDATE app.direct_calls SET status = 'booked', appointment_id = $2 WHERE id = $1`, [Number(b.sourceRef), ins!.id]);
      return { appointment: await loadOne(ins!.id, c), warnings };
    });
  });

  // ---- reschedule / move between waitlist and a slot ----
  app.post("/api/appointments/:id/move", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const b = moveBody.parse(req.body);
    const override = overrideFor(req, b.override);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      if (["completed", "no_show", "checked_in"].includes(cur.status)) throw conflict(`This appointment is already ${cur.status.replace("_", " ")}`);
      const slot = b.slotTime ?? null;
      const doctorId = b.doctorId === undefined ? cur.doctor_id : b.doctorId;
      const warnings = await checkPlacement(c, { date: b.date, slotTime: slot, doctorId,
                                                 planOfAction: cur.plan_of_action, appointmentType: cur.appointment_type, urgency: cur.urgency },
        { patientId: cur.patient_id, mrd: cur.mrd, phone: cur.phone, name: cur.patient_name }, id, override);
      const wasCancelled = cur.status === "cancelled";
      const newStatus = slot ? (cur.status === "confirmed" && cur.appointment_date === b.date ? "confirmed" : "booked") : "waitlist";
      const verb = wasCancelled ? "Restored" : cur.status === "waitlist" && slot ? "Gave a slot to" : "Rescheduled";
      await setAuditSummary(c, `${verb} ${describe(cur)}: ${whenText(cur.appointment_date, cur.slot_time)} → ${whenText(b.date, slot)}${b.reason ? ` (${b.reason})` : ""}`);
      await c.query(
        `UPDATE app.appointments SET appointment_date = $2, slot_time = $3, doctor_id = $4, status = $5,
                cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL,
                confirmed_4day_at = CASE WHEN appointment_date = $2 THEN confirmed_4day_at END,
                confirmed_4day_by = CASE WHEN appointment_date = $2 THEN confirmed_4day_by END,
                confirmed_1day_at = CASE WHEN appointment_date = $2 THEN confirmed_1day_at END,
                confirmed_1day_by = CASE WHEN appointment_date = $2 THEN confirmed_1day_by END
          WHERE id = $1`, [id, b.date, slot, doctorId, newStatus]);
      const type = wasCancelled ? "restored" : cur.status === "waitlist" && slot ? "moved_from_waitlist" : "rescheduled";
      await addEvent(c, id, me.id, type, { date: cur.appointment_date, slot: cur.slot_time, status: cur.status },
                     { date: b.date, slot, status: newStatus }, [b.reason, override ? `Override: ${override.reason}` : null].filter(Boolean).join(" · ") || null);
      return { appointment: await loadOne(id, c), warnings };
    });
  });

  // ---- edit details (not date/time: use /move) ----
  app.patch("/api/appointments/:id", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const b = editBody.parse(req.body);
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) throw badRequest("Nothing to change");
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      if (b.doctorId && cur.status !== "cancelled") {
        const docs = await doctorsOnDate(cur.appointment_date, c);
        const d = docs.find((x) => x.doctorId === b.doctorId);
        if (!d) throw badRequest("That doctor is not active");
        if (d.onLeave) throw conflict(`${d.name} is on leave on ${niceDate(cur.appointment_date)}`);
      }
      await setAuditSummary(c, `Updated ${describe(cur)}'s appointment on ${niceDate(cur.appointment_date)}`);
      const sets = keys.map((k, i) => `${EDIT_COLUMNS[k]} = $${i + 2}`);
      await c.query(`UPDATE app.appointments SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => (b as any)[k])]);
      if (b.tags) {
        const before: string[] = cur.tags ?? [];
        for (const t of b.tags.filter((x) => !before.includes(x))) await addEvent(c, id, me.id, "tag_added", null, t);
        for (const t of before.filter((x) => !b.tags!.includes(x))) await addEvent(c, id, me.id, "tag_removed", t, null);
      }
      return { appointment: await loadOne(id, c) };
    });
  });

  // ---- cancel ----
  app.post("/api/appointments/:id/cancel", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const { reason, callbackOn } = z.object({ reason: z.string().trim().min(2).max(300), callbackOn: dateStr.nullable().optional() }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      if (["cancelled", "completed", "no_show"].includes(cur.status)) throw conflict(`This appointment is already ${cur.status.replace("_", " ")}`);
      await setAuditSummary(c, `Cancelled ${describe(cur)}'s appointment on ${whenText(cur.appointment_date, cur.slot_time)}: ${reason}`);
      // a cancelled booking goes on the cancel list (again), with a call-back date if one was given
      await c.query(`UPDATE app.appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
                       callback_on = $4, cancel_list_done_at = NULL, cancel_list_done_by = NULL, cancel_list_note = NULL WHERE id = $1`,
                    [id, me.id, reason, callbackOn ?? null]);
      await addEvent(c, id, me.id, "cancelled", { status: cur.status, slot: cur.slot_time }, { status: "cancelled" }, reason);
      return { appointment: await loadOne(id, c) };
    });
  });

  // ---- confirmation calls (4 days before, 1 day before) ----
  app.post("/api/appointments/:id/confirm", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const { stage, note } = z.object({ stage: z.enum(["4day", "1day"]), note: optText(300) }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      if (!["booked", "confirmed"].includes(cur.status)) throw conflict(`Only booked appointments can be confirmed (this one is ${cur.status})`);
      const label = stage === "4day" ? "4-day" : "1-day";
      await setAuditSummary(c, `${label} confirmation: ${describe(cur)} for ${whenText(cur.appointment_date, cur.slot_time)}${note ? ` (${note})` : ""}`);
      await c.query(`UPDATE app.appointments SET status = 'confirmed', confirmed_${stage}_at = now(), confirmed_${stage}_by = $2 WHERE id = $1`, [id, me.id]);
      await addEvent(c, id, me.id, `confirmed_${stage}`, null, null, note);
      return { appointment: await loadOne(id, c) };
    });
  });

  // ---- remark (adds to the story; does not overwrite the remarks field) ----
  app.post("/api/appointments/:id/remarks", async (req) => {
    const me = need(req, "appointments.read");          // doctors and optometrists may add remarks too
    const { id } = idParam.parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      await setAuditSummary(c, `Remark on ${describe(cur)}'s appointment: ${note.slice(0, 120)}`);
      await addEvent(c, id, me.id, "remark", null, null, note);
      return { ok: true };
    });
  });

  // ---- link a booking made for a new patient to their Yarago record (once registered) ----
  app.post("/api/appointments/:id/link", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const { patientId } = z.object({ patientId: z.number().int().positive() }).parse(req.body);
    const yp = await one<any>(`SELECT patient_id, mrd, name, mobile, age_years, sex FROM clinical.patient WHERE patient_id = $1`, [patientId]);
    if (!yp) throw notFound("Yarago patient");
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      await setAuditSummary(c, `Linked ${describe(cur)}'s appointment on ${niceDate(cur.appointment_date)} to Yarago patient ${yp.name} (${yp.mrd})`);
      await c.query(`UPDATE app.appointments SET patient_id = $2, mrd = $3, phone = coalesce(phone, $4),
                       age_years = coalesce(age_years, $5), gender = coalesce(gender, $6) WHERE id = $1`,
                    [id, yp.patient_id, yp.mrd, yp.mobile, yp.age_years, yp.sex]);
      await addEvent(c, id, me.id, "remark", null, null, `Linked to Yarago patient ${yp.name} (${yp.mrd})`);
      return { appointment: await loadOne(id, c) };
    });
  });

  // ---- manual arrival / outcome (normally taken from Yarago) ----
  app.post("/api/appointments/:id/status", async (req) => {
    const me = need(req, "appointments.write");
    const { id } = idParam.parse(req.params);
    const { status, note } = z.object({ status: z.enum(["checked_in", "completed", "no_show"]), note: optText(300) }).parse(req.body);
    return withTx(auditCtx(req), async (c) => {
      const cur = await lockRow(c, id);
      if (!cur.slot_time && cur.status === "waitlist") throw conflict("Give the patient a slot first");
      if (cur.status === "cancelled") throw conflict("This appointment is cancelled");
      const words: Record<string, string> = { checked_in: "Checked in", completed: "Marked completed", no_show: "Marked no-show" };
      await setAuditSummary(c, `${words[status]}: ${describe(cur)}, ${whenText(cur.appointment_date, cur.slot_time)}`);
      await c.query("UPDATE app.appointments SET status = $2 WHERE id = $1", [id, status]);
      await addEvent(c, id, me.id, status, { status: cur.status }, { status }, note);
      return { appointment: await loadOne(id, c) };
    });
  });
}
