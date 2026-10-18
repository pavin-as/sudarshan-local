// Follow-up board: patients Yarago says should have come back. Work list order: injection patients
// first (missed anti-VEGF doses cost vision), then the most recently overdue (most likely to return).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { notFound } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";

const ACTIONS = ["called", "no_answer", "will_come", "booked", "declined", "wrong_number", "not_needed", "moved_away", "deceased", "note"] as const;
const ACTION_WORDS: Record<(typeof ACTIONS)[number], string> = {
  called: "Called", no_answer: "No answer", will_come: "Will come", booked: "Booked", declined: "Declined",
  wrong_number: "Wrong number", not_needed: "Follow-up not needed", moved_away: "Moved away", deceased: "Deceased", note: "Note",
};
// After these the patient leaves the work list
const CLOSING = ["booked", "declined", "wrong_number", "not_needed", "moved_away", "deceased"];

export async function followupRoutes(app: FastifyInstance) {
  app.get("/api/followups", async (req) => {
    need(req, "patients.read");
    const f = z.object({
      view: z.enum(["to_call", "upcoming", "all_overdue"]).default("to_call"),
      maxOverdueDays: z.coerce.number().int().min(1).max(3650).default(90),
      upcomingDays: z.coerce.number().int().min(1).max(60).default(7),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);

    const stateFilter = f.view === "upcoming"
      ? `fc.due_date BETWEEN current_date AND current_date + $1::int`
      : f.view === "all_overdue" ? `NOT fc.came_back AND fc.due_date < current_date AND $1::int > 0`
      : `NOT fc.came_back AND fc.due_date < current_date AND fc.days_overdue <= $1::int`;
    const rows = await q(
      `SELECT fc.patient_id AS "patientId", p.mrd, p.name, p.age_years AS "ageYears", p.mobile,
              fc.followup_id AS "followupId", to_char(fc.due_date,'YYYY-MM-DD') AS "dueDate", fc.days_overdue AS "daysOverdue",
              fc.followup_state AS state, to_char(fc.from_visit_date,'YYYY-MM-DD') AS "fromVisitDate", fc.comments,
              inj.n AS "injectionCount", to_char(inj.last_at,'YYYY-MM-DD') AS "lastInjection",
              la.action AS "lastAction", la.at AS "lastActionAt", la.note AS "lastNote", to_char(la.next_call_on,'YYYY-MM-DD') AS "nextCallOn",
              ap.id AS "appointmentId", to_char(ap.appointment_date,'YYYY-MM-DD') AS "appointmentDate"
         FROM clinical.followup_current fc
         JOIN clinical.patient p ON p.patient_id = fc.patient_id
         LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE given)::int AS n, max(treated_at) FILTER (WHERE given) AS last_at
                              FROM clinical.injection i WHERE i.patient_id = fc.patient_id) inj ON true
         LEFT JOIN LATERAL (SELECT action, at, note, next_call_on FROM app.followup_actions x
                             WHERE x.patient_id = fc.patient_id AND x.at >= fc.from_visit_date
                             ORDER BY x.at DESC LIMIT 1) la ON true
         LEFT JOIN LATERAL (SELECT id, appointment_date FROM app.appointments a
                             WHERE a.patient_id = fc.patient_id AND a.appointment_date >= current_date
                               AND a.status IN ('booked','confirmed','waitlist')
                             ORDER BY appointment_date LIMIT 1) ap ON true
        WHERE ${stateFilter}
          ${f.view === "to_call" ? `AND ap.id IS NULL
          AND (la.action IS NULL OR la.action NOT IN (${CLOSING.map((c) => `'${c}'`).join(",")}))
          AND (la.next_call_on IS NULL OR la.next_call_on <= current_date)` : ""}
        ORDER BY ${f.view === "upcoming" ? "fc.due_date" : `(coalesce(inj.n,0) > 0) DESC, fc.days_overdue`}
        LIMIT $2`, [f.view === "upcoming" ? f.upcomingDays : f.maxOverdueDays, f.limit]);
    return { followups: rows };
  });

  app.post("/api/followups/:patientId/actions", async (req) => {
    const me = need(req, "followups.write");
    const { patientId } = z.object({ patientId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({
      action: z.enum(ACTIONS), note: z.string().trim().max(1000).optional(),
      nextCallOn: dateStr.optional(), followupId: z.number().int().optional(), appointmentId: z.number().int().optional(),
    }).parse(req.body);
    const p = await one<any>("SELECT mrd, name FROM clinical.patient WHERE patient_id = $1", [patientId]);
    if (!p) throw notFound("Patient");
    const fu = b.followupId ?? (await one<any>("SELECT followup_id FROM clinical.followup_current WHERE patient_id = $1", [patientId]))?.followup_id ?? null;
    const summary = `Follow-up call for ${p.name} (${p.mrd}): ${ACTION_WORDS[b.action]}${b.note ? ` - ${b.note.slice(0, 120)}` : ""}${b.nextCallOn ? `; call again ${b.nextCallOn}` : ""}`;
    const row = await withTx(auditCtx(req, summary), async (c) =>
      (await c.query(`INSERT INTO app.followup_actions (yarago_followup_id, patient_id, action, note, next_call_on, appointment_id, actor_id)
                      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, at`,
                     [fu, patientId, b.action, b.note ?? null, b.nextCallOn ?? null, b.appointmentId ?? null, me.id])).rows[0]);
    return { action: row };
  });
}
