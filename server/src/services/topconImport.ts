// Topcon Maestro2 exams into Sudarshan (D-048 photographs, D-049 OCT / OCTA; docs/OCT_PLAN.md Steps 3-4). Every minute
// Sudarshan looks at IMAGEnet's exam folders on the ImageNet PC's read-only shares (the live folder
// \\192.168.0.152\SudarshanOCT$\Data, and the Jukebox archives in TOPCON_ARCHIVES with their subfolders), copies each new
// exam's .fda (the .fds is not needed: checked 26 Oct) to an administrators-only work folder on shichika, converts the
// copy with Topcon's DICOM OCT Export Tool and keeps:
//   - the colour fundus photograph next to the Remidio photographs (RETINA_PHOTO_DIR): linked to the Yarago patient by the
//     SPD number in the DICOM patient ID, reported by doctors (D-042), graded silently (D-046; remidioReceiver.ts)
//   - the OCT / OCTA scan (OCT_DIR): the exported DICOM and the viewer's files (B-scans, scan lines, layers, slabs)
// ImageNet is never written to; the work folder is emptied after each exam. Switch: retina.topcon_mode = off / peek / on.
//   peek  converts the next waiting exam and logs its shape (protocol, eye, patient-ID format); keeps nothing
//   on    up to 3 exams a minute: today's first (oldest first), then past ones (newest first)
// Only exams saved from retina.topcon_since on are imported, each once it has not changed for 2 minutes; past exams
// (saved before today) only inside retina.topcon_backfill_window (outside clinic hours). An exam is done once its log
// has a final outcome from this version of the import (VERSION); an exam done by an older version is done again (its
// photograph is recognised as a duplicate, its OCT added). An exam that fails 5 times is logged "gave_up" and left.
// Logs and messages carry file numbers and shapes, never names, patient IDs or the share password.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { APP_ROOT, config } from "../config.js";
import { one, q, withTx } from "../db.js";
import { backfillOpen, startOfToday } from "./backfillWindow.js";
import { setting } from "./outreach.js";
import { mrnShape, patientForMrn } from "./remidioReceiver.js";

const run = promisify(execFile);
export type TopconMode = "off" | "peek" | "on";
const ctx = (summary: string) => ({ userId: null, source: "job" as const, summary });
export const SETTLE_MS = 2 * 60_000;
const PER_TICK = 3;
export const GIVE_UP_AFTER = 5;
/** 1: photograph only (26 Oct morning). 2: photograph and OCT / OCTA (D-049). */
export const VERSION = 2;
const FINAL = ["stored", "duplicate", "skipped", "no_photo", "gave_up"];
const CONVERTER = path.join(APP_ROOT, "scripts", "topcon_photo.py");
/** B-scans, Topcon's layer surfaces and, for OCTA, the flow volume and en face slabs; not the binary flow mask or stub. */
export const EXPORT_FLAGS = ["-dcm", "-segDcm", "-enfaceSlabs"];
let busy = false;
export const lastRun: { at: Date | null; result: string; error: string | null; waiting: number | null } = { at: null, result: "not run yet", error: null, waiting: null };

/** name: what the log calls it (the live folder: "40742.fda"; an archive: "E/VOLUME_0001/40742.fda"); path: where it is. */
export interface ExamFile { name: string; path: string; bytes: number; mtime: Date; settledAt: Date }
export interface TopconPhoto {
  base: string; patientId: string; sex: string | null; eye: "RE" | "LE" | null; capturedAt: string | null; protocol: string | null;
  field: string | null; device: string | null; studyUid: string | null; sopUid: string; width: number; height: number;
  pixelSpacingMm: number[] | null;
}
export interface TopconOct {
  sopUid: string; studyUid: string; protocol: string | null; frames: number; rows: number; cols: number;
  spacing: { axialMm: number; lateralMm: number; betweenMm: number | null } | null; flow: boolean; layers: string[] | null;
  slabs: string[]; linesOnColourPhoto: boolean; patientId: string; sex: string | null; eye: "RE" | "LE" | null;
  capturedAt: string | null; device: string | null;
}
export interface Converted { photos: TopconPhoto[]; otherOp: number; otherObjects: number; oct?: TopconOct | null }

