// Thickness of kept OCT scans (D-050, OCT_PLAN Step 7): measured after import (and for scans kept before), plus the
// check against IMAGEnet. The check sheet is written for a person on shichika: it names patients so they can find the
// scan in IMAGEnet and type IMAGEnet's CST next to Sudarshan's; the comparison prints aggregates only.
//   node dist/cli.js oct-thickness-sheet [--from yyyy-mm-dd] [--out <file.csv>]
//   node dist/cli.js oct-thickness-compare [<file.csv>] [--record ILM-BM|ILM-OS/RPE]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { q, withTx } from "../db.js";
import { computeThickness, DEFINITIONS, type Definition } from "./octThickness.js";

export const THICKNESS_VERSION = 1;
export const SHEET = "D:\\Sudarshan\\data\\oct\\work\\cst_check.csv";     // administrators only (patient names)
const ctx = (summary: string) => ({ userId: null, source: "job" as const, summary });

/** Measure one kept scan; null if it is not a macula cube or radial scan, or has no layers. */
export async function measureStudy(s: { id: number; dir_path: string; eye: "RE" | "LE" | null; protocol: string | null }) {
  const view = path.join(config.topcon.octDir, s.dir_path, "view");
  let meta: any, buf: Buffer;
  try { meta = JSON.parse(await readFile(path.join(view, "oct.json"), "utf8")); buf = await readFile(path.join(view, "layers.bin")); }
  catch { return null; }
  if (!meta.layers) return null;
  const data = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  return computeThickness({ data, shape: meta.layers.shape, scale: meta.layers.scale, labels: meta.layers.labels },
                          meta.spacing, meta.scanLines, s.eye, s.protocol ?? meta.protocol);
}

/** Measure scans not yet measured by this version (a few at a time). Scans that cannot be measured are tried once per
 *  server run only. */
const unmeasurable = new Set<number>();
export async function measureMissing(limit = 20): Promise<number> {
  const todo = await q<any>(
    `SELECT o.id, o.dir_path, o.eye, o.protocol FROM app.oct_studies o
      WHERE o.layers IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.oct_thickness t WHERE t.study_id = o.id AND t.version = $1)
        AND NOT (o.id = ANY($2)) ORDER BY o.id DESC LIMIT $3`, [THICKNESS_VERSION, [...unmeasurable], limit]);
  let n = 0;
  for (const s of todo) {
    const t = await measureStudy(s);
    if (!t) { unmeasurable.add(Number(s.id)); continue; }
    await withTx(ctx(`Measured retinal thickness of OCT scan #${s.id}`), (c) => c.query(
      `INSERT INTO app.oct_thickness (study_id, version, kind, centre, cst_ilm_bm_um, cst_ilm_rpe_um, results)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (study_id, version) DO NOTHING`,
      [s.id, THICKNESS_VERSION, t.kind, t.centre, t.results["ILM-BM"]?.cstUm ?? null, t.results["ILM-OS/RPE"]?.cstUm ?? null, t.results]));
    n++;
  }
  return n;
}

// ---------- the check against IMAGEnet ----------
const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const HEADER = ["scan", "patient", "mrd", "taken", "eye", "protocol", "centre", "sudarshan_cst_ilm_bm_um", "sudarshan_cst_ilm_rpe_um",
                "imagenet_cst_um", "note"];

