// Fundus photographs and the doctor's fundus report (D-042). A session = one patient's Remidio photographs of one exam
// (one day). Clinical roles read (clinical.read); doctors write and correct (fundus.report). The research AI grade is
// never part of these answers. Writing a report also records its DR grades as the doctor's blinded grades for the
// Retina AI agreement figures (services/fundusReport.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { conflict, notFound } from "../lib/errors.js";
import { dateStr, niceDate } from "../lib/time.js";
import { DME, DR, FINDINGS, REFERRAL, reportLine, syncReportGrades } from "../services/fundusReport.js";

// sessions = linked photographs grouped by patient, day (clinic time) and Remidio exam; joined to their report. Maestro2
// photographs (D-048) have no Remidio exam: one patient's Maestro2 photographs of a day are session 0 of that day.
const WITH_SESSIONS = `
  WITH s AS (
    SELECT f.patient_id, (coalesce(f.captured_at, f.received_at) AT TIME ZONE 'Asia/Kolkata')::date AS exam_date,
           coalesce(f.remidio_exam_id, 0) AS exam_key,
           array_agg(f.id ORDER BY f.eye NULLS LAST, f.captured_at) AS photo_ids, count(*)::int AS photos,
           max(coalesce(f.captured_at, f.received_at)) AS last_at, bool_or(f.quality = 'INSUFFICIENT') AS any_poor,
           array_agg(DISTINCT f.source) AS sources, bool_and(f.source = 'topcon') AS topcon_only
      FROM app.fundus_photos f WHERE f.patient_id IS NOT NULL GROUP BY 1, 2, 3)`;
const FROM_SESSIONS = `
    FROM s JOIN clinical.patient p ON p.patient_id = s.patient_id
    LEFT JOIN app.fundus_reports r ON r.patient_id = s.patient_id AND r.exam_date = s.exam_date AND coalesce(r.remidio_exam_id, 0) = s.exam_key
    LEFT JOIN app.users ru ON ru.id = r.reported_by`;
// "To report": no report yet, leaving out Maestro2 sessions from before retina.topcon_report_from (IMAGEnet's past exams,
// D-049): they stay under All and on the patient page
const TODO = `r.id IS NULL AND NOT (s.topcon_only AND s.exam_date < coalesce(
  (SELECT (value #>> '{}')::date FROM app.settings WHERE key = 'retina.topcon_report_from'), '-infinity'::date))`;
const SESSIONS = `${WITH_SESSIONS}
  SELECT s.patient_id AS "patientId", to_char(s.exam_date, 'YYYY-MM-DD') AS "examDate", s.exam_key AS "examKey",
         s.photo_ids AS "photoIds", s.photos, s.last_at AS "lastAt", s.any_poor AS "anyPoor", s.sources,
         -- the day's Maestro2 OCT / OCTA scans of a Maestro2 session (D-049), for the list's tags
         (SELECT count(*)::int FROM app.oct_studies o WHERE 'topcon' = ANY(s.sources) AND o.patient_id = s.patient_id
             AND (coalesce(o.captured_at, o.received_at) AT TIME ZONE 'Asia/Kolkata')::date = s.exam_date) AS "octScans",
         (SELECT count(*)::int FROM app.oct_studies o WHERE 'topcon' = ANY(s.sources) AND o.patient_id = s.patient_id AND o.kind = 'octa'
             AND (coalesce(o.captured_at, o.received_at) AT TIME ZONE 'Asia/Kolkata')::date = s.exam_date) AS "octaScans",
         p.mrd, p.name AS "patientName", p.age_years AS "ageYears", p.sex,
         r.id AS "reportId", r.re_dr, r.le_dr, r.referral, r.reported_at AS "reportedAt", ru.full_name AS "reportedBy",
         r.amended_at AS "amendedAt"
  ${FROM_SESSIONS}`;

const choice = <T extends Record<string, string>>(o: T) => z.enum(Object.keys(o) as [keyof T & string, ...(keyof T & string)[]]);
const eyeBody = z.object({
  dr: choice(DR).nullable(), dme: choice(DME).nullable().default(null),
  findings: z.array(choice(FINDINGS)).max(5).default([]), other: z.string().trim().max(300).default(""),
}).refine((e) => !e.findings.includes("other") || e.other.length > 0, { message: "Say what the other finding is" });
const reportBody = z.object({ re: eyeBody, le: eyeBody, referral: choice(REFERRAL), comments: z.string().trim().max(2000).default("") })
  .refine((b) => b.re.dr || b.le.dr, { message: "Give the DR grade of at least one eye" });

