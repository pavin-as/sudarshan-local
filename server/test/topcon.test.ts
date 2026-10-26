// Topcon Maestro2 import (D-048 photographs, D-049 OCT / OCTA) end to end against a TEST database. The ImageNet shares are
// temporary folders, Topcon's export tool is faked by test/fixtures/make_topcon_export.py (synthetic DICOM, no real
// patient), and the real converter (scripts/topcon_photo.py in tools\oct-venv) makes the photographs and the OCT views;
// the grader is faked.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/topcon.test.ts
// Its users are zz_test_top_*, its patients ZZ Test Topcon (Yarago id 990000103, SPD99902) and ZZ Test Topcon Two
// (990000105, SPD99904), its exam files *99000*.fda; all removed afterwards and the import settings put back.
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
import { startOfToday, windowOpen } from "../src/services/backfillWindow.js";
import { gradeNewPhotos } from "../src/services/remidioReceiver.js";
import { setGraderTransport } from "../src/services/retinaAi.js";
import { GIVE_UP_AFTER, forgetSettledNames, pickWaiting, pollTopcon, setTopconExporter } from "../src/services/topconImport.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
if (!existsSync(config.topcon.python)) { console.error(`The isolated Python is needed: ${config.topcon.python}`); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const tmp = mkdtempSync(path.join(tmpdir(), "zz-topcon-"));
const share = path.join(tmp, "share"), jukebox = path.join(tmp, "jukeboxE"), photoDir = path.join(tmp, "fundus");
const workDir = path.join(tmp, "work"), octDir = path.join(tmp, "oct");
mkdirSync(path.join(share, "Data"), { recursive: true });
mkdirSync(path.join(jukebox, "VOL_0001"), { recursive: true });
Object.assign(config.retinaAi, { photoDir, key: "fake-grader-key" });
Object.assign(config.topcon, { share, dataDir: "Data", password: "", workDir, octDir, tool: process.execPath,    // local folders: no sign-in
                               archives: [{ label: "E", dir: jukebox }] });

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
/** Put an exam (.fda + .fds) in the live folder, or in the archive's VOL_0001 with archive = true. */
function exam(name: string, o: Record<string, unknown> | null, saved: number | Date = 10, archive = false) {
  const when = saved instanceof Date ? saved : old(saved);
  for (const ext of [".fda", ".fds"]) {
    const f = path.join(archive ? path.join(jukebox, "VOL_0001") : path.join(share, "Data"), name + ext);
    writeFileSync(f, Buffer.alloc(ext === ".fda" ? 2000 : 9000, 7));
    utimesSync(f, when, when);
  }
  if (o) exams.set(`${name}.fda`, { when: dicomTime(when), ...o }); else exams.delete(`${name}.fda`);
}
const today = startOfToday();
const yesterday = new Date(today.getTime() - 3 * 3_600_000);                      // 21:00 the evening before
const dicomTime = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d).replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, "$3$2$1$4$5$6");
const CLOSED = { from: "00:00", to: "00:00", sundays: false }, OPEN = { from: "00:00", to: "23:59", sundays: false };

// ---------- fixtures ----------
const PID = 990000103, MRD = "SPD99902", PID2 = 990000105, MRD2 = "SPD99904", FILES = "file_name LIKE '%9900%'";
const KEYS = ["retina.topcon_mode", "retina.topcon_unmatched", "retina.topcon_since", "retina.graders", "retina.topcon_backfill_window", "retina.topcon_report_from"];
const saved = (await pool.query(`SELECT key, value FROM app.settings WHERE key = ANY($1)`, [KEYS])).rows;
const put = (key: string, v: unknown) => pool.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb)
                                                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(v)]);
