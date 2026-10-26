// OCT and OCTA scans from the Topcon Maestro2 (D-049, docs/OCT_PLAN.md Step 4): the list of a patient's scans, one scan's
// geometry (scan lines on the colour photograph, spacing, layers, slabs) and its viewer files (B-scan JPEGs, slab PNGs,
// layer heights). Clinical images: every clinical role sees them (clinical.read), like the fundus photographs (D-042).
// Files are read only from paths stored by the import, resolved inside OCT_DIR.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { notFound } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
/** The Step 7 gate: when Sudarshan's CST was checked against IMAGEnet (null = not yet; screens say so). */
const thicknessChecked = async () => (await one<{ value: any }>(`SELECT value FROM app.settings WHERE key = 'retina.oct_thickness_checked'`))?.value ?? null;
const COLS = `o.id, o.photo_id AS "photoId", o.patient_id AS "patientId", o.eye, o.captured_at AS "capturedAt", o.device, o.protocol,
  o.kind, o.frames, o.rows, o.cols, o.spacing, o.layers, o.slabs`;

async function studyDir(id: number): Promise<{ row: any; root: string }> {
  const row = await one<any>(`SELECT ${COLS}, o.dir_path FROM app.oct_studies o WHERE o.id = $1`, [id]);
  if (!row) throw notFound("OCT scan");
  const base = path.resolve(config.topcon.octDir);
  const root = path.resolve(base, row.dir_path);
  if (!root.startsWith(base + path.sep)) throw notFound("OCT scan");
  return { row, root };
}

async function sendFile(reply: FastifyReply, root: string, rel: string, type: string) {
  const full = path.resolve(root, "view", rel);
  if (!full.startsWith(path.resolve(root, "view") + path.sep)) throw notFound("OCT file");
  let data: Buffer;
  try { data = await readFile(full); } catch { throw notFound("OCT file"); }
  return reply.header("Content-Type", type).header("Cache-Control", "private, max-age=86400").send(data);
}

export async function octRoutes(app: FastifyInstance) {
  // A patient's scans (newest first), or one day's (a fundus report session).
  app.get("/api/oct/studies", async (req) => {
    need(req, "clinical.read");
    const f = z.object({ patientId: z.coerce.number().int().positive(), date: dateStr.optional() }).parse(req.query);
    const params: unknown[] = [f.patientId];
    let day = "";
    if (f.date) { params.push(f.date); day = `AND (coalesce(o.captured_at, o.received_at) AT TIME ZONE 'Asia/Kolkata')::date = $2`; }
    return { studies: await q(`SELECT ${COLS} FROM app.oct_studies o WHERE o.patient_id = $1 ${day}
                                ORDER BY o.captured_at DESC NULLS LAST, o.id DESC LIMIT 200`, params) };
  });

  // One scan: its row and the viewer's description (scan lines, layers' shape, slabs).
  app.get("/api/oct/studies/:id", async (req) => {
    need(req, "clinical.read");
    const { id } = idParam.parse(req.params);
    const { row, root } = await studyDir(id);
    let view: any = {};
    try { view = JSON.parse(await readFile(path.join(root, "view", "oct.json"), "utf8")); } catch { throw notFound("OCT viewer files"); }
    const photo = row.photoId ? await one<{ width: number; height: number }>(`SELECT width, height FROM app.fundus_photos WHERE id = $1`, [row.photoId]) : null;
    const thickness = await one(`SELECT version, kind, centre, results, computed_at AS "computedAt" FROM app.oct_thickness
                                  WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [id]);
    return { study: row, view: { scanLines: view.scanLines ?? null, linesOnColourPhoto: !!view.linesOnColourPhoto, spacing: view.spacing ?? null,
                                 layers: view.layers ?? null, slabs: (view.slabs ?? []).map((s: any, i: number) => ({ n: i + 1, label: s.label, definition: s.definition })) },
             photo, thickness, checked: await thicknessChecked() };
  });

  // The "injection response" chart (D-050): CST per eye over time with the injections and the vision from Yarago.
  app.get("/api/oct/thickness", async (req) => {
    need(req, "clinical.read");
    const { patientId } = z.object({ patientId: z.coerce.number().int().positive() }).parse(req.query);
    const [points, injections, vision] = await Promise.all([
      q(`SELECT DISTINCT ON (o.id) o.id AS "studyId", to_char(o.captured_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date,
                o.captured_at AS "capturedAt", o.eye, o.kind, o.protocol, t.cst_ilm_bm_um AS "cstIlmBm", t.cst_ilm_rpe_um AS "cstIlmRpe",
                t.centre ->> 'method' AS centre
           FROM app.oct_studies o JOIN app.oct_thickness t ON t.study_id = o.id
          WHERE o.patient_id = $1 ORDER BY o.id, t.version DESC`, [patientId]),
      q(`SELECT to_char(treated_at, 'YYYY-MM-DD') AS date, eye, drug, injection_number_for_eye AS number
           FROM clinical.injection WHERE patient_id = $1 AND given AND treated_at IS NOT NULL ORDER BY treated_at`, [patientId]),
      q(`SELECT to_char(visit_date, 'YYYY-MM-DD') AS date, bcva_re AS "bcvaRe", bcva_le AS "bcvaLe",
                bcva_logmar_re AS "logmarRe", bcva_logmar_le AS "logmarLe"
           FROM clinical.va_iop_trend WHERE patient_id = $1 AND coalesce(bcva_re, bcva_le) IS NOT NULL ORDER BY visit_date`, [patientId]),
    ]);
    return { points: (points as any[]).sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt))), injections, vision,
             checked: await thicknessChecked() };
  });

  app.get("/api/oct/studies/:id/bscan/:n", async (req, reply) => {
    need(req, "clinical.read");
    const { id, n } = z.object({ id: z.coerce.number().int().positive(), n: z.coerce.number().int().min(1).max(4096) }).parse(req.params);
    const { row, root } = await studyDir(id);
    if (n > row.frames) throw notFound("B-scan");
    return sendFile(reply, root, `b${String(n).padStart(3, "0")}.jpg`, "image/jpeg");
  });

  app.get("/api/oct/studies/:id/slab/:n", async (req, reply) => {
    need(req, "clinical.read");
    const { id, n } = z.object({ id: z.coerce.number().int().positive(), n: z.coerce.number().int().min(1).max(32) }).parse(req.params);
    const { root } = await studyDir(id);
    return sendFile(reply, root, `slab${n}.png`, "image/png");
  });

  // Topcon's layer heights: int16, rows x10, -1 where missing, shape [B-scans, surfaces, columns] (in the scan's view).
  app.get("/api/oct/studies/:id/layers", async (req, reply) => {
    need(req, "clinical.read");
    const { id } = idParam.parse(req.params);
    const { root } = await studyDir(id);
    return sendFile(reply, root, "layers.bin", "application/octet-stream");
  });
}