export async function fundusRoutes(app: FastifyInstance) {
  // Sessions of photographs: to report (no report yet), reported, or all; newest first.
  app.get("/api/fundus/sessions", async (req) => {
    need(req, "clinical.read");
    const f = z.object({ status: z.enum(["todo", "reported", "all"]).default("todo"), patientId: z.coerce.number().int().positive().optional(),
                         q: z.string().trim().max(60).optional() }).parse(req.query);
    const params: unknown[] = []; const where: string[] = [];
    if (f.status === "todo") where.push(TODO);
    if (f.status === "reported") where.push("r.id IS NOT NULL");
    if (f.patientId) { params.push(f.patientId); where.push(`s.patient_id = $${params.length}`); }
    if (f.q) { params.push(f.q); where.push(`(p.mrd ILIKE $${params.length} || '%' OR p.name ILIKE '%' || $${params.length} || '%')`); }
    const rows = await q<any>(`${SESSIONS} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.last_at DESC LIMIT 300`, params);
    const todo = (await one<{ n: number }>(`${WITH_SESSIONS} SELECT count(*)::int AS n ${FROM_SESSIONS} WHERE ${TODO}`))?.n ?? 0;
    return { sessions: rows.map(({ re_dr, le_dr, referral, ...s }) => ({ ...s, summary: s.reportId ? reportLine({ re_dr, le_dr, referral }) : null })), todo };
  });

  // One session: its photographs and its report (if any).
  app.get("/api/fundus/session", async (req) => {
    need(req, "clinical.read");
    const k = z.object({ patientId: z.coerce.number().int().positive(), examDate: dateStr, examKey: z.coerce.number().int().min(0) }).parse(req.query);
    const s = await one<any>(`${SESSIONS} WHERE s.patient_id = $1 AND s.exam_date = $2 AND s.exam_key = $3`, [k.patientId, k.examDate, k.examKey]);
    if (!s) throw notFound("Photo session");
    const photos = await q(`SELECT id, eye, field, quality, captured_at AS "capturedAt", width, height, source, device, protocol
                              FROM app.fundus_photos WHERE id = ANY($1)
                             ORDER BY eye NULLS LAST, captured_at`, [s.photoIds]);
    const report = s.reportId ? await one(
      `SELECT r.id, r.re_dr AS "reDr", r.le_dr AS "leDr", r.re_dme AS "reDme", r.le_dme AS "leDme", r.re_findings AS "reFindings",
              r.le_findings AS "leFindings", r.re_other AS "reOther", r.le_other AS "leOther", r.referral, r.comments,
              r.reported_at AS "reportedAt", ru.full_name AS "reportedBy", r.amended_at AS "amendedAt", au.full_name AS "amendedBy",
              r.amendment_reason AS "amendmentReason"
         FROM app.fundus_reports r JOIN app.users ru ON ru.id = r.reported_by LEFT JOIN app.users au ON au.id = r.amended_by
        WHERE r.id = $1`, [s.reportId]) : null;
    return { session: { ...s, re_dr: undefined, le_dr: undefined }, photos, report, words: { DR, DME, FINDINGS, REFERRAL } };
  });

  // Write the report of a session (doctors).
  app.post("/api/fundus/reports", async (req) => {
    const me = need(req, "fundus.report");
    const k = z.object({ patientId: z.number().int().positive(), examDate: dateStr, examKey: z.number().int().min(0) }).parse(req.body);
    const b = reportBody.parse(req.body);
    const s = await one<any>(`${SESSIONS} WHERE s.patient_id = $1 AND s.exam_date = $2 AND s.exam_key = $3`, [k.patientId, k.examDate, k.examKey]);
    if (!s) throw notFound("Photo session");
    if (s.reportId) throw conflict("This session already has a report. Open it and correct it instead.");
    const id = await withTx(auditCtx(req, `Wrote the fundus report of ${s.patientName} (${s.mrd}), photographs of ${niceDate(k.examDate)}`), async (c) => {
      const rid = Number((await c.query(
        `INSERT INTO app.fundus_reports (patient_id, exam_date, remidio_exam_id, photo_ids, re_dr, le_dr, re_dme, le_dme, re_findings, le_findings,
                                         re_other, le_other, referral, comments, reported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [k.patientId, k.examDate, k.examKey || null, s.photoIds, b.re.dr, b.le.dr, b.re.dme, b.le.dme, b.re.findings, b.le.findings,
         b.re.other, b.le.other, b.referral, b.comments, me.id])).rows[0].id);
      await syncReportGrades(c, rid);
      return rid;
    });
    return { ok: true, id };
  });

  // Correct a report (doctors); the reason is required and kept with every version in the activity log.
  app.put("/api/fundus/reports/:id", async (req) => {
    const me = need(req, "fundus.report");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = reportBody.parse(req.body);
    const { reason } = z.object({ reason: z.string().trim().min(5, "Say why the report is corrected (at least a few words)").max(500) }).parse(req.body);
    const r = await one<any>(`SELECT r.id, p.name, p.mrd, r.exam_date FROM app.fundus_reports r JOIN clinical.patient p ON p.patient_id = r.patient_id WHERE r.id = $1`, [id]);
    if (!r) throw notFound("Fundus report");
    await withTx(auditCtx(req, `Corrected the fundus report of ${r.name} (${r.mrd}), photographs of ${niceDate(r.exam_date)}: ${reason}`), async (c) => {
      await c.query(
        `UPDATE app.fundus_reports SET re_dr = $2, le_dr = $3, re_dme = $4, le_dme = $5, re_findings = $6, le_findings = $7, re_other = $8,
                le_other = $9, referral = $10, comments = $11, amended_by = $12, amended_at = now(), amendment_reason = $13 WHERE id = $1`,
        [id, b.re.dr, b.le.dr, b.re.dme, b.le.dme, b.re.findings, b.le.findings, b.re.other, b.le.other, b.referral, b.comments, me.id, reason]);
      await syncReportGrades(c, id);
    });
    return { ok: true };
  });

  // The reports' choices in plain words (for the form).
  app.get("/api/fundus/words", async (req) => { need(req, "clinical.read"); return { DR, DME, FINDINGS, REFERRAL }; });
}
