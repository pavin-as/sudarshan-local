// Already-taken photographs (D-041), run from the server console as administrator, never from the web:
//   node dist/cli.js retina-remidio-import [<folder>] [--dry-run] [--all]
// The folder holds Remidio Connect "Download" zips (or their extracted folders). Each photograph is matched to Remidio's
// exam list (getExamsByDate, read only) by MRN, day and capture time, which gives its Remidio image id, eye, field and
// quality; then it is kept exactly like a queue photograph (keepPhoto), so a later queue copy is recognised as a duplicate,
// and the server's grading job grades it within a minute. Only SPD numbers unless --all. Zips are unpacked into a
// temporary folder that is removed afterwards; the downloads themselves are left as they are.
// Output: counts and file numbers only, never names or MRNs.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { one } from "../db.js";
import { getExamsByDate, matchDownload, parseDownloadPath, photoFromExamImage, remidioReady, stripLinks } from "./remidio.js";
import { keepPhoto, mrnShape, patientForMrn } from "./remidioReceiver.js";
import { normaliseMrd } from "./retinaImport.js";

const run = promisify(execFile);
const ZIP = /^[A-Za-z]+\d*_\d{2}-\d{2}-\d{4}_.*\.zip$/i;      // Remidio Connect's name: <MRN>_<dd-MM-yyyy>_<time>.zip

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export interface ImportOptions { folder: string; dryRun?: boolean; all?: boolean }

export async function importDownloads(o: ImportOptions) {
  if (!remidioReady()) throw new Error("Remidio is not set up: run scripts\\setup-remidio.ps1 first");
  if (!existsSync(o.folder)) throw new Error(`No folder ${o.folder}`);
  const temp = mkdtempSync(path.join(tmpdir(), "sudarshan-remidio-"));
  try {
    // 1. unpack Remidio zips whose folder is not already there (Windows' own tar reads zip files)
    let unpacked = 0;
    for (const name of readdirSync(o.folder).filter((n) => ZIP.test(n))) {
      if (existsSync(path.join(o.folder, name.replace(/\.zip$/i, "")))) continue;
      const dest = path.join(temp, name.replace(/\.zip$/i, ""));
      mkdirSync(dest, { recursive: true });
      await run("tar", ["-xf", path.join(o.folder, name), "-C", dest]);
      unpacked++;
    }
    // 2. every photograph laid out the Remidio way
    const files = [...walk(o.folder), ...walk(temp)]
      .map((file) => ({ file, d: parseDownloadPath(file) })).filter((x) => x.d) as { file: string; d: NonNullable<ReturnType<typeof parseDownloadPath>> }[];
    console.log(`${files.length} downloaded photograph(s) found${unpacked ? ` (${unpacked} zip(s) unpacked)` : ""}${o.dryRun ? "  [dry run: nothing is saved]" : ""}`);
    if (!files.length) { console.log("Nothing to import. Download exams in Remidio Connect (Exams > Download) into this folder first."); return; }

    // 3. Remidio's exam list for those days (read only), one day either side
    const days = files.map((x) => x.d.examDate).sort();
    const from = new Date(Date.parse(days[0]) - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(days[days.length - 1]) + 86_400_000).toISOString().slice(0, 10);
    const exams = await getExamsByDate(from, to);
    console.log(`Remidio's exam list ${from} to ${to}: ${exams.length} exam(s)\n`);

    const sameMrn = (a: string, b: string) => normaliseMrd(a) === normaliseMrd(b);
    const seen = new Set<number>();
    const n = { stored: 0, wouldStore: 0, already: 0, notSpd: 0, noMatch: 0, twice: 0, linked: 0, unlinked: 0, failed: 0 };
    for (const [i, { file, d }] of files.entries()) {
      const tag = `  #${String(i + 1).padStart(3)}`;
      if (!o.all && !/^SPD\d{1,6}$/.test(normaliseMrd(d.mrn))) { n.notSpd++; console.log(`${tag}  MRN ${mrnShape(d.mrn)} is not an SPD number: left out (--all to include)`); continue; }
      const m = matchDownload(d, exams, sameMrn);
      if (!m) { n.noMatch++; console.log(`${tag}  not found in Remidio's exam list (${d.examDate}): left out`); continue; }
      const p = photoFromExamImage(m.exam, m.image);
      if (seen.has(p.remidioImageId)) { n.twice++; continue; }
      seen.add(p.remidioImageId);
      const what = `${p.eye === "RE" ? "right eye" : p.eye === "LE" ? "left eye" : "eye ?"}, ${String(p.field ?? "?").toLowerCase()}, quality ${String(p.quality ?? "?").toLowerCase()}, ${d.examDate}`;
      if (await one(`SELECT 1 FROM app.fundus_photos WHERE remidio_image_id = $1`, [p.remidioImageId])) { n.already++; console.log(`${tag}  ${what}: already in Sudarshan`); continue; }
      const patient = await patientForMrn(p.mrn);
      patient ? n.linked++ : n.unlinked++;
      if (o.dryRun) { n.wouldStore++; console.log(`${tag}  ${what}: would be kept${patient ? "" : " (SPD number not in Yarago: unlinked)"}`); continue; }
      try {
        await keepPhoto(p, await readFile(file), null, stripLinks({ examDetails: m.exam.examDetails, image: m.image }), patient, "cli");
        n.stored++; console.log(`${tag}  ${what}: kept${patient ? "" : " (unlinked)"}`);
      } catch (e: any) { n.failed++; console.log(`${tag}  ${what}: NOT kept: ${String(e?.message ?? e).slice(0, 150)}`); }
    }
    console.log(`\n${o.dryRun ? `${n.wouldStore} would be kept` : `${n.stored} kept`} (${n.linked} linked to their Yarago patient${n.unlinked ? `, ${n.unlinked} unlinked` : ""}), `
      + `${n.already} already in Sudarshan, ${n.noMatch} not matched, ${n.notSpd} not SPD numbers${n.twice ? `, ${n.twice} copies of the same photograph` : ""}${n.failed ? `, ${n.failed} FAILED` : ""}.`);
    if (!o.dryRun && n.stored) console.log("The server grades them within a few minutes. See Retina AI > Photographs and each patient's page.");
    if (!o.dryRun) console.log("The downloads are patient data: delete them from this folder once the import is checked.");
  } finally {
    rmSync(temp, { recursive: true, force: true });       // only the temporary unpacked copies made by this run
  }
}
