// Topcon Maestro2 photographs (D-048, docs/OCT_PLAN.md Step 3). Every minute Sudarshan looks at IMAGEnet's exam folder on
// the ImageNet PC's read-only share (\\192.168.0.152\SudarshanOCT$\Data), copies each new exam (<number>.fda and its .fds)
// to an administrators-only work folder on shichika, converts the copy with Topcon's DICOM OCT Export Tool (-dcm) and
// keeps the exam's colour fundus photograph next to the Remidio photographs: linked to the Yarago patient by the SPD
// number in the DICOM patient ID, reported by doctors (D-042), graded silently by the research models (D-046; the grading
// job in remidioReceiver.ts takes every photograph). ImageNet is never written to; the work folder is emptied after
// each exam. Switch: setting retina.topcon_mode = off / peek / on (Retina AI > System, admins).
//   peek  converts the next waiting exam and logs its shape (protocol, eye, patient-ID format); keeps nothing
//   on    up to 3 exams a minute, oldest first; an exam is done once its log has a final outcome
// Only exams saved from retina.topcon_since on are imported (set to the moment the import is first switched on), and
// only once the file has not changed for 2 minutes. An exam that fails 5 times is logged "gave_up" and left (it stays
// in IMAGEnet). Logs and messages carry file numbers and shapes, never names, patient IDs or the share password.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { APP_ROOT, config } from "../config.js";
import { one, q, withTx } from "../db.js";
import { setting } from "./outreach.js";
import { mrnShape, patientForMrn } from "./remidioReceiver.js";

const run = promisify(execFile);
export type TopconMode = "off" | "peek" | "on";
const ctx = (summary: string) => ({ userId: null, source: "job" as const, summary });
export const SETTLE_MS = 2 * 60_000;
const PER_TICK = 3;
export const GIVE_UP_AFTER = 5;
const FINAL = ["stored", "duplicate", "skipped", "no_photo", "gave_up"];
const CONVERTER = path.join(APP_ROOT, "scripts", "topcon_photo.py");
let busy = false;
export const lastRun: { at: Date | null; result: string; error: string | null; waiting: number | null } = { at: null, result: "not run yet", error: null, waiting: null };

export interface ExamFile { name: string; bytes: number; mtime: Date; fds: string | null; settledAt: Date }
export interface TopconPhoto {
  base: string; patientId: string; sex: string | null; eye: "RE" | "LE" | null; capturedAt: string | null; protocol: string | null;
  field: string | null; device: string | null; studyUid: string | null; sopUid: string; width: number; height: number;
  pixelSpacingMm: number[] | null;
}
export interface Converted { photos: TopconPhoto[]; otherOp: number; otherObjects: number }

// ---------- the two programs, replaceable in tests ----------
type Exporter = (fda: string, outDir: string) => Promise<void>;
type Converter = (exportDir: string, outDir: string) => Promise<Converted>;
let exporter: Exporter = runTool;
let converter: Converter = runConverter;
export function setTopconExporter(f: Exporter | null) { exporter = f ?? runTool; }
export function setTopconConverter(f: Converter | null) { converter = f ?? runConverter; }

const hasDicom = async (dir: string) => { try { return (await readdir(dir, { recursive: true })).some((n) => String(n).toLowerCase().endsWith(".dcm")); } catch { return false; } };

/** Topcon's tool; its exit code is -1 even when it succeeds (OCT_PLAN Step 1), so a run is judged by its DICOM output.
 *  Its console output can hold patient details, so it is never logged. */
async function runTool(fda: string, outDir: string) {
  try {
    await run(config.topcon.tool, [fda, outDir, "-dcm"], { cwd: path.dirname(outDir), timeout: 5 * 60_000, windowsHide: true, maxBuffer: 16 << 20 });
  } catch (e: any) {
    if (e?.killed) throw new Error("the export tool took longer than 5 minutes and was stopped");
  }
  if (!(await hasDicom(outDir))) throw new Error("the export tool made no DICOM files");
}

/** scripts\topcon_photo.py in the isolated Python (pydicom + OpenJPEG): JSON on its last line. */
async function runConverter(exportDir: string, outDir: string): Promise<Converted> {
  let stdout: string;
  try {
    ({ stdout } = await run(config.topcon.python, ["-I", CONVERTER, exportDir, outDir], { timeout: 2 * 60_000, windowsHide: true, maxBuffer: 16 << 20 }));
  } catch (e: any) {
    throw new Error(`the photograph converter failed${e?.code != null ? ` (exit ${e.code})` : ""}`);
  }
  const last = stdout.trim().split(/\r?\n/).pop() ?? "";
  try { return JSON.parse(last) as Converted; } catch { throw new Error("the photograph converter gave no answer"); }
}