// ---------- the two programs, replaceable in tests ----------
type Exporter = (fda: string, outDir: string) => Promise<void>;
type Converter = (exportDir: string, outDir: string, octDir: string) => Promise<Converted>;
let exporter: Exporter = runTool;
let converter: Converter = runConverter;
export function setTopconExporter(f: Exporter | null) { exporter = f ?? runTool; }
export function setTopconConverter(f: Converter | null) { converter = f ?? runConverter; }

const hasDicom = async (dir: string) => { try { return (await readdir(dir, { recursive: true })).some((n) => String(n).toLowerCase().endsWith(".dcm")); } catch { return false; } };

/** Topcon's tool; its exit code is -1 even when it succeeds (OCT_PLAN Step 1), so a run is judged by its DICOM output.
 *  Its console output can hold patient details, so it is never logged. */
async function runTool(fda: string, outDir: string) {
  try {
    await run(config.topcon.tool, [fda, outDir, ...EXPORT_FLAGS], { cwd: path.dirname(outDir), timeout: 5 * 60_000, windowsHide: true, maxBuffer: 16 << 20 });
  } catch (e: any) {
    if (e?.killed) throw new Error("the export tool took longer than 5 minutes and was stopped");
  }
  if (!(await hasDicom(outDir))) throw new Error("the export tool made no DICOM files");
}

/** scripts\topcon_photo.py in the isolated Python (pydicom + OpenJPEG): JSON on its last line. */
async function runConverter(exportDir: string, outDir: string, octDir: string): Promise<Converted> {
  let stdout: string;
  try {
    ({ stdout } = await run(config.topcon.python, ["-I", CONVERTER, exportDir, outDir, "--oct", octDir], { timeout: 5 * 60_000, windowsHide: true, maxBuffer: 16 << 20 }));
  } catch (e: any) {
    throw new Error(`the converter failed${e?.code != null ? ` (exit ${e.code})` : ""}`);
  }
  const last = stdout.trim().split(/\r?\n/).pop() ?? "";
  try { return JSON.parse(last) as Converted; } catch { throw new Error("the converter gave no answer"); }
}

// ---------- which exams wait ----------
export const fileKey = (name: string, mtime: Date) => `${name.toLowerCase()}|${mtime.getTime()}`;

/** Exams to import: saved since the start point, unchanged for 2 minutes, not done yet. Today's first, oldest first; then
 *  past exams (saved before `today`), newest first, and only while the backfill window is open. */
export function pickWaiting(files: ExamFile[], done: Set<string>, since: Date | null, now: number,
                            pastAllowed = true, today: Date = new Date(0)): ExamFile[] {
  const ok = files.filter((f) => (!since || f.mtime >= since) && now - f.settledAt.getTime() >= SETTLE_MS && !done.has(fileKey(f.name, f.mtime)));
  const fresh = ok.filter((f) => f.mtime >= today).sort((a, b) => a.mtime.getTime() - b.mtime.getTime() || a.name.localeCompare(b.name));
  const past = pastAllowed ? ok.filter((f) => f.mtime < today).sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.name.localeCompare(b.name)) : [];
  return [...fresh, ...past];
}

const isUnc = (p: string) => /^\\\\[^\\]+\\[^\\]+/.test(p);
const shareOf = (p: string) => p.split("\\").slice(0, 4).join("\\");              // \\host\share
const signedIn = new Set<string>();
/** Sign in to a share once (the server runs as SYSTEM, which has no saved credentials). net use's own error text is
 *  never passed on: it can repeat the command, password included. */
async function signIn(dir: string) {
  if (!isUnc(dir)) return;
  const share = shareOf(dir);
  if (signedIn.has(share)) return;
  if (!config.topcon.password) throw new Error("the share password is not set: run scripts\\setup-topcon.ps1");
  try {
    await run("net", ["use", share, `/user:${config.topcon.user}`, config.topcon.password, "/persistent:no"], { timeout: 30_000, windowsHide: true });
  } catch (e: any) {
    const said = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
    if (!/\b(1219|85)\b/.test(said)) throw new Error(`could not sign in to ${share} (net use exit ${e?.code ?? "?"}; is the ImageNet PC on?)`);
  }
  signedIn.add(share);
}

async function readFolder(dir: string, recursive: boolean): Promise<string[]> {
  try { return (await readdir(dir, { recursive })).map(String); }
  catch {
    signedIn.delete(shareOf(dir));
    await signIn(dir);
    try { return (await readdir(dir, { recursive })).map(String); }
    catch (e: any) { throw new Error(`cannot read ${dir} (${e?.code ?? "error"}; is the ImageNet PC on?)`); }
  }
}

