// Remidio photo receiver (D-041) end to end against a TEST database: Remidio's queue, the photo downloads and the grader
// are fakes (nothing leaves the machine); photographs are written to a temporary folder.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/remidio.test.ts
// Its users are zz_test_rem_*, its patient ZZ Test Remidio (Yarago id 990000102, MRD SPD99901), its Remidio ids 9900001..;
// all removed afterwards and the receiver settings put back.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { setPhotoFetcher, setRemidioTransport } from "../src/services/remidio.js";
import { gradeNewPhotos, pollQueue } from "../src/services/remidioReceiver.js";
import { importDownloads } from "../src/services/remidioImport.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { setGraderTransport } from "../src/services/retinaAi.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
const photoDir = mkdtempSync(path.join(tmpdir(), "zz-fundus-"));
Object.assign(config.retinaAi, { photoDir, key: "fake-grader-key" });
Object.assign(config.remidio, { clientIdToken: "fake-client-id", clientAuthToken: "fake-client-auth" });

// ---------- fakes ----------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 9)]);
const queue: any[] = [];
const calls: string[] = [];
// the exam list a Remidio Connect download is matched against: one SPD exam (two photographs) and one WSD exam
const shot = Date.parse("2026-10-24T17:34:54.833+05:30");
const examList = [
  { patientDetails: { id: 9900300, mrn: "spd99901", gender: "MALE" }, examDetails: { id: 9900301, examDate: shot - 60_000 },
    images: { fopImages: { STANDARD: [{ id: 9900011, examId: 9900301, date: shot, laterality: "RIGHT", field: "MACULA", quality: "SUFFICIENT", width: 2866, height: 2866 },
                                      { id: 9900012, examId: 9900301, date: shot + 40_000, laterality: "LEFT", field: "DISC", quality: "INSUFFICIENT" }], EDITED: [] } } },
  { patientDetails: { id: 9900400, mrn: "WSD07" }, examDetails: { id: 9900401, examDate: shot },
    images: { fopImages: { STANDARD: [{ id: 9900013, date: shot, laterality: "RIGHT" }] } } },
];
setRemidioTransport(async (method, p) => {
  calls.push(`${method} ${p}`);
  if (p === "/api/gateway/getQueueItem") return queue.length ? { status: 200, data: { status: { statusCode: "OK" }, data: queue[0] } } : { status: 404, data: null };
  if (p === "/api/gateway/itemSuccessfullyHandled") { queue.shift(); return { status: 200, data: { status: { statusCode: "OK" } } }; }
  if (p.startsWith("/api/gateway/getExamsByDate/")) return { status: 200, data: { data: examList } };
  return { status: 404, data: null };
});
let failDownloads = false;
const downloads: string[] = [];
setPhotoFetcher(async (url) => { downloads.push(url); if (failDownloads) throw new Error("photograph download failed (HTTP 403, the link may have expired)"); return JPEG; });
// two research graders (D-046): Arko007 on its own URL, RFM (port 7861) with two heads, each head its own model SHA
process.env.RFM_GRADER_URL = "http://127.0.0.1:7861"; process.env.RFM_GRADER_KEY = "fake-rfm-key";
const RFM_SHA: Record<string, string> = { aptos: "f1a558fc09dbc07452bdd3570f4aa6af84f2bc2550c794cb88ff419c1efaaefb", messidor: "b23dcc9b2ecde8b562f61e1a046345a799327e0aa0ace36188ca8315ab0efde3" };
setGraderTransport(async (_m, p, _b, _h, target) => {
  const rfm = !!target?.url.includes(":7861");
  if (p === "/health") return { status: 200, data: rfm ? { model_loaded: true, heads: Object.fromEntries(Object.entries(RFM_SHA).map(([k, v]) => [k, { model_sha256: v }])) } : { model_loaded: true } };
  const head = /head=(\w+)/.exec(p)?.[1];
  return { status: 200, data: rfm
    ? { grade: 2, probs: [0.1, 0.1, 0.6, 0.1, 0.1], raw: [], calibration: "softmax_applied", width: 2866, height: 2866, model_repo: "ok1zjf/RFM", model_sha256: RFM_SHA[head ?? ""] }
    : { grade: 1, probs: [0.2, 0.5, 0.1, 0.1, 0.1], raw: [0.2, 0.5, 0.1, 0.1, 0.1], calibration: "native_probabilities", width: 2866, height: 2866 } };
});
const item = (id: number, mrn: string, extra: any = {}) => ({
  type: "IMAGE",
  image: { id, examId: id + 100, laterality: "LEFT", date: Date.now(), width: 2866, height: 2866, quality: "SUFFICIENT", field: "MACULA",
           path: `https://storage.googleapis.com/remidio-backend-india.appspot.com/x/${id}?Signature=s`, thumbnailPath: `https://storage.googleapis.com/remidio-backend-india.appspot.com/t/${id}?Signature=s` },
  patient: { id: id + 200, firstName: "ZZ", lastName: "Test", gender: "MALE", mrn }, site: { siteCustomIdentifier: "TIRUR" }, ...extra,
});

