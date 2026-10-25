// The doctor's fundus report (D-042) end to end against a TEST database; the AI grader is a fake.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/fundus.test.ts
// Its users are zz_test_fun_*, its patient ZZ Test Fundus (Yarago id 990000103, MRD SPD99902), its photographs Remidio
// ids 9900101..; all removed afterwards.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { gradeNewPhotos } from "../src/services/remidioReceiver.js";
import { setGraderTransport } from "../src/services/retinaAi.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
const photoDir = mkdtempSync(path.join(tmpdir(), "zz-fundus-rep-"));
Object.assign(config.retinaAi, { photoDir, key: "fake-grader-key" });
setGraderTransport(async (_m, p) => p === "/health" ? { status: 200, data: { model_loaded: true } }
  : { status: 200, data: { grade: 2, probs: [0.1, 0.1, 0.6, 0.1, 0.1], raw: [0.1, 0.1, 0.6, 0.1, 0.1], calibration: "native_probabilities" } });

const PID = 990000103, MRD = "SPD99902", IDS = "remidio_image_id BETWEEN 9900101 AND 9900199";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 3)]);
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos DISABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports DISABLE TRIGGER fundus_reports_guard;
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS}));
    DELETE FROM app.dr_grading_views WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS}));
    DELETE FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS});
    DELETE FROM app.fundus_reports WHERE patient_id = ${PID};
    DELETE FROM app.fundus_photos WHERE ${IDS};
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos ENABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports ENABLE TRIGGER fundus_reports_guard;
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_fun%') OR patient_id = ${PID};
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_fun%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_fun%';
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id = ${PID};
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_fun_doc','ZZ Fun Doctor','doctor','${hash}',false), ('zz_test_fun_doc2','ZZ Fun Doctor Two','doctor','${hash}',false),
    ('zz_test_fun_opt','ZZ Fun Optometrist','optometrist','${hash}',false), ('zz_test_fun_staff','ZZ Fun Staff','staff','${hash}',false),
    ('zz_test_fun_admin','ZZ Fun Admin','admin','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name, tlast_name, tsex) VALUES (${PID}, '${MRD}', 'ZZ Test', 'Fundus', 'Female');
  COMMIT;`);
// one Remidio exam: right and left photographs, taken 24 Oct 2026 17:34 clinic time; the right one already AI-graded
mkdirSync(path.join(photoDir, "2026", "10"), { recursive: true });
const taken = "2026-10-24T17:34:54+05:30";
const photo = async (rid: number, eye: string) => {
  writeFileSync(path.join(photoDir, "2026", "10", `${rid}.jpg`), JPEG);
  return Number((await pool.query(`INSERT INTO app.fundus_photos (remidio_image_id, remidio_exam_id, mrn, patient_id, eye, field, quality, captured_at, bytes, sha256, file_path)
    VALUES ($1, 9900150, $2, $3, $4, 'MACULA', 'SUFFICIENT', $5, $6, 'x', $7) RETURNING id`, [rid, MRD, PID, eye, taken, JPEG.length, path.join("2026", "10", `${rid}.jpg`)])).rows[0].id);
};
const reId = await photo(9900101, "RE"), leId = await photo(9900102, "LE");
const reGrading = Number((await pool.query(`INSERT INTO app.dr_gradings (patient_id, mrd, eye, source, photo_id, status, ai_grade, probs)
  VALUES ($1, $2, 'RE', 'remidio', $3, 'ok', 1, '{0.1,0.6,0.1,0.1,0.1}') RETURNING id`, [PID, MRD, reId])).rows[0].id);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
async function login(u: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: pw } });
  assert.equal(r.statusCode, 200, `login ${u}`); return String(r.headers["set-cookie"]).split(";")[0];
}
const call = async (method: string, url: string, cookie: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: r.statusCode, body: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : null };
};
const key = { patientId: PID, examDate: "2026-10-24", examKey: 9900150 };
const report = { re: { dr: "moderate", dme: "non_centre", findings: ["hypertensive"] }, le: { dr: "none", dme: "none", findings: [] }, referral: "routine", comments: "ZZ check" };
const docId = async (u: string) => Number((await pool.query(`SELECT id FROM app.users WHERE username = $1`, [u])).rows[0].id);

try {
  const doc = await login("zz_test_fun_doc"), doc2 = await login("zz_test_fun_doc2"), opt = await login("zz_test_fun_opt");
  const staff = await login("zz_test_fun_staff"), admin = await login("zz_test_fun_admin");

  await step("the session is on the to-report list; clinical roles see it and its photographs, front desk does not", async () => {
    const s = (await call("GET", `/api/fundus/sessions?status=todo&patientId=${PID}`, opt)).body.sessions;
    assert.equal(s.length, 1); assert.equal(s[0].photos, 2); assert.equal(s[0].examDate, "2026-10-24"); assert.equal(s[0].reportId, null);
    assert.equal((await call("GET", `/api/fundus/sessions`, staff)).status, 403);
    assert.equal((await call("GET", `/api/retina-ai/photos/${reId}/image`, opt)).status, 200, "an optometrist sees the photograph");
    assert.equal((await call("GET", `/api/retina-ai/photos/${reId}/image`, staff)).status, 403);
    const one = (await call("GET", `/api/fundus/session?patientId=${PID}&examDate=2026-10-24&examKey=9900150`, opt)).body;
    assert.equal(one.photos.length, 2); assert.ok(!JSON.stringify(one).includes("aiGrade"), "no AI grade on the report screen");
  });
  await step("only doctors write; the form needs a DR grade, a referral, and words for 'other'", async () => {
    for (const c of [opt, admin, staff]) assert.equal((await call("POST", "/api/fundus/reports", c, { ...key, ...report })).status, 403);
    assert.equal((await call("POST", "/api/fundus/reports", doc, { ...key, ...report, re: { dr: null }, le: { dr: null } })).status, 400);
    assert.equal((await call("POST", "/api/fundus/reports", doc, { ...key, ...report, referral: undefined })).status, 400);
    assert.equal((await call("POST", "/api/fundus/reports", doc, { ...key, ...report, le: { dr: "none", findings: ["other"] } })).status, 400);
  });
  let reportId = 0;
  await step("a doctor writes the report; it is signed, and its grades become that doctor's blinded grades", async () => {
    const r = await call("POST", "/api/fundus/reports", doc, { ...key, ...report });
    assert.equal(r.status, 200); reportId = r.body.id;
    const g = (await pool.query(`SELECT grade, blinded, graded_by, note FROM app.dr_doctor_grades WHERE grading_id = $1`, [reGrading])).rows;
    assert.equal(g.length, 1); assert.equal(g[0].grade, 2, "moderate = 2"); assert.equal(g[0].blinded, true);
    assert.equal(Number(g[0].graded_by), await docId("zz_test_fun_doc")); assert.match(g[0].note, /fundus report/);
    const s = (await call("GET", `/api/fundus/sessions?status=reported&patientId=${PID}`, opt)).body.sessions[0];
    assert.equal(s.summary, "RE Moderate NPDR, LE No DR; refer, routine"); assert.equal(s.reportedBy, "ZZ Fun Doctor");
    assert.equal((await call("POST", "/api/fundus/reports", doc2, { ...key, ...report })).status, 409, "one report per session");
  });
  await step("when the AI grades the left photograph later, the report's left-eye grade is added to it", async () => {
    await gradeNewPhotos(app.log);
    const g = (await pool.query(`SELECT d.grade, d.blinded FROM app.dr_doctor_grades d JOIN app.dr_gradings g ON g.id = d.grading_id WHERE g.photo_id = $1`, [leId])).rows;
    assert.equal(g.length, 1); assert.equal(g[0].grade, 0, "no DR = 0"); assert.equal(g[0].blinded, true);
  });
  await step("a correction needs a reason; it keeps the signing doctor and records who corrected and why", async () => {
    const changed = { ...report, re: { ...report.re, dr: "severe" } };
    assert.equal((await call("PUT", `/api/fundus/reports/${reportId}`, doc2, changed)).status, 400, "no reason");
    assert.equal((await call("PUT", `/api/fundus/reports/${reportId}`, doc2, { ...changed, reason: "ZZ second look at the right eye" })).status, 200);
    const r = (await call("GET", `/api/fundus/session?patientId=${PID}&examDate=2026-10-24&examKey=9900150`, opt)).body.report;
    assert.equal(r.reDr, "severe"); assert.equal(r.reportedBy, "ZZ Fun Doctor"); assert.equal(r.amendedBy, "ZZ Fun Doctor Two");
    assert.equal(r.amendmentReason, "ZZ second look at the right eye");
    const g2 = (await pool.query(`SELECT grade FROM app.dr_doctor_grades WHERE grading_id = $1 AND graded_by = $2`, [reGrading, await docId("zz_test_fun_doc2")])).rows;
    assert.equal(g2[0].grade, 3, "the correcting doctor's grade: severe = 3");
  });
  await step("reports are kept for good: no delete, no change of patient or signer, no change without a reason", async () => {
    await assert.rejects(pool.query(`DELETE FROM app.fundus_reports WHERE id = $1`, [reportId]), /cannot be removed/);
    await assert.rejects(pool.query(`UPDATE app.fundus_reports SET patient_id = 1 WHERE id = $1`, [reportId]), /cannot change/);
    await assert.rejects(pool.query(`UPDATE app.fundus_reports SET comments = 'x' WHERE id = $1`, [reportId]), /needs a reason/);
  });
  await step("the activity log has the report sentences", async () => {
    const n = Number((await pool.query(`SELECT count(*) n FROM app.audit_feed WHERE entity_type = 'fundus_reports' AND summary LIKE '%fundus report of ZZ Test Fundus (SPD99902)%'`)).rows[0].n);
    assert.ok(n >= 2, "written and corrected");
  });
} finally {
  setGraderTransport(null);
  await cleanup();
  rmSync(photoDir, { recursive: true, force: true });
  await app.close(); await pool.end();
}
console.log(`\n${passed} fundus report checks passed`);
