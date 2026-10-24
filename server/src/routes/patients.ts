// Patients come from the Yarago mirror (read only). Front desk sees demographics, visits, dues and
// follow-ups; clinical detail (vision, IOP, diagnosis, findings, injections) needs clinical.read.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { one, q } from "../db.js";
import { notFound } from "../lib/errors.js";
import { can } from "../lib/permissions.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function patientRoutes(app: FastifyInstance) {
  app.get("/api/patients/search", async (req) => {
    need(req, "patients.read");
    const { q: text } = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query);
    const digits = text.replace(/\D/g, "");
    const isPhone = digits.length >= 6 && digits.length === text.replace(/[\s+-]/g, "").length;
    // MRDs are SPD + 1-5 digits: "12345", "spd12345" and "SPD 12345" all look for SPD12345 (exact first, then SPD123456...)
    const mrdNumber = /^(spd)?\s*\d{1,5}$/i.test(text) ? `SPD${digits}` : null;
    const params: unknown[] = [mrdNumber ?? text.toUpperCase(), text, isPhone ? digits.slice(-10) : null];
    const rows = await q(
      `SELECT p.patient_id AS "patientId", p.mrd, p.name, p.age_years AS "ageYears", p.age_text AS "ageText", p.sex, p.mobile,
              (SELECT max(v.tappoint_date_time)::date FROM yarago.tblappointments v
                WHERE v.npatient_id = p.patient_id AND v.nstatus_id <> 4) AS "lastVisit",
              CASE WHEN upper(p.mrd) = $1 THEN 0 WHEN upper(p.mrd) LIKE $1 || '%' THEN 1
                   WHEN $3::text IS NOT NULL AND p.mobile LIKE '%' || $3 THEN 2 ELSE 3 END AS rank
         FROM clinical.patient p
        WHERE upper(p.mrd) LIKE $1 || '%'
           OR ($3::text IS NOT NULL AND p.mobile LIKE '%' || $3)
           OR ($3::text IS NULL AND ${mrdNumber ? "$2::text IS NULL" : "p.name ILIKE '%' || $2 || '%'"})
        ORDER BY rank, "lastVisit" DESC NULLS LAST, p.name
        LIMIT 25`, params);
    return { patients: rows.map(({ rank, ...r }: any) => r) };
  });

  app.get("/api/patients/:id", async (req) => {
    const me = need(req, "patients.read");
    const { id } = idParam.parse(req.params);
    const patient = await one(
      `SELECT patient_id AS "patientId", mrd, name, to_char(dob,'YYYY-MM-DD') AS dob, age_years AS "ageYears", age_text AS "ageText", sex, mobile,
              language, vip_category AS "vipCategory", registered_at AS "registeredAt"
         FROM clinical.patient WHERE patient_id = $1`, [id]);
    if (!patient) throw notFound("Patient");
    const clinical = can(me.role, "clinical.read");

    const [visits, due, followup, followupActions, appointments] = await Promise.all([
      q(`SELECT visit_id AS "visitId", to_char(visit_date,'YYYY-MM-DD') AS date, visit_type AS "visitType", doctor, status,
                ${clinical ? `diagnosis, bcva_re AS "bcvaRe", bcva_le AS "bcvaLe", iop_re AS "iopRe", iop_le AS "iopLe",` : ""}
                to_char(followup_date,'YYYY-MM-DD') AS "followupDate"
           FROM clinical.visit WHERE patient_id = $1 ORDER BY visit_at DESC LIMIT 50`, [id]),
      one(`SELECT due_total AS "dueTotal", due_opd AS "dueOpd", due_pharmacy AS "duePharmacy", due_optical AS "dueOptical",
                  due_ipd AS "dueIpd", clinic_owes_patient AS "clinicOwesPatient"
             FROM clinical.patient_due WHERE patient_id = $1`, [id]),
      one(`SELECT followup_id AS "followupId", to_char(due_date,'YYYY-MM-DD') AS "dueDate", status, followup_state AS state,
                  days_overdue AS "daysOverdue", came_back AS "cameBack", comments
             FROM clinical.followup_current WHERE patient_id = $1`, [id]),
      q(`SELECT f.at, f.action, f.note, to_char(f.next_call_on,'YYYY-MM-DD') AS "nextCallOn", coalesce(u.full_name, f.actor_name) AS "by"
           FROM app.followup_actions f LEFT JOIN app.users u ON u.id = f.actor_id
          WHERE f.patient_id = $1 ORDER BY f.at DESC LIMIT 20`, [id]),
      q(`SELECT a.id, to_char(a.appointment_date,'YYYY-MM-DD') AS date, to_char(a.slot_time,'HH24:MI') AS "slotTime",
                a.status, a.plan_of_action AS "planOfAction", d.name AS "doctorName", a.remarks
           FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id
          WHERE a.patient_id = $1 ORDER BY a.appointment_date DESC, a.slot_time DESC NULLS LAST LIMIT 30`, [id]),
    ]);

    const result: Record<string, unknown> = { patient, visits, due, followup, followupActions, appointments, clinicalAccess: clinical };
    if (clinical) {
      const [trend, injections, lasers, latest] = await Promise.all([
        q(`SELECT to_char(visit_date,'YYYY-MM-DD') AS date, bcva_re AS "bcvaRe", bcva_le AS "bcvaLe",
                  bcva_logmar_re AS "logmarRe", bcva_logmar_le AS "logmarLe", iop_re AS "iopRe", iop_le AS "iopLe"
             FROM clinical.va_iop_trend WHERE patient_id = $1 ORDER BY visit_date DESC LIMIT 24`, [id]),
        q(`SELECT injection_id AS "injectionId", to_char(treated_at,'YYYY-MM-DD') AS date, drug, procedure, eye, given,
                  injection_number_for_eye AS "numberForEye", remarks
             FROM clinical.injection WHERE patient_id = $1 ORDER BY treated_at DESC NULLS LAST LIMIT 40`, [id]),
        q(`SELECT laser_id AS "laserId", to_char(treated_at,'YYYY-MM-DD') AS date, eye, done, remarks
             FROM clinical.laser WHERE patient_id = $1 ORDER BY treated_at DESC NULLS LAST LIMIT 20`, [id]),
        one(`SELECT visit_id AS "visitId" FROM clinical.visit WHERE patient_id = $1 AND status_id = 3 ORDER BY visit_at DESC LIMIT 1`, [id]),
      ]);
      Object.assign(result, { trend: trend.reverse(), injections, lasers, latestVisitId: (latest as any)?.visitId ?? null });
    }
    return result;
  });

  // Full detail of one visit (doctor view)
  app.get("/api/patients/:id/visits/:visitId", async (req) => {
    need(req, "clinical.read");
    const p = z.object({ id: z.coerce.number().int().positive(), visitId: z.coerce.number().int().positive() }).parse(req.params);
    const visit = await one(`SELECT * FROM clinical.visit WHERE visit_id = $1 AND patient_id = $2`, [p.visitId, p.id]);
    if (!visit) throw notFound("Visit");
    const [findings, timeline] = await Promise.all([
      q(`SELECT eye_part AS "eyePart", finding, eye FROM clinical.visit_exam_finding WHERE visit_id = $1 ORDER BY position`, [p.visitId]),
      one(`SELECT * FROM clinical.visit_timeline WHERE visit_id = $1`, [p.visitId]),
    ]);
    return { visit, findings, timeline };
  });
}
