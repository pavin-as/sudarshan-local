// Remidio photo receiver (D-041): reads TIRUR's Cloud Data Queue every minute, keeps each photograph on shichika, links it
// to the Yarago patient by SPD number, then takes the item off the queue; a second job grades new photographs with the
// research DR model (D-040). Switch: setting retina.remidio_mode = off / peek / on (Retina AI > System, admins).
//   peek  looks at the head item and logs its shape (links removed); takes nothing, so the queue is untouched
//   on    store first, then itemSuccessfullyHandled: a crash in between only means the next read sees a duplicate
// An item that fails 10 times in a row is logged ("gave_up") and taken off, so one bad item cannot stop the queue; the
// photograph stays in Remidio's cloud. Items that are not photographs (doctor reports, videos ...) are kept in
// app.remidio_queue_log, links removed, until Sudarshan reads them. Logs carry ids and MRN shapes, never names.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { one, q, withTx } from "../db.js";
import { HttpError } from "../lib/errors.js";
import { setting } from "./outreach.js";
import { fetchPhoto, getQueueItem, itemHandled, lastQueueHttp, photoFromItem, photoUrlAllowed, remidioReady, stripLinks,
         type QueuePhoto } from "./remidio.js";
import { gradeImage, graderHealth, graderTargets, type GraderTarget } from "./retinaAi.js";
import { activeGraders } from "./screening.js";
import { syncGradesForPhoto } from "./fundusReport.js";
import { normaliseMrd } from "./retinaImport.js";

export type ReceiverMode = "off" | "peek" | "on";
const ctx = (summary: string) => ({ userId: null, source: "job" as const, summary });
const GIVE_UP_AFTER = 10;
const PER_TICK = 20;
const failures = new Map<string, number>();
let receiving = false, grading = false;
export const lastPoll: { at: Date | null; result: string; error: string | null; queueHttp: number | null } = { at: null, result: "not run yet", error: null, queueHttp: null };

export async function receiverMode(): Promise<ReceiverMode> {
  const v = await setting<string>("retina.remidio_mode", "off");
  return v === "on" || v === "peek" ? v : "off";
}
export const mrnShape = (m: string) => m.replace(/\d/g, "9").replace(/[a-z]/gi, "A") || "(empty)";

/** JPEG or PNG by their first bytes (a download error page must never be kept as a photograph). */
export function imageKind(b: Buffer): "jpg" | "png" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return null;
}

async function logItem(item: unknown, type: string, remidioId: number | null, outcome: string, message: string, photoId: number | null = null, keepPayload = false) {
  await withTx(ctx(`Remidio receiver: ${outcome}`), (c) => c.query(
    `INSERT INTO app.remidio_queue_log (item_type, remidio_id, outcome, photo_id, message, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [type || null, remidioId, outcome, photoId, message.slice(0, 500), keepPayload ? stripLinks(item) : null]));
}

/** The Yarago patient for an MRN typed on the FOP: only an SPD number that exists in Yarago. */
export async function patientForMrn(mrn: string) {
  const mrd = normaliseMrd(mrn);
  return /^SPD\d{1,6}$/.test(mrd)
    ? await one<{ patientId: number; mrd: string; name: string; sex: string | null }>(
        `SELECT patient_id AS "patientId", mrd, name, sex FROM clinical.patient WHERE upper(mrd) = $1 LIMIT 1`, [mrd])
    : undefined;
}

/** Keep one photograph. Returns what happened; throws when it could not be stored (the item then stays on the queue). */
async function storePhoto(p: QueuePhoto, item: unknown): Promise<"stored" | "duplicate" | "skipped"> {
  const dup = await one<{ id: number }>(`SELECT id FROM app.fundus_photos WHERE remidio_image_id = $1`, [p.remidioImageId]);
  if (dup) { await logItem(item, "IMAGE", p.remidioImageId, "duplicate", "already stored", dup.id); return "duplicate"; }

  const patient = await patientForMrn(p.mrn);
  if (!patient && (await setting<string>("retina.remidio_unmatched", "keep")) === "skip") {
    await logItem(item, "IMAGE", p.remidioImageId, "skipped", `MRN ${mrnShape(p.mrn)} is not a Yarago SPD number; skipped by setting`);
    return "skipped";
  }

  const image = await fetchPhoto(p.url);
  let thumb: Buffer | null = null;
  if (p.thumbUrl && photoUrlAllowed(p.thumbUrl)) { try { thumb = await fetchPhoto(p.thumbUrl); if (!imageKind(thumb)) thumb = null; } catch { thumb = null; } }
  const id = await keepPhoto(p, image, thumb, stripLinks(item), patient, "job");
  await logItem(item, "IMAGE", p.remidioImageId, "stored", patient ? "linked to the Yarago patient" : `MRN ${mrnShape(p.mrn)} not in Yarago: kept unlinked`, id);
  return "stored";
}

/** Write the photograph (and thumbnail) into the photo folder and record it. Shared by the queue and the download import. */
export async function keepPhoto(p: QueuePhoto, image: Buffer, thumb: Buffer | null, meta: unknown,
                                patient: Awaited<ReturnType<typeof patientForMrn>>, source: "job" | "cli"): Promise<number> {
  const kind = imageKind(image);
  if (!kind) throw new Error("the file is not a JPEG or PNG photograph");
  if (thumb && !imageKind(thumb)) thumb = null;
  const when = p.capturedAt ?? new Date();
  const rel = path.join(String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, "0"));
  await mkdir(path.join(config.retinaAi.photoDir, rel), { recursive: true });
  const file = path.join(rel, `${p.remidioImageId}.${kind}`);
  const thumbFile = thumb ? path.join(rel, `${p.remidioImageId}_thumb.${imageKind(thumb)}`) : null;
  await writeFile(path.join(config.retinaAi.photoDir, file), image);
  if (thumb && thumbFile) await writeFile(path.join(config.retinaAi.photoDir, thumbFile), thumb);

  const sexCheck = patient?.sex && p.sex ? (patient.sex.toUpperCase().startsWith(p.sex) ? "same" : "different") : null;
  const eyeWords = p.eye === "RE" ? "right eye" : p.eye === "LE" ? "left eye" : "eye not given";
  const who = patient ? `${patient.name} (${patient.mrd})` : `MRN ${p.mrn || "(none)"} (not in Yarago)`;
  const how = source === "cli" ? "Imported a fundus photograph downloaded from Remidio Connect" : "Received a fundus photograph from Remidio";
  return withTx({ ...ctx(`${how} for ${who}, ${eyeWords}`), source }, async (c) => Number((await c.query(
    `INSERT INTO app.fundus_photos (remidio_image_id, remidio_exam_id, remidio_patient_id, mrn, patient_id, sex_check, eye, field, quality,
                                    quality_score, captured_at, width, height, bytes, sha256, file_path, thumb_path, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [p.remidioImageId, p.remidioExamId, p.remidioPatientId, p.mrn || null, patient?.patientId ?? null, sexCheck, p.eye, p.field,
     p.quality, p.qualityScore, p.capturedAt, p.width, p.height, image.length, createHash("sha256").update(image).digest("hex"),
     file, thumbFile, meta])).rows[0].id));
}

