// Side-by-side comparison of models on the same public images (D-044), from per-image CSVs written by
// retina-eval-external; nothing is graded again and nothing is stored:
//   node dist/cli.js retina-eval-compare --labels <labels.csv> --run "Arko007=<csv>" --run "RFM aptos=<csv>" [--name <name>] [--out <folder>]
// Only images graded by every run and listed in labels.csv are compared (paired). Each model's figures use the same
// metric code as every other report; differences get paired 95% intervals (the same resampled images for every model).
// False negatives (referable reference, model below grade 2) are broken down by reference grade and by which models
// missed them. Public images only: the CSV ids are the datasets' own file names.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../config.js";
import { BOOTSTRAP, computeMetrics, evaluate, seeded, type EvalRow, type Metrics } from "./evaluation.js";
import { labelColumns, stem } from "./evalExternal.js";
import { parseCsv } from "./retinaImport.js";

const GRADE = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"];
const pc = (x: number | null | undefined) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const d3 = (x: number | null | undefined) => (x == null ? "n/a" : x.toFixed(3));
const iv = (i: [number, number] | null | undefined, f: (x: number) => string) => (i ? ` (${f(i[0])} to ${f(i[1])})` : "");

export interface RunInput { name: string; csv: string }
interface Pred { pred: number; probs: number[] }

function readRun(file: string): Map<string, Pred> {
  const m = new Map<string, Pred>();
  for (const r of parseCsv(readFileSync(file, "utf8"))) {
    if (r.status !== "ok") continue;
    m.set(stem(r.image), { pred: Number(r.predicted_grade), probs: ["p0", "p1", "p2", "p3", "p4"].map((k) => Number(r[k])) });
  }
  return m;
}

/** Paired percentile intervals of (model - first model) for a few headline figures. */
export function pairedDifferences(ids: string[], ref: Map<string, number>, runs: Map<string, Pred>[], resamples = BOOTSTRAP.resamples, seed = BOOTSTRAP.seed) {
  const pick: Record<string, (m: Metrics) => number | null> = {
    sensitivity: (m) => m.referable.sensitivity, specificity: (m) => m.referable.specificity, auroc: (m) => m.auroc, kappa: (m) => m.kappa,
  };
  const rowsFor = (run: Map<string, Pred>, sample: string[]): EvalRow[] =>
    sample.map((id) => ({ cluster: id, ref: ref.get(id)!, pred: run.get(id)!.pred, probs: run.get(id)!.probs }));
  const rand = seeded(seed);
  const diffs = runs.slice(1).map(() => Object.fromEntries(Object.keys(pick).map((k) => [k, [] as number[]])));
  for (let b = 0; b < resamples; b++) {
    const sample = Array.from({ length: ids.length }, () => ids[Math.floor(rand() * ids.length)]);
    const base = computeMetrics(rowsFor(runs[0], sample));
    runs.slice(1).forEach((run, j) => {
      const m = computeMetrics(rowsFor(run, sample));
      for (const [k, f] of Object.entries(pick)) { const a = f(m), c = f(base); if (a != null && c != null) diffs[j][k].push(a - c); }
    });
  }
  return diffs.map((d) => Object.fromEntries(Object.entries(d).map(([k, xs]) => {
    if (xs.length < resamples / 2) return [k, null];
    xs.sort((a, b) => a - b);
    const at = (p: number) => xs[Math.round(p * (xs.length - 1))];
    return [k, [at(0.025), at(0.975)]];
  })) as Record<string, [number, number] | null>);
}

