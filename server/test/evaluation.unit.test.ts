// Retina AI evaluation metrics (D-043) without a database: every figure checked against values worked out by hand.
//   npx tsx test/evaluation.unit.test.ts
import assert from "node:assert/strict";
import { auroc, bootstrapIntervals, computeMetrics, evaluate, reportMarkdown, seeded, STATS, toCsv, type EvalRow } from "../src/services/evaluation.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
const near = (a: number | null | undefined, b: number, msg = "") => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);

// 8 eyes of 4 patients: (reference, model)
const pairs: [number, number][] = [[0, 0], [0, 0], [0, 2], [1, 1], [2, 1], [2, 2], [3, 4], [4, 4]];
const rows: EvalRow[] = pairs.map(([ref, pred], i) => ({ cluster: `P${Math.floor(i / 2)}`, ref, pred, probs: null }));

check("confusion matrix (rows reference), exact and within-one agreement", () => {
  const m = computeMetrics(rows);
  assert.equal(m.n, 8); assert.equal(m.patients, 4);
  assert.deepEqual(m.confusion, [[2, 0, 1, 0, 0], [0, 1, 0, 0, 0], [0, 1, 1, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 1]]);
  near(m.accuracy, 5 / 8); near(m.withinOne, 7 / 8);
});

check("per-grade recall, precision, specificity, F1 and macro-F1 (worked by hand)", () => {
  const c = computeMetrics(rows).perClass;
  near(c[0].recall, 2 / 3); near(c[0].precision, 1); near(c[0].specificity, 1); near(c[0].f1, 0.8);
  near(c[1].recall, 1); near(c[1].precision, 0.5); near(c[1].specificity, 6 / 7); near(c[1].f1, 2 / 3);
  near(c[2].recall, 0.5); near(c[2].precision, 0.5); near(c[2].f1, 0.5);
  near(c[3].recall, 0); assert.equal(c[3].precision, null, "never predicted"); near(c[3].f1, 0);
  near(c[4].recall, 1); near(c[4].precision, 0.5); near(c[4].f1, 2 / 3);
  near(computeMetrics(rows).macroF1, (0.8 + 2 / 3 + 0.5 + 0 + 2 / 3) / 5);
});

check("referable DR (grade 2 or worse): 3 found, 1 missed, 1 false alarm, 3 correctly clear", () => {
  const r = computeMetrics(rows).referable;
  assert.deepEqual([r.tp, r.fn, r.fp, r.tn], [3, 1, 1, 3]);
  near(r.sensitivity, 0.75); near(r.specificity, 0.75); near(r.ppv, 0.75); near(r.npv, 0.75);
});

check("AUROC: hand example 0.75, ties count half, one class only gives no value, uses p2+p3+p4", () => {
  near(auroc([0.9, 0.8, 0.3, 0.1], [true, false, true, false]), 0.75);
  near(auroc([0.5, 0.5], [true, false]), 0.5);
  assert.equal(auroc([0.1, 0.2], [false, false]), null);
  const p = (ref: number, s: number): EvalRow => ({ cluster: String(ref) + s, ref, pred: 0, probs: [1 - s, 0, s, 0, 0] });
  near(computeMetrics([p(3, 0.9), p(0, 0.1), p(2, 0.4), p(1, 0.6)]).auroc, 0.75, "pos {0.9,0.4} vs neg {0.1,0.6}: 3 of 4 pairs (only 0.4 < 0.6 loses)");
  assert.equal(computeMetrics(rows).auroc, null, "no class scores, no AUROC");
});

check("the bootstrap is reproducible, resamples whole patients, and gives no interval where a figure is mostly undefined", () => {
  const a = bootstrapIntervals(rows, STATS, 500), b = bootstrapIntervals(rows, STATS, 500);
  assert.deepEqual(a, b, "same seed, same intervals");
  assert.ok(a.accuracy && a.accuracy[0] <= 5 / 8 && 5 / 8 <= a.accuracy[1]);
  const one: EvalRow[] = rows.map((r) => ({ ...r, cluster: "same patient" }));
  const c = bootstrapIntervals(one, STATS, 200);
  near(c.accuracy![0], 5 / 8); near(c.accuracy![1], 5 / 8, "one patient: every resample is the whole set");
  const noRef: EvalRow[] = [{ cluster: "a", ref: 0, pred: 0, probs: null }, { cluster: "b", ref: 1, pred: 0, probs: null }];
  assert.equal(bootstrapIntervals(noRef, STATS, 200).sensitivity, null, "no referable eyes: no sensitivity interval");
  const r = seeded(1); const xs = Array.from({ length: 1000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1) && Math.abs(xs.reduce((s, x) => s + x, 0) / 1000 - 0.5) < 0.05);
});

check("cautions say plainly when the set is too small to judge, and the report and CSV carry the figures", () => {
  const e = evaluate(rows, 2);
  assert.ok(e.cautions.some((c) => /Only 8 eye images/.test(c)));
  assert.ok(e.cautions.some((c) => /Only 4 referable-DR eyes/.test(c)));
  assert.ok(e.cautions.some((c) => /2 image\(s\) the doctor could not grade/.test(c)));
  const md = reportMarkdown({ title: "ZZ", dataset: ["d"], model: ["m"], reproducibility: ["r"] }, e);
  assert.match(md, /Referable DR sensitivity \| 75\.0%/); assert.match(md, /Research use only/); assert.match(md, /seed 20261025/);
  assert.equal(toCsv(["a", "b"], [["x,y", 'q"'], [1, null]]), 'a,b\r\n"x,y","q"""\r\n1,\r\n');
});

const { labelColumns, stem } = await import("../src/services/evalExternal.js");
check("public dataset labels: IDRiD, APTOS and Messidor-2 headers are recognised; file names match with or without extension", () => {
  assert.deepEqual(labelColumns(["Image name", "Retinopathy grade", "Risk of macular edema "]), { image: "image name", grade: "retinopathy grade" });
  assert.deepEqual(labelColumns(["id_code", "diagnosis"]), { image: "id_code", grade: "diagnosis" });
  assert.deepEqual(labelColumns(["image_id", "adjudicated_dr_grade", "adjudicated_dme", "adjudicated_gradable"]), { image: "image_id", grade: "adjudicated_dr_grade" });
  assert.equal(labelColumns(["foo", "bar"]), null);
  assert.equal(stem("IDRiD_001.jpg"), "idrid_001"); assert.equal(stem("C:\\x\\IDRiD_001.JPG"), "idrid_001"); assert.equal(stem("IDRiD_001"), "idrid_001");
});

console.log(`\n${passed} evaluation checks passed`);