/** One look at the queue: up to 20 items in "on" mode, one look in "peek". Never runs twice at once. */
export async function pollQueue(log: FastifyBaseLogger): Promise<string> {
  if (receiving) return "busy";
  receiving = true;
  const done = (result: string, error: string | null = null) => {
    Object.assign(lastPoll, { at: new Date(), result, error, queueHttp: lastQueueHttp });
    return result;
  };
  try {
    const mode = await receiverMode();
    if (mode === "off") return done("off");
    if (!remidioReady()) return done("not set up", "Remidio tokens are not in .env: run scripts\\setup-remidio.ps1");
    const n = { stored: 0, duplicate: 0, skipped: 0, kept: 0 };
    for (let i = 0; i < (mode === "peek" ? 1 : PER_TICK); i++) {
      const item = await getQueueItem();
      if (!item) break;
      const photo = photoFromItem(item);
      const type = String(item.type ?? "").toUpperCase();
      const remidioId = photo?.remidioImageId ?? (Number(item.id ?? item.report?.id ?? item.video?.id) || null);
      const key = `${type}:${remidioId ?? JSON.stringify(stripLinks(item)).length}`;
      if (mode === "peek") {
        const seen = await one(`SELECT 1 FROM app.remidio_queue_log WHERE outcome = 'peeked' AND item_type IS NOT DISTINCT FROM $1
                                   AND remidio_id IS NOT DISTINCT FROM $2`, [type || null, remidioId]);
        if (!seen) await logItem(item, type, remidioId, "peeked", "looked at, not taken", null, true);
        const eye = photo?.eye === "RE" ? "right eye" : photo?.eye === "LE" ? "left eye" : "eye not given";
        return done(`peek: the next item is ${type || "of unknown type"}${photo ? ` (photograph, ${eye}, MRN ${mrnShape(photo.mrn)})` : ""}; nothing taken`);
      }
      try {
        if (photo) n[await storePhoto(photo, item)]++;
        else { await logItem(item, type, remidioId, "kept", "not a photograph: kept for later", null, true); n.kept++; }
        await itemHandled();
        failures.delete(key);
      } catch (e: any) {
        const why = String(e?.message ?? e).slice(0, 300);
        const tries = (failures.get(key) ?? 0) + 1;
        failures.set(key, tries);
        if (tries >= GIVE_UP_AFTER) {
          await logItem(item, type, remidioId, "gave_up", `${why} (after ${tries} tries; the photograph is still in Remidio's cloud)`, null, true);
          await itemHandled();
          failures.delete(key);
          continue;
        }
        if (tries === 1 || tries % 5 === 0) await logItem(item, type, remidioId, "error", `${why} (try ${tries}; will try again)`);
        log.warn({ remidioId, tries }, `remidio receiver: ${why}`);
        return done(`stopped at an item that failed (try ${tries} of ${GIVE_UP_AFTER})`, why);
      }
    }
    const parts = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
    return done(parts.length ? parts.join(", ") : "queue empty");
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 300);
    log.warn(`remidio receiver: ${why}`);
    return done("could not read the queue", why);
  } finally {
    receiving = false;
  }
}

