// Retina AI (D-040) end to end against a TEST database, with the grader replaced by a fake (no Docker, no model).
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/retina.test.ts
// Its users are zz_test_ret_*, its patient ZZ Test Retina (Yarago id 990000101, MRD ZZT90101); all removed afterwards.
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { setGraderTransport } from "../src/services/retinaAi.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
config.retinaAi.key = "fake-grader-key";

// ---------- fake grader ----------
let graderNext: { status: number; data: any } | Error | null = null;
const graderCalls: { path: string; headers?: Record<string, string> }[] = [];
setGraderTransport(async (_m, path, _body, headers) => {
  graderCalls.push({ path, headers });
  if (graderNext) { const n = graderNext; graderNext = null; if (n instanceof Error) throw n; return n; }
  if (path === "/health") return { status: 200, data: { model_loaded: true, output_calibration: "native_probabilities", app_version: "1.1.0" } };
  return { status: 200, data: { grade: 3, probs: [0.01, 0.02, 0.07, 0.85, 0.05], raw: [0.01, 0.02, 0.07, 0.85, 0.05],
           calibration: "native_probabilities", preprocess_ms: 10, inference_ms: 400, image_sha256: "f".repeat(64),
           width: 2000, height: 2000, model_repo: "Arko007/diabetic-retinopathy-v1", model_commit: "05e5b0f", model_sha256: "cd4b10c3", app_version: "1.1.0" } };
});