await put("retina.graders", ["arko"]);
await put("retina.topcon_report_from", new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
await put("retina.topcon_backfill_window", CLOSED);
const PHOTOS = `SELECT id FROM app.fundus_photos WHERE source = 'topcon' AND topcon_file LIKE '%9900%'`;
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos DISABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports DISABLE TRIGGER fundus_reports_guard; ALTER TABLE app.oct_studies DISABLE TRIGGER oct_studies_guard;
    DELETE FROM app.dr_grading_views WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (${PHOTOS}));
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE photo_id IN (${PHOTOS}));
    DELETE FROM app.dr_gradings WHERE photo_id IN (${PHOTOS});
    DELETE FROM app.fundus_reports WHERE patient_id IN (${PID}, ${PID2});
    DELETE FROM app.topcon_import_log WHERE ${FILES};
    DELETE FROM app.oct_studies WHERE topcon_file LIKE '%9900%';
    DELETE FROM app.fundus_photos WHERE id IN (${PHOTOS});
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard; ALTER TABLE app.fundus_photos ENABLE TRIGGER fundus_photos_guard;
    ALTER TABLE app.fundus_reports ENABLE TRIGGER fundus_reports_guard; ALTER TABLE app.oct_studies ENABLE TRIGGER oct_studies_guard;
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_top%') OR patient_id IN (${PID}, ${PID2})
                                 OR summary LIKE '%ZZ Test Topcon%' OR summary LIKE '%patient ID ZZT%'
                                 OR (entity_type IN ('fundus_photos', 'dr_gradings', 'oct_studies') AND summary LIKE '%Maestro2%');
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_top%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_top%';
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id IN (${PID}, ${PID2});
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_top_admin','ZZ Top Admin','admin','${hash}',false), ('zz_test_top_doc','ZZ Top Doctor','doctor','${hash}',false),
    ('zz_test_top_mgr','ZZ Top Manager','manager','${hash}',false), ('zz_test_top_staff','ZZ Top Staff','staff','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name, tlast_name, tsex) VALUES
    (${PID}, '${MRD}', 'ZZ Test', 'Topcon', 'Male'), (${PID2}, '${MRD2}', 'ZZ Test', 'Topcon Two', 'Female');
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
  return { status: r.statusCode, type: String(r.headers["content-type"] ?? ""),
           body: r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body || "null") : r.rawPayload };
};
const count = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);
const workEmpty = () => !existsSync(workDir) || readdirSync(workDir).length === 0;
const outcomes = async (file: string) => (await pool.query(`SELECT outcome FROM app.topcon_import_log WHERE file_name = $1 ORDER BY id`, [file])).rows.map((r) => r.outcome);