// ---------- which exams wait ----------
export const fileKey = (name: string, mtime: Date) => `${name.toLowerCase()}|${mtime.getTime()}`;

/** Exams to import, oldest first: saved since the start point, unchanged for 2 minutes, not done yet. */
export function pickWaiting(files: ExamFile[], done: Set<string>, since: Date | null, now: number): ExamFile[] {
  return files
    .filter((f) => (!since || f.mtime >= since) && now - f.settledAt.getTime() >= SETTLE_MS && !done.has(fileKey(f.name, f.mtime)))
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime() || a.name.localeCompare(b.name));
}

const isUnc = (p: string) => /^\\\\[^\\]+\\[^\\]+/.test(p);
let signedIn = false;
/** Sign in to the share once (the server runs as SYSTEM, which has no saved credentials). net use's own error text is
 *  never passed on: it can repeat the command, password included. */
async function signIn() {
  if (!isUnc(config.topcon.share) || signedIn) return;
  if (!config.topcon.password) throw new Error("the share password is not set: run scripts\\setup-topcon.ps1");
  try {
    await run("net", ["use", config.topcon.share, `/user:${config.topcon.user}`, config.topcon.password, "/persistent:no"], { timeout: 30_000, windowsHide: true });
  } catch (e: any) {
    const said = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
    if (!/\b(1219|85)\b/.test(said)) throw new Error(`could not sign in to the ImageNet share (net use exit ${e?.code ?? "?"}; is the ImageNet PC on?)`);
  }
  signedIn = true;
}

// Exams not to look at again while the server runs: saved before the start point, or done. IMAGEnet keeps thousands of
// exams in one folder, so only names not in here are looked at (one file-time read each over the network).
const settledNames = new Map<string, number>();     // lower-case name -> the file time it had when it was settled
export function forgetSettledNames() { settledNames.clear(); }

export async function listExamFiles(skip: (name: string, mtime: Date) => boolean = () => false): Promise<ExamFile[]> {
  const dir = path.join(config.topcon.share, config.topcon.dataDir);
  let names: string[];
  try { names = await readdir(dir); }
  catch {
    signedIn = false;
    await signIn();
    try { names = await readdir(dir); } catch (e: any) { throw new Error(`cannot read the ImageNet exam folder (${e?.code ?? "error"}; is the ImageNet PC on?)`); }
  }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out: ExamFile[] = [];
  for (const name of names) {
    if (!/\.fda$/i.test(name) || settledNames.has(name.toLowerCase())) continue;
    try {
      const s = await stat(path.join(dir, name));
      if (skip(name, s.mtime)) { settledNames.set(name.toLowerCase(), s.mtime.getTime()); continue; }
      const fds = byLower.get(name.toLowerCase().replace(/\.fda$/, ".fds")) ?? null;
      let settled = s.mtime;
      if (fds) {
        try { const t = await stat(path.join(dir, fds)); if (t.mtime > settled) settled = t.mtime; } catch { settled = new Date(); /* being written: wait */ }
      }
      out.push({ name, bytes: s.size, mtime: s.mtime, fds, settledAt: settled });
    } catch { /* removed or being written: next time */ }
  }
  return out;
}

export async function topconMode(): Promise<TopconMode> {
  const v = await setting<string>("retina.topcon_mode", "off");
  return v === "on" || v === "peek" ? v : "off";
}
export async function topconSince(): Promise<Date | null> {
  const v = await setting<string | null>("retina.topcon_since", null);
  return v ? new Date(v) : null;
}
export function topconReady(): { ready: boolean; missing: string[] } {
  const missing = [
    !existsSync(config.topcon.tool) && "Topcon's export tool",
    !existsSync(config.topcon.python) && "the isolated Python (tools\\oct-venv)",
    !existsSync(CONVERTER) && "scripts\\topcon_photo.py",
    isUnc(config.topcon.share) && !config.topcon.password && "the share password (scripts\\setup-topcon.ps1)",
  ].filter(Boolean) as string[];
  return { ready: !missing.length, missing };
}

