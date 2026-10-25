// Benchmark the retina AI on a PUBLIC dataset (D-043), from the server console; nothing is stored in the database:
//   node dist/cli.js retina-eval-external <image folder> --labels <labels.csv> [--name "IDRiD test"] [--out <folder>]
// labels.csv: one row per image; the image column is found by a header containing "image", "file" or "name" (with or
// without the extension), the grade column by "retinopathy grade", "diagnosis", "level" or "grade" (0-4, ICDR).
// IDRiD's "B. Disease Grading" test labels work as they are. Each image is its own cluster for the intervals (public sets
// rarely say which images share a patient). Writes <name>-<date>.md (the report) and .csv (per image) to the out folder.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../config.js";
import { evaluate, reportMarkdown, toCsv, type EvalRow } from "./evaluation.js";
import { graderHealth, graderTargets, gradeImage, type GraderResult } from "./retinaAi.js";
import { parseCsv } from "./retinaImport.js";

export interface ExternalOptions { folder: string; labels: string; name?: string; out?: string; grader?: string; head?: string }

/** The image and grade columns of a labels file (pure). */
export function labelColumns(headers: string[]): { image: string; grade: string } | null {
  const h = headers.map((x) => x.trim().toLowerCase());
  const image = h.find((x) => /image|file|name|id_code/.test(x) && !/grade|level|diagnos/.test(x));
  const grade = h.find((x) => /retinopathy grade/.test(x)) ?? h.find((x) => /diagnosis|level|grade/.test(x) && !/edema|oedema/.test(x));
  return image && grade ? { image, grade } : null;
}
export const stem = (f: string) => path.basename(f).replace(/\.(jpe?g|png|tif{1,2})$/i, "").trim().toLowerCase();

export async function evaluateExternal(o: ExternalOptions) {
  const name = o.name ?? path.basename(path.resolve(o.folder));
  const rowsIn = parseCsv(readFileSync(o.labels, "utf8"));
  const cols = rowsIn.length ? labelColumns(Object.keys(rowsIn[0])) : null;
  if (!cols) throw new Error("labels.csv needs an image column (image / file / name) and a grade column (retinopathy grade / diagnosis / level / grade)");
  const labels = new Map(rowsIn.filter((r) => /^[0-4]$/.test(String(r[cols.image] ? r[cols.grade] : "").trim()))
                              .map((r) => [stem(r[cols.image]), Number(r[cols.grade])] as const));
  const files = readdirSync(o.folder).filter((f) => /\.(jpe?g|png)$/i.test(f) && labels.has(stem(f))).sort();
  console.log(`${name}: ${labels.size} labelled image(s), ${files.length} found in ${o.folder}`);
  if (!files.length) throw new Error("No labelled JPG/PNG images found in the folder (TIFF is not accepted by the grader: convert first)");
  const target = o.grader ? graderTargets()[o.grader] : undefined;
  if (o.grader && !target) throw new Error(`Unknown grader "${o.grader}" (known: ${Object.keys(graderTargets()).join(", ")})`);
  const query = o.head ? `head=${encodeURIComponent(o.head)}` : "";
  const health = await graderHealth(target);
  if (!health.ready) throw new Error(`The ${o.grader ?? "default"} grader is not ready: start Docker Desktop and wait for the model`);

  const rows: EvalRow[] = [];
  const out: (string | number | null)[][] = [];
  let failed = 0;
  let used: GraderResult | null = null;              // the model that actually graded (for RFM: the chosen head)
  for (const [i, f] of files.entries()) {
    const ref = labels.get(stem(f))!;
    const g = await gradeImage(readFileSync(path.join(o.folder, f)), f, /\.png$/i.test(f) ? "image/png" : "image/jpeg", target, query);
    if (g.kind !== "ok") { failed++; out.push([f, ref, g.kind, null, null, null, null, null, null, null]); continue; }
    const r = g.result;
    used ??= r;
    rows.push({ cluster: f, ref, pred: r.grade, probs: r.probs });
    out.push([f, ref, "ok", r.grade, ...r.probs.map((p) => String(p)), String(r.probs[2] + r.probs[3] + r.probs[4])]);
    if ((i + 1) % 10 === 0 || i + 1 === files.length) console.log(`  ${i + 1}/${files.length} graded`);
  }
  const e = evaluate(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = o.out ?? path.join(APP_ROOT, "outputs", "retina-eval");
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}-${stamp}`);
  writeFileSync(`${base}.md`, reportMarkdown({
    title: `Retina AI on the public dataset "${name}"`, byImage: true,
    dataset: [`${files.length} images from ${path.resolve(o.folder)}; labels ${path.resolve(o.labels)} (columns "${cols.image}", "${cols.grade}").`,
              "Public dataset, not Sampada patients: shows how the model does on another camera and population, not on the Remidio FOP.",
              ...(failed ? [`${failed} image(s) the grader could not read are left out.`] : []),
              "Each image is resampled on its own (which images share a patient is not known), so intervals may be too narrow."],
    model: [`${used?.modelRepo || health.modelRepo || "unknown"}, commit ${used?.modelCommit || health.modelCommit || "unknown"}, model SHA-256 ${used?.modelSha256 || health.modelSha256 || "unknown"}`,
            `grader ${health.version ?? "unknown"}, output ${health.calibration ?? "unknown"}`],
    reproducibility: [`Run ${new Date().toISOString()} with node dist/cli.js retina-eval-external.`],
  }, e));
  writeFileSync(`${base}.csv`, toCsv(["image", "reference_grade", "status", "predicted_grade", "p0", "p1", "p2", "p3", "p4", "referable_score"], out));
  const m = e.metrics;
  console.log(`\nReferable DR: sensitivity ${m.referable.sensitivity == null ? "n/a" : (m.referable.sensitivity * 100).toFixed(1) + "%"}, specificity ${m.referable.specificity == null ? "n/a" : (m.referable.specificity * 100).toFixed(1) + "%"}; kappa ${m.kappa?.toFixed(3) ?? "n/a"}; AUROC ${m.auroc?.toFixed(3) ?? "n/a"}`);
  console.log(`Report: ${base}.md\nPer image: ${base}.csv`);
}
