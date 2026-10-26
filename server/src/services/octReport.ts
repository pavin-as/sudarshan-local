// IMAGEnet's own CST from a thickness report saved as PDF (D-050 check). IMAGEnet exports no machine-readable thickness
// (OCT_PLAN section 7, question 7), so a person prints one report to PDF on shichika and this reads its selectable text,
// finds the Sudarshan scan by SPD number, exam date and eye, and compares the CSTs. The text names the patient: it stays
// in memory and only checks, labels from a fixed list and numbers are printed.
//   node dist/cli.js oct-report-check <file.pdf> [--scan <id>]
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { APP_ROOT, config } from "../config.js";
import { q } from "../db.js";
import { THICKNESS_VERSION } from "./octMeasure.js";
import { normaliseMrd } from "./retinaImport.js";

const run = promisify(execFile);
const READER = path.join(APP_ROOT, "scripts", "oct_report_pdf.py");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LAYERS = new Set(["RPE", "BM", "RPE/BM", "IS/OS", "OS", "OS/RPE", "NFL", "GCL", "IPL", "INL", "OPL", "ONL", "CHOROID"]);
const CST_LABEL = /\b(central subfield thickness|central subfield|central thickness|center fovea|centre fovea|center|centre|central|cst|fovea)\b[^\d\n]{0,25}?(\d{2,3}(?:\.\d+)?)/gi;

export interface ReportText { dates: string[]; eyes: ("RE" | "LE")[]; definitions: string[]; cst: { label: string; um: number }[] }

const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;

/** Dates (yyyy-mm-dd; a dd/mm/yyyy that could be mm/dd gives both), eyes, layer definitions and CST candidates. */
export function readReport(text: string): ReportText {
  const dates = new Set<string>(), add = (s: string | null) => s && dates.add(s);
  for (const m of text.matchAll(/\b(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/g)) add(iso(+m[1], +m[2], +m[3]));
  for (const m of text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)) { add(iso(+m[3], +m[2], +m[1])); add(iso(+m[3], +m[1], +m[2])); }
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*\.?[\s,-]+(\d{4})\b/g)) add(iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]));
  for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) add(iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]));

  const eyes = new Set<"RE" | "LE">();
  if (/\b(OD|right)\b/i.test(text) || /\beye\s*:?\s*R\b/i.test(text)) eyes.add("RE");
  if (/(?<![\w\/-])OS(?![\w\/-])/.test(text) || /\bleft\b/i.test(text) || /\beye\s*:?\s*L\b/i.test(text)) eyes.add("LE");

  const definitions = new Set<string>();
  for (const m of text.matchAll(/\bILM\s*(?:-|–|~|to)\s*([A-Za-z\/]{2,8})/gi)) {
    const layer = m[1].toUpperCase();
    if (LAYERS.has(layer)) definitions.add(`ILM-${layer}`);
  }
  for (const m of text.matchAll(/\b(retina|RNFL|GCL\+\+|GCL\+|full thickness)(?![\w])/gi)) definitions.add(m[1].toLowerCase() === "rnfl" ? "RNFL" : m[1]);

  const cst: ReportText["cst"] = [];
  for (const m of text.matchAll(CST_LABEL)) {
    const um = Number(m[2]);
    if (um >= 100 && um <= 900) cst.push({ label: m[1].toLowerCase(), um });
  }
  return { dates: [...dates].sort(), eyes: [...eyes], definitions: [...definitions], cst };
}

/** "SPD" + number in the text ("strong"), or the number alone after an ID label ("number only"). */
export function idInText(text: string, mrd: string): "strong" | "number only" | null {
  const n = normaliseMrd(mrd).match(/^SPD(\d+)$/)?.[1];
  if (!n) return text.toUpperCase().includes(mrd.toUpperCase()) ? "strong" : null;
  const digits = String(Number(n));
  if (new RegExp(`(?<![A-Z0-9])SPD\\s*-?\\s*0*${digits}(?!\\d)`, "i").test(text)) return "strong";
  if (new RegExp(`\\bID\\b[^\\n\\d]{0,15}0*${digits}(?!\\d)`, "i").test(text)) return "number only";
  return null;
}

