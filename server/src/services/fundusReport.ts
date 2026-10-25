// The doctor's fundus report (D-042): the words for each choice, and the link to the Retina AI agreement figures. The
// report's DR grade per eye is the reporting doctor's grade of that eye's photographs in app.dr_doctor_grades, "blinded"
// when that doctor had not been shown the AI grade of the photograph before (app.dr_grading_views). The report form never
// shows the AI grade. Runs inside the caller's transaction.
import type pg from "pg";

export const DR = { none: "No DR", mild: "Mild NPDR", moderate: "Moderate NPDR", severe: "Severe NPDR", pdr: "Proliferative DR", ungradable: "Cannot be graded" } as const;
export const DME = { none: "No macular oedema", non_centre: "Macular oedema, not centre-involving", centre: "Centre-involving macular oedema", ungradable: "Macula cannot be assessed" } as const;
export const FINDINGS = { glaucoma_suspect: "Glaucoma suspect (disc)", drusen_amd: "Drusen / AMD", hypertensive: "Hypertensive retinopathy", vein_occlusion: "Vein occlusion", other: "Other" } as const;
export const REFERRAL = { none: "No referral", routine: "Refer, routine", urgent: "Refer, urgent" } as const;
export type DrChoice = keyof typeof DR;

/** DR choice as the 0-4 scale of the AI grader; null = cannot be graded. */
export function drNumber(dr: DrChoice): number | null {
  return { none: 0, mild: 1, moderate: 2, severe: 3, pdr: 4, ungradable: null }[dr];
}

/** One line for lists: "RE Moderate NPDR, LE No DR; refer urgent". */
export function reportLine(r: { re_dr: DrChoice | null; le_dr: DrChoice | null; referral: keyof typeof REFERRAL }): string {
  const eyes = [r.re_dr && `RE ${DR[r.re_dr]}`, r.le_dr && `LE ${DR[r.le_dr]}`].filter(Boolean).join(", ");
  return `${eyes}${r.referral !== "none" ? `; ${REFERRAL[r.referral].toLowerCase()}` : ""}`;
}

/** Write the report's grades as the doctor's grades of its photographs' AI gradings (one per doctor per photograph;
 *  a correction replaces that doctor's grade). Photographs not graded by the AI yet are picked up by gradeNewPhotos. */
export async function syncReportGrades(c: pg.PoolClient, reportId: number): Promise<number> {
  const r = (await c.query(`SELECT id, patient_id, photo_ids, re_dr, le_dr, coalesce(amended_by, reported_by) AS doctor
                              FROM app.fundus_reports WHERE id = $1`, [reportId])).rows[0];
  if (!r) return 0;
  const gradings = (await c.query(
    `SELECT g.id, f.eye FROM app.dr_gradings g JOIN app.fundus_photos f ON f.id = g.photo_id
      WHERE g.photo_id = ANY($1) AND g.status = 'ok'`, [r.photo_ids])).rows;
  let n = 0;
  for (const g of gradings) {
    const dr: DrChoice | null = g.eye === "RE" ? r.re_dr : g.eye === "LE" ? r.le_dr : null;
    if (!dr) continue;
    const grade = drNumber(dr);
    await c.query(
      `INSERT INTO app.dr_doctor_grades (grading_id, patient_id, graded_by, grade, ungradable, note, blinded)
       VALUES ($1, $2, $3, $4, $5, $6, NOT EXISTS (SELECT 1 FROM app.dr_grading_views v WHERE v.grading_id = $1 AND v.user_id = $3))
       ON CONFLICT (grading_id, graded_by) DO UPDATE
         SET grade = EXCLUDED.grade, ungradable = EXCLUDED.ungradable, note = EXCLUDED.note, blinded = EXCLUDED.blinded`,
      [g.id, r.patient_id, r.doctor, grade, grade === null, `from fundus report #${r.id}`]);
    n++;
  }
  return n;
}

/** After the AI grades a photograph: if a report already covers it, add that report's grade (gradeNewPhotos). */
export async function syncGradesForPhoto(c: pg.PoolClient, photoId: number): Promise<void> {
  const reports = (await c.query(`SELECT id FROM app.fundus_reports WHERE $1 = ANY(photo_ids)`, [photoId])).rows;
  for (const r of reports) await syncReportGrades(c, Number(r.id));
}
