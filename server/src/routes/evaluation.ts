// Retina AI evaluation sets (D-043). A set = Remidio photographs with the doctor's grade of that eye from the fundus
// report (D-042), copied in when the set is made; frozen sets never change. Results are computed per model (each
// model's AI gradings of the same photographs) with patient-level bootstrap intervals. Reading needs retina_ai.use;
// making, freezing and discarding sets also settings.manage (admin). Results and the report are aggregates; the CSV has
// one row per image with codes instead of names, MRDs or dates, and its AI grades are logged as shown to the exporter.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { APP_ROOT } from "../config.js";
import { one, q, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";
import { evaluate, reportMarkdown, toCsv, type EvalRow } from "../services/evaluation.js";

const DR_NUMBER: Record<string, number> = { none: 0, mild: 1, moderate: 2, severe: 3, pdr: 4 };
const criteriaBody = z.object({
  from: dateStr.optional(), to: dateStr.optional(),
  blindedOnly: z.boolean().default(true),            // only grades given before that doctor saw the AI grade
  excludePoor: z.boolean().default(false),           // leave out photographs Remidio marked INSUFFICIENT
  maculaOnly: z.boolean().default(false),            // only macula-centred photographs (the model was trained on these)
});
type Criteria = z.infer<typeof criteriaBody>;

/** Photographs that can go into a set: linked, with an eye, in a fundus report that grades that eye. */
async function candidates(c: Criteria) {
  const rows = await q<any>(
    `SELECT f.id AS photo_id, f.patient_id, f.eye, f.field, f.quality, f.captured_at,
            CASE WHEN f.eye = 'RE' THEN r.re_dr ELSE r.le_dr END AS dr, r.id AS report_id,
            coalesce(r.amended_by, r.reported_by) AS doctor,
            NOT EXISTS (SELECT 1 FROM app.dr_grading_views v JOIN app.dr_gradings g ON g.id = v.grading_id
                         WHERE g.photo_id = f.id AND v.user_id = coalesce(r.amended_by, r.reported_by)
                           AND v.viewed_at <= coalesce(r.amended_at, r.reported_at)) AS blinded
       FROM app.fundus_photos f JOIN app.fundus_reports r ON f.id = ANY(r.photo_ids)
      WHERE f.patient_id IS NOT NULL AND f.eye IS NOT NULL
        AND (CASE WHEN f.eye = 'RE' THEN r.re_dr ELSE r.le_dr END) IS NOT NULL
        AND ($1::date IS NULL OR (coalesce(f.captured_at, f.received_at) AT TIME ZONE 'Asia/Kolkata')::date >= $1::date)
        AND ($2::date IS NULL OR (coalesce(f.captured_at, f.received_at) AT TIME ZONE 'Asia/Kolkata')::date <= $2::date)
      ORDER BY f.patient_id, f.eye, f.captured_at, f.id`, [c.from ?? null, c.to ?? null]);
  const left = { notBlinded: 0, poorQuality: 0, notMacula: 0 };
  const kept = rows.filter((r) => {
    if (c.blindedOnly && !r.blinded) { left.notBlinded++; return false; }
    if (c.excludePoor && r.quality === "INSUFFICIENT") { left.poorQuality++; return false; }
    if (c.maculaOnly && r.field !== "MACULA") { left.notMacula++; return false; }
    return true;
  });
  return { kept, left };
}

function summary(rows: { dr: string; patient_id: number }[]) {
  const byGrade = [0, 1, 2, 3, 4].map((g) => rows.filter((r) => DR_NUMBER[r.dr] === g).length);
  return { images: rows.length, patients: new Set(rows.map((r) => r.patient_id)).size, byGrade,
           ungradable: rows.filter((r) => r.dr === "ungradable").length, referable: byGrade[2] + byGrade[3] + byGrade[4] };
}

async function sudarshanCommit(): Promise<string> {
  try { return (await promisify(execFile)("git", ["-c", "safe.directory=*", "-C", APP_ROOT, "rev-parse", "--short", "HEAD"])).stdout.trim(); }
  catch { return "unknown"; }
}

/** The set's images joined to one model's gradings (model = its SHA-256), as evaluation rows. */
async function modelRows(setId: number, model: string) {
  const items = await q<any>(
    `SELECT i.image_code, i.patient_code, i.eye, i.reference_grade, i.reference_ungradable, f.field, f.quality,
            to_char(coalesce(f.captured_at, f.received_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
            g.id AS grading_id, g.status, g.ai_grade, g.probs, g.created_at AS graded_at
       FROM app.eval_set_items i JOIN app.fundus_photos f ON f.id = i.photo_id
       LEFT JOIN app.dr_gradings g ON g.photo_id = i.photo_id AND g.model_sha256 = $2
      WHERE i.set_id = $1 ORDER BY i.image_code`, [setId, model]);
  const graded = items.filter((x) => !x.reference_ungradable && x.status === "ok");
  const rows: EvalRow[] = graded.map((x) => ({ cluster: x.patient_code, ref: x.reference_grade, pred: x.ai_grade, probs: x.probs }));
  return { items, rows, ungradable: items.filter((x) => x.reference_ungradable).length,
           notGraded: items.filter((x) => !x.reference_ungradable && x.status !== "ok").length };
}

async function loadSet(id: number) {
  const s = await one<any>(
    `SELECT s.id, s.name, s.notes, s.criteria, s.created_at AS "createdAt", s.frozen_at AS "frozenAt", cu.full_name AS "createdBy",
            fu.full_name AS "frozenBy", (SELECT count(*)::int FROM app.eval_set_items i WHERE i.set_id = s.id) AS images,
            (SELECT count(DISTINCT patient_id)::int FROM app.eval_set_items i WHERE i.set_id = s.id) AS patients
       FROM app.eval_sets s JOIN app.users cu ON cu.id = s.created_by LEFT JOIN app.users fu ON fu.id = s.frozen_by WHERE s.id = $1`, [id]);
  if (!s) throw notFound("Evaluation set");
  return s;
}

async function modelsOf(setId: number) {
  return q<any>(
    `SELECT g.model_sha256 AS sha, max(g.model_repo) AS repo, max(g.model_commit) AS commit, max(g.grader_version) AS version,
            max(g.calibration) AS calibration, count(*) FILTER (WHERE g.status = 'ok')::int AS graded
       FROM app.eval_set_items i JOIN app.dr_gradings g ON g.photo_id = i.photo_id
      WHERE i.set_id = $1 AND g.model_sha256 IS NOT NULL GROUP BY g.model_sha256 ORDER BY max(g.created_at)`, [setId]);
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const modelQuery = z.object({ model: z.string().regex(/^[0-9a-f]{16,64}$/i, "Choose a model").optional() });

export async function evaluationRoutes(app: FastifyInstance) {
  // How many photographs a set with these rules would hold (nothing saved).
  app.get("/api/retina-ai/eval/candidates", async (req) => {
    need(req, "retina_ai.use");
    const qy = req.query as Record<string, string>;
    const c = criteriaBody.parse({ from: qy.from || undefined, to: qy.to || undefined, blindedOnly: qy.blindedOnly !== "false",
                                   excludePoor: qy.excludePoor === "true", maculaOnly: qy.maculaOnly === "true" });
    const { kept, left } = await candidates(c);
    return { ...summary(kept), left };
  });

  app.get("/api/retina-ai/eval/sets", async (req) => {
    need(req, "retina_ai.use");
    const sets = await q(
      `SELECT s.id, s.name, s.notes, s.criteria, s.created_at AS "createdAt", s.frozen_at AS "frozenAt",
              (SELECT count(*)::int FROM app.eval_set_items i WHERE i.set_id = s.id) AS images,
              (SELECT count(DISTINCT patient_id)::int FROM app.eval_set_items i WHERE i.set_id = s.id) AS patients
         FROM app.eval_sets s ORDER BY s.created_at DESC`);
    return { sets };
  });

  // Make a draft set from the rules: copies each photograph's reference grade now.
  app.post("/api/retina-ai/eval/sets", async (req) => {
    const me = need(req, "retina_ai.use"); need(req, "settings.manage");
    const b = z.object({ name: z.string().trim().min(3, "Give the set a name").max(80), notes: z.string().trim().max(1000).default("") }).parse(req.body);
    const c = criteriaBody.parse(req.body);
    if (await one(`SELECT 1 FROM app.eval_sets WHERE name = $1`, [b.name])) throw conflict("A set with that name exists already");
    const { kept, left } = await candidates(c);
    if (!kept.length) throw badRequest("No photographs match these rules yet: they need a fundus report that grades the eye.");
    const codes = new Map<number, string>();
    for (const r of kept) if (!codes.has(Number(r.patient_id))) codes.set(Number(r.patient_id), `P${String(codes.size + 1).padStart(3, "0")}`);
    const seq = new Map<string, number>();
    const id = await withTx(auditCtx(req, `Made evaluation set "${b.name}" (draft, ${kept.length} images of ${codes.size} patients)`), async (cx) => {
      const sid = Number((await cx.query(`INSERT INTO app.eval_sets (name, notes, criteria, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [b.name, b.notes, { ...c, left }, me.id])).rows[0].id);
      for (const r of kept) {
        const pc = codes.get(Number(r.patient_id))!, k = `${pc}-${r.eye}`;
        seq.set(k, (seq.get(k) ?? 0) + 1);
        await cx.query(
          `INSERT INTO app.eval_set_items (set_id, photo_id, patient_id, patient_code, image_code, eye, reference_grade, reference_ungradable,
                                           reference_blinded, reference_report_id, reference_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [sid, r.photo_id, r.patient_id, pc, `${k}-${String(seq.get(k)).padStart(2, "0")}`, r.eye, DR_NUMBER[r.dr] ?? null,
           r.dr === "ungradable", r.blinded, r.report_id, r.doctor]);
      }
      return sid;
    });
    return { id, ...summary(kept), left };
  });

  app.post("/api/retina-ai/eval/sets/:id/freeze", async (req) => {
    const me = need(req, "retina_ai.use"); need(req, "settings.manage");
    const { id } = idParam.parse(req.params);
    const s = await loadSet(id);
    if (s.frozenAt) throw conflict("This set is frozen already");
    await withTx(auditCtx(req, `Froze evaluation set "${s.name}" (${s.images} images): it can no longer change`), (c) =>
      c.query(`UPDATE app.eval_sets SET frozen_at = now(), frozen_by = $2 WHERE id = $1`, [id, me.id]));
    return { ok: true };
  });

  app.delete("/api/retina-ai/eval/sets/:id", async (req) => {
    need(req, "retina_ai.use"); need(req, "settings.manage");
    const { id } = idParam.parse(req.params);
    const s = await loadSet(id);
    if (s.frozenAt) throw conflict("A frozen set is kept for good");
    await withTx(auditCtx(req, `Discarded draft evaluation set "${s.name}"`), async (c) => {
      await c.query(`DELETE FROM app.eval_set_items WHERE set_id = $1`, [id]);
      await c.query(`DELETE FROM app.eval_sets WHERE id = $1`, [id]);
    });
    return { ok: true };
  });

  // Results of every model that graded the set's photographs (aggregates only).
  app.get("/api/retina-ai/eval/sets/:id/results", async (req) => {
    need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const set = await loadSet(id);
    const ref = await one<any>(`SELECT count(*) FILTER (WHERE reference_ungradable)::int AS ungradable,
                                       count(*) FILTER (WHERE NOT reference_blinded)::int AS "notBlinded",
                                       array_agg(reference_grade) FILTER (WHERE NOT reference_ungradable) AS grades
                                  FROM app.eval_set_items WHERE set_id = $1`, [id]);
    const models = [];
    for (const m of await modelsOf(id)) {
      const r = await modelRows(id, m.sha);
      models.push({ ...m, notGraded: r.notGraded, evaluation: evaluate(r.rows, r.ungradable) });
    }
    return { set, reference: { ungradable: ref.ungradable, notBlinded: ref.notBlinded,
                               byGrade: [0, 1, 2, 3, 4].map((g) => (ref.grades ?? []).filter((x: number) => x === g).length) }, models };
  });

  // The written report (Markdown) of one model on the set.
  app.get("/api/retina-ai/eval/sets/:id/report.md", async (req, reply) => {
    need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const { model } = modelQuery.parse(req.query);
    const set = await loadSet(id);
    const m = (await modelsOf(id)).find((x) => !model || x.sha === model);
    if (!m) throw notFound("Model grades for this set");
    const r = await modelRows(id, m.sha);
    const c = set.criteria;
    const md = reportMarkdown({
      title: `Retina AI evaluation: ${m.repo ?? "model"} on "${set.name}"`,
      dataset: [
        `Set "${set.name}" (#${set.id}), ${set.frozenAt ? `frozen ${new Date(set.frozenAt).toISOString().slice(0, 10)} by ${set.frozenBy}` : "**DRAFT (not frozen): figures may change**"}.`,
        `${set.images} eye images of ${set.patients} patients from the Remidio FOP at Sampada VR, Tirur.`,
        `Reference: the doctor's DR grade of that eye in the Sudarshan fundus report (D-042), copied into the set when it was made${c.blindedOnly ? "; only grades given before that doctor saw the AI grade" : "; includes grades given after seeing the AI grade"}.`,
        `Rules: photographs ${c.from ?? "from the start"} to ${c.to ?? "the day the set was made"}; ${c.excludePoor ? "Remidio-insufficient quality left out" : "all qualities"}; ${c.maculaOnly ? "macula-centred only" : "all fields"}.`,
        ...(r.notGraded ? [`${r.notGraded} image(s) without a grade from this model are left out.`] : []),
        ...(set.notes ? [`Notes: ${set.notes}`] : []),
      ],
      model: [`${m.repo ?? "unknown"}, commit ${m.commit ?? "unknown"}, weights SHA-256 ${m.sha}`, `grader ${m.version ?? "unknown"}, output ${m.calibration ?? "unknown"}`,
              `${m.graded} images graded by this model`],
      reproducibility: [`Sudarshan ${await sudarshanCommit()}; report made ${new Date().toISOString()}.`,
                        "Ungradable references are counted and left out of every figure."],
    }, evaluate(r.rows, r.ungradable));
    return reply.header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="retina-eval-set${id}-${m.sha.slice(0, 12)}.md"`).send(md);
  });

  // One row per image, without names, MRDs or dates (codes and month only).
  app.get("/api/retina-ai/eval/sets/:id/export.csv", async (req, reply) => {
    const me = need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const { model } = modelQuery.parse(req.query);
    const set = await loadSet(id);
    const m = (await modelsOf(id)).find((x) => !model || x.sha === model);
    if (!m) throw notFound("Model grades for this set");
    const r = await modelRows(id, m.sha);
    const shown = r.items.filter((x) => x.status === "ok").map((x) => Number(x.grading_id));
    await withTx(auditCtx(req, `Exported evaluation set "${set.name}" with ${m.repo ?? "model"} grades (${r.items.length} rows, no names)`), (c) =>
      c.query(`INSERT INTO app.dr_grading_views (grading_id, user_id) SELECT unnest($1::bigint[]), $2`, [shown, me.id]));
    const exportedAt = new Date().toISOString();
    const csv = toCsv(
      ["image_code", "patient_code", "eye", "field", "quality", "photo_month", "reference_grade", "reference_ungradable", "model_repo",
       "model_sha256_12", "status", "predicted_grade", "p0", "p1", "p2", "p3", "p4", "referable_score", "set_frozen", "exported_at"],
      r.items.map((x) => [x.image_code, x.patient_code, x.eye, x.field, x.quality, x.month, x.reference_grade, x.reference_ungradable ? 1 : 0,
        m.repo, m.sha.slice(0, 12), x.status ?? "not graded", x.ai_grade, ...(x.probs ?? [null, null, null, null, null]).map((p: number | null) => (p == null ? null : String(Number(p)))),
        x.probs ? String(Number(x.probs[2]) + Number(x.probs[3]) + Number(x.probs[4])) : null, set.frozenAt ? 1 : 0, exportedAt]));
    return reply.header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="retina-eval-set${id}-${m.sha.slice(0, 12)}.csv"`).send(csv);
  });
}
