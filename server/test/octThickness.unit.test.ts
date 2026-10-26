// Retinal thickness from layer lines (D-050) and the check against IMAGEnet: no database, synthetic scans only.
//   npx tsx test/octThickness.unit.test.ts      (also in npm run test:rules)
import assert from "node:assert/strict";
import { agreement, parseCsv } from "../src/services/octMeasure.js";
import { idInText, readReport } from "../src/services/octReport.js";
import { computeThickness, scanKind, sectorOf, type LayerGrid } from "../src/services/octThickness.js";

let passed = 0;
const step = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; } };
const LABELS = ["ILM", "RNFL/GCL", "IPL/INL", "IS/OS", "OS/RPE", "BM"];

/** A synthetic cube: B x W samples 0.1 mm apart (6.4 mm square), ILM at `ilm(u, v)` rows, OS/RPE 10 rows above BM. */
function cube(ilm: (u: number, v: number) => number, bm = 200, n = 64) {
  const data = new Int16Array(n * LABELS.length * n).fill(-1);
  for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
    const u = (c + 0.5 - n / 2) * 0.1, v = (b + 0.5 - n / 2) * 0.1;
    const set = (s: number, row: number) => { data[(b * LABELS.length + s) * n + c] = Math.round(row * 10); };
    set(0, ilm(u, v)); set(4, bm - 10); set(5, bm);
  }
  // scan lines on a photograph: B-scan b is horizontal at y = 100 + 10 b, from x = 100 to 740 (image right = +u, down = +v)
  const lines = Array.from({ length: n }, (_, b) => [100, 100 + 10 * b, 740, 100 + 10 * b]);
  return { g: { data, shape: [n, LABELS.length, n] as [number, number, number], scale: 10, labels: LABELS } as LayerGrid, lines };
}
const sp = { axialMm: 0.0026, lateralMm: 0.1, betweenMm: 0.1 };