/** Read the PDF and compare with Sudarshan. Returns lines to print (no names, no ID, no free text from the report). */
export async function checkReport(file: string, scan?: number): Promise<string[]> {
  const { stdout } = await run(config.topcon.python, ["-I", READER, file], { timeout: 60_000, windowsHide: true, maxBuffer: 64 << 20 });
  const pdf = JSON.parse(stdout) as { pages: { chars: number; images: number | null }[]; producer: string; creator: string; text: string };
  const chars = pdf.pages.reduce((a, p) => a + p.chars, 0), images = pdf.pages.reduce((a, p) => a + (p.images ?? 0), 0);
  const made = [pdf.producer, pdf.creator].filter((s) => /^[\w .:\/()+,-]{1,60}$/.test(s)).join("; ") || "not stated";
  const out = [`PDF: ${pdf.pages.length} page(s), ${images} image(s), made by ${made}.`,
               `Selectable text: ${chars >= 20 ? `yes (${chars} characters)` : "no - the report is a picture; its numbers could only be read by OCR"}.`];
  if (chars < 20) return out;

  const r = readReport(pdf.text);
  out.push(`Eye stated: ${r.eyes.join(" and ") || "not found"}. Dates in the report: ${r.dates.length}. Layer definitions named: ${r.definitions.join(", ") || "none found"}.`);
  out.push(`CST candidates (label: µm): ${r.cst.map((c) => `${c.label}: ${c.um}`).join("; ") || "none found"}.`);

  const studies = await q<any>(
    `SELECT o.id, coalesce(p.mrd, o.mrn) AS mrd, o.eye, o.protocol, to_char(o.captured_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
            t.cst_ilm_bm_um, t.cst_ilm_rpe_um
       FROM app.oct_thickness t JOIN app.oct_studies o ON o.id = t.study_id LEFT JOIN clinical.patient p ON p.patient_id = o.patient_id
      WHERE t.version = $1 AND ($2::bigint IS NULL OR o.id = $2)`, [THICKNESS_VERSION, scan ?? null]);
  const checked = studies.map((s) => ({ s, id: s.mrd ? idInText(pdf.text, s.mrd) : null, date: r.dates.includes(s.day), eye: r.eyes.length === 1 && r.eyes[0] === s.eye }));
  const byId = checked.filter((c) => c.id);
  const all = byId.filter((c) => c.date && c.eye);
  out.push(scan
    ? `Scan #${scan}: patient ID in the report ${checked[0]?.id ? `yes (${checked[0].id})` : "NO"}, exam date ${checked[0]?.date ? "yes" : "NO"}, eye ${checked[0]?.eye ? "yes" : "NO"}.`
    : `Measured scans whose patient ID is in the report: ${byId.length}; with the same exam date and eye too: ${all.length}${all.length ? ` (scan ${all.map((c) => `#${c.s.id} ${c.s.protocol ?? ""}`.trim()).join(", ")})` : ""}.`);

  const values = [...new Set(r.cst.map((c) => c.um))];
  const match = scan ? (checked[0]?.id && checked[0].date && checked[0].eye ? checked[0] : null) : all.length === 1 ? all[0] : null;
  if (!match) out.push(all.length > 1 ? "More than one scan matches: run again with --scan <id> from the check sheet." : "No single scan matches: nothing compared.");
  else if (values.length !== 1) out.push(`IMAGEnet CST: ${values.length ? "more than one candidate" : "not found"} - cannot pick it from the text alone.`);
  else {
    const [v] = values, d = (x: number | null) => (x == null ? "not measured" : `${x} µm (difference ${Math.round((x - v) * 10) / 10})`);
    out.push(`IMAGEnet CST ${v} µm. Sudarshan scan #${match.s.id}: ILM-BM ${d(match.s.cst_ilm_bm_um)}, ILM-OS/RPE ${d(match.s.cst_ilm_rpe_um)}.`);
  }
  return out;
}