// ---------- fixtures ----------
const PID = 990000101, MRD = "ZZT90101";
const MINE = `(SELECT id FROM app.dr_gradings WHERE patient_id = ${PID} OR mrd = '${MRD}')`;
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard;
    DELETE FROM app.dr_grading_views WHERE grading_id IN ${MINE};
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN ${MINE};
    DELETE FROM app.dr_gradings WHERE id IN ${MINE};
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard;
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_ret%') OR patient_id = ${PID};
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_ret%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_ret%';
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id = ${PID};
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9";
const hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_ret_admin','ZZ Ret Admin','admin','${hash}',false), ('zz_test_ret_doc','ZZ Ret Doctor','doctor','${hash}',false),
    ('zz_test_ret_doc2','ZZ Ret Doctor Two','doctor','${hash}',false), ('zz_test_ret_mgr','ZZ Ret Manager','manager','${hash}',false),
    ('zz_test_ret_staff','ZZ Ret Staff','staff','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name, tlast_name) VALUES (${PID}, '${MRD}', 'ZZ Test', 'Retina');
  COMMIT;`);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
type Res = { status: number; body: any };
async function call(method: string, url: string, cookie: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
async function login(username: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: pw } });
  assert.equal(r.statusCode, 200, `login ${username}`);
  return String(r.headers["set-cookie"]).split(";")[0];
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const upload = (cookie: string, q: string, body: Buffer = JPEG, type = "image/jpeg", name = "ZZ photo.jpg") =>
  call("POST", `/api/retina-ai/grade?${q}`, cookie, body, { "content-type": type, "x-file-name": encodeURIComponent(name) });
const count = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

try {
  const admin = await login("zz_test_ret_admin"), doc = await login("zz_test_ret_doc"), doc2 = await login("zz_test_ret_doc2");
  const mgr = await login("zz_test_ret_mgr"), staff = await login("zz_test_ret_staff");
  const docId = Number((await pool.query(`SELECT id FROM app.users WHERE username = 'zz_test_ret_doc'`)).rows[0].id);

  console.log("who may");
  await step("managers and front desk may not use the retina AI, not even read it", async () => {
    for (const c of [mgr, staff]) {
      assert.equal((await call("GET", "/api/retina-ai/status", c)).status, 403);
      assert.equal((await call("GET", "/api/retina-ai/gradings", c)).status, 403);
      assert.equal((await call("GET", "/api/retina-ai/agreement", c)).status, 403);
      assert.equal((await upload(c, `patientId=${PID}&eye=RE`)).status, 403);
    }
    assert.equal((await call("GET", "/api/auth/me", mgr)).body.user.permissions.includes("retina_ai.use"), false);
    assert.equal((await call("GET", "/api/auth/me", doc)).body.user.permissions.includes("retina_ai.use"), true);
  });
  await step("status shows the grader as ready", async () => {
    const r = await call("GET", "/api/retina-ai/status", doc);
    assert.equal(r.status, 200); assert.equal(r.body.grader.ready, true); assert.equal(r.body.grades.length, 5);
  });

  console.log("grading");
  let blindId = 0;
  await step("a doctor grades blinded: the AI grade is saved but not returned or logged as seen", async () => {
    const r = await upload(doc, `patientId=${PID}&eye=RE&blind=true`);
    assert.equal(r.status, 200); assert.equal(r.body.aiHidden, true);
    assert.equal(r.body.grading.status, "ok"); assert.equal(r.body.grading.aiGrade, undefined); assert.equal(r.body.grading.probs, undefined);
    blindId = r.body.grading.id;
    assert.equal(await count(`SELECT count(*) n FROM app.dr_gradings WHERE id = $1 AND ai_grade = 3 AND array_length(probs,1) = 5`, [blindId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_grading_views WHERE grading_id = $1`, [blindId]), 0);
    const sent = graderCalls.at(-1)!;
    assert.equal(sent.path, "/api/grade"); assert.ok(!JSON.stringify(sent.headers).includes(MRD), "no MRD sent to the grader");
  });
  await step("their grade, given before seeing the AI grade, is blinded; the AI grade then shows and the view is logged", async () => {
    const g = await call("PUT", `/api/retina-ai/gradings/${blindId}/my-grade`, doc, { grade: 2, ungradable: false, note: "" });
    assert.equal(g.status, 200); assert.equal(g.body.blinded, true);
    const d = await call("GET", `/api/retina-ai/gradings/${blindId}`, doc);
    assert.equal(d.body.grading.aiGrade, 3); assert.equal(d.body.doctorGrades[0].blinded, true); assert.equal(d.body.doctorGrades[0].mine, true);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_grading_views WHERE grading_id = $1 AND user_id = $2`, [blindId, docId]), 1);
  });
  await step("changing the grade after seeing the AI grade makes it not blinded", async () => {
    const g = await call("PUT", `/api/retina-ai/gradings/${blindId}/my-grade`, doc, { grade: 3, ungradable: false, note: "second look" });
    assert.equal(g.body.blinded, false);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_doctor_grades WHERE grading_id = $1`, [blindId]), 1, "one grade per doctor");
  });
  await step("another doctor's to-grade list has it, without the AI grade", async () => {
    const r = await call("GET", "/api/retina-ai/to-grade", doc2);
    const row = r.body.gradings.find((x: any) => x.id === blindId);
    assert.ok(row); assert.equal(row.aiGrade, undefined); assert.equal(row.aiSeen, false);
    assert.ok(!(await call("GET", "/api/retina-ai/to-grade", doc)).body.gradings.some((x: any) => x.id === blindId), "not on the grader's own list");
  });
  let openId = 0;
  await step("admin grades without hiding: the AI grade comes back and is logged as seen", async () => {
    const r = await upload(admin, `patientId=${PID}&eye=LE`);
    assert.equal(r.body.grading.aiGrade, 3); assert.equal(r.body.grading.probs.length, 5); assert.equal(r.body.grading.eye, "LE");
    openId = r.body.grading.id;
    const g = await call("PUT", `/api/retina-ai/gradings/${openId}/my-grade`, admin, { grade: 3, ungradable: false });
    assert.equal(g.body.blinded, false);
  });
  await step("not gradable is a grade of its own; a grade and 'not gradable' together are refused", async () => {
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${openId}/my-grade`, doc2, { grade: null, ungradable: true })).status, 200);
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${openId}/my-grade`, doc2, { grade: 1, ungradable: true })).status, 400);
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${openId}/my-grade`, doc2, { grade: 5, ungradable: false })).status, 400);
  });
  await step("an unreadable photograph is recorded as not graded, with the grader's words", async () => {
    graderNext = { status: 422, data: { error: "image", message: "The file is empty (0 bytes)." } };
    const r = await upload(doc, `patientId=${PID}&eye=RE`);
    assert.equal(r.status, 200); assert.equal(r.body.grading.status, "rejected"); assert.match(r.body.grading.error, /empty/);
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${r.body.grading.id}/my-grade`, doc, { grade: 1, ungradable: false })).status, 400);
  });
  await step("grader down: 503 in plain words and nothing saved", async () => {
    const before = await count(`SELECT count(*) n FROM app.dr_gradings WHERE patient_id = $1`, [PID]);
    graderNext = new TypeError("fetch failed");
    const r = await upload(doc, `patientId=${PID}&eye=RE`);
    assert.equal(r.status, 503); assert.match(r.body.message, /not available/);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_gradings WHERE patient_id = $1`, [PID]), before);
  });
  await step("wrong file type, no eye, unknown patient, too big and other sites are refused", async () => {
    const txt = await upload(doc, `patientId=${PID}&eye=RE`, Buffer.from("hello"), "text/plain", "a.txt");
    assert.equal(txt.status, 400); assert.match(txt.body.message, /JPG or PNG/);
    assert.equal((await upload(doc, `patientId=${PID}&eye=RE`, Buffer.from("x"), "application/pdf", "a.pdf")).status, 415);
    assert.equal((await upload(doc, `patientId=${PID}`)).status, 400);
    assert.equal((await upload(doc, `patientId=990000999&eye=RE`)).status, 404);
    assert.equal((await upload(doc, `patientId=${PID}&eye=RE`, Buffer.alloc(41 * 1024 * 1024, 1))).status, 413);
    const x = await call("POST", `/api/retina-ai/grade?patientId=${PID}&eye=RE`, doc, JPEG, { "content-type": "image/jpeg", origin: "http://evil.example" });
    assert.equal(x.status, 403);
  });

  console.log("records");
  await step("records search by MRD; each AI grade shown is logged", async () => {
    const before = await count(`SELECT count(*) n FROM app.dr_grading_views WHERE user_id = $1`, [docId]);
    const r = await call("GET", `/api/retina-ai/gradings?q=${MRD}`, doc);
    assert.equal(r.status, 200); assert.ok(r.body.gradings.length >= 3);
    assert.equal(r.body.gradings[0].patientName, "ZZ Test Retina");
    const okRows = r.body.gradings.filter((g: any) => g.status === "ok").length;
    assert.equal(await count(`SELECT count(*) n FROM app.dr_grading_views WHERE user_id = $1`, [docId]), before + okRows);
  });
  await step("remarks can change; the grading itself cannot be changed or removed, even in the database", async () => {
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${blindId}/remarks`, doc, { remarks: "ZZ check remark" })).status, 200);
    await assert.rejects(pool.query(`UPDATE app.dr_gradings SET ai_grade = 0 WHERE id = $1`, [blindId]), /Only the remarks/);
    await assert.rejects(pool.query(`DELETE FROM app.dr_gradings WHERE id = $1`, [blindId]), /cannot be removed/);
  });
  await step("a grading's patient cannot be changed, and old-store copies are no longer accepted (0019)", async () => {
    await assert.rejects(pool.query(`UPDATE app.dr_gradings SET patient_id = NULL WHERE id = $1`, [blindId]), /Only the remarks/);
    await assert.rejects(pool.query(`INSERT INTO app.dr_gradings (mrd, source, status, ai_grade, probs) VALUES ($1, 'legacy_import', 'ok', 1, '{0,1,0,0,0}')`, [MRD]),
                         /dr_gradings_source_check/);
  });
  await step("the activity log (read by managers) never shows a grade", async () => {
    const rows = (await pool.query(`SELECT summary, details FROM app.audit_feed WHERE entity_type IN ('dr_gradings','dr_doctor_grades')
                                     AND actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_ret%')`)).rows;
    assert.ok(rows.length >= 4);
    for (const r of rows) {
      assert.doesNotMatch(String(r.summary), /grade \d|NPDR|No DR|Proliferative/, r.summary);
      assert.doesNotMatch(String(r.details ?? ""), /AI grade: \d|Doctor's grade: \d|0\.85/, r.details);
    }
  });

  console.log("agreement");
  await step("agreement counts blinded grades only, unless asked; not gradable is left out", async () => {
    const blindOnly = (await call("GET", `/api/retina-ai/agreement?graderId=${docId}`, doc)).body;
    assert.equal(blindOnly.n, 0, "the doctor's only blinded grade was changed after seeing the AI");
    const all = (await call("GET", "/api/retina-ai/agreement?includeUnblinded=true", doc)).body;
    assert.ok(all.n >= 2); assert.ok(all.ungradable >= 1); assert.equal(all.confusion.length, 5);
    assert.ok(all.graders.some((g: any) => g.name === "ZZ Ret Doctor"));
  });
} finally {
  setGraderTransport(null);
  await cleanup();
  await app.close();
  await pool.end();
}
console.log(`\n${passed} retina AI API checks passed`);