async function logExam(f: ExamFile, outcome: string, message: string, photoId: number | null = null, meta: object | null = null) {
  await withTx(ctx(`Topcon import: ${outcome}`), (c) => c.query(
    `INSERT INTO app.topcon_import_log (file_name, file_bytes, file_mtime, outcome, photo_id, message, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [f.name, f.bytes, f.mtime, outcome, photoId, message.slice(0, 500), meta]));
}

const eyeWords = (e: string | null) => (e === "RE" ? "right eye" : e === "LE" ? "left eye" : "eye not given");
const shape = (p: TopconPhoto) => ({ protocol: p.protocol, eye: p.eye, field: p.field, device: p.device, idFormat: mrnShape(p.patientId),
                                     width: p.width, height: p.height });

/** Keep one Maestro2 photograph (JPEG, thumbnail and its OP .dcm) in RETINA_PHOTO_DIR and record it. */
async function keepTopconPhoto(f: ExamFile, p: TopconPhoto, dir: string, n: number): Promise<{ outcome: "stored" | "duplicate" | "skipped"; id: number | null; linked: boolean }> {
  const dup = await one<{ id: number }>(`SELECT id FROM app.fundus_photos WHERE dicom_sop_uid = $1`, [p.sopUid]);
  if (dup) return { outcome: "duplicate", id: Number(dup.id), linked: false };
  const patient = await patientForMrn(p.patientId);
  if (!patient && (await setting<string>("retina.topcon_unmatched", "keep")) === "skip") return { outcome: "skipped", id: null, linked: false };

  const image = await readFile(path.join(dir, `${p.base}.jpg`));
  if (!(image[0] === 0xff && image[1] === 0xd8)) throw new Error("the converted photograph is not a JPEG");
  const when = p.capturedAt ? new Date(p.capturedAt) : f.mtime;
  const rel = path.join(String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, "0"));
  await mkdir(path.join(config.retinaAi.photoDir, rel), { recursive: true });
  const stem = `topcon-${f.name.replace(/\.fda$/i, "")}-${n}`;
  const file = path.join(rel, `${stem}.jpg`), thumb = path.join(rel, `${stem}_thumb.jpg`), dcm = path.join(rel, `${stem}.dcm`);
  await copyFile(path.join(dir, `${p.base}.jpg`), path.join(config.retinaAi.photoDir, file));
  await copyFile(path.join(dir, `${p.base}_thumb.jpg`), path.join(config.retinaAi.photoDir, thumb));
  await copyFile(path.join(dir, `${p.base}.dcm`), path.join(config.retinaAi.photoDir, dcm));

  const sexCheck = patient?.sex && p.sex ? (patient.sex.toUpperCase().startsWith(p.sex) ? "same" : "different") : null;
  const who = patient ? `${patient.name} (${patient.mrd})` : `patient ID ${p.patientId || "(none)"} (not in Yarago)`;
  const id = await withTx(ctx(`Imported a Maestro2 fundus photograph for ${who}, ${eyeWords(p.eye)}`), async (c) => Number((await c.query(
    `INSERT INTO app.fundus_photos (source, mrn, patient_id, sex_check, eye, field, captured_at, width, height, bytes, sha256, file_path,
                                    thumb_path, dicom_study_uid, dicom_sop_uid, device, protocol, topcon_file, dicom_path, meta)
     VALUES ('topcon',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [p.patientId || null, patient?.patientId ?? null, sexCheck, p.eye, p.field, p.capturedAt, p.width, p.height, image.length,
     createHash("sha256").update(image).digest("hex"), file, thumb, p.studyUid, p.sopUid, p.device, p.protocol, f.name, dcm,
     { pixelSpacingMm: p.pixelSpacingMm, fdaBytes: f.bytes }])).rows[0].id));
  return { outcome: "stored", id, linked: !!patient };
}

