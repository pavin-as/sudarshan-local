// Retina AI evaluation (D-043), pure: no database. Metrics of one model's DR grades against reference grades, with 95%
// confidence intervals from a patient-level (cluster) bootstrap: a patient's two eyes are not independent, so whole
// patients are resampled. Fixed seed, so the same set and model always give the same numbers.
// Grades 0-4 (ICDR); "referable DR" = grade 2 or worse (moderate NPDR or worse); the referable score of a model is
// p2 + p3 + p4 from its class scores (used for AUROC only, never as a probability). Ungradable references are counted
// and left out of every metric.
import { quadraticKappa } from "./retinaAi.js";

export interface EvalRow { cluster: string; ref: number; pred: number; probs: number[] | null }
export const REFERABLE_FROM = 2;
export const BOOTSTRAP = { resamples: 2000, seed: 20261025 };

const ratio = (a: number, b: number) => (b ? a / b : null);

/** Area under the ROC curve (Mann-Whitney, ties counted half). null when one class is missing. */
export function auroc(scores: number[], positive: boolean[]): number | null {
  const pos = scores.filter((_, i) => positive[i]), neg = scores.filter((_, i) => !positive[i]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function computeMetrics(rows: EvalRow[]) {
  const confusion = Array.from({ length: 5 }, () => Array(5).fill(0));        // rows = reference, columns = model
  for (const r of rows) confusion[r.ref][r.pred]++;
  const n = rows.length;
  const perClass = [0, 1, 2, 3, 4].map((g) => {
    const tp = confusion[g][g];
    const refN = confusion[g].reduce((s: number, x: number) => s + x, 0);
    const predN = confusion.reduce((s: number, row: number[]) => s + row[g], 0);
    const recall = ratio(tp, refN), precision = ratio(tp, predN);
    const tn = n - refN - predN + tp;
    return { grade: g, reference: refN, predicted: predN, recall, precision, specificity: ratio(tn, n - refN),
             f1: recall != null && precision != null && recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0 };
  });
  const present = perClass.filter((c) => c.reference > 0 || c.predicted > 0);
  const ref = (g: number) => g >= REFERABLE_FROM;
  const tp = rows.filter((r) => ref(r.ref) && ref(r.pred)).length, fn = rows.filter((r) => ref(r.ref) && !ref(r.pred)).length;
  const fp = rows.filter((r) => !ref(r.ref) && ref(r.pred)).length, tn = rows.filter((r) => !ref(r.ref) && !ref(r.pred)).length;
  const withProbs = rows.filter((r) => r.probs && r.probs.length === 5);
  return {
    n, patients: new Set(rows.map((r) => r.cluster)).size, confusion, perClass,
    accuracy: ratio(rows.filter((r) => r.ref === r.pred).length, n),
    withinOne: ratio(rows.filter((r) => Math.abs(r.ref - r.pred) <= 1).length, n),
    macroF1: present.length ? present.reduce((s, c) => s + c.f1, 0) / present.length : null,
    kappa: quadraticKappa(rows.map((r) => ({ doctor: r.ref, ai: r.pred }))),
    referable: { tp, fn, fp, tn, positives: tp + fn, negatives: fp + tn, sensitivity: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp),
                 ppv: ratio(tp, tp + fp), npv: ratio(tn, tn + fn) },
    auroc: withProbs.length === n ? auroc(withProbs.map((r) => r.probs![2] + r.probs![3] + r.probs![4]), withProbs.map((r) => ref(r.ref))) : null,
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;

/** Small fast seeded generator (mulberry32), so bootstrap intervals are reproducible. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile intervals of each statistic, resampling whole patients with replacement. A statistic undefined in
 *  more than half of the resamples (e.g. sensitivity with almost no referable eyes) gets no interval. */
export function bootstrapIntervals(rows: EvalRow[], stats: Record<string, (m: Metrics) => number | null>,
                                   resamples = BOOTSTRAP.resamples, seed = BOOTSTRAP.seed) {
  const byPatient = new Map<string, EvalRow[]>();
  for (const r of rows) byPatient.set(r.cluster, [...(byPatient.get(r.cluster) ?? []), r]);
  const clusters = [...byPatient.values()];
  const draws: Record<string, number[]> = Object.fromEntries(Object.keys(stats).map((k) => [k, []]));
  if (!clusters.length) return Object.fromEntries(Object.keys(stats).map((k) => [k, null])) as Record<string, [number, number] | null>;
  const rand = seeded(seed);
  for (let b = 0; b < resamples; b++) {
    const sample: EvalRow[] = [];
    for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rand() * clusters.length)]);
    const m = computeMetrics(sample);
    for (const [k, f] of Object.entries(stats)) { const v = f(m); if (v != null && Number.isFinite(v)) draws[k].push(v); }
  }
  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))];
  return Object.fromEntries(Object.entries(draws).map(([k, xs]) => {
    if (xs.length < resamples / 2) return [k, null];
    xs.sort((a, b) => a - b);
    return [k, [pct(xs, 0.025), pct(xs, 0.975)] as [number, number]];
  })) as Record<string, [number, number] | null>;
}

