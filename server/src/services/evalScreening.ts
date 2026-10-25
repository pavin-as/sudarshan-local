// Screening-first evaluation (D-045): Sampada's question is "does this eye need an ophthalmologist, or can it continue
// routine screening?", not the exact DR grade. Pure functions plus a console report; nothing is stored.
//   node dist/cli.js retina-eval-screening --validation <labels.csv> --test <labels.csv> --run "Name=<per-image csv>" ...
//          [--refer-sensitivity 0.95] [--clear-sensitivity 0.99] [--name <name>] [--out <folder>]
// The referral score of a model is p2+p3+p4 (its scores for moderate NPDR or worse). Cut-offs are chosen on the
// VALIDATION images only, then frozen and applied once to the TEST images (never tuned there):
//   refer cut-off   the highest cut-off that still refers >= refer-sensitivity of validation referable eyes
//   clear cut-off   the highest cut-off that still refers >= clear-sensitivity (a lower, safer cut-off)
// Three outcomes: score >= refer -> REFER; clear <= score < refer -> UNCERTAIN (a person decides; never cleared);
// score < clear -> ROUTINE. Ungradable images (on Sampada data) are always UNCERTAIN. Only ROUTINE eyes are "cleared",
// so screening sensitivity = referable eyes not cleared; specificity = non-referable eyes cleared.
// The DR outcome alone never clears a patient: macular oedema, symptoms and image quality still need a person (D-045).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../config.js";
import { BOOTSTRAP, seeded } from "./evaluation.js";
import { labelColumns, stem } from "./evalExternal.js";
import { parseCsv } from "./retinaImport.js";

export interface ScreenRow { id: string; ref: number; score: number }
export type Outcome = "refer" | "uncertain" | "routine";
const referable = (g: number) => g >= 2;

/** Highest cut-off (refer when score >= cut-off) that still refers at least `target` of the referable rows. */
export function cutoffForSensitivity(rows: ScreenRow[], target: number): number | null {
  const pos = rows.filter((r) => referable(r.ref)).map((r) => r.score).sort((a, b) => a - b);
  if (!pos.length) return null;
  const allowedMisses = Math.floor((1 - target) * pos.length + 1e-9);
  return pos[allowedMisses];                       // eyes scoring below this are the allowed misses
}

export function outcomeOf(score: number, refer: number, clear: number, ungradable = false): Outcome {
  if (ungradable) return "uncertain";
  if (score >= refer) return "refer";
  return score >= clear ? "uncertain" : "routine";
}

export function screeningFigures(rows: ScreenRow[], refer: number, clear: number) {
  const out = rows.map((r) => ({ ...r, outcome: outcomeOf(r.score, refer, clear) }));
  const pos = out.filter((r) => referable(r.ref)), neg = out.filter((r) => !referable(r.ref));
  const cleared = out.filter((r) => r.outcome === "routine");
  const missed = pos.filter((r) => r.outcome === "routine");
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return {
    n: out.length, positives: pos.length, negatives: neg.length,
    refer: out.filter((r) => r.outcome === "refer").length, uncertain: out.filter((r) => r.outcome === "uncertain").length, routine: cleared.length,
    sensitivity: ratio(pos.length - missed.length, pos.length),                  // referable eyes NOT cleared
    specificity: ratio(neg.filter((r) => r.outcome === "routine").length, neg.length),
    npv: ratio(cleared.filter((r) => !referable(r.ref)).length, cleared.length),
    referralRate: ratio(out.length - cleared.length, out.length),                 // refer + uncertain: seen by a person
    autoReferSensitivity: ratio(pos.filter((r) => r.outcome === "refer").length, pos.length),
    missedByGrade: [2, 3, 4].map((g) => ({ grade: g, eyes: out.filter((r) => r.ref === g).length, missed: missed.filter((r) => r.ref === g).length })),
    missedIds: missed.filter((r) => r.ref >= 3).map((r) => r.id),
  };
}
export type Screening = ReturnType<typeof screeningFigures>;

/** 95% percentile intervals (resampling single images) at fixed cut-offs. */
export function screeningIntervals(rows: ScreenRow[], refer: number, clear: number, resamples = BOOTSTRAP.resamples, seed = BOOTSTRAP.seed) {
  const keys = ["sensitivity", "specificity", "npv", "referralRate"] as const;
  const draws: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, []]));
  const rand = seeded(seed);
  for (let b = 0; b < resamples; b++) {
    const f = screeningFigures(Array.from({ length: rows.length }, () => rows[Math.floor(rand() * rows.length)]), refer, clear);
    for (const k of keys) { const v = f[k]; if (v != null) draws[k].push(v); }
  }
  return Object.fromEntries(keys.map((k) => {
    const xs = draws[k].sort((a, b) => a - b);
    return [k, xs.length >= resamples / 2 ? [xs[Math.round(0.025 * (xs.length - 1))], xs[Math.round(0.975 * (xs.length - 1))]] : null];
  })) as Record<(typeof keys)[number], [number, number] | null>;
}