/** Where exams are: the live folder (its own files) and each archive (with subfolders). */
export function examRoots() {
  return [{ label: "", dir: path.join(config.topcon.share, config.topcon.dataDir), recursive: false },
          ...config.topcon.archives.map((a) => ({ label: a.label, dir: a.dir, recursive: true }))];
}

// Exams not to look at again while the server runs: saved before the start point, or done. IMAGEnet keeps thousands of
// exams, so only names not in here are looked at (one file-time read each over the network).
const settledNames = new Map<string, number>();     // lower-case log name -> the file time it had when it was settled
export function forgetSettledNames() { settledNames.clear(); }

export async function listExamFiles(skip: (name: string, mtime: Date) => boolean = () => false): Promise<ExamFile[]> {
  const out: ExamFile[] = [];
  for (const root of examRoots()) {
    const rels = await readFolder(root.dir, root.recursive);
    const byLower = new Map(rels.map((n) => [n.toLowerCase(), n]));
    for (const rel of rels) {
      if (!/\.fda$/i.test(rel)) continue;
      const name = root.label ? `${root.label}/${rel.replace(/\\/g, "/")}` : rel;
      if (settledNames.has(name.toLowerCase())) continue;
      const full = path.join(root.dir, rel);
      try {
        const s = await stat(full);
        if (skip(name, s.mtime)) { settledNames.set(name.toLowerCase(), s.mtime.getTime()); continue; }
        let settled = s.mtime;
        const fds = byLower.get(rel.toLowerCase().replace(/\.fda$/, ".fds"));
        if (fds) {    // IMAGEnet writes the .fds alongside: wait for both, even though only the .fda is copied
          try { const t = await stat(path.join(root.dir, fds)); if (t.mtime > settled) settled = t.mtime; } catch { settled = new Date(); }
        }
        out.push({ name, path: full, bytes: s.size, mtime: s.mtime, settledAt: settled });
      } catch { /* removed or being written: next time */ }
    }
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
    [config.topcon.share, ...config.topcon.archives.map((a) => a.dir)].some(isUnc) && !config.topcon.password && "the share password (scripts\\setup-topcon.ps1)",
  ].filter(Boolean) as string[];
  return { ready: !missing.length, missing };
}

