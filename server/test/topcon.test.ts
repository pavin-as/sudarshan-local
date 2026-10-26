// Topcon Maestro2 photo import (D-048) end to end against a TEST database. The ImageNet share is a temporary folder,
// Topcon's export tool is faked by test/fixtures/make_topcon_export.py (synthetic DICOM, no real patient), and the
// real converter (scripts/topcon_photo.py in tools\oct-venv) turns it into the photograph; the grader is faked.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/topcon.test.ts
// Its users are zz_test_top_*, its patient ZZ Test Topcon (Yarago id 990000103, MRD SPD99902), its exam files 99000*.fda;
// all removed afterwards and the import settings put back.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { gradeNewPhotos } from "../src/services/remidioReceiver.js";
import { setGraderTransport } from "../src/services/retinaAi.js";
import { GIVE_UP_AFTER, forgetSettledNames, pickWaiting, pollTopcon, setTopconExporter } from "../src/services/topconImport.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
if (!existsSync(config.topcon.python)) { console.error(`The isolated Python is needed: ${config.topcon.python}`); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const tmp = mkdtempSync(path.join(tmpdir(), "zz-topcon-"));
const share = path.join(tmp, "share"), photoDir = path.join(tmp, "fundus"), workDir = path.join(tmp, "work");
mkdirSync(path.join(share, "Data"), { recursive: true });
Object.assign(config.retinaAi, { photoDir, key: "fake-grader-key" });
Object.assign(config.topcon, { share, dataDir: "Data", password: "", workDir, tool: process.execPath });   // a local folder: no sign-in

// ---------- fakes ----------
// exam file name -> what the fake export holds; an exam that is not listed makes the "tool" fail
const exams = new Map<string, Record<string, unknown>>();
const exported: string[] = [];
setTopconExporter(async (fda, outDir) => {
  const name = path.basename(fda);
  exported.push(name);
  assert.ok(fda.startsWith(workDir), "the tool works on the copy, never on the share");
  const o = exams.get(name.toLowerCase());
  if (!o) throw new Error("the export tool made no DICOM files");
  await run(config.topcon.python, ["-I", path.join(here, "fixtures", "make_topcon_export.py"), outDir, JSON.stringify(o)]);
});
setGraderTransport(async (_m, p) => p === "/health" ? { status: 200, data: { model_loaded: true } }
  : { status: 200, data: { grade: 2, probs: [0.1, 0.1, 0.6, 0.1, 0.1], raw: [], calibration: "native_probabilities", width: 160, height: 120 } });

const old = (min: number) => new Date(Date.now() - min * 60_000);
function exam(name: string, o: Record<string, unknown> | null, minutesAgo = 10) {
  for (const ext of [".fda", ".fds"]) {
    const f = path.join(share, "Data", name + ext);
    writeFileSync(f, Buffer.alloc(ext === ".fda" ? 2000 : 9000, 7));
    utimesSync(f, old(minutesAgo), old(minutesAgo));
  }
  if (o) exams.set(`${name}.fda`, o); else exams.delete(`${name}.fda`);
}

// ---------- fixtures ----------
const PID = 990000103, MRD = "SPD99902", FILES = "file_name LIKE '99000%'";
const KEYS = ["retina.topcon_mode", "retina.topcon_unmatched", "retina.topcon_since", "retina.graders"];
const saved = (await pool.query(`SELECT key, value FROM app.settings WHERE key = ANY($1)`, [KEYS])).rows;
const put = (key: string, v: unknown) => pool.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb)
                                                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(v)]);