// ---------- fixtures ----------
const PID = 990000102, MRD = "SPD99901", IDS = "remidio_image_id BETWEEN 9900001 AND 9900099";
const KEYS = ["retina.remidio_mode", "retina.remidio_unmatched", "retina.graders"];
const saved = (await pool.query(`SELECT key, value FROM app.settings WHERE key = ANY($1)`, [KEYS])).rows;
await pool.query(`INSERT INTO app.settings (key, value) VALUES ('retina.graders', '["arko", "rfm:aptos", "rfm:messidor"]'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
const setMode = (mode: string, unmatched = "keep") => pool.query(
  `INSERT INTO app.settings (key, value) VALUES ('retina.remidio_mode', to_jsonb($1::text)), ('retina.remidio_unmatched', to_jsonb($2::text))
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [mode, unmatched]);
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos DISABLE TRIGGER fundus_photos_guard;
    DELETE FROM app.dr_grading_views WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS}));
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS}));
    DELETE FROM app.dr_gradings WHERE photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS});
    DELETE FROM app.remidio_queue_log WHERE remidio_id BETWEEN 9900001 AND 9900099 OR photo_id IN (SELECT id FROM app.fundus_photos WHERE ${IDS});
    DELETE FROM app.fundus_photos WHERE ${IDS};
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos ENABLE TRIGGER fundus_photos_guard;
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_rem%') OR patient_id = ${PID}
                                 OR (entity_type IN ('fundus_photos','dr_gradings') AND (summary LIKE '%ZZ%' OR summary LIKE '%MRN WSD1_ (not in Yarago)%'));
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_rem%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_rem%';
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id = ${PID};
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_rem_admin','ZZ Rem Admin','admin','${hash}',false), ('zz_test_rem_doc','ZZ Rem Doctor','doctor','${hash}',false),
    ('zz_test_rem_mgr','ZZ Rem Manager','manager','${hash}',false), ('zz_test_rem_staff','ZZ Rem Staff','staff','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name, tlast_name, tsex) VALUES (${PID}, '${MRD}', 'ZZ Test', 'Remidio', 'Male');
  COMMIT;`);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
async function login(username: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: pw } });
  assert.equal(r.statusCode, 200, `login ${username}`); return String(r.headers["set-cookie"]).split(";")[0];
}
const call = async (method: string, url: string, cookie: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body || "null") : r.rawPayload };
};
const count = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);
const acks = () => calls.filter((c) => c.endsWith("itemSuccessfullyHandled")).length;

try {
  const admin = await login("zz_test_rem_admin"), doc = await login("zz_test_rem_doc"), mgr = await login("zz_test_rem_mgr"),
        staff = await login("zz_test_rem_staff");

  console.log("switch");
  await step("off: the receiver does not touch Remidio", async () => {
    await setMode("off"); queue.push(item(9900001, MRD));
    assert.equal(await pollQueue(app.log), "off"); assert.equal(calls.length, 0);
  });
  await step("only admins switch it; managers cannot even see it", async () => {
    assert.equal((await call("PUT", "/api/retina-ai/remidio", doc, { mode: "on" })).status, 403);
    assert.equal((await call("GET", "/api/retina-ai/remidio", mgr)).status, 403);
    assert.equal((await call("PUT", "/api/retina-ai/remidio", admin, { mode: "peek" })).status, 200);
    assert.equal((await call("GET", "/api/retina-ai/remidio", doc)).body.mode, "peek");
  });
  await step("peek: looks at the head item, logs its fields without links, takes nothing", async () => {
    const r = await pollQueue(app.log);
    assert.match(r, /^peek: the next item is IMAGE \(photograph, left eye, MRN AAA99999\)/);
    assert.equal(acks(), 0); assert.equal(queue.length, 1); assert.equal(downloads.length, 0);
    await pollQueue(app.log);
    assert.equal(await count(`SELECT count(*) n FROM app.remidio_queue_log WHERE remidio_id = 9900001 AND outcome = 'peeked'`), 1, "logged once");
    const payload = JSON.stringify((await pool.query(`SELECT payload FROM app.remidio_queue_log WHERE remidio_id = 9900001`)).rows[0].payload);
    assert.doesNotMatch(payload, /https?:|Signature/);
    const shown = (await call("GET", "/api/retina-ai/remidio", admin)).body.recent[0];
    assert.equal(shown.outcome, "peeked"); assert.ok(shown.fields.includes("patient.mrn")); assert.ok(!JSON.stringify(shown).includes(MRD), "fields only, no values");
  });

  console.log("receiving");
  let photoId = 0;
  await step("on: stores the photograph and thumbnail, links the patient by SPD number, then takes it off the queue", async () => {
    await setMode("on");
    assert.equal(await pollQueue(app.log), "1 stored");
    assert.equal(acks(), 1); assert.equal(queue.length, 0); assert.equal(downloads.length, 2, "photo and thumbnail");
    const f = (await pool.query(`SELECT * FROM app.fundus_photos WHERE remidio_image_id = 9900001`)).rows[0];
    photoId = Number(f.id);
    assert.equal(Number(f.patient_id), PID); assert.equal(f.eye, "LE"); assert.equal(f.sex_check, "same"); assert.equal(f.quality, "SUFFICIENT");
    assert.ok(existsSync(path.join(photoDir, f.file_path))); assert.ok(existsSync(path.join(photoDir, f.thumb_path)));
    assert.deepEqual(readFileSync(path.join(photoDir, f.file_path)), JPEG);
    assert.doesNotMatch(JSON.stringify(f.meta), /https?:/);
  });
  await step("the same photograph again is a duplicate: not stored twice, still taken off", async () => {
    queue.push(item(9900001, MRD));
    assert.equal(await pollQueue(app.log), "1 duplicate"); assert.equal(acks(), 2);
    assert.equal(await count(`SELECT count(*) n FROM app.fundus_photos WHERE remidio_image_id = 9900001`), 1);
  });
  await step("MRN not in Yarago (e.g. a WSD number): kept unlinked, or skipped without downloading when set to skip", async () => {
    queue.push(item(9900002, "WSD12"));
    assert.equal(await pollQueue(app.log), "1 stored");
    assert.equal(await count(`SELECT count(*) n FROM app.fundus_photos WHERE remidio_image_id = 9900002 AND patient_id IS NULL`), 1);
    await setMode("on", "skip");
    const before = downloads.length; queue.push(item(9900003, "WSD13"));
    assert.equal(await pollQueue(app.log), "1 skipped"); assert.equal(downloads.length, before); assert.equal(queue.length, 0);
    await setMode("on");
  });
  await step("an item that is not a photograph is kept in the log, without links, and taken off", async () => {
    queue.push({ type: "REPORT", id: 9900004, report: { grade: "MODERATE NPDR", pdf: "https://storage.googleapis.com/x?Signature=y" } });
    assert.equal(await pollQueue(app.log), "1 kept");
    const row = (await pool.query(`SELECT payload FROM app.remidio_queue_log WHERE remidio_id = 9900004 AND outcome = 'kept'`)).rows[0];
    assert.equal(row.payload.report.grade, "MODERATE NPDR"); assert.equal(row.payload.report.pdf, "(link removed)");
  });
  await step("a failing download leaves the item on the queue; after 10 tries it is logged and taken off", async () => {
    failDownloads = true; queue.push(item(9900005, MRD));
    const r = await pollQueue(app.log);
    assert.match(r, /stopped at an item that failed \(try 1 of 10\)/); assert.equal(queue.length, 1);
    for (let i = 2; i <= 10; i++) await pollQueue(app.log);
    assert.equal(queue.length, 0, "taken off after 10 tries");
    assert.equal(await count(`SELECT count(*) n FROM app.remidio_queue_log WHERE remidio_id = 9900005 AND outcome = 'gave_up'`), 1);
    assert.equal(await count(`SELECT count(*) n FROM app.fundus_photos WHERE remidio_image_id = 9900005`), 0);
    failDownloads = false;
  });

  console.log("grading and viewing");
  await step("new photographs are graded by every research model switched on, once each per model (D-046)", async () => {
    assert.ok(await gradeNewPhotos(app.log) >= 2);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_gradings WHERE photo_id = $1 AND source = 'remidio' AND ai_grade = 1 AND eye = 'LE'`, [photoId]), 1);
    for (const sha of Object.values(RFM_SHA))
      assert.equal(await count(`SELECT count(*) n FROM app.dr_gradings WHERE photo_id = $1 AND model_sha256 = $2 AND ai_grade = 2`, [photoId, sha]), 1, sha.slice(0, 8));
    await gradeNewPhotos(app.log);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_gradings WHERE photo_id = $1`, [photoId]), 3, "not graded twice by any model");
    const todo = (await call("GET", "/api/retina-ai/to-grade", doc)).body.gradings.filter((g: any) => g.photoId === photoId);
    assert.equal(todo.length, 1, "one row per photograph on the doctor's to-grade list"); assert.equal(todo[0].aiGrade, undefined);
  });
  await step("each grading shows its model's research screening outcome; the doctor's grade counts for every model", async () => {
    const recs = (await call("GET", `/api/retina-ai/gradings?patientId=${PID}`, admin)).body.gradings.filter((g: any) => g.photoId === photoId);
    const aptos = recs.find((g: any) => g.modelSha256 === RFM_SHA.aptos);
    assert.equal(aptos.screening.outcome, "refer", "score 0.8 is above the APTOS head's refer cut-off");
    assert.equal(recs.find((g: any) => !g.modelSha256).screening, null, "a model without cut-offs gets no outcome");
    const todo = (await call("GET", "/api/retina-ai/to-grade", doc)).body.gradings.find((g: any) => g.photoId === photoId);
    assert.equal((await call("PUT", `/api/retina-ai/gradings/${todo.id}/my-grade`, doc, { grade: 2, ungradable: false, note: "" })).status, 200);
    assert.equal(await count(`SELECT count(*) n FROM app.dr_doctor_grades d JOIN app.dr_gradings g ON g.id = d.grading_id WHERE g.photo_id = $1 AND d.grade = 2 AND d.blinded`, [photoId]), 3);
    const st = (await call("GET", "/api/retina-ai/status", admin)).body.graders;
    assert.deepEqual(st.map((x: any) => x.key), ["arko", "rfm:aptos", "rfm:messidor"]);
    assert.equal(st[1].modelSha256, RFM_SHA.aptos); assert.ok(st[1].cutoffs);
  });
  await step("the photograph opens for every clinical role, not front-desk staff (D-042); the patient's list shows it", async () => {
    const r = await call("GET", `/api/retina-ai/photos/${photoId}/image`, doc);
    assert.equal(r.status, 200); assert.deepEqual(Buffer.from(r.body as any), JPEG);
    assert.equal((await call("GET", `/api/retina-ai/photos/${photoId}/image?size=thumb`, doc)).status, 200);
    // D-042: every clinical role sees the photographs (managers too); front-desk staff do not
    assert.equal((await call("GET", `/api/retina-ai/photos/${photoId}/image`, mgr)).status, 200);
    assert.equal((await call("GET", `/api/retina-ai/photos/${photoId}/image`, staff)).status, 403);
    const list = (await call("GET", `/api/retina-ai/photos?patientId=${PID}`, doc)).body.photos;
    assert.equal(list.length, 1); assert.equal(list[0].patientName, "ZZ Test Remidio"); assert.equal(list[0].aiGrade, undefined);
    assert.equal((await call("GET", "/api/retina-ai/photos?unmatched=true", doc)).body.photos.some((x: any) => x.mrn === "WSD12"), true);
  });
  await step("already-taken photographs: Remidio Connect downloads are matched to the exam list and kept (SPD only)", async () => {
    const dl = mkdtempSync(path.join(tmpdir(), "zz-remidio-dl-"));
    try {
      const put = (mrn: string, t: string) => {
        const dir = path.join(dl, `${mrn}_25-10-2026_3.30.34.165_PM`, `ZZ TEST_${mrn}_24-10-2026`, "FOP");
        mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${t}.jpg`), JPEG);
      };
      put("spd99901", "5.34.54.833_PM"); put("spd99901", "5.35.34.833_PM"); put("WSD07", "5.34.54.833_PM"); put("spd99901", "9.00.00.000_AM");
      await importDownloads({ folder: dl, dryRun: true });
      assert.equal(await count(`SELECT count(*) n FROM app.fundus_photos WHERE remidio_image_id IN (9900011, 9900012)`), 0, "dry run keeps nothing");
      await importDownloads({ folder: dl });
      const rows = (await pool.query(`SELECT remidio_image_id::int id, eye, field, quality, patient_id FROM app.fundus_photos WHERE remidio_image_id BETWEEN 9900011 AND 9900013 ORDER BY 1`)).rows;
      assert.deepEqual(rows.map((r) => [r.id, r.eye, r.field, Number(r.patient_id)]), [[9900011, "RE", "MACULA", PID], [9900012, "LE", "DISC", PID]],
                       "both SPD photographs, right eye and left eye; the WSD one and the unmatched 9 AM file left out");
      await importDownloads({ folder: dl });
      assert.equal(await count(`SELECT count(*) n FROM app.fundus_photos WHERE remidio_image_id IN (9900011, 9900012)`), 2, "a second run adds nothing");
      queue.push(item(9900011, MRD));
      assert.equal(await pollQueue(app.log), "1 duplicate", "the same photograph later from the queue is a duplicate");
    } finally { rmSync(dl, { recursive: true, force: true }); }
  });
  await step("photographs are kept for good: no delete, no change; an unlinked one may be linked once", async () => {
    await assert.rejects(pool.query(`DELETE FROM app.fundus_photos WHERE id = $1`, [photoId]), /cannot be removed/);
    await assert.rejects(pool.query(`UPDATE app.fundus_photos SET eye = 'RE' WHERE id = $1`, [photoId]), /cannot be changed/);
    await pool.query(`UPDATE app.fundus_photos SET patient_id = $1 WHERE remidio_image_id = 9900002`, [PID]);
    await assert.rejects(pool.query(`UPDATE app.fundus_photos SET patient_id = NULL WHERE remidio_image_id = 9900002`), /cannot be changed/);
  });
} finally {
  setRemidioTransport(null); setPhotoFetcher(null); setGraderTransport(null);
  await cleanup();
  // pg reads jsonb back as plain values ("off"), so write them back as JSON text
  for (const s of saved) await pool.query(`UPDATE app.settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]);
  rmSync(photoDir, { recursive: true, force: true });
  await app.close(); await pool.end();
}
console.log(`\n${passed} Remidio receiver checks passed`);