async function logExam(f: ExamFile, outcome: string, message: string, photoId: number | null = null, meta: object | null = null) {
  await withTx(ctx(`Topcon import: ${outcome}`), (c) => c.query(
    `INSERT INTO app.topcon_import_log (file_name, file_bytes, file_mtime, outcome, photo_id, message, meta, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [f.name, f.bytes, f.mtime, outcome, photoId, message.slice(0, 500), meta, VERSION]));
}

const eyeWords = (e: string | null) => (e === "RE" ? "right eye" : e === "LE" ? "left eye" : "eye not given");
const shape = (p: TopconPhoto) => ({ protocol: p.protocol, eye: p.eye, field: p.field, device: p.device, idFormat: mrnShape(p.patientId),
                                     width: p.width, height: p.height });
const octShape = (o: TopconOct) => ({ protocol: o.protocol, eye: o.eye, frames: o.frames, size: [o.rows, o.cols], layers: o.layers?.length ?? 0,
                                      slabs: o.slabs.length, flow: o.flow, idFormat: mrnShape(o.patientId) });
const octWords = (o: TopconOct) => `${o.frames} B-scan${o.frames === 1 ? "" : "s"}${o.layers?.length ? ", layers" : ""}${o.slabs.length ? `, ${o.slabs.length} OCTA slabs` : ""}`;
/** A folder name for an exam: IMAGEnet's file without its folders or extension (archive names keep their label). */
const stemOf = (f: ExamFile) => f.name.replace(/\.fda$/i, "").replace(/[\\/:]+/g, "_");
const monthDir = (when: Date) => path.join(String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, "0"));
type Patient = Awaited<ReturnType<typeof patientForMrn>>;

/** Keep one Maestro2 photograph (JPEG, thumbnail and its OP .dcm) in RETINA_PHOTO_DIR and record it. */
async function keepTopconPhoto(f: ExamFile, p: TopconPhoto, patient: Patient, dir: string, n: number): Promise<{ outcome: "stored" | "duplicate"; id: number }> {
  const dup = await one<{ id: number }>(`SELECT id FROM app.fundus_photos WHERE dicom_sop_uid = $1`, [p.sopUid]);
  if (dup) return { outcome: "duplicate", id: Number(dup.id) };
  const image = await readFile(path.join(dir, `${p.base}.jpg`));
  if (!(image[0] === 0xff && image[1] === 0xd8)) throw new Error("the converted photograph is not a JPEG");
  const rel = monthDir(p.capturedAt ? new Date(p.capturedAt) : f.mtime);
  await mkdir(path.join(config.retinaAi.photoDir, rel), { recursive: true });
  const stem = `topcon-${stemOf(f)}-${n}`;
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
  return { outcome: "stored", id };
}

async function copyTree(from: string, to: string, filter: (n: string) => boolean = () => true): Promise<number> {
  await mkdir(to, { recursive: true });
  let bytes = 0;
  for (const n of (await readdir(from, { recursive: true })).map(String)) {
    const src = path.join(from, n);
    if (!(await stat(src)).isFile() || !filter(n)) continue;
    const dst = path.join(to, path.basename(n));
    await copyFile(src, dst);
    bytes += (await stat(dst)).size;
  }
  return bytes;
}

/** Keep one exam's OCT / OCTA scan in OCT_DIR: the exported DICOM (dicom\) and the viewer's files (view\). */
async function keepOct(f: ExamFile, o: TopconOct, patient: Patient, exportDir: string, viewDir: string, photoId: number | null): Promise<{ outcome: "stored" | "duplicate"; id: number }> {
  const dup = await one<{ id: number }>(`SELECT id FROM app.oct_studies WHERE opt_sop_uid = $1`, [o.sopUid]);
  if (dup) return { outcome: "duplicate", id: Number(dup.id) };
  const rel = path.join(monthDir(o.capturedAt ? new Date(o.capturedAt) : f.mtime), `topcon-${stemOf(f)}`);
  const root = path.join(config.topcon.octDir, rel);
  const bytes = await copyTree(exportDir, path.join(root, "dicom"), (n) => n.toLowerCase().endsWith(".dcm"))
              + await copyTree(viewDir, path.join(root, "view"));
  const kind = o.flow || o.slabs.length ? "octa" : "oct";
  const who = patient ? `${patient.name} (${patient.mrd})` : `patient ID ${o.patientId || "(none)"} (not in Yarago)`;
  const id = await withTx(ctx(`Imported a Maestro2 ${kind.toUpperCase()} scan for ${who}, ${eyeWords(o.eye)} (${o.protocol ?? "protocol not given"})`), async (c) => Number((await c.query(
    `INSERT INTO app.oct_studies (photo_id, mrn, patient_id, eye, captured_at, device, protocol, kind, frames, rows, cols, spacing, layers, slabs,
                                  dicom_study_uid, opt_sop_uid, topcon_file, dir_path, bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [photoId, o.patientId || null, patient?.patientId ?? null, o.eye, o.capturedAt, o.device, o.protocol, kind, o.frames, o.rows, o.cols,
     o.spacing, o.layers, o.slabs, o.studyUid, o.sopUid, f.name, rel, bytes])).rows[0].id));
  return { outcome: "stored", id };
}

