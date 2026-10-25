// Retina AI (D-040) without a database: agreement figures, the grader's answers, the batch file readers.
//   npx tsx test/retina.unit.test.ts
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { HttpError } from "../src/lib/errors.js";
import { agreement, gradeImage, graderHealth, quadraticKappa, setGraderTransport } from "../src/services/retinaAi.js";
import { eyeFrom, normaliseMrd, parseCsv } from "../src/services/retinaImport.js";
import { ROLE_PERMISSIONS, can } from "../src/lib/permissions.js";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
const near = (a: number | null, b: number, msg?: string) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} != ${b}`);

await check("only admin and doctors may use the retina AI (not managers, who get everything else)", () => {
  assert.ok(can("admin", "retina_ai.use"));
  assert.ok(can("doctor", "retina_ai.use"));
  for (const r of ["manager", "staff", "optometrist", "counsellor"] as const) assert.ok(!can(r, "retina_ai.use"), r);
  assert.ok(ROLE_PERMISSIONS.admin.includes("users.manage"), "admin keeps every other permission");
});

await check("kappa: perfect agreement 1, none possible null, known value matches the grader's Python formula", () => {
  near(quadraticKappa([0, 1, 2, 3, 4].map((g) => ({ ai: g, doctor: g }))), 1);
  assert.equal(quadraticKappa([]), null);
  assert.equal(quadraticKappa([{ ai: 2, doctor: 2 }, { ai: 2, doctor: 2 }]), null, "one grade only: kappa undefined");
  // same pairs through batch_import.py's quadratic_weighted_kappa formula (run in Python, 25 Oct 2026): 0.8518518518518519
  near(quadraticKappa([{ doctor: 0, ai: 0 }, { doctor: 1, ai: 2 }, { doctor: 2, ai: 2 }, { doctor: 4, ai: 3 }]), 23 / 27);
});

await check("agreement: exact, within one, confusion rows = doctor, referable = grade 2 or worse", () => {
  const a = agreement([{ doctor: 0, ai: 0 }, { doctor: 0, ai: 2 }, { doctor: 2, ai: 1 }, { doctor: 3, ai: 3 }, { doctor: 4, ai: 0 }]);
  assert.equal(a.n, 5); assert.equal(a.exact, 2); assert.equal(a.withinOne, 3);
  assert.equal(a.confusion[2][1], 1); assert.equal(a.confusion[0][2], 1);
  assert.deepEqual({ tp: a.referable.tp, fn: a.referable.fn, fp: a.referable.fp, tn: a.referable.tn }, { tp: 1, fn: 2, fp: 1, tn: 1 });
  near(a.referable.sensitivity, 1 / 3); near(a.referable.specificity, 1 / 2);
  assert.equal(agreement([]).referable.sensitivity, null);
});

const calls: { path: string; headers?: Record<string, string>; bytes?: number }[] = [];
let next: { status: number; data: any } | Error = { status: 200, data: {} };
setGraderTransport(async (_m, path, body, headers) => {
  calls.push({ path, headers, bytes: body?.length });
  if (next instanceof Error) throw next;
  return next;
});
config.retinaAi.key = "fake-grader-key";
const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

await check("a graded photograph comes back with all five scores; only the file name goes with it", async () => {
  next = { status: 200, data: { grade: 2, probs: [0.1, 0.1, 0.6, 0.1, 0.1], raw: [0.1, 0.1, 0.6, 0.1, 0.1], calibration: "native_probabilities",
           inference_ms: 410, preprocess_ms: 12, image_sha256: "ab", width: 2866, height: 2866, model_sha256: "cd4b", app_version: "1.1.0" } };
  const o = await gradeImage(img, "SPD12765 right.jpg", "image/jpeg");
  assert.equal(o.kind, "ok");
  if (o.kind === "ok") { assert.equal(o.result.grade, 2); assert.equal(o.result.probs.length, 5); assert.equal(o.result.width, 2866); }
  const c = calls.at(-1)!;
  assert.equal(c.path, "/api/grade"); assert.equal(c.bytes, img.length);
  assert.equal(c.headers?.["x-file-name"], "SPD12765%20right.jpg");
  assert.deepEqual(Object.keys(c.headers ?? {}).sort(), ["content-type", "x-file-name"], "no patient fields are sent");
});

await check("an unreadable photograph is 'rejected' with the grader's words; a malformed answer is 'error'", async () => {
  next = { status: 422, data: { error: "image", message: "Image is only 40x40 pixels — too small to be a fundus photograph." } };
  const o = await gradeImage(img, "a.jpg", "image/jpeg");
  assert.deepEqual(o, { kind: "rejected", message: "Image is only 40x40 pixels — too small to be a fundus photograph." });
  next = { status: 200, data: { grade: 7, probs: [1] } };
  assert.equal((await gradeImage(img, "a.jpg", "image/jpeg")).kind, "error");
  next = { status: 500, data: { error: "failed" } };
  assert.equal((await gradeImage(img, "a.jpg", "image/jpeg")).kind, "error");
});

await check("grader down, wrong key, model loading or no key: 503 in plain words, nothing graded", async () => {
  for (const [n, words] of [[new TypeError("fetch failed"), "does not answer"], [{ status: 401, data: {} }, "key"],
                            [{ status: 503, data: {} }, "not loaded"], [{ status: 404, data: {} }, "older version"]] as const) {
    next = n as any;
    await assert.rejects(gradeImage(img, "a.jpg", "image/jpeg"), (e: any) => e instanceof HttpError && e.status === 503 && e.message.includes(words));
  }
  config.retinaAi.key = "";
  const before = calls.length;
  await assert.rejects(gradeImage(img, "a.jpg", "image/jpeg"), (e: any) => e.status === 503 && /RETINA_AI_KEY/.test(e.message));
  assert.equal(calls.length, before, "no call without a key");
  config.retinaAi.key = "fake-grader-key";
});

await check("health: ready only when the model is loaded; an unreachable grader is not an error", async () => {
  next = { status: 200, data: { model_loaded: true, output_calibration: "native_probabilities", app_version: "1.1.0" } };
  assert.equal((await graderHealth()).ready, true);
  next = { status: 503, data: { model_loaded: false, error: "load failed" } };
  const h = await graderHealth(); assert.equal(h.ready, false); assert.equal(h.reachable, true);
  next = new TypeError("fetch failed");
  assert.equal((await graderHealth()).reachable, false);
});

await check("eye words from the old grader and metadata.csv", () => {
  assert.equal(eyeFrom("Right (OD)"), "RE"); assert.equal(eyeFrom("Left (OS)"), "LE");
  assert.equal(eyeFrom("RE"), "RE"); assert.equal(eyeFrom("l"), "LE"); assert.equal(eyeFrom("OD"), "RE");
  assert.equal(eyeFrom("Not specified"), null); assert.equal(eyeFrom(""), null); assert.equal(eyeFrom(undefined), null);
});

await check("MRDs typed as digits find the SPD number, as patient search does (the old grader's records)", () => {
  assert.equal(normaliseMrd("12765"), "SPD12765"); assert.equal(normaliseMrd("spd 1276"), "SPD1276");
  assert.equal(normaliseMrd(" SPD12765 "), "SPD12765"); assert.equal(normaliseMrd("ndc_x1"), "NDC_X1");
  assert.equal(normaliseMrd("123456"), "123456", "six digits is not an SPD number"); assert.equal(normaliseMrd(null), "");
});

await check("metadata.csv: header, quotes, commas inside quotes, BOM, Windows line ends, blank lines", () => {
  const rows = parseCsv('﻿filename,mrd_no,eye,reference_grade\r\n"a,1.jpg",SPD12765,Right (OD),2\r\n\r\nb.jpg,SPD1,"Left ""OS""",\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { filename: "a,1.jpg", mrd_no: "SPD12765", eye: "Right (OD)", reference_grade: "2" });
  assert.equal(rows[1].eye, 'Left "OS"'); assert.equal(rows[1].reference_grade, "");
  assert.deepEqual(parseCsv(""), []);
});

setGraderTransport(null);
console.log(`\n${passed} retina AI checks passed`);