try {
  const admin = await login("zz_test_top_admin"), doc = await login("zz_test_top_doc"), mgr = await login("zz_test_top_mgr"),
        staff = await login("zz_test_top_staff");

  console.log("rules without a database");
  await step("waiting exams: from the start point on, settled for 2 minutes, not done; today's oldest first, then past newest first", async () => {
    const f = (name: string, min: number, settledMin = min) => ({ name, path: name, bytes: 1, mtime: old(min), settledAt: old(settledMin) });
    const files = [f("a.fda", 30), f("b.fda", 10), f("c.fda", 1), f("d.fda", 12, 1), f("e.fda", 90)];
    const done = new Set([`b.fda|${files[1].mtime.getTime()}`]);
    assert.deepEqual(pickWaiting(files, done, old(60), Date.now()).map((x) => x.name), ["a.fda"]);
    assert.deepEqual(pickWaiting(files, new Set(), null, Date.now()).map((x) => x.name), ["e.fda", "a.fda", "b.fda"]);
    const cut = old(20);                                                         // a, e "past"; b "today"
    assert.deepEqual(pickWaiting(files, new Set(), null, Date.now(), true, cut).map((x) => x.name), ["b.fda", "a.fda", "e.fda"]);
    assert.deepEqual(pickWaiting(files, new Set(), null, Date.now(), false, cut).map((x) => x.name), ["b.fda"]);
  });
  await step("backfill window: crosses midnight; Sundays all day", async () => {
    const at = (iso: string) => new Date(iso);
    const w = { from: "20:00", to: "07:00", sundays: true };
    assert.equal(windowOpen(w, at("2026-10-26T21:30:00+05:30")), true);     // Monday night
    assert.equal(windowOpen(w, at("2026-10-27T06:59:00+05:30")), true);     // Tuesday early
    assert.equal(windowOpen(w, at("2026-10-27T11:00:00+05:30")), false);    // Tuesday clinic
    assert.equal(windowOpen(w, at("2026-11-01T11:00:00+05:30")), true);     // Sunday
    assert.equal(windowOpen({ ...w, sundays: false }, at("2026-11-01T11:00:00+05:30")), false);
  });

  console.log("switch");
  await put("retina.topcon_mode", "off"); await put("retina.topcon_since", null); await put("retina.topcon_unmatched", "keep");
  exam("990001", { patientId: MRD, sex: "M", eye: "R" });
  await step("off: the import does not look at the shares", async () => {
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
    assert.match(r, /^peek: exam 990001\.fda \(3D H\/Macula\/320\/320\/6x6mm\/Angio, right eye, patient ID AAA99999; OCT 4 B-scans, layers, 4 OCTA slabs\); nothing kept$/);
    assert.deepEqual(await outcomes("990001.fda"), ["peeked"]);
    assert.equal(await count(`SELECT count(*) AS n FROM (${PHOTOS}) x`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM app.oct_studies WHERE topcon_file LIKE '%9900%'`), 0);
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
    assert.deepEqual(await outcomes("990001.fda"), ["peeked", "stored", "stored"]);      // photograph, then OCT
    assert.ok(workEmpty(), "work folder emptied");
    assert.equal(await count(`SELECT count(*) AS n FROM app.audit_log WHERE entity_type = 'fundus_photos' AND summary LIKE 'Imported a Maestro2 fundus photograph for ZZ Test Topcon (SPD99902), right eye%'`), 1);
    assert.equal(exported.filter((x) => x === "990002.fda").length, 0, "an exam still being saved waits");
  });
  await step("and its OCTA scan: DICOM and viewer files kept, linked to the photograph and the patient", async () => {
    const o = (await pool.query(`SELECT * FROM app.oct_studies WHERE topcon_file = '990001.fda'`)).rows;
    assert.equal(o.length, 1);
    const photoId = (await pool.query(`SELECT id FROM app.fundus_photos WHERE topcon_file = '990001.fda'`)).rows[0].id;
    assert.equal(o[0].photo_id, photoId); assert.equal(Number(o[0].patient_id), PID); assert.equal(o[0].kind, "octa");
    assert.equal(o[0].frames, 4); assert.deepEqual(o[0].layers, ["ILM", "RNFL/GCL", "IPL/INL", "IS/OS", "OS/RPE", "BM"]);
    assert.deepEqual(o[0].slabs, ["Superficial", "Deep", "Choriocapillaris", "Outer Retina (PAR)"]);
    const root = path.join(octDir, o[0].dir_path);
    assert.ok(readdirSync(path.join(root, "dicom")).filter((n) => n.endsWith(".dcm")).length >= 8, "the exported DICOM");
    for (const f of ["b001.jpg", "b004.jpg", "oct.json", "layers.bin", "slab1.png", "slab4.png"]) assert.ok(existsSync(path.join(root, "view", f)), f);
    assert.equal(await count(`SELECT count(*) AS n FROM app.audit_log WHERE entity_type = 'oct_studies' AND summary LIKE 'Imported a Maestro2 OCTA scan for ZZ Test Topcon (SPD99902), right eye%'`), 1);
    await assert.rejects(pool.query(`DELETE FROM app.oct_studies WHERE id = $1`, [o[0].id]), /cannot be removed/);
  });
  await step("the viewer's API: clinical roles only; scan lines on the photograph, B-scans, layers, slabs", async () => {
    const id = (await pool.query(`SELECT id FROM app.oct_studies WHERE topcon_file = '990001.fda'`)).rows[0].id;
    assert.equal((await call("GET", `/api/oct/studies?patientId=${PID}`, staff)).status, 403);
    assert.equal((await call("GET", `/api/oct/studies/${id}/bscan/1`, staff)).status, 403);
    const list = (await call("GET", `/api/oct/studies?patientId=${PID}`, mgr)).body.studies;
    assert.equal(list.length, 1); assert.equal(list[0].kind, "octa");
    const d = (await call("GET", `/api/oct/studies/${id}`, doc)).body;
    assert.equal(d.view.linesOnColourPhoto, true);
    assert.deepEqual(d.view.scanLines[0], [20, 30, 140, 30]);                  // x1, y1, x2, y2 on the 160 x 120 photograph
    assert.deepEqual(d.view.layers.shape, [4, 6, 32]); assert.equal(d.view.slabs.length, 4);
    assert.deepEqual(d.photo, { width: 160, height: 120 });
    const b = await call("GET", `/api/oct/studies/${id}/bscan/2`, doc);
    assert.equal(b.status, 200); assert.equal(b.type, "image/jpeg");
    assert.equal((await call("GET", `/api/oct/studies/${id}/bscan/5`, doc)).status, 404);
    const L = await call("GET", `/api/oct/studies/${id}/layers`, doc);
    const h = new Int16Array(new Uint8Array(L.body as Buffer).buffer.slice(0));
    assert.equal(h.length, 4 * 6 * 32); assert.equal(h[0], -1); assert.equal(h[1], 200);   // missing point; ILM at row 20.0
    const s = await call("GET", `/api/oct/studies/${id}/slab/1`, doc);
    assert.equal(s.status, 200); assert.equal(s.type, "image/png");
  });
  await step("a done exam is not converted again; a re-saved copy of the same exam is a duplicate", async () => {
    const before = exported.length;
    assert.equal(await pollTopcon(log), "nothing new");
    assert.equal(exported.length, before);
    const sop = (await pool.query(`SELECT dicom_sop_uid FROM app.fundus_photos WHERE topcon_file = '990001.fda'`)).rows[0].dicom_sop_uid;
    const optSop = (await pool.query(`SELECT opt_sop_uid FROM app.oct_studies WHERE topcon_file = '990001.fda'`)).rows[0].opt_sop_uid;
    exam("990001", { patientId: MRD, sex: "M", eye: "R", sop, optSop }, 5);
    forgetSettledNames();
    assert.equal(await pollTopcon(log), "1 duplicate");
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos WHERE topcon_file = '990001.fda'`), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM app.oct_studies WHERE topcon_file = '990001.fda'`), 1);
  });
  await step("patient ID not in Yarago: kept unlinked, or skipped when set to skip; an exam with no photograph and no OCT is logged", async () => {
    exam("990003", { patientId: "ZZT123", sex: "F", eye: "L" });
    exam("990004", { patientId: MRD, eye: "L", colour: false, opt: false });
    assert.match(await pollTopcon(log), /1 stored, 1 no photo/);
    assert.equal((await pool.query(`SELECT patient_id FROM app.fundus_photos WHERE topcon_file = '990003.fda'`)).rows[0].patient_id, null);
    assert.equal((await pool.query(`SELECT patient_id FROM app.oct_studies WHERE topcon_file = '990003.fda'`)).rows[0].patient_id, null);
    assert.deepEqual(await outcomes("990004.fda"), ["no_photo"]);
    await put("retina.topcon_unmatched", "skip");
    exam("990005", { patientId: "ZZT124", eye: "R" });
    assert.match(await pollTopcon(log), /1 skipped/);
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos WHERE topcon_file = '990005.fda'`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM app.oct_studies WHERE topcon_file = '990005.fda'`), 0);
    await put("retina.topcon_unmatched", "keep");
  });
  await step(`a failing export is tried again, then given up after ${GIVE_UP_AFTER} tries without blocking later exams`, async () => {
    exam("990006", null, 20);
    for (let i = 1; i < GIVE_UP_AFTER; i++) assert.match(await pollTopcon(log), new RegExp(`try ${i} of ${GIVE_UP_AFTER}`));
    exam("990002", { patientId: MRD, eye: "L", octa: false, protocol: "Radial/Macula/1024/12/6mm" }, 15);   // settled by now
    forgetSettledNames();
    assert.equal(await pollTopcon(log), "1 gave up, 1 stored");               // the next exam goes on in the same minute
    assert.deepEqual((await outcomes("990006.fda")).slice(-1), ["gave_up"]);
    assert.equal((await pool.query(`SELECT kind FROM app.oct_studies WHERE topcon_file = '990002.fda'`)).rows[0].kind, "oct");
    assert.ok(workEmpty(), "work folder emptied after failures too");
  });
  await step("an exam done by the photograph-only import (26 Oct morning) is done again: photograph recognised, OCT added", async () => {
    exam("990007", { patientId: MRD2, eye: "R", sex: "F" }, 8);
    assert.equal(await pollTopcon(log), "1 stored");
    await pool.query(`BEGIN; ALTER TABLE app.oct_studies DISABLE TRIGGER oct_studies_guard; DELETE FROM app.oct_studies WHERE topcon_file = '990007.fda';
                      ALTER TABLE app.oct_studies ENABLE TRIGGER oct_studies_guard; UPDATE app.topcon_import_log SET version = 1 WHERE file_name = '990007.fda'; COMMIT;`);
    const sop = (await pool.query(`SELECT dicom_sop_uid FROM app.fundus_photos WHERE topcon_file = '990007.fda'`)).rows[0].dicom_sop_uid;
    exams.set("990007.fda", { patientId: MRD2, eye: "R", sex: "F", sop });   // the same exam, exported again
    forgetSettledNames();
    assert.equal(await pollTopcon(log), "1 stored");
    assert.deepEqual((await outcomes("990007.fda")).slice(-2), ["duplicate", "stored"]);
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos WHERE topcon_file = '990007.fda'`), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM app.oct_studies WHERE topcon_file = '990007.fda'`), 1);
  });

  console.log("past exams and the archive");
  await step("past exams wait for the backfill window; the archive's subfolders are read; a copy in both is recognised", async () => {
    const when = dicomTime(yesterday);
    exam("990008", { patientId: MRD2, eye: "L", when }, yesterday);
    exam("990009", { patientId: MRD2, eye: "R", when, sop: "1.2.826.0.1.3680043.10.999.9", optSop: "1.2.826.0.1.3680043.10.999.19" }, yesterday, true);
    await put("retina.topcon_since", new Date(today.getTime() - 86_400_000).toISOString());
    forgetSettledNames();
    assert.match(await pollTopcon(log), /^nothing new; 2 past exams wait for the backfill window$/);
    await put("retina.topcon_backfill_window", OPEN);
    assert.equal(await pollTopcon(log), "2 stored");
    assert.equal(await count(`SELECT count(*) AS n FROM app.oct_studies WHERE topcon_file = 'E/VOL_0001/990009.fda'`), 1);
    exam("990010", { patientId: MRD2, eye: "R", when, sop: "1.2.826.0.1.3680043.10.999.9", optSop: "1.2.826.0.1.3680043.10.999.19" }, yesterday);
    assert.equal(await pollTopcon(log), "1 duplicate");
    await put("retina.topcon_backfill_window", CLOSED);
  });
  await step("past photographs are graded only in the window; past sessions stay off the doctors' To report list", async () => {
    let n = 0; for (let i = 0; i < 4; i++) n += await gradeNewPhotos(log);
    const ungraded = `SELECT count(*) AS n FROM app.fundus_photos f WHERE f.topcon_file IN ('990008.fda', 'E/VOL_0001/990009.fda')
                        AND NOT EXISTS (SELECT 1 FROM app.dr_gradings g WHERE g.photo_id = f.id)`;
    assert.equal(await count(ungraded), 2, "window closed: not graded");
    assert.equal(await count(`SELECT count(*) AS n FROM app.fundus_photos f WHERE f.topcon_file = '990007.fda' AND NOT EXISTS (SELECT 1 FROM app.dr_gradings g WHERE g.photo_id = f.id)`), 0, "today's are");
    await put("retina.topcon_backfill_window", OPEN);
    for (let i = 0; i < 3; i++) await gradeNewPhotos(log);
    assert.equal(await count(ungraded), 0, "window open: graded");
    await put("retina.topcon_backfill_window", CLOSED);
    const todo = (await call("GET", `/api/fundus/sessions?status=todo&patientId=${PID2}`, doc)).body.sessions;
    const all = (await call("GET", `/api/fundus/sessions?status=all&patientId=${PID2}`, doc)).body.sessions;
    assert.equal(todo.length, 1, "today's session only"); assert.equal(all.length, 2, "yesterday's under All");
  });

  console.log("grading, reports and screens");
  await step("Maestro2 photographs are graded by the research model, recorded as source topcon", async () => {
    let n = 0; for (let i = 0; i < 3; i++) n += await gradeNewPhotos(log);
    const g = (await pool.query(`SELECT source, image_filename FROM app.dr_gradings WHERE photo_id IN (${PHOTOS})`)).rows;
    assert.ok(g.length >= 3 && g.every((x) => x.source === "topcon" && /^topcon-photo-\d+\.jpg$/.test(x.image_filename)));
  });
  await step("the day's Maestro2 photographs form a fundus report session the doctor can report, with its OCT scans", async () => {
    const s = (await call("GET", `/api/fundus/sessions?status=todo&patientId=${PID}`, doc)).body.sessions;
    assert.equal(s.length, 1); assert.deepEqual(s[0].sources, ["topcon"]); assert.equal(s[0].examKey, 0); assert.equal(s[0].photos, 2);
    const one = (await call("GET", `/api/fundus/session?patientId=${PID}&examDate=${s[0].examDate}&examKey=0`, doc)).body;
    assert.ok(one.photos.every((p: any) => p.source === "topcon" && p.protocol));
    const scans = (await call("GET", `/api/oct/studies?patientId=${PID}&date=${s[0].examDate}`, doc)).body.studies;
    assert.equal(scans.length, 2);
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