/** One exam: copy, export, convert, then (on) keep its colour photographs and OCT, or (peek) only describe them. */
async function importExam(f: ExamFile, mode: "peek" | "on"): Promise<string> {
  const work = path.join(config.topcon.workDir, `exam-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const inDir = path.join(work, "in"), exp = path.join(work, "export"), photos = path.join(work, "photos"), view = path.join(work, "view");
  const base = path.basename(f.path);
  try {
    await mkdir(inDir, { recursive: true });
    // the .fda alone gives the photograph and the OCT / OCTA (checked 26 Oct on a Radial and an OCTA exam); the .fds, about
    // 90% of the bytes, stays on the ImageNet PC, so the copy reads a tenth as much from the PC that drives the Maestro2
    await copyFile(f.path, path.join(inDir, base));
    const [a, b] = await Promise.all([stat(f.path), stat(path.join(inDir, base))]);
    if (a.size !== b.size) throw new Error(`the copy of ${f.name} is incomplete`);
    await exporter(path.join(inDir, base), exp);
    const r = await converter(exp, photos, view);
    const o = r.oct ?? null;
    if (mode === "peek") {
      const first = r.photos[0];
      await logExam(f, "peeked", `converted, nothing kept: ${r.photos.length} colour photograph(s)${o ? `; OCT ${octWords(o)}` : "; no OCT"}`,
                    null, { photos: r.photos.map(shape), oct: o ? octShape(o) : null, otherObjects: r.otherObjects });
      const what = first ?? o;
      return what ? `peek: exam ${f.name} (${what.protocol ?? "protocol not given"}, ${eyeWords(what.eye)}, patient ID ${mrnShape(what.patientId)}${o ? `; OCT ${octWords(o)}` : ""}); nothing kept`
                  : `peek: exam ${f.name} has no colour photograph and no OCT; nothing kept`;
    }
    if (!r.photos.length && !o) { await logExam(f, "no_photo", `no colour fundus photograph or OCT in this exam (${r.otherObjects} other object(s))`); return "no_photo"; }
    const id = r.photos[0]?.patientId ?? o!.patientId;
    const patient = await patientForMrn(id);
    if (!patient && (await setting<string>("retina.topcon_unmatched", "keep")) === "skip") {
      await logExam(f, "skipped", `patient ID ${mrnShape(id)} is not a Yarago SPD number; skipped by setting`);
      return "skipped";
    }
    const outcomes: string[] = [];
    let photoId: number | null = null;
    for (const [i, p] of r.photos.entries()) {
      const k = await keepTopconPhoto(f, p, patient, photos, i + 1);
      photoId ??= k.id;
      const linked = patient ? "linked to the Yarago patient" : `patient ID ${mrnShape(p.patientId)} not in Yarago: kept unlinked`;
      await logExam(f, k.outcome, `photograph, ${eyeWords(p.eye)}, ${p.protocol ?? "protocol not given"}: ${k.outcome === "stored" ? linked : "already kept"}`, k.id, shape(p));
      outcomes.push(k.outcome);
    }
    if (o) {
      const k = await keepOct(f, o, patient, exp, view, photoId);
      await logExam(f, k.outcome, `${o.slabs.length || o.flow ? "OCTA" : "OCT"}, ${eyeWords(o.eye)}, ${o.protocol ?? "protocol not given"}: `
                    + (k.outcome === "stored" ? `${octWords(o)} kept` : "already kept"), photoId, octShape(o));
      outcomes.push(k.outcome);
    }
    return outcomes.includes("stored") ? "stored" : outcomes[0];
  } finally {
    await rm(work, { recursive: true, force: true });          // patient data: never left behind
  }
}

/** One look at the exam folders. Never runs twice at once. */
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
    const rows = await q<{ file_name: string; file_mtime: Date; outcome: string; version: number; n: number }>(
      `SELECT file_name, file_mtime, outcome, version, count(*)::int AS n FROM app.topcon_import_log
        WHERE file_mtime >= coalesce($1::timestamptz, '-infinity') GROUP BY 1, 2, 3, 4`, [since]);
    const finished = new Set(rows.filter((x) => FINAL.includes(x.outcome) && x.version >= VERSION).map((x) => fileKey(x.file_name, x.file_mtime)));
    const files = await listExamFiles((name, mtime) => (!!since && mtime < since) || finished.has(fileKey(name, mtime)));
    const peeked = new Set(rows.filter((x) => x.outcome === "peeked" && x.version >= VERSION).map((x) => fileKey(x.file_name, x.file_mtime)));
    const tries = new Map(rows.filter((x) => x.outcome === "error" && x.version >= VERSION).map((x) => [fileKey(x.file_name, x.file_mtime), x.n]));
    const today = startOfToday(), pastOpen = await backfillOpen();
    const waiting = pickWaiting(files, finished, since, Date.now(), pastOpen, today);
    const heldBack = pastOpen ? 0 : pickWaiting(files, finished, since, Date.now(), true, today).length - waiting.length;
    const later = heldBack ? `; ${heldBack} past exam${heldBack === 1 ? "" : "s"} wait for the backfill window` : "";
    if (!waiting.length) return done(`nothing new${later}`, null, 0);
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
    return done(Object.entries(n).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ") + later, null, Math.max(0, waiting.length - PER_TICK));
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
