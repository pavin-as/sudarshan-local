// Retina AI, research use only (D-040): grade a fundus photograph with the DR model, keep every result, let doctors give
// their own grade, and show how often the two agree. Permission retina_ai.use (admin and doctors).
// Every AI grade shown is logged in app.dr_grading_views (COMPLIANCE: every AI result shown is logged); a doctor's grade
// counts as "blinded" only when that doctor had not been shown the AI grade before saving it.
// The photograph is held in memory for the call to the grader and never stored.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { config } from "../config.js";
import { one, q, withTx } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";
import { remidioReady } from "../services/remidio.js";
import { lastPoll, pollQueue, receiverMode } from "../services/remidioReceiver.js";
import { forgetSettledNames, lastRun, pollTopcon, topconMode, topconReady, topconSince } from "../services/topconImport.js";
import { GRADES, IMAGE_TYPES, MAX_IMAGE_MB, agreement, gradeImage, graderHealth, graderTargets } from "../services/retinaAi.js";
import { activeGraders, screeningCutoffs, screeningFor, type Screened } from "../services/screening.js";

const EYE_WORDS: Record<string, string> = { RE: "right eye", LE: "left eye" };
const idParam = z.object({ id: z.coerce.number().int().positive() });

const COLS = `g.id, g.created_at AS "createdAt", g.patient_id AS "patientId", coalesce(p.mrd, g.mrd) AS mrd, p.name AS "patientName",
  g.eye, g.source, g.batch_id AS "batchId", g.status, g.error, g.image_filename AS "imageFilename", g.remarks, g.photo_id AS "photoId",
  u.full_name AS "createdBy", (SELECT count(*) FROM app.dr_doctor_grades d WHERE d.grading_id = g.id)::int AS "doctorGrades",
  mine.grade AS "myGrade", mine.ungradable AS "myUngradable", mine.blinded AS "myBlinded"`;
const AI_COLS = `g.ai_grade AS "aiGrade", g.probs, g.raw_outputs AS "rawOutputs", g.calibration, g.image_width AS "imageWidth",
  g.image_height AS "imageHeight", g.inference_ms AS "inferenceMs", g.model_sha256 AS "modelSha256", g.model_commit AS "modelCommit",
  g.grader_version AS "graderVersion", g.model_repo AS "modelRepo", fp.quality AS "photoQuality",
  EXISTS (SELECT 1 FROM app.dr_doctor_grades dd WHERE dd.grading_id = g.id AND dd.ungradable) AS "doctorUngradable"`;
const FROM = `FROM app.dr_gradings g LEFT JOIN clinical.patient p ON p.patient_id = g.patient_id
  LEFT JOIN app.users u ON u.id = g.created_by LEFT JOIN app.fundus_photos fp ON fp.id = g.photo_id
  LEFT JOIN app.dr_doctor_grades mine ON mine.grading_id = g.id AND mine.graded_by = $1`;

/** Each AI grading shown gets its screening outcome (refer / uncertain / routine) from its model's cut-offs (D-046). */
async function withScreening<T extends Record<string, any>>(rows: T[]): Promise<(T & { screening: Screened | null })[]> {
  const cutoffs = await screeningCutoffs();
  return rows.map((r) => ({ ...r, screening: "aiGrade" in r ? screeningFor(r as any, cutoffs) : null }));
}

const who = (r: { patientName?: string | null; mrd?: string | null; patientId?: number | null }) =>
  r.patientName ? `${r.patientName} (${r.mrd})` : r.mrd ?? (r.patientId ? `patient ${r.patientId}` : "an unknown patient");

async function logViews(req: FastifyRequest, userId: number, ids: number[], c?: pg.PoolClient) {
  if (!ids.length) return;
  const sql = `INSERT INTO app.dr_grading_views (grading_id, user_id) SELECT unnest($1::bigint[]), $2`;
  if (c) { await c.query(sql, [ids, userId]); return; }
  await withTx(auditCtx(req, `Viewed ${ids.length} AI grading${ids.length === 1 ? "" : "s"}`), (t) => t.query(sql, [ids, userId]));
}