/** Write the sheet (UTF-8 with BOM, so Excel opens it). Rows already in an older sheet keep their IMAGEnet value. */
export async function writeCheckSheet(o: { from?: string; out?: string }) {
  const out = o.out ?? SHEET;
  const kept = new Map<string, [string, string]>();
  try {
    const old = parseCsv((await readFile(out, "utf8")).replace(/^\uFEFF/, ""));
    const h = old[0] ?? [];
    for (const r of old.slice(1)) kept.set(r[h.indexOf("scan")], [r[h.indexOf("imagenet_cst_um")] ?? "", r[h.indexOf("note")] ?? ""]);
  } catch { /* no sheet yet */ }
  const rows = await q<any>(
    `SELECT o.id, p.name, coalesce(p.mrd, o.mrn) AS mrd, to_char(o.captured_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS taken,
            o.eye, o.protocol, t.centre ->> 'method' AS centre, t.cst_ilm_bm_um, t.cst_ilm_rpe_um
       FROM app.oct_thickness t JOIN app.oct_studies o ON o.id = t.study_id LEFT JOIN clinical.patient p ON p.patient_id = o.patient_id
      WHERE t.version = $1 AND ($2::date IS NULL OR (o.captured_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date)
      ORDER BY o.captured_at, o.id`, [THICKNESS_VERSION, o.from ?? null]);
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    const [imagenet, note] = kept.get(String(r.id)) ?? ["", ""];
    lines.push([r.id, r.name, r.mrd, r.taken, r.eye, r.protocol, r.centre, r.cst_ilm_bm_um, r.cst_ilm_rpe_um, imagenet, note].map(csvCell).join(","));
  }
  await writeFile(out, "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
  return { out, rows: rows.length, filledBefore: [...kept.values()].filter(([v]) => v.trim()).length };
}

export interface Agreement { n: number; biasUm: number; sdUm: number; loaUm: [number, number]; maeUm: number; maxAbsUm: number; r: number | null }
/** Bland-Altman agreement of Sudarshan minus IMAGEnet. */
export function agreement(pairs: [number, number][]): Agreement | null {
  if (pairs.length < 2) return null;
  const d = pairs.map(([s, i]) => s - i), n = d.length;
  const mean = d.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), vy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n, biasUm: r1(mean), sdUm: r1(sd), loaUm: [r1(mean - 1.96 * sd), r1(mean + 1.96 * sd)], maeUm: r1(d.reduce((a, b) => a + Math.abs(b), 0) / n),
           maxAbsUm: r1(Math.max(...d.map(Math.abs))), r: vx && vy ? Math.round((cov / Math.sqrt(vx * vy)) * 1000) / 1000 : null };
}

/** Compare the filled sheet; aggregates only (no names). With record, the passed check is written to the setting. */
export async function compareCheckSheet(o: { file?: string; record?: Definition; by?: string }) {
  const rows = parseCsv((await readFile(o.file ?? SHEET, "utf8")).replace(/^\uFEFF/, ""));
  const h = rows[0] ?? [];
  const col = (r: string[], k: string) => r[h.indexOf(k)];
  const filled = rows.slice(1).filter((r) => Number.isFinite(Number(col(r, "imagenet_cst_um"))) && String(col(r, "imagenet_cst_um")).trim() !== "");
  const result: Record<string, any> = { filled: filled.length };
  for (const def of Object.keys(DEFINITIONS) as Definition[]) {
    const key = def === "ILM-BM" ? "sudarshan_cst_ilm_bm_um" : "sudarshan_cst_ilm_rpe_um";
    const pairs = (kind?: string) => filled.filter((r) => !kind || String(col(r, "protocol")).toLowerCase().startsWith(kind))
      .filter((r) => String(col(r, key)).trim() !== "").map((r) => [Number(col(r, key)), Number(col(r, "imagenet_cst_um"))] as [number, number]);
    result[def] = { all: agreement(pairs()), cubes: agreement(pairs("3d")), radial: agreement(pairs("radial")) };
  }
  if (o.record) {
    const a = result[o.record]?.all as Agreement | null;
    if (!a) throw new Error("Not enough filled rows to record a check");
    await withTx({ userId: null, source: "cli", summary: `Recorded the OCT thickness check against IMAGEnet (${o.record}, ${a.n} scans)` }, (c) => c.query(
      `UPDATE app.settings SET value = $1 WHERE key = 'retina.oct_thickness_checked'`,
      [{ on: new Date().toISOString().slice(0, 10), definition: o.record, n: a.n, biasUm: a.biasUm, loaUm: a.loaUm, by: o.by ?? null }]));
  }
  return result;
}