export const STATS: Record<string, (m: Metrics) => number | null> = {
  accuracy: (m) => m.accuracy, kappa: (m) => m.kappa, macroF1: (m) => m.macroF1,
  sensitivity: (m) => m.referable.sensitivity, specificity: (m) => m.referable.specificity, auroc: (m) => m.auroc,
  recall0: (m) => m.perClass[0].recall, recall1: (m) => m.perClass[1].recall, recall2: (m) => m.perClass[2].recall,
  recall3: (m) => m.perClass[3].recall, recall4: (m) => m.perClass[4].recall,
};

/** Metrics, intervals and the cautions a reader needs, in one object. */
export function evaluate(rows: EvalRow[], ungradable = 0) {
  const metrics = computeMetrics(rows);
  const intervals = bootstrapIntervals(rows, STATS);
  const cautions: string[] = [];
  if (metrics.n < 100) cautions.push(`Only ${metrics.n} eye images: every figure is uncertain; read the intervals, not the point values.`);
  if (metrics.referable.positives < 30) cautions.push(`Only ${metrics.referable.positives} referable-DR eyes: sensitivity cannot be judged yet (aim for 100 or more).`);
  const missing = metrics.perClass.filter((c) => c.reference === 0).map((c) => c.grade);
  if (missing.length) cautions.push(`No reference images of grade ${missing.join(", ")}: recall for ${missing.length === 1 ? "that grade" : "those grades"} cannot be measured.`);
  if (ungradable) cautions.push(`${ungradable} image(s) the doctor could not grade are left out.`);
  return { metrics, intervals, cautions, bootstrap: { ...BOOTSTRAP, unit: "patient" }, referableFrom: REFERABLE_FROM };
}
export type Evaluation = ReturnType<typeof evaluate>;

// ---------- the written report (Markdown) ----------
const GRADE = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"];
const pc = (x: number | null | undefined) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const dec = (x: number | null | undefined) => (x == null ? "n/a" : x.toFixed(3));
const ci = (i: [number, number] | null | undefined, f: (x: number) => string) => (i ? ` (95% CI ${f(i[0])} to ${f(i[1])})` : "");

export interface ReportHeader { title: string; dataset: string[]; model: string[]; reproducibility: string[] }
export function reportMarkdown(h: ReportHeader, e: Evaluation): string {
  const m = e.metrics, i = e.intervals;
  const f = (x: number) => pc(x), d = (x: number) => dec(x);
  return [
    `# ${h.title}`, "",
    "**Research use only.** The model is not a medical device; these figures do not make it fit for clinical use.", "",
    "## Data", ...h.dataset.map((l) => `- ${l}`), "",
    "## Model", ...h.model.map((l) => `- ${l}`), "",
    "## Results", "",
    `Eye images: **${m.n}** from **${m.patients}** patients. Referable DR = grade ${e.referableFrom} (moderate NPDR) or worse.`, "",
    "| Measure | Value |", "|---|---|",
    `| Referable DR sensitivity | ${pc(m.referable.sensitivity)}${ci(i.sensitivity, f)}, ${m.referable.tp} of ${m.referable.positives} found |`,
    `| Referable DR specificity | ${pc(m.referable.specificity)}${ci(i.specificity, f)}, ${m.referable.tn} of ${m.referable.negatives} |`,
    `| Referable DR PPV / NPV | ${pc(m.referable.ppv)} / ${pc(m.referable.npv)} |`,
    `| AUROC, referable DR (score p2+p3+p4) | ${dec(m.auroc)}${ci(i.auroc, d)} |`,
    `| Quadratic weighted kappa | ${dec(m.kappa)}${ci(i.kappa, d)} |`,
    `| Macro-F1 (grades present) | ${dec(m.macroF1)}${ci(i.macroF1, d)} |`,
    `| Exact grade / within one grade | ${pc(m.accuracy)}${ci(i.accuracy, f)} / ${pc(m.withinOne)} |`, "",
    "| Grade | Reference images | Recall (sensitivity) | Precision | Specificity | F1 |", "|---|---|---|---|---|---|",
    ...m.perClass.map((c) => `| ${c.grade} ${GRADE[c.grade]} | ${c.reference} | ${pc(c.recall)}${ci(i[`recall${c.grade}`], f)} | ${pc(c.precision)} | ${pc(c.specificity)} | ${dec(c.f1)} |`), "",
    "Confusion matrix (rows = reference grade, columns = model grade):", "",
    "| Reference \\ Model | 0 | 1 | 2 | 3 | 4 |", "|---|---|---|---|---|---|",
    ...m.confusion.map((row, g) => `| ${g} ${GRADE[g]} | ${row.join(" | ")} |`), "",
    "## Cautions", ...(e.cautions.length ? e.cautions.map((c) => `- ${c}`) : ["- None beyond the general ones above."]), "",
    "## Reproducibility",
    `- 95% intervals: percentile bootstrap, ${e.bootstrap.resamples} resamples of whole patients, seed ${e.bootstrap.seed}.`,
    ...h.reproducibility.map((l) => `- ${l}`), "",
  ].join("\n");
}

/** CSV text (RFC 4180 quoting). */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