/** Grade photographs that have no AI grading yet, a few at a time; stops quietly while the grader is down. */
/** Grade photographs not yet graded by each research grader switched on in retina.graders (D-046), a few at a time per
 *  grader; a grader that is down or has no key is skipped (the others carry on). Its model is identified by the
 *  SHA-256 its /health reports (for RFM, per head), so each photograph gets one grading per model. */
export async function gradeNewPhotos(log: FastifyBaseLogger): Promise<number> {
  if (grading) return 0;
  grading = true;
  let graded = 0;
  try {
    for (const g of await activeGraders()) {
      const target = graderTargets()[g.grader];
      if (!target?.key) continue;
      const health = await graderHealth(target);
      if (!health.ready) continue;
      // the model this grader (and head) answers with; "" when a grader does not say (then: any grading without a model)
      const sha = (g.head ? health.heads?.[g.head]?.model_sha256 : health.modelSha256) ?? "";
      if (g.head && !sha) { log.warn(`photo grading: ${g.key} has no head "${g.head}"`); continue; }
      graded += await gradeWith(g.key, target, g.head ? `head=${encodeURIComponent(g.head)}` : "", sha);
    }
  } catch (e: any) {
    if (!(e instanceof HttpError && e.status === 503)) log.warn(`photo grading: ${String(e?.message ?? e).slice(0, 300)}`);
  } finally {
    grading = false;
  }
  return graded;
}

async function gradeWith(key: string, target: GraderTarget, query: string, sha: string): Promise<number> {
  let graded = 0;
  {
    const todo = await q<any>(
      `SELECT f.id, f.source, f.remidio_image_id, f.patient_id, coalesce(p.mrd, f.mrn) AS mrd, f.eye, f.file_path
         FROM app.fundus_photos f LEFT JOIN clinical.patient p ON p.patient_id = f.patient_id
        WHERE NOT EXISTS (SELECT 1 FROM app.dr_gradings g WHERE g.photo_id = f.id AND coalesce(g.model_sha256, '') = $1)
        ORDER BY f.id LIMIT 5`, [sha]);
    for (const f of todo) {
      const file = path.join(config.retinaAi.photoDir, f.file_path);
      let outcome: Awaited<ReturnType<typeof gradeImage>>;
      try { outcome = await gradeImage(await readFile(file), path.basename(file), file.endsWith(".png") ? "image/png" : "image/jpeg", target, query); }
      catch (e: any) {
        if (e instanceof HttpError && e.status === 503) break;            // grader down: try again next time
        outcome = { kind: "error", message: `could not grade: ${String(e?.message ?? e).slice(0, 200)}` };   // e.g. file missing
      }
      const r = outcome.kind === "ok" ? outcome.result : null;
      if (r && (r.modelSha256 || "") !== sha) break;   // the model changed since /health was read: read it again next round
      const modelSha = sha || null;                     // failures are recorded under the model too, so they are not retried for ever
      // Remidio and Maestro2 (D-048) photographs alike; the grading keeps which camera it came from
      const camera = f.source === "topcon" ? "Maestro2" : "Remidio";
      const label = f.source === "topcon" ? `topcon-photo-${f.id}` : `remidio-${f.remidio_image_id}`;
      await withTx(ctx(`Graded ${camera} photograph #${f.id} with the research model ${key}`), async (c) => { await c.query(
        `INSERT INTO app.dr_gradings (patient_id, mrd, eye, source, photo_id, status, error, ai_grade, probs, raw_outputs, calibration,
                                      image_filename, image_sha256, image_width, image_height, preprocess_ms, inference_ms,
                                      model_repo, model_commit, model_sha256, grader_version)
         VALUES ($1,$2,$3,$21,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [f.patient_id, f.mrd, f.eye, f.id, outcome.kind, outcome.kind === "ok" ? null : outcome.message, r?.grade ?? null, r?.probs ?? null,
         r?.raw ?? null, r?.calibration ?? null, `${label}${path.extname(file)}`, r?.imageSha256 ?? null,
         r?.width ?? null, r?.height ?? null, r?.preprocessMs ?? null, r?.inferenceMs ?? null, r?.modelRepo ?? null,
         r?.modelCommit ?? null, modelSha, r?.graderVersion ?? null, f.source === "topcon" ? "topcon" : "remidio"]);
        await syncGradesForPhoto(c, Number(f.id));       // a doctor's report written before the AI graded it (D-042)
      });
      graded++;
    }
  }
  return graded;
}

export function startRemidioJobs(log: FastifyBaseLogger) {
  const a = setInterval(() => { void pollQueue(log); }, 60_000);
  const b = setInterval(() => { void gradeNewPhotos(log); }, 30_000);
  return [a, b];
}