/** One exam: copy, export, convert, then (on) keep its colour photographs or (peek) only describe them. */
async function importExam(f: ExamFile, mode: "peek" | "on"): Promise<string> {
  const dir = path.join(config.topcon.share, config.topcon.dataDir);
  const work = path.join(config.topcon.workDir, `exam-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const inDir = path.join(work, "in"), exp = path.join(work, "export"), photos = path.join(work, "photos");
  try {
    await mkdir(inDir, { recursive: true });
    for (const name of [f.name, f.fds].filter(Boolean) as string[]) {
      await copyFile(path.join(dir, name), path.join(inDir, name));
      const [a, b] = await Promise.all([stat(path.join(dir, name)), stat(path.join(inDir, name))]);
      if (a.size !== b.size) throw new Error(`the copy of ${name} is incomplete`);
    }
    await exporter(path.join(inDir, f.name), exp);
    const r = await converter(exp, photos);
    if (mode === "peek") {
      const first = r.photos[0];
      await logExam(f, "peeked", r.photos.length ? `converted, nothing kept: ${r.photos.length} colour photograph(s)` : "converted, nothing kept: no colour photograph",
                    null, { photos: r.photos.map(shape), otherObjects: r.otherObjects });
      return first ? `peek: exam ${f.name} (${first.protocol ?? "protocol not given"}, ${eyeWords(first.eye)}, patient ID ${mrnShape(first.patientId)}); nothing kept`
                   : `peek: exam ${f.name} has no colour photograph; nothing kept`;
    }
    if (!r.photos.length) { await logExam(f, "no_photo", `no colour fundus photograph in this exam (${r.otherObjects} other object(s))`); return "no_photo"; }
    const outcomes: string[] = [];
    for (const [i, p] of r.photos.entries()) {
      const k = await keepTopconPhoto(f, p, photos, i + 1);
      const words = k.outcome === "stored" ? (k.linked ? "linked to the Yarago patient" : `patient ID ${mrnShape(p.patientId)} not in Yarago: kept unlinked`)
        : k.outcome === "duplicate" ? "already kept" : `patient ID ${mrnShape(p.patientId)} is not a Yarago SPD number; skipped by setting`;
      await logExam(f, k.outcome, `${eyeWords(p.eye)}, ${p.protocol ?? "protocol not given"}: ${words}`, k.id, shape(p));
      outcomes.push(k.outcome);
    }
    return outcomes.includes("stored") ? "stored" : outcomes[0];
  } finally {
    await rm(work, { recursive: true, force: true });          // patient data: never left behind
  }
}

/** One look at the exam folder. Never runs twice at once. */
export async function pollTopcon(log: FastifyBaseLogger): Promise<string> {
  if (busy) return "busy";
  busy = true;
  const done = (result: string, error: string | null = null, waiting: number | null = lastRun.waiting) => {
    Object.assign(lastRun, { at: new Date(), result, error, waiting });
    return result;
  };
  try {
    const mode = await topconMode();
    if (mode === "off") return done("off");
    const r = topconReady();
    if (!r.ready) return done("not set up", `missing: ${r.missing.join(", ")}`);
    const since = await topconSince();
    const rows = await q<{ file_name: string; file_mtime: Date; outcome: string; n: number }>(
      `SELECT file_name, file_mtime, outcome, count(*)::int AS n FROM app.topcon_import_log
        WHERE file_mtime >= coalesce($1::timestamptz, '-infinity') GROUP BY 1, 2, 3`, [since]);
    const finished = new Set(rows.filter((x) => FINAL.includes(x.outcome)).map((x) => fileKey(x.file_name, x.file_mtime)));
    const files = await listExamFiles((name, mtime) => (!!since && mtime < since) || finished.has(fileKey(name, mtime)));
    const peeked = new Set(rows.filter((x) => x.outcome === "peeked").map((x) => fileKey(x.file_name, x.file_mtime)));
    const tries = new Map(rows.filter((x) => x.outcome === "error").map((x) => [fileKey(x.file_name, x.file_mtime), x.n]));
    const waiting = pickWaiting(files, finished, since, Date.now());
    if (!waiting.length) return done("nothing new", null, 0);
    if (mode === "peek") {
      const f = waiting[0];
      if (peeked.has(fileKey(f.name, f.mtime))) return done(`peek: exam ${f.name} was looked at already; nothing kept`, null, waiting.length);
      return done(await importExam(f, "peek"), null, waiting.length);
    }
    const n: Record<string, number> = {};
    for (const f of waiting.slice(0, PER_TICK)) {
      try {
        const out = await importExam(f, "on");
        n[out] = (n[out] ?? 0) + 1;
      } catch (e: any) {
        const why = String(e?.message ?? e).slice(0, 300);
        const t = (tries.get(fileKey(f.name, f.mtime)) ?? 0) + 1;
        if (t >= GIVE_UP_AFTER) { await logExam(f, "gave_up", `${why} (after ${t} tries; the exam is still in IMAGEnet)`); n.gave_up = (n.gave_up ?? 0) + 1; continue; }
        await logExam(f, "error", `${why} (try ${t}; will try again)`);
        log.warn({ file: f.name, tries: t }, `topcon import: ${why}`);
        return done(`stopped at exam ${f.name}, which failed (try ${t} of ${GIVE_UP_AFTER})`, why, waiting.length);
      }
    }
    return done(Object.entries(n).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", "), null, Math.max(0, waiting.length - PER_TICK));
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 300);
    log.warn(`topcon import: ${why}`);
    return done("could not look at the exams", why);
  } finally {
    busy = false;
  }
}

export function startTopconJobs(log: FastifyBaseLogger) {
  return [setInterval(() => { void pollTopcon(log); }, 60_000)];
}
