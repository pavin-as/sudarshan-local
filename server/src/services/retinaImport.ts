// Retina AI folder import, run from the server console (D-040), never from the web: grade every photograph in a folder
// (with an optional metadata.csv), like the grader's old batch_import.py. (The old grader's records.db held only test
// photographs and is not copied: migration 0019.) Output names files and MRDs only, never patient names.
import { readFileSync, readdirSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { one, withTx } from "../db.js";
import { GRADES, gradeImage } from "./retinaAi.js";

const ctx = (summary: string) => ({ userId: null, source: "cli" as const, summary });

/** "Right (OD)", "RE", "R", "OD", "right" -> RE; the same for the left eye; anything else -> null. */
export function eyeFrom(text: string | null | undefined): "RE" | "LE" | null {
  const t = (text ?? "").trim().toLowerCase();
  if (/^(re|r|od|right)\b|\(od\)/.test(t)) return "RE";
  if (/^(le|l|os|left)\b|\(os\)/.test(t)) return "LE";
  return null;
}

/** A small CSV reader: header row, commas, double quotes around fields that contain commas or quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** MRDs as typed in the old grader and metadata.csv: "12765", "spd12765" and "SPD 12765" all mean SPD12765 (as patient search). */
export function normaliseMrd(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  return /^(spd)?\s*\d{1,5}$/i.test(t) ? `SPD${t.replace(/\D/g, "")}` : t.toUpperCase();
}

async function patientByMrd(mrd: string) {
  const m = normaliseMrd(mrd);
  if (!m || m === "-") return null;
  return (await one<{ patientId: number; mrd: string }>(
    `SELECT patient_id AS "patientId", mrd FROM clinical.patient WHERE upper(mrd) = $1 LIMIT 1`, [m])) ?? null;
}

async function userId(username: string) {
  const u = await one<{ id: number }>(`SELECT id FROM app.users WHERE username = $1 AND is_active`, [username]);
  if (!u) throw new Error(`No active user called ${username}. Run list-users.`);
  return u.id;
}

export interface BatchOptions { folder: string; gradedBy?: string; dryRun?: boolean; move?: boolean }

/** Grade every JPG/PNG in the folder. metadata.csv columns: filename, mrd_no, eye, reference_grade (all but filename optional).
 *  reference_grade is a doctor's grade given WITHOUT the AI result; it needs --graded-by and is saved as blinded. */
export async function runBatch(o: BatchOptions) {
  const files = readdirSync(o.folder).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (!files.length) { console.log(`No photographs in ${o.folder}. Nothing to do.`); return; }
  const metaPath = path.join(o.folder, "metadata.csv");
  const meta = new Map(existsSync(metaPath) ? parseCsv(readFileSync(metaPath, "utf8")).map((r) => [r.filename, r] as const) : []);
  const hasRef = [...meta.values()].some((r) => /^[0-4]$/.test(r.reference_grade ?? ""));
  if (hasRef && !o.gradedBy && !o.dryRun) throw new Error("metadata.csv has reference grades: say whose they are with --graded-by <username>");
  const graderId = o.gradedBy ? await userId(o.gradedBy) : null;
  const batchId = `batch-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}`;
  const done = path.join(o.folder, "..", "processed"), failed = path.join(o.folder, "..", "failed");
  if (o.move && !o.dryRun) { mkdirSync(done, { recursive: true }); mkdirSync(failed, { recursive: true }); }
  console.log(`${batchId}: ${files.length} photograph(s) in ${o.folder}${o.dryRun ? "  [dry run: nothing is saved]" : ""}`);

  let ok = 0, notGraded = 0, noPatient = 0;
  for (const [i, file] of files.entries()) {
    const m = meta.get(file) ?? {};
    const patient = await patientByMrd(m.mrd_no ?? "");
    if (m.mrd_no && !patient) noPatient++;
    const eye = eyeFrom(m.eye);
    const ref = /^[0-4]$/.test(m.reference_grade ?? "") ? Number(m.reference_grade) : null;
    const image = readFileSync(path.join(o.folder, file));
    const outcome = await gradeImage(image, file, /\.png$/i.test(file) ? "image/png" : "image/jpeg");
    const r = outcome.kind === "ok" ? outcome.result : null;
    const line = `${String(i + 1).padStart(4)}/${files.length}  ${file.slice(0, 40).padEnd(40)} ${patient?.mrd ?? (m.mrd_no ? `${m.mrd_no}?` : "-")}`;
    console.log(r ? `${line}  grade ${r.grade} (${GRADES[r.grade]})${ref !== null ? `  doctor ${ref}` : ""}`
                  : `${line}  NOT GRADED: ${outcome.kind === "ok" ? "" : outcome.message}`);
    if (r) ok++; else notGraded++;
    if (o.dryRun) continue;
    await withTx(ctx(`Batch ${batchId}: ${r ? `graded ${file} with the research DR model` : `${file} not graded`}`), async (c) => {
      const row = (await c.query(
        `INSERT INTO app.dr_gradings (patient_id, mrd, eye, source, batch_id, status, error, ai_grade, probs, raw_outputs, calibration,
                                      image_filename, image_sha256, image_width, image_height, preprocess_ms, inference_ms,
                                      model_repo, model_commit, model_sha256, grader_version)
         VALUES ($1,$2,$3,'batch',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [patient?.patientId ?? null, patient?.mrd ?? (m.mrd_no || null), eye, batchId, outcome.kind,
         outcome.kind === "ok" ? null : outcome.message, r?.grade ?? null, r?.probs ?? null, r?.raw ?? null, r?.calibration ?? null,
         file, r?.imageSha256 ?? null, r?.width ?? null, r?.height ?? null, r?.preprocessMs ?? null, r?.inferenceMs ?? null,
         r?.modelRepo ?? null, r?.modelCommit ?? null, r?.modelSha256 ?? null, r?.graderVersion ?? null])).rows[0];
      if (r && ref !== null && graderId)
        await c.query(`INSERT INTO app.dr_doctor_grades (grading_id, patient_id, graded_by, grade, note, blinded)
                       VALUES ($1, $2, $3, $4, $5, true)`, [row.id, patient?.patientId ?? null, graderId, ref, `from metadata.csv (${batchId})`]);
    });
    if (o.move) renameSync(path.join(o.folder, file), path.join(r ? done : failed, file));
  }
  console.log(`\n${ok} graded, ${notGraded} not graded${noPatient ? `, ${noPatient} with an MRD not found in Yarago (saved without a patient)` : ""}.`);
  console.log("Results: Sudarshan > Retina AI > Records (search the batch's patients) and > Agreement.");
}