export function compareRuns(o: { labels: string; runs: RunInput[]; name?: string; out?: string }) {
  if (o.runs.length < 2) throw new Error("Give at least two --run Name=file.csv");
  const lrows = parseCsv(readFileSync(o.labels, "utf8"));
  const cols = lrows.length ? labelColumns(Object.keys(lrows[0])) : null;
  if (!cols) throw new Error("labels.csv needs an image column and a grade column");
  const ref = new Map(lrows.filter((r) => /^[0-4]$/.test((r[cols.grade] ?? "").trim())).map((r) => [stem(r[cols.image]), Number(r[cols.grade])]));
  const runs = o.runs.map((r) => readRun(r.csv));
  const ids = [...ref.keys()].filter((id) => runs.every((m) => m.has(id))).sort();
  if (!ids.length) throw new Error("No image is in the labels file and graded by every run");
  const evals = runs.map((run) => evaluate(ids.map((id) => ({ cluster: id, ref: ref.get(id)!, pred: run.get(id)!.pred, probs: run.get(id)!.probs }))));
  const diffs = pairedDifferences(ids, ref, runs);
  const fnOf = (run: Map<string, Pred>) => new Set(ids.filter((id) => ref.get(id)! >= 2 && run.get(id)!.pred < 2));
  const fns = runs.map(fnOf);
  const names = o.runs.map((r) => r.name);
  const notIn = ref.size - ids.length;

  const lines = [
    `# Retina AI comparison: ${o.name ?? names.join(" vs ")}`, "",
    "**Research use only.** Public images, not Sampada patients and not the Remidio FOP.", "",
    `Images compared: **${ids.length}** (in ${path.basename(o.labels)} and graded by every model${notIn ? `; ${notIn} left out` : ""}); each image is resampled on its own (patients unknown). Referable DR = grade 2 or worse; AUROC from p2+p3+p4.`, "",
    "## Headline figures (95% intervals)", "",
    `| Measure | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`,
    `| Referable DR sensitivity | ${evals.map((e) => `${pc(e.metrics.referable.sensitivity)}${iv(e.intervals.sensitivity, pc)}, ${e.metrics.referable.tp}/${e.metrics.referable.positives}`).join(" | ")} |`,
    `| Referable DR specificity | ${evals.map((e) => `${pc(e.metrics.referable.specificity)}${iv(e.intervals.specificity, pc)}, ${e.metrics.referable.tn}/${e.metrics.referable.negatives}`).join(" | ")} |`,
    `| PPV / NPV | ${evals.map((e) => `${pc(e.metrics.referable.ppv)} / ${pc(e.metrics.referable.npv)}`).join(" | ")} |`,
    `| AUROC, referable | ${evals.map((e) => `${d3(e.metrics.auroc)}${iv(e.intervals.auroc, d3)}`).join(" | ")} |`,
    `| Weighted kappa | ${evals.map((e) => `${d3(e.metrics.kappa)}${iv(e.intervals.kappa, d3)}`).join(" | ")} |`,
    `| Macro-F1 | ${evals.map((e) => d3(e.metrics.macroF1)).join(" | ")} |`,
    `| Exact grade | ${evals.map((e) => pc(e.metrics.accuracy)).join(" | ")} |`,
    ...[0, 1, 2, 3, 4].map((g) => `| Recall, grade ${g} ${GRADE[g]} (${evals[0].metrics.perClass[g].reference}) | ${evals.map((e) => `${pc(e.metrics.perClass[g].recall)}${iv(e.intervals[`recall${g}`], pc)}`).join(" | ")} |`), "",
    `## Paired differences against ${names[0]} (95% intervals; an interval not containing 0 is a real difference on these images)`, "",
    "| Model | Sensitivity | Specificity | AUROC | Kappa |", "|---|---|---|---|---|",
    ...diffs.map((d, j) => {
      const e = evals[j + 1].metrics, b = evals[0].metrics;
      const f = (v: number | null, k: string, fmt: (x: number) => string) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${fmt(v)}${iv(d[k], fmt)}`);
      const pp = (x: number) => `${(x * 100).toFixed(1)} pts`;
      return `| ${names[j + 1]} | ${f(e.referable.sensitivity! - b.referable.sensitivity!, "sensitivity", pp)} | ${f(e.referable.specificity! - b.referable.specificity!, "specificity", pp)} | ${f(e.auroc != null && b.auroc != null ? e.auroc - b.auroc : null, "auroc", (x) => x.toFixed(3))} | ${f(e.kappa != null && b.kappa != null ? e.kappa - b.kappa : null, "kappa", (x) => x.toFixed(3))} |`;
    }), "",
    "## False negatives (referable eye graded 0 or 1)", "",
    `| Reference grade | Eyes | ${names.map((n) => `${n} missed`).join(" | ")} | ${names.map((n) => `${n}: called No DR`).join(" | ")} |`,
    `|---|---|${names.map(() => "---").join("|")}|${names.map(() => "---").join("|")}|`,
    ...[2, 3, 4].map((g) => {
      const eyes = ids.filter((id) => ref.get(id) === g);
      return `| ${g} ${GRADE[g]} | ${eyes.length} | ${runs.map((run) => { const n = eyes.filter((id) => run.get(id)!.pred < 2).length; return `${n} (${pc(n / eyes.length)})`; }).join(" | ")} | ${runs.map((run) => eyes.filter((id) => run.get(id)!.pred === 0).length).join(" | ")} |`;
    }), "",
    ...(runs.length === 2 ? [
      `Missed by both: ${[...fns[0]].filter((id) => fns[1].has(id)).length}; only by ${names[0]}: ${[...fns[0]].filter((id) => !fns[1].has(id)).length}; only by ${names[1]}: ${[...fns[1]].filter((id) => !fns[0].has(id)).length}.`, "",
      `Severe or proliferative eyes missed by ${names[1]} (image ids, for review): ${ids.filter((id) => ref.get(id)! >= 3 && runs[1].get(id)!.pred < 2).join(", ") || "none"}.`, ""] : []),
    "## Confusion matrices (rows = reference grade, columns = model grade)", "",
    ...evals.flatMap((e, j) => [`**${names[j]}**`, "", "| Reference \\ Model | 0 | 1 | 2 | 3 | 4 |", "|---|---|---|---|---|---|",
      ...e.metrics.confusion.map((row, g) => `| ${g} ${GRADE[g]} | ${row.join(" | ")} |`), ""]),
    "## Reproducibility",
    `- Runs: ${o.runs.map((r) => `${r.name} = ${r.csv}`).join("; ")}.`,
    `- Labels: ${o.labels}. Intervals: percentile bootstrap, ${BOOTSTRAP.resamples} resamples of single images, seed ${BOOTSTRAP.seed}; differences paired on the same resamples.`,
    `- Made ${new Date().toISOString()} with node dist/cli.js retina-eval-compare.`, "",
  ];
  const dir = o.out ?? path.join(APP_ROOT, "outputs", "retina-eval");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `compare-${(o.name ?? names.join("-vs-")).replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(file, lines.join("\n"));
  console.log(`${ids.length} images compared. ${names.map((n, j) => `${n}: sensitivity ${pc(evals[j].metrics.referable.sensitivity)}, specificity ${pc(evals[j].metrics.referable.specificity)}, AUROC ${d3(evals[j].metrics.auroc)}`).join(" | ")}`);
  console.log(`Report: ${file}`);
}
