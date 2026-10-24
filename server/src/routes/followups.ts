// Follow-up board: patients Yarago says should have come back, ranked by clinical risk (services/followupRisk.ts):
// injection course or ROP first, then retinal disease under care, then diabetes / conditions to watch, then the rest;
// within a tier the most recently overdue first (most likely to return). Each patient is also on the card of every team that cares.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { notFound } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";
import { ordinal, titleWords } from "../lib/text.js";
import { GROUPS, groupsFor, riskTier, type Group } from "../services/followupRisk.js";
import { drugName } from "../services/summary.js";


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
      group: z.enum(GROUPS.map((g) => g.key) as [Group, ...Group[]]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);

    // ROP babies are seen every 1-2 weeks, so the "overdue up to N days" choice does not hide them (they leave at 12 months)
    const stateFilter = f.view === "upcoming"
      ? `fc.due_date BETWEEN current_date AND current_date + $1::int`
      : f.view === "all_overdue" ? `NOT fc.came_back AND fc.due_date < current_date AND $1::int > 0`
      : `NOT fc.came_back AND fc.due_date < current_date AND fc.days_overdue <= greatest($1::int, 365)`;
    // every candidate is ranked, then the list is cut: the order is clinical risk, not the order Yarago returns
    const rows = await q<any>(
      `SELECT fc.patient_id AS "patientId", p.mrd, p.name, p.age_years AS "ageYears", p.mobile,
              fc.followup_id AS "followupId", to_char(fc.due_date,'YYYY-MM-DD') AS "dueDate", fc.days_overdue AS "daysOverdue",
              fc.followup_state AS state, to_char(fc.from_visit_date,'YYYY-MM-DD') AS "fromVisitDate", fc.comments,
              (SELECT v.doctor FROM clinical.visit v WHERE v.visit_id = fc.from_visit_id) AS doctor,
              inj.n AS "injectionCount", to_char(inj.last_at,'YYYY-MM-DD') AS "lastInjection",
              (current_date - inj.last_at::date) AS inj_days, inj.last_proc, inj.last_drug, inj.last_eye, inj.last_n,
              to_char(las.treated_at,'YYYY-MM-DD') AS "lastLaser", (current_date - las.treated_at::date) AS las_days, las.what AS las_what, las.eye AS las_eye,
              cd.cond AS condition, coalesce(dm.dm, false) AS diabetes,
              coalesce(rp.active, false) AS rop, rp.days AS rop_days,
              la.action AS "lastAction", la.at AS "lastActionAt", la.note AS "lastNote", to_char(la.next_call_on,'YYYY-MM-DD') AS "nextCallOn",
              ap.id AS "appointmentId", to_char(ap.appointment_date,'YYYY-MM-DD') AS "appointmentDate"
         FROM clinical.followup_current fc
         JOIN clinical.patient p ON p.patient_id = fc.patient_id
         LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE given)::int AS n, max(treated_at) FILTER (WHERE given) AS last_at,
                                   (array_agg(procedure ORDER BY treated_at DESC) FILTER (WHERE given))[1] AS last_proc,
                                   (array_agg(drug ORDER BY treated_at DESC) FILTER (WHERE given))[1] AS last_drug,
                                   (array_agg(eye ORDER BY treated_at DESC) FILTER (WHERE given))[1] AS last_eye,
                                   (array_agg(injection_number_for_eye ORDER BY treated_at DESC) FILTER (WHERE given))[1] AS last_n
                              FROM clinical.injection i WHERE i.patient_id = fc.patient_id) inj ON true
         LEFT JOIN LATERAL (SELECT treated_at, coalesce(done, advised) AS what, eye FROM clinical.laser l
                             WHERE l.patient_id = fc.patient_id AND l.done IS NOT NULL ORDER BY treated_at DESC LIMIT 1) las ON true
         LEFT JOIN LATERAL (SELECT analytics.categorise('diagnosis', string_agg(x.finding, ' ; ')) AS cond
                              FROM clinical.visit_exam_finding x
                             WHERE x.visit_id = (SELECT max(y.visit_id) FROM clinical.visit_exam_finding y
                                                  WHERE y.patient_id = fc.patient_id AND y.finding IS NOT NULL)) cd ON true
         LEFT JOIN LATERAL (SELECT bool_or(v.systemic_illness ILIKE '%DIABET%') AS dm FROM clinical.visit v
                             WHERE v.patient_id = fc.patient_id AND v.status_id = 3) dm ON true
         -- ROP list: the latest completed ROP visit (booked as ROP clinic / screening, or ROP findings) was in the last 12 months
         -- and did not find a mature retina. A mature retina ends ROP screening, so the baby leaves the ROP group.
         LEFT JOIN LATERAL (SELECT (current_date - v.visit_date) AS days,
                                   (v.visit_date >= current_date - 365
                                    AND NOT EXISTS (SELECT 1 FROM clinical.visit_exam_finding m WHERE m.visit_id = v.visit_id AND m.finding ~* 'mature retina')) AS active
                              FROM clinical.visit v
                             WHERE v.patient_id = fc.patient_id AND v.status_id = 3
                               AND (v.reason ~* '\\mrop\\M'
                                    OR EXISTS (SELECT 1 FROM clinical.visit_exam_finding e WHERE e.visit_id = v.visit_id
                                                AND e.finding ~* '\\mrop\\M|prematur|plus disease|\\mzone\\M|mature retina'))
                             ORDER BY v.visit_date DESC, v.visit_id DESC LIMIT 1) rp ON true
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
        ORDER BY fc.due_date DESC
        LIMIT 5000`, [f.view === "upcoming" ? f.upcomingDays : f.maxOverdueDays]);

    const ranked = rows.filter((r) => f.view !== "to_call" || r.rop || (r.daysOverdue ?? 0) <= f.maxOverdueDays).map((r) => {
      const inj = r.inj_days != null ? [drugName(r.last_proc, r.last_drug), r.last_eye, r.last_n ? ordinal(r.last_n) : null].filter(Boolean).join(" ") : null;
      const las = r.las_days != null ? [titleWords(r.las_what), r.las_eye].filter(Boolean).join(" ") : null;
      const risk = { ageYears: r.ageYears, condition: r.condition, lastInjectionDays: r.inj_days, lastInjection: inj,
                     lastLaserDays: r.las_days, lastLaser: las, diabetes: r.diabetes, rop: r.rop, ropDays: r.rop_days };
      const { tier, reasons } = riskTier(risk);
      const { inj_days, last_proc, last_drug, last_eye, last_n, las_days, las_what, las_eye, rop, rop_days, ...out } = r;
      return { ...out, tier, groups: groupsFor(risk), reasons };
    });
    // A card is a team's list. A patient can be on several cards, so the card numbers are not added up: `total` counts each patient once.
    const groups = GROUPS.map((g) => {
      const inG = ranked.filter((r) => r.groups.includes(g.key));
      return { key: g.key, label: g.label, rule: g.rule, count: inG.length, notCalled: inG.filter((r) => !r.lastAction).length };
    });
    const shown = f.group ? ranked.filter((r) => r.groups.includes(f.group!)) : ranked;
    // ROP: the longest overdue baby first. Others: the most recently overdue first (most likely to return).
    shown.sort(f.view === "upcoming"
      ? (a, b) => a.dueDate.localeCompare(b.dueDate) || a.tier - b.tier
      : f.group === "rop" ? (a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0)
      : (a, b) => a.tier - b.tier || (a.daysOverdue ?? 0) - (b.daysOverdue ?? 0));
    const recovered = await one<{ n: number }>(
      `SELECT count(DISTINCT a.patient_id)::int AS n FROM app.followup_actions a
        WHERE a.at >= now() - interval '60 days' AND a.actor_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM yarago.tblappointments v WHERE v.npatient_id = a.patient_id AND v.nstatus_id = 3
                        AND v.tappoint_date_time > a.at AND v.tappoint_date_time >= now() - interval '30 days')`);
    return { followups: shown.slice(0, f.limit), groups,
             total: ranked.length, cameBackAfterCall30d: recovered?.n ?? 0 };
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