step("ETDRS sectors: centre within 0.5 mm, rings at 1.5 and 3 mm, nasal on the disc's side (right eye: image right)", () => {
  assert.equal(sectorOf(0.2, 0.2, true), "C");
  assert.equal(sectorOf(1, 0, true), "N1"); assert.equal(sectorOf(1, 0, false), "T1");
  assert.equal(sectorOf(-2, 0, true), "T2"); assert.equal(sectorOf(-2, 0, false), "N2");
  assert.equal(sectorOf(0, -1, true), "S1"); assert.equal(sectorOf(0, 2.5, true), "I2");     // up on the photograph = superior
  assert.equal(sectorOf(3.1, 0, true), null);
  // the diagonals belong to exactly one sector each (a point on the lower-right diagonal was once counted temporal)
  assert.equal(sectorOf(1, 1, true), "I1"); assert.equal(sectorOf(1, -1, true), "S1");
  assert.equal(sectorOf(-1, 1, true), "T1"); assert.equal(sectorOf(-1, 1, false), "N1"); assert.equal(sectorOf(1.1, 1.1, true), "I2");
});
step("which scans are measured: 3D macula cubes and radial macula scans only", () => {
  assert.equal(scanKind("3D H/Macula/320/320/6x6mm/Angio", 320, sp), "cube");
  assert.equal(scanKind("Radial/Macula/1024/12/6mm", 12, { ...sp, betweenMm: null }), "radial");
  assert.equal(scanKind("3D H/Disc/512/128/6x6mm", 128, sp), null);
  assert.equal(scanKind("Line/Macula/1024/1/9mm", 1, sp), null);
});
step("a cube with a foveal pit: the centre is found at the pit, CST is its thickness, a flat ring elsewhere", () => {
  // flat ILM at row 100 (BM 200: 100 rows = 260 um), a pit 0.3 mm right and 0.2 mm down of the scan centre
  const { g, lines } = cube((u, v) => 100 + 60 * Math.exp(-((u - 0.3) ** 2 + (v - 0.2) ** 2) / 0.08));
  const t = computeThickness(g, sp, lines, "RE", "3D H/Macula/320/320/6x6mm")!;
  assert.equal(t.kind, "cube"); assert.equal(t.centre.method, "thinnest point");
  assert.ok(Math.abs(t.centre.uMm - 0.3) < 0.11 && Math.abs(t.centre.vMm - 0.2) < 0.11, JSON.stringify(t.centre));
  const r = t.results["ILM-BM"]!;
  // the central 1 mm average: between the pit floor (40 rows = 104 um) and the flat retina (260 um)
  assert.ok(r.cstUm! > 150 && r.cstUm! < 230, `CST ${r.cstUm}`);
  assert.equal(r.sectorsUm.S2, 260); assert.equal(r.sectorsUm.T2, 260);
  assert.equal(t.results["ILM-OS/RPE"]!.sectorsUm.S2, 234);                       // 90 rows
});
step("nasal and temporal follow the eye: a thicker image-right half is nasal in a right eye, temporal in a left eye", () => {
  // image right: 120 rows = 312 um; a small foveal pit at the scan centre, as in a real macula, fixes the grid's centre
  const { g, lines } = cube((u, v) => (u > 0 ? 80 : 100) + 50 * Math.exp(-(u * u + v * v) / 0.02));
  const re = computeThickness(g, sp, lines, "RE", "3D H/Macula/320/320/6x6mm")!.results["ILM-BM"]!.sectorsUm;
  const le = computeThickness(g, sp, lines, "LE", "3D H/Macula/320/320/6x6mm")!.results["ILM-BM"]!.sectorsUm;
  assert.equal(re.N2, 312); assert.equal(re.T2, 260);
  assert.equal(le.N2, 260); assert.equal(le.T2, 312);
});
step("missing layer points: a sector less than half measured is left empty, not guessed", () => {
  const { g, lines } = cube(() => 100);
  for (let b = 0; b < 64; b++) for (let c = 0; c < 64; c++) if ((b + 0.5 - 32) * 0.1 < -1.5) g.data[(b * 6 + 0) * 64 + c] = -1;   // no ILM in the top
  const r = computeThickness(g, sp, lines, "RE", "3D H/Macula/320/320/6x6mm")!.results["ILM-BM"]!;
  assert.equal(r.sectorsUm.S2, null); assert.equal(r.sectorsUm.I2, 260); assert.equal(r.cstUm, 260);
});
step("a radial scan: lines through the centre, centre = where they cross", () => {
  const n = 12, w = 64, data = new Int16Array(n * 6 * w);
  for (let b = 0; b < n; b++) for (let c = 0; c < w; c++) { data[(b * 6) * w + c] = 1000; data[(b * 6 + 4) * w + c] = 1900; data[(b * 6 + 5) * w + c] = 2000; }
  const lines = Array.from({ length: n }, (_, b) => { const a = (b * Math.PI) / n; return [400 - 300 * Math.cos(a), 400 - 300 * Math.sin(a), 400 + 300 * Math.cos(a), 400 + 300 * Math.sin(a)]; });
  const t = computeThickness({ data, shape: [n, 6, w], scale: 10, labels: LABELS }, { axialMm: 0.0026, lateralMm: 0.09375, betweenMm: null }, lines, "LE", "Radial/Macula/1024/12/6mm")!;
  assert.equal(t.kind, "radial"); assert.equal(t.centre.method, "scan centre");
  assert.equal(t.results["ILM-BM"]!.cstUm, 260);
  assert.ok(Object.values(t.results["ILM-BM"]!.sectorsUm).every((x) => x === 260));
});
step("no eye, no layers, or a scan that is not a macula cube or radial: not measured", () => {
  const { g, lines } = cube(() => 100);
  assert.equal(computeThickness(g, sp, lines, null, "3D H/Macula/320/320/6x6mm"), null);
  assert.equal(computeThickness(g, sp, lines, "RE", "3D H/Disc/512/128/6x6mm"), null);
  assert.equal(computeThickness({ ...g, labels: ["ILM", "RPE"] }, sp, lines, "RE", "3D H/Macula/320/320/6x6mm"), null);
});
step("agreement with IMAGEnet: bias, SD, 95% limits, mean and largest difference, r", () => {
  const a = agreement([[260, 255], [300, 296], [250, 248], [410, 400]])!;
  assert.equal(a.n, 4); assert.equal(a.biasUm, 5.3); assert.equal(a.maxAbsUm, 10); assert.equal(a.maeUm, 5.3);
  assert.equal(a.sdUm, 3.4); assert.deepEqual(a.loaUm, [-1.4, 11.9]); assert.ok(a.r! > 0.99);   // differences 5, 4, 2, 10
  assert.equal(agreement([[1, 2]]), null);
});
step("the check sheet reads back as written (quotes, commas, Excel's BOM and line ends)", () => {
  const rows = parseCsv('scan,patient,imagenet_cst_um\r\n12,"ZZ, Test ""A""",255\r\n13,ZZ B,\r\n'.replace(/^/, ""));
  assert.deepEqual(rows[1], ["12", 'ZZ, Test "A"', "255"]); assert.deepEqual(rows[2], ["13", "ZZ B", ""]);
});
step("an IMAGEnet report's text: dates, eye, layer definition, CST candidates; IS/OS is not the left eye", () => {
  const r = readReport("Name: ZZ Test  ID: SPD0412\nDOB 1960/03/04  Exam date 26-Oct-2026 10:41\nOD  3D Macula\n"
    + "Retina (ILM - RPE/BM)  IS/OS\nCenter: 245 µm  Inner superior 310\nTotal volume 8.71 mm3\n");
  assert.deepEqual(r.dates, ["1960-03-04", "2026-10-26"]); assert.deepEqual(r.eyes, ["RE"]);
  assert.deepEqual(r.definitions, ["ILM-RPE/BM", "Retina"]); assert.deepEqual(r.cst, [{ label: "center", um: 245 }]);
  assert.deepEqual(readReport("Left eye 04/11/2026 Central subfield thickness 0.4 mm 251").dates, ["2026-04-11", "2026-11-04"]);
  assert.deepEqual(readReport("Left eye  CST 251").eyes, ["LE"]);
});
step("the report's patient ID: SPD number with or without zeros; a bare number only after an ID label", () => {
  assert.equal(idInText("ID: SPD0412", "SPD412"), "strong"); assert.equal(idInText("Patient ID 412 ", "SPD412"), "number only");
  assert.equal(idInText("Center 412 µm", "SPD412"), null); assert.equal(idInText("ID: SPD4120", "SPD412"), null);
});
console.log(`\n${passed} OCT thickness checks passed`);