// ---------- console report ----------
const pc = (x: number | null | undefined) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const iv = (i: [number, number] | null | undefined) => (i ? ` (${pc(i[0])} to ${pc(i[1])})` : "");
const cut = (x: number | null) => (x == null ? "n/a" : x < 0.001 ? x.toExponential(2) : x.toFixed(4));

function readLabels(file: string) {
  const rows = parseCsv(readFileSync(file, "utf8"));
  const cols = rows.length ? labelColumns(Object.keys(rows[0])) : null;
  if (!cols) throw new Error(`${file}: needs an image column and a grade column`);
  return new Map(rows.filter((r) => /^[0-4]$/.test((r[cols.grade] ?? "").trim())).map((r) => [stem(r[cols.image]), Number(r[cols.grade])]));
}
function readScores(file: string) {
  const m = new Map<string, number>();
  for (const r of parseCsv(readFileSync(file, "utf8"))) {
    if (r.status !== "ok") continue;
    m.set(stem(r.image), Number(r.p2) + Number(r.p3) + Number(r.p4));
  }
  return m;
}

export function screeningReport(o: { validation: string; test: string; runs: { name: string; csv: string }[]; referSens?: number; clearSens?: number; name?: string; out?: string }) {
  const referSens = o.referSens ?? 0.95, clearSens = o.clearSens ?? 0.99;
  const val = readLabels(o.validation), test = readLabels(o.test);
  const overlap = [...val.keys()].filter((id) => test.has(id)).length;
  if (overlap) throw new Error(`${overlap} image(s) are in both the validation and the test labels: the test set must be untouched`);
  const results = o.runs.map((r) => {
    const s = readScores(r.csv);
    const rowsOf = (lab: Map<string, number>) => [...lab].filter(([id]) => s.has(id)).map(([id, ref]) => ({ id, ref, score: s.get(id)! }));
    const v = rowsOf(val), t = rowsOf(test);
    const refer = cutoffForSensitivity(v, referSens), clear0 = cutoffForSensitivity(v, clearSens);
    if (refer == null || clear0 == null) throw new Error(`${r.name}: no referable validation eyes`);
    const clear = Math.min(clear0, refer);
    const operating = [0.9, 0.95, 0.975, 0.99].map((target) => {
      const c = cutoffForSensitivity(v, target)!;
      return { target, cut: c, val: screeningFigures(v, c, c), test: screeningFigures(t, c, c) };
    });
    return { ...r, v, t, refer, clear, valFig: screeningFigures(v, refer, clear), testFig: screeningFigures(t, refer, clear),
             testIv: screeningIntervals(t, refer, clear), twoWay: screeningFigures(t, refer, refer), twoWayIv: screeningIntervals(t, refer, refer), operating };
  });
  const L: string[] = [
    `# Screening evaluation: ${o.name ?? results.map((r) => r.name).join(" vs ")}`, "",
    "**Research use only.** Outcome: referable DR (moderate NPDR or worse) - does the eye need an ophthalmologist? Five-class grading is secondary.",
    "The DR outcome alone never clears a patient: suspected macular oedema, symptoms and image quality need a person.", "",
    `Validation: ${path.basename(o.validation)} (${val.size} images, used ONLY to choose cut-offs). Test: ${path.basename(o.test)} (${test.size} images, untouched: cut-offs applied once). No image is in both.`,
    `Referral score = p2+p3+p4. Refer cut-off: highest that refers >= ${pc(referSens)} of validation referable eyes; clear cut-off: highest that refers >= ${pc(clearSens)}. REFER >= refer cut-off; UNCERTAIN between (a person decides, never cleared); ROUTINE below the clear cut-off. Images are resampled one by one (patients unknown).`, "",
    "## Three-outcome screening on the TEST images (cut-offs from validation)", "",
    `| Measure | ${results.map((r) => r.name).join(" | ")} |`, `|---|${results.map(() => "---").join("|")}|`,
    `| Cut-offs (refer / clear) | ${results.map((r) => `${cut(r.refer)} / ${cut(r.clear)}`).join(" | ")} |`,
    `| **Sensitivity (referable not cleared)** | ${results.map((r) => `**${pc(r.testFig.sensitivity)}**${iv(r.testIv.sensitivity)}`).join(" | ")} |`,
    `| Severe NPDR cleared (missed) | ${results.map((r) => `${r.testFig.missedByGrade[1].missed} of ${r.testFig.missedByGrade[1].eyes}`).join(" | ")} |`,
    `| Proliferative DR cleared (missed) | ${results.map((r) => `${r.testFig.missedByGrade[2].missed} of ${r.testFig.missedByGrade[2].eyes}`).join(" | ")} |`,
    `| Moderate NPDR cleared (missed) | ${results.map((r) => `${r.testFig.missedByGrade[0].missed} of ${r.testFig.missedByGrade[0].eyes}`).join(" | ")} |`,
    `| Specificity (non-referable cleared) | ${results.map((r) => `${pc(r.testFig.specificity)}${iv(r.testIv.specificity)}`).join(" | ")} |`,
    `| NPV (cleared eyes truly non-referable) | ${results.map((r) => `${pc(r.testFig.npv)}${iv(r.testIv.npv)}`).join(" | ")} |`,
    `| Referral rate (refer + uncertain) | ${results.map((r) => `${pc(r.testFig.referralRate)}${iv(r.testIv.referralRate)}`).join(" | ")} |`,
    `| Refer / uncertain / routine | ${results.map((r) => `${r.testFig.refer} / ${r.testFig.uncertain} / ${r.testFig.routine}`).join(" | ")} |`,
    `| Validation check: sensitivity / specificity | ${results.map((r) => `${pc(r.valFig.sensitivity)} / ${pc(r.valFig.specificity)}`).join(" | ")} |`, "",
    "## Two-outcome screening at the refer cut-off only (no uncertain band), TEST images", "",
    `| Measure | ${results.map((r) => r.name).join(" | ")} |`, `|---|${results.map(() => "---").join("|")}|`,
    `| Sensitivity | ${results.map((r) => `${pc(r.twoWay.sensitivity)}${iv(r.twoWayIv.sensitivity)}`).join(" | ")} |`,
    `| Specificity | ${results.map((r) => `${pc(r.twoWay.specificity)}${iv(r.twoWayIv.specificity)}`).join(" | ")} |`,
    `| NPV | ${results.map((r) => `${pc(r.twoWay.npv)}${iv(r.twoWayIv.npv)}`).join(" | ")} |`,
    `| Referral rate | ${results.map((r) => `${pc(r.twoWay.referralRate)}${iv(r.twoWayIv.referralRate)}`).join(" | ")} |`,
    `| Severe / PDR missed | ${results.map((r) => `${r.twoWay.missedByGrade[1].missed} / ${r.twoWay.missedByGrade[2].missed}`).join(" | ")} |`, "",
    "## Operating points (cut-off chosen on validation for each target, then test)", "",
    "| Model | Target sensitivity (validation) | Cut-off | Test sensitivity | Severe / PDR missed | Test specificity | Test NPV | Test referral rate |", "|---|---|---|---|---|---|---|---|",
    ...results.flatMap((r) => r.operating.map((p) => `| ${r.name} | ${pc(p.target)} | ${cut(p.cut)} | ${pc(p.test.sensitivity)} | ${p.test.missedByGrade[1].missed} / ${p.test.missedByGrade[2].missed} | ${pc(p.test.specificity)} | ${pc(p.test.npv)} | ${pc(p.test.referralRate)} |`)), "",
    "## Severe NPDR and PDR eyes cleared on test (image ids, for review)", "",
    ...results.map((r) => `- ${r.name}: ${r.testFig.missedIds.join(", ") || "none"}`), "",
    "## Reproducibility",
    `- Runs: ${o.runs.map((r) => `${r.name} = ${r.csv}`).join("; ")}.`,
    `- Intervals: percentile bootstrap, ${BOOTSTRAP.resamples} resamples of single images, seed ${BOOTSTRAP.seed}; cut-offs held fixed.`,
    `- Made ${new Date().toISOString()} with node dist/cli.js retina-eval-screening.`, "",
  ];
  const dir = o.out ?? path.join(APP_ROOT, "outputs", "retina-eval");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screening-${(o.name ?? "models").replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(file, L.join("\n"));
  for (const r of results)
    console.log(`${r.name}: test sensitivity ${pc(r.testFig.sensitivity)}, specificity ${pc(r.testFig.specificity)}, NPV ${pc(r.testFig.npv)}, referral rate ${pc(r.testFig.referralRate)}, severe/PDR cleared ${r.testFig.missedByGrade[1].missed}/${r.testFig.missedByGrade[2].missed}`);
  console.log(`Report: ${file}`);
}