export async function retinaAiRoutes(app: FastifyInstance) {
  // photographs arrive as the raw request body (JPEG or PNG); this parser only applies to the routes in this file
  app.addContentTypeParser([...IMAGE_TYPES], { parseAs: "buffer", bodyLimit: MAX_IMAGE_MB * 1024 * 1024 },
    (_req, body, done) => done(null, body));

  app.get("/api/retina-ai/status", async (req) => {
    need(req, "retina_ai.use");
    const [grader, counts] = await Promise.all([graderHealth(), one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ok')::int AS graded,
              count(*) FILTER (WHERE status <> 'ok')::int AS "notGraded",
              (SELECT count(DISTINCT grading_id)::int FROM app.dr_doctor_grades) AS "withDoctorGrade",
              max(created_at) AS "lastAt"
         FROM app.dr_gradings`)]);
    // every research grader switched on (D-046), with whether it answers and which model it is
    const cutoffs = await screeningCutoffs();
    const graders = await Promise.all((await activeGraders()).map(async (g) => {
      const t = graderTargets()[g.grader];
      const h = t ? await graderHealth(t) : { reachable: false, ready: false, keySet: false, heads: null } as any;
      const sha = (g.head ? h.heads?.[g.head]?.model_sha256 : h.modelSha256) ?? null;
      return { key: g.key, ready: !!h.ready && (!g.head || !!sha), reachable: !!h.reachable, keySet: !!h.keySet, modelSha256: sha,
               cutoffs: sha ? cutoffs[sha] ?? null : null };
    }));
    return { grader, graders, counts, grades: GRADES, maxImageMb: MAX_IMAGE_MB };
  });

  // Grade one photograph: ?patientId=&eye=RE|LE[&blind=true], body = the image, header x-file-name = its file name (URL-encoded).
  // blind=true: the AI grade is saved but not returned (nor logged as seen), so the person can give their own grade first.
  app.post("/api/retina-ai/grade", { bodyLimit: MAX_IMAGE_MB * 1024 * 1024 }, async (req) => {
    const me = need(req, "retina_ai.use");
    const { patientId, eye, blind } = z.object({ patientId: z.coerce.number().int().positive(), eye: z.enum(["RE", "LE"]),
                                                 blind: z.enum(["true", "false"]).optional() }).parse(req.query);
    const hide = blind === "true";
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw badRequest("Choose a JPG or PNG photograph.");
    const image = req.body as Buffer;
    if (!Buffer.isBuffer(image) || !image.length) throw badRequest("No photograph was received. Choose the file again.");
    let fileName = "photo";
    try { fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).slice(0, 200) || fileName; } catch { /* keep the default */ }
    if (!/\.(jpe?g|png)$/i.test(fileName)) fileName += type === "image/png" ? ".png" : ".jpg";

    const patient = await one<{ patientId: number; mrd: string; patientName: string }>(
      `SELECT patient_id AS "patientId", mrd, name AS "patientName" FROM clinical.patient WHERE patient_id = $1`, [patientId]);
    if (!patient) throw notFound("Patient");

    const outcome = await gradeImage(image, fileName, type);         // throws 503 when the grader cannot be reached: nothing saved
    const r = outcome.kind === "ok" ? outcome.result : null;
    // never the grade itself: managers read the activity log but may not see AI results (D-040)
    const sentence = r
      ? `Graded a fundus photograph of ${who(patient)}, ${EYE_WORDS[eye]}, with the research DR model`
      : `Fundus photograph of ${who(patient)}, ${EYE_WORDS[eye]}, not graded: ${outcome.kind === "ok" ? "" : outcome.message}`;
    const id = await withTx(auditCtx(req, sentence), async (c) => {
      const row = (await c.query(
        `INSERT INTO app.dr_gradings (created_by, patient_id, mrd, eye, source, status, error, ai_grade, probs, raw_outputs, calibration,
                                      image_filename, image_sha256, image_width, image_height, preprocess_ms, inference_ms,
                                      model_repo, model_commit, model_sha256, grader_version)
         VALUES ($1,$2,$3,$4,'upload',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [me.id, patientId, patient.mrd, eye, outcome.kind, outcome.kind === "ok" ? null : outcome.message,
         r?.grade ?? null, r?.probs ?? null, r?.raw ?? null, r?.calibration ?? null, fileName, r?.imageSha256 ?? null,
         r?.width ?? null, r?.height ?? null, r?.preprocessMs ?? null, r?.inferenceMs ?? null,
         r?.modelRepo ?? null, r?.modelCommit ?? null, r?.modelSha256 ?? null, r?.graderVersion ?? null])).rows[0];
      if (r && !hide) await logViews(req, me.id, [row.id], c);
      return Number(row.id);
    });
    const [shown] = await withScreening([await one<any>(`SELECT ${COLS}${hide ? "" : `, ${AI_COLS}`} ${FROM} WHERE g.id = $2`, [me.id, id])]);
    return { grading: shown, aiHidden: hide };
  });

  // Past gradings with the AI grade (each shown result is logged).
  app.get("/api/retina-ai/gradings", async (req) => {
    const me = need(req, "retina_ai.use");
    const f = z.object({ q: z.string().trim().max(60).optional(), from: dateStr.optional(), to: dateStr.optional(),
                         patientId: z.coerce.number().int().positive().optional(),
                         model: z.string().regex(/^[0-9a-f]{64}$/i).optional() }).parse(req.query);
    const params: unknown[] = [me.id];
    const where: string[] = [];
    if (f.model) { params.push(f.model); where.push(`g.model_sha256 = $${params.length}`); }
    if (f.q) { params.push(f.q); where.push(`(coalesce(p.mrd, g.mrd) ILIKE $${params.length} || '%' OR p.name ILIKE '%' || $${params.length} || '%')`); }
    if (f.from) { params.push(f.from); where.push(`g.created_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`g.created_at < $${params.length}::date + 1`); }
    if (f.patientId) { params.push(f.patientId); where.push(`g.patient_id = $${params.length}`); }
    const rows = await q(`SELECT ${COLS}, ${AI_COLS} ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                           ORDER BY g.created_at DESC, g.id DESC LIMIT 200`, params);
    await logViews(req, me.id, rows.filter((r: any) => r.status === "ok").map((r: any) => Number(r.id)));
    return { gradings: await withScreening(rows) };
  });

  // Photographs I have not graded yet, WITHOUT the AI grade, so my grade can be blinded. One row per photograph (a Remidio
  // photograph has one AI grading per model; the doctor grades the photograph once, which counts against every model).
  app.get("/api/retina-ai/to-grade", async (req) => {
    const me = need(req, "retina_ai.use");
    const rows = await q<any>(
      `SELECT * FROM (
         SELECT DISTINCT ON (coalesce(g.photo_id, -g.id)) ${COLS},
                EXISTS (SELECT 1 FROM app.dr_grading_views v JOIN app.dr_gradings g2 ON g2.id = v.grading_id
                         WHERE v.user_id = $1 AND (g2.id = g.id OR g2.photo_id = g.photo_id)) AS "aiSeen"
           ${FROM} WHERE g.status = 'ok' AND mine.id IS NULL ORDER BY coalesce(g.photo_id, -g.id), g.created_at) x
        ORDER BY "createdAt" DESC LIMIT 200`, [me.id]);
    return { gradings: rows };
  });

  app.get("/api/retina-ai/gradings/:id", async (req) => {
    const me = need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const g = await one<any>(`SELECT ${COLS}, ${AI_COLS} ${FROM} WHERE g.id = $2`, [me.id, id]);
    if (!g) throw notFound("AI grading");
    const doctorGrades = await q(
      `SELECT d.grade, d.ungradable, d.note, d.blinded, d.updated_at AS at, u.full_name AS "by", d.graded_by = $2 AS mine
         FROM app.dr_doctor_grades d JOIN app.users u ON u.id = d.graded_by WHERE d.grading_id = $1 ORDER BY d.updated_at`, [id, me.id]);
    if (g.status === "ok") await logViews(req, me.id, [id]);
    const [shown] = await withScreening([g]);
    return { grading: shown, doctorGrades };
  });

  app.put("/api/retina-ai/gradings/:id/remarks", async (req) => {
    need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const { remarks } = z.object({ remarks: z.string().trim().max(2000) }).parse(req.body);
    const g = await one<any>(`SELECT g.patient_id AS "patientId", coalesce(p.mrd, g.mrd) AS mrd, p.name AS "patientName"
                                FROM app.dr_gradings g LEFT JOIN clinical.patient p ON p.patient_id = g.patient_id WHERE g.id = $1`, [id]);
    if (!g) throw notFound("AI grading");
    await withTx(auditCtx(req, `Changed the remarks on AI grading #${id} of ${who(g)}`), (c) =>
      c.query(`UPDATE app.dr_gradings SET remarks = $2 WHERE id = $1`, [id, remarks]));
    return { ok: true };
  });

  // My own grade of the photograph (one per person; saving again replaces it).
  app.put("/api/retina-ai/gradings/:id/my-grade", async (req) => {
    const me = need(req, "retina_ai.use");
    const { id } = idParam.parse(req.params);
    const b = z.object({ grade: z.number().int().min(0).max(4).nullable(), ungradable: z.boolean().default(false),
                         note: z.string().trim().max(1000).default("") })
      .refine((x) => (x.grade === null) === x.ungradable, { message: "Choose a grade, or mark the photograph as not gradable" })
      .parse(req.body);
    const g = await one<any>(`SELECT g.status, g.photo_id AS "photoId", g.patient_id AS "patientId", coalesce(p.mrd, g.mrd) AS mrd, p.name AS "patientName"
                                FROM app.dr_gradings g LEFT JOIN clinical.patient p ON p.patient_id = g.patient_id WHERE g.id = $1`, [id]);
    if (!g) throw notFound("AI grading");
    if (g.status !== "ok") throw badRequest("This photograph was not graded by the AI, so there is nothing to compare with.");
    // a Remidio photograph: the doctor's grade is of the photograph, so it goes on every model's grading of it (D-046);
    // "blinded" is worked out per grading (has this doctor been shown that model's grade?)
    const ids = g.photoId
      ? (await q<{ id: number }>(`SELECT id FROM app.dr_gradings WHERE photo_id = $1 AND status = 'ok'`, [g.photoId])).map((x) => Number(x.id))
      : [id];
    const saved = await withTx(auditCtx(req, `Gave a doctor's DR grade for ${who(g)} (AI grading #${id})`), async (c) => {
      let thisOne = null;
      for (const gid of ids) {
        const row = (await c.query(
          `INSERT INTO app.dr_doctor_grades (grading_id, patient_id, graded_by, grade, ungradable, note, blinded)
           VALUES ($1, $2, $3, $4, $5, $6, NOT EXISTS (SELECT 1 FROM app.dr_grading_views v WHERE v.grading_id = $1 AND v.user_id = $3))
           ON CONFLICT (grading_id, graded_by) DO UPDATE
             SET grade = EXCLUDED.grade, ungradable = EXCLUDED.ungradable, note = EXCLUDED.note, blinded = EXCLUDED.blinded
           RETURNING blinded`, [gid, g.patientId, me.id, b.grade, b.ungradable, b.note])).rows[0];
        if (gid === id) thisOne = row;
      }
      return thisOne;
    });
    return { ok: true, blinded: saved.blinded };
  });

  // ---------- fundus photographs from Remidio (D-041) ----------
  // The photograph itself (or Remidio's thumbnail). Only paths stored by the receiver are read, inside RETINA_PHOTO_DIR.
  // Photographs are clinical records: every clinical role sees them (D-042); only the AI grade is admin + doctor.
  app.get("/api/retina-ai/photos/:id/image", async (req, reply) => {
    need(req, "clinical.read");
    const { id } = idParam.parse(req.params);
    const { size } = z.object({ size: z.enum(["thumb", "full"]).default("full") }).parse(req.query);
    const f = await one<{ file: string; thumb: string | null }>(`SELECT file_path AS file, thumb_path AS thumb FROM app.fundus_photos WHERE id = $1`, [id]);
    if (!f) throw notFound("Photograph");
    const root = path.resolve(config.retinaAi.photoDir);
    const full = path.resolve(root, size === "thumb" && f.thumb ? f.thumb : f.file);
    if (!full.startsWith(root + path.sep)) throw notFound("Photograph");
    let data: Buffer;
    try { data = await readFile(full); } catch { throw notFound("Photograph file"); }
    return reply.header("Content-Type", full.endsWith(".png") ? "image/png" : "image/jpeg")
                .header("Cache-Control", "private, max-age=86400").send(data);
  });

  // Photographs received, newest first (no AI grades here: those are on Records, where each one shown is logged).
  app.get("/api/retina-ai/photos", async (req) => {
    need(req, "clinical.read");
    const f = z.object({ patientId: z.coerce.number().int().positive().optional(), q: z.string().trim().max(60).optional(),
                         unmatched: z.enum(["true", "false"]).optional(), source: z.enum(["remidio", "topcon"]).optional() }).parse(req.query);
    const params: unknown[] = []; const where: string[] = [];
    if (f.patientId) { params.push(f.patientId); where.push(`f.patient_id = $${params.length}`); }
    if (f.source) { params.push(f.source); where.push(`f.source = $${params.length}`); }
    if (f.unmatched === "true") where.push("f.patient_id IS NULL");
    if (f.q) { params.push(f.q); where.push(`(coalesce(p.mrd, f.mrn) ILIKE $${params.length} || '%' OR p.name ILIKE '%' || $${params.length} || '%')`); }
    const photos = await q(
      `SELECT f.id, f.captured_at AS "capturedAt", f.received_at AS "receivedAt", f.patient_id AS "patientId", p.mrd, p.name AS "patientName",
              f.mrn, f.sex_check AS "sexCheck", f.eye, f.field, f.quality, f.width, f.height, f.thumb_path IS NOT NULL AS "hasThumb",
              f.source, f.device, f.protocol,
              (SELECT count(*)::int FROM app.dr_gradings g WHERE g.photo_id = f.id) AS "gradings"
         FROM app.fundus_photos f LEFT JOIN clinical.patient p ON p.patient_id = f.patient_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.captured_at DESC NULLS LAST, f.id DESC LIMIT 300`, params);
    return { photos };
  });

  // The receiver: switch, what it did last, counts.
  app.get("/api/retina-ai/remidio", async (req) => {
    need(req, "retina_ai.use");
    const [counts, recent] = await Promise.all([
      one(`SELECT (SELECT count(*)::int FROM app.fundus_photos WHERE source = 'remidio') AS photos,
                  (SELECT count(*)::int FROM app.fundus_photos WHERE source = 'remidio' AND patient_id IS NULL) AS unmatched,
                  (SELECT count(*)::int FROM app.fundus_photos f WHERE source = 'remidio'
                      AND NOT EXISTS (SELECT 1 FROM app.dr_gradings g WHERE g.photo_id = f.id)) AS "toGrade",
                  (SELECT max(received_at) FROM app.fundus_photos WHERE source = 'remidio') AS "lastPhotoAt"`),
      q(`SELECT at, item_type AS "itemType", outcome, message, payload FROM app.remidio_queue_log ORDER BY id DESC LIMIT 15`),
    ]);
    const unmatched = (await one<{ value: string }>(`SELECT value FROM app.settings WHERE key = 'retina.remidio_unmatched'`))?.value ?? "keep";
    // the log's payload is shown only as its field names (the item holds patient details)
    const fields = (o: any, pre = ""): string[] => o && typeof o === "object" && !Array.isArray(o)
      ? Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? fields(v, `${pre}${k}.`) : [`${pre}${k}`])) : [];
    return { mode: await receiverMode(), unmatched, ready: remidioReady(), site: config.remidio.site, lastPoll, counts,
             recent: recent.map(({ payload, ...r }: any) => ({ ...r, fields: payload ? fields(payload) : null })) };
  });

  app.put("/api/retina-ai/remidio", async (req) => {
    need(req, "retina_ai.use"); need(req, "settings.manage");
    const b = z.object({ mode: z.enum(["off", "peek", "on"]).optional(), unmatched: z.enum(["keep", "skip"]).optional() }).parse(req.body);
    if (!b.mode && !b.unmatched) throw badRequest("Nothing to change");
    const words = [b.mode && `receiver ${b.mode}`, b.unmatched && `photographs without a Yarago SPD number: ${b.unmatched}`].filter(Boolean).join("; ");
    await withTx(auditCtx(req, `Remidio photo receiver: ${words}`), async (c) => {
      if (b.mode) await c.query(`INSERT INTO app.settings (key, value) VALUES ('retina.remidio_mode', to_jsonb($1::text))
                                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [b.mode]);
      if (b.unmatched) await c.query(`INSERT INTO app.settings (key, value) VALUES ('retina.remidio_unmatched', to_jsonb($1::text))
                                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [b.unmatched]);
    });
    return { ok: true };
  });

  app.post("/api/retina-ai/remidio/check-now", async (req) => {
    need(req, "retina_ai.use"); need(req, "settings.manage");
    return { result: await pollQueue(req.log), lastPoll };
  });

  // ---------- fundus photographs from the Topcon Maestro2 (D-048) ----------
  // The import: switch, start point, what it did last, counts and the latest log rows (shapes only, no patient details).
  app.get("/api/retina-ai/topcon", async (req) => {
    need(req, "retina_ai.use");
    const [counts, recent, unmatched] = await Promise.all([
      one(`SELECT count(*)::int AS photos, count(*) FILTER (WHERE patient_id IS NULL)::int AS unmatched,
                  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM app.dr_gradings g WHERE g.photo_id = f.id))::int AS "toGrade",
                  max(received_at) AS "lastPhotoAt",
                  (SELECT count(*)::int FROM app.oct_studies) AS scans,
                  (SELECT count(*)::int FROM app.oct_studies WHERE kind = 'octa') AS "octaScans",
                  (SELECT coalesce(sum(bytes), 0)::bigint FROM app.oct_studies) AS "scanBytes"
             FROM app.fundus_photos f WHERE source = 'topcon'`),
      q(`SELECT at, file_name AS "fileName", outcome, message, meta FROM app.topcon_import_log ORDER BY id DESC LIMIT 15`),
      one<{ value: string }>(`SELECT value FROM app.settings WHERE key = 'retina.topcon_unmatched'`),
    ]);
    return { mode: await topconMode(), since: await topconSince(), unmatched: unmatched?.value ?? "keep", ...topconReady(),
             share: config.topcon.share, lastRun, counts, recent };
  });

  app.put("/api/retina-ai/topcon", async (req) => {
    need(req, "retina_ai.use"); need(req, "settings.manage");
    const b = z.object({ mode: z.enum(["off", "peek", "on"]).optional(), unmatched: z.enum(["keep", "skip"]).optional(),
                         since: z.string().datetime({ offset: true }).optional() }).parse(req.body);
    if (!b.mode && !b.unmatched && !b.since) throw badRequest("Nothing to change");
    if (b.since && Date.parse(b.since) > Date.now()) throw badRequest("The start point cannot be in the future");
    // first switched on without a start point: only exams saved from now on (IMAGEnet holds years of exams)
    const since = b.since ?? (b.mode && b.mode !== "off" && !(await topconSince()) ? new Date().toISOString() : undefined);
    const words = [b.mode && `import ${b.mode}`, b.unmatched && `photographs without a Yarago SPD number: ${b.unmatched}`,
                   since && `exams saved from ${new Date(since).toLocaleString("en-IN", { timeZone: config.timezone })} on`].filter(Boolean).join("; ");
    await withTx(auditCtx(req, `Topcon Maestro2 photo import: ${words}`), async (c) => {
      const put = (key: string, v: string) => c.query(`INSERT INTO app.settings (key, value) VALUES ($1, to_jsonb($2::text))
                                                       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, v]);
      if (b.mode) await put("retina.topcon_mode", b.mode);
      if (b.unmatched) await put("retina.topcon_unmatched", b.unmatched);
      if (since) await put("retina.topcon_since", new Date(since).toISOString());
    });
    if (since) forgetSettledNames();                  // exams skipped as too old may now be in range
    return { ok: true };
  });

  app.post("/api/retina-ai/topcon/check-now", async (req) => {
    need(req, "retina_ai.use"); need(req, "settings.manage");
    return { result: await pollTopcon(req.log), lastRun };
  });

  // How often the AI grade matches doctors' grades. Blinded grades only unless asked otherwise.
  app.get("/api/retina-ai/agreement", async (req) => {
    need(req, "retina_ai.use");
    const f = z.object({ from: dateStr.optional(), to: dateStr.optional(), graderId: z.coerce.number().int().positive().optional(),
                         includeUnblinded: z.enum(["true", "false"]).optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = [`g.status = 'ok'`];
    if (f.includeUnblinded !== "true") where.push("d.blinded");
    if (f.from) { params.push(f.from); where.push(`g.created_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`g.created_at < $${params.length}::date + 1`); }
    if (f.graderId) { params.push(f.graderId); where.push(`d.graded_by = $${params.length}`); }
    const rows = await q<{ ai: number; doctor: number | null; ungradable: boolean }>(
      `SELECT g.ai_grade AS ai, d.grade AS doctor, d.ungradable
         FROM app.dr_doctor_grades d JOIN app.dr_gradings g ON g.id = d.grading_id WHERE ${where.join(" AND ")}`, params);
    const graders = await q(
      `SELECT u.id, u.full_name AS name, count(*)::int AS grades, count(*) FILTER (WHERE d.blinded)::int AS blinded
         FROM app.dr_doctor_grades d JOIN app.users u ON u.id = d.graded_by GROUP BY u.id, u.full_name ORDER BY u.full_name`);
    const pairs = rows.filter((r) => !r.ungradable && r.doctor !== null).map((r) => ({ ai: Number(r.ai), doctor: Number(r.doctor) }));
    return { ...agreement(pairs), ungradable: rows.filter((r) => r.ungradable).length, graders, grades: GRADES };
  });
}