await put("retina.graders", ["arko"]);
const PHOTOS = `SELECT id FROM app.fundus_photos WHERE source = 'topcon' AND topcon_file LIKE '99000%'`;
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos DISABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports DISABLE TRIGGER fundus_reports_guard;
    DELETE FROM app.dr_grading_views WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (${PHOTOS}));
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (${PHOTOS}));
    DELETE FROM app.dr_gradings WHERE photo_id IN (${PHOTOS});
    DELETE FROM app.fundus_reports WHERE patient_id = ${PID};
    DELETE FROM app.topcon_import_log WHERE ${FILES};
    DELETE FROM app.fundus_photos WHERE id IN (${PHOTOS});
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos ENABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports ENABLE TRIGGER fundus_reports_guard;
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_top%') OR patient_id = ${PID}
                                 OR summary LIKE '%ZZ Test Topcon%' OR summary LIKE '%patient ID ZZT%'
                                 OR (entity_type IN ('fundus_photos', 'dr_gradings') AND summary LIKE '%Maestro2%');
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_top%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_top%';
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id = ${PID};
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_top_admin','ZZ Top Admin','admin','${hash}',false), ('zz_test_top_doc','ZZ Top Doctor','doctor','${hash}',false),
    ('zz_test_top_mgr','ZZ Top Manager','manager','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name, tlast_name, tsex) VALUES (${PID}, '${MRD}', 'ZZ Test', 'Topcon', 'Male');
  COMMIT;`);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
const log = app.log;
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
const workEmpty = () => !existsSync(workDir) || readdirSync(workDir).length === 0;
const outcomes = async (file: string) => (await pool.query(`SELECT outcome FROM app.topcon_import_log WHERE file_name = $1 ORDER BY id`, [file])).rows.map((r) => r.outcome);

try {
  const admin = await login("zz_test_top_admin"), doc = await login("zz_test_top_doc"), mgr = await login("zz_test_top_mgr");

  console.log("rules without a database");
  await step("waiting exams: from the start point on, settled for 2 minutes, not done, oldest first", async () => {
    const f = (name: string, min: number, settledMin = min) => ({ name, bytes: 1, mtime: old(min), fds: null, settledAt: old(settledMin) });
    const files = [f("a.fda", 30), f("b.fda", 10), f("c.fda", 1), f("d.fda", 12, 1), f("e.fda", 90)];
    const done = new Set([`b.fda|${files[1].mtime.getTime()}`]);
    assert.deepEqual(pickWaiting(files, done, old(60), Date.now()).map((x) => x.name), ["a.fda"]);
    assert.deepEqual(pickWaiting(files, new Set(), null, Date.now()).map((x) => x.name), ["e.fda", "a.fda", "b.fda"]);
  });

  console.log("switch");
  await put("retina.topcon_mode", "off"); await put("retina.topcon_since", null); await put("retina.topcon_unmatched", "keep");
  exam("990001", { patientId: MRD, sex: "M", eye: "R" });
  await step("off: the import does not look at the share", async () => {
    assert.equal(await pollTopcon(log), "off");
    assert.equal(exported.length, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM app.topcon_import_log WHERE ${FILES}`), 0);
  });
  await step("only admins switch it; doctors see it, managers cannot", async () => {
    assert.equal((await call("PUT", "/api/retina-ai/topcon", doc, { mode: "on" })).status, 403);
    assert.equal((await call("GET", "/api/retina-ai/topcon", mgr)).status, 403);
    const s = (await call("GET", "/api/retina-ai/topcon", doc)).body;
    assert.equal(s.mode, "off"); assert.equal(s.ready, true, `ready: missing ${s.missing}`);
  });
  await step("first switched on: only exams saved from then on; an earlier start point can be set", async () => {
    assert.equal((await call("PUT", "/api/retina-ai/topcon", admin, { mode: "peek" })).status, 200);
    const since = Date.parse((await call("GET", "/api/retina-ai/topcon", admin)).body.since);
    assert.ok(Math.abs(since - Date.now()) < 60_000, "start point = now");
    assert.equal(await pollTopcon(log), "nothing new");                     // the exam was saved 10 minutes before
    assert.equal((await call("PUT", "/api/retina-ai/topcon", admin, { since: new Date(Date.now() + 3_600_000).toISOString() })).status, 400);
    assert.equal((await call("PUT", "/api/retina-ai/topcon", admin, { since: old(60).toISOString() })).status, 200);
  });

  console.log("peek and on");
  await step("peek: converts the next exam, logs its shape only, keeps nothing, leaves no copy", async () => {
    const r = await pollTopcon(log);
    assert.match(r, /^peek: exam 990001\.fda \(3D H\/Macula\/320\/320\/6x6mm\/Angio, right eye, patient ID AAA99999\); nothing kept$/);
    assert.deepEqual(await outcomes("990001.fda"), ["peeked"]);
    assert.equal(await count(`SELECT count(*) AS n FROM (${PHOTOS}) x`), 0);
    assert.ok(workEmpty(), "work folder emptied");
    assert.match(await pollTopcon(log), /looked at already/);
    assert.equal(exported.length, 1);
    const shown = JSON.stringify((await call("GET", "/api/retina-ai/topcon", admin)).body);
    assert.ok(!shown.includes(MRD) && !shown.includes("TEST TOPCON"), "no patient ID or name on the System tab");
  });
  exam("990002", null, 1);                                                  // saved a minute ago: not settled yet
  await step("on: keeps the colour photograph (not the infrared one), linked by SPD number, sex checked", async () => {
    await put("retina.topcon_mode", "on");
    assert.match(await pollTopcon(log), /^1 stored$/);
    const p = (await pool.query(`SELECT * FROM app.fundus_photos WHERE topcon_file = '990001.fda'`)).rows;
    assert.equal(p.length, 1);
    assert.equal(p[0].source, "topcon"); assert.equal(Number(p[0].patient_id), PID); assert.equal(p[0].sex_check, "same");
    assert.equal(p[0].eye, "RE"); assert.equal(p[0].field, "MACULA"); assert.equal(p[0].device, "Maestro2");
    assert.equal(p[0].width, 160); assert.equal(p[0].height, 120);
    for (const f of [p[0].file_path, p[0].thumb_path, p[0].dicom_path]) assert.ok(existsSync(path.join(photoDir, f)), f);
    assert.ok(!JSON.stringify(p[0].meta).includes(MRD));
    assert.deepEqual(await outcomes("990001.fda"), ["peeked", "stored"]);
    assert.ok(workEmpty(), "work folder emptied");
    assert.equal(await count(`SELECT count(*) AS n FROM app.audit_log WHERE entity_type = 'fundus_photos' AND summary LIKE 'Imported a Maestro2 fundus photograph for ZZ Test Topcon (SPD99902), right eye%'`), 1);
    assert.equal(exported.filter((x) => x === "990002.fda").length, 0, "an exam still being saved waits");
  });
  await step("a done exam is not converted again; a re-saved copy with the same photograph is a duplicate", async () => {
    const before = exported.length;
    assert.equal(await pollTopcon(log), "nothing new");
    assert.equal(exported.length, before);
    exam("990001", { patientId: MRD, sex: "M", eye: "R", sop: (await pool.query(`SELECT dicom_sop_uid FROM app.fundus_photos WHERE topcon_file = '990001.fda'`)).rows[0].dicom_sop_uid }, 5);
    forgetSettledNames();
    assert.match(await pollTopcon(log), /1 duplicate/);
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos WHERE topcon_file = '990001.fda'`), 1);
  });
  await step("patient ID not in Yarago: kept unlinked, or skipped when set to skip; an exam without a photograph is logged", async () => {
    exam("990003", { patientId: "ZZT123", sex: "F", eye: "L" });
    exam("990004", { patientId: MRD, eye: "L", colour: false });
    assert.match(await pollTopcon(log), /1 stored, 1 no photo/);
    assert.equal((await pool.query(`SELECT patient_id FROM app.fundus_photos WHERE topcon_file = '990003.fda'`)).rows[0].patient_id, null);
    assert.deepEqual(await outcomes("990004.fda"), ["no_photo"]);
    await put("retina.topcon_unmatched", "skip");
    exam("990005", { patientId: "ZZT124", eye: "R" });
    assert.match(await pollTopcon(log), /1 skipped/);
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos WHERE topcon_file = '990005.fda'`), 0);
    await put("retina.topcon_unmatched", "keep");
  });
  await step(`a failing export is tried again, then given up after ${GIVE_UP_AFTER} tries without blocking later exams`, async () => {
    exam("990006", null, 20);
    for (let i = 1; i < GIVE_UP_AFTER; i++) assert.match(await pollTopcon(log), new RegExp(`try ${i} of ${GIVE_UP_AFTER}`));
    exam("990002", { patientId: MRD, eye: "L" }, 15);                        // settled by now
    forgetSettledNames();
    assert.equal(await pollTopcon(log), "1 gave up, 1 stored");               // the next exam goes on in the same minute
    assert.deepEqual((await outcomes("990006.fda")).slice(-1), ["gave_up"]);
    assert.ok(workEmpty(), "work folder emptied after failures too");
  });

  console.log("grading, reports and screens");
  await step("Maestro2 photographs are graded by the research model, recorded as source topcon", async () => {
    let n = 0; for (let i = 0; i < 3; i++) n += await gradeNewPhotos(log);
    assert.ok(n >= 3);
    const g = (await pool.query(`SELECT source, image_filename FROM app.dr_gradings WHERE photo_id IN (${PHOTOS})`)).rows;
    assert.ok(g.length >= 3 && g.every((x) => x.source === "topcon" && /^topcon-photo-\d+\.jpg$/.test(x.image_filename)));
  });
  await step("the day's Maestro2 photographs form a fundus report session the doctor can report", async () => {
    const s = (await call("GET", `/api/fundus/sessions?status=todo&patientId=${PID}`, doc)).body.sessions;
    assert.equal(s.length, 1); assert.deepEqual(s[0].sources, ["topcon"]); assert.equal(s[0].examKey, 0); assert.equal(s[0].photos, 2);
    const one = (await call("GET", `/api/fundus/session?patientId=${PID}&examDate=${s[0].examDate}&examKey=0`, doc)).body;
    assert.ok(one.photos.every((p: any) => p.source === "topcon" && p.protocol));
    const w = await call("POST", "/api/fundus/reports", doc, { patientId: PID, examDate: s[0].examDate, examKey: 0,
      re: { dr: "moderate" }, le: { dr: "none" }, referral: "routine" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.ok(await count(`SELECT count(*) AS n FROM app.dr_doctor_grades d JOIN app.dr_gradings g ON g.id = d.grading_id WHERE g.photo_id IN (${PHOTOS})`) >= 2);
  });
  await step("photographs open for clinical roles and filter by camera; evaluation sets are per camera", async () => {
    const id = (await pool.query(`SELECT id FROM app.fundus_photos WHERE topcon_file = '990001.fda'`)).rows[0].id;
    assert.equal((await call("GET", `/api/retina-ai/photos/${id}/image`, mgr)).status, 200);
    const list = (await call("GET", `/api/retina-ai/photos?source=topcon&patientId=${PID}`, doc)).body.photos;
    assert.ok(list.length >= 2 && list.every((p: any) => p.source === "topcon"));
    assert.equal((await call("GET", `/api/retina-ai/photos?source=remidio&patientId=${PID}`, doc)).body.photos.length, 0);
    const t = (await call("GET", "/api/retina-ai/eval/candidates?camera=topcon&blindedOnly=false", admin)).body;
    const r = (await call("GET", "/api/retina-ai/eval/candidates?camera=remidio&blindedOnly=false", admin)).body;
    assert.ok(t.images >= 2, `topcon candidates ${t.images}`);
    assert.equal(r.images, 0);
  });
} finally {
  setTopconExporter(null); setGraderTransport(null);
  await cleanup();
  // pg reads jsonb back as plain values, so write them back as JSON text
  for (const s of saved) await pool.query(`UPDATE app.settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]);
  rmSync(tmp, { recursive: true, force: true });
  await app.close(); await pool.end();
}
console.log(`\n${passed} Topcon import checks passed`);
