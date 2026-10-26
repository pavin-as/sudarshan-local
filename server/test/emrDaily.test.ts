// The EMR daily report (D-051) against a TEST database: synthetic Yarago visits on 2 Mar 2026, the per-visit check,
// the report kept at 17:30, items saved later, and the monthly page counting from the same check.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/emrDaily.test.ts
// Its users are zz_test_emr_*, its Yarago patients 990000201-990000203 (MRD SPD99911-13), appointments 990000201..; all
// removed afterwards.
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { takeReport } from "../src/services/emrDaily.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);

const D = "2026-03-02";
const A = 990000201, B = 990000202, C = 990000203;                  // patients, and their visits that day
const B_EARLIER = 990000211, INJ = 990000212, CANCELLED = 990000213;   // other appointments
const ALL = [A, B, C, B_EARLIER, INJ, CANCELLED];
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    DELETE FROM app.audit_log WHERE entity_type = 'emr_daily_reports' AND summary LIKE '%2 Mar 2026%';
    DELETE FROM app.emr_daily_reports WHERE report_date = '${D}';
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_emr%');
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_emr%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_emr%';
    DELETE FROM yarago.tbldiagnosis WHERE tappt_id IN (${ALL});
    DELETE FROM yarago.tblpatientinjectionopdinvestigationdetials WHERE napptid IN (${ALL});
    DELETE FROM yarago.tbl_patient_appointment_history WHERE nappoint_id IN (${ALL});
    DELETE FROM yarago.tblappointments WHERE aappoint_id IN (${ALL});
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id IN (${A}, ${B}, ${C});
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_emr_opt','ZZ Emr Optometrist','optometrist','${hash}',false), ('zz_test_emr_doc','ZZ Emr Doctor','doctor','${hash}',false),
    ('zz_test_emr_staff','ZZ Emr Staff','staff','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name) VALUES
    (${A}, 'SPD99911', 'ZZ Test A'), (${B}, 'SPD99912', 'ZZ Test B'), (${C}, 'SPD99913', 'ZZ Test C');
  INSERT INTO yarago.tblappointments (aappoint_id, npatient_id, tappoint_date_time, nstatus_id) VALUES
    (${A}, ${A}, '${D} 09:30', 3),          -- new patient, completed, pinhole and family history not recorded
    (${B}, ${B}, '${D} 10:15', 3),          -- review (completed visit in February), nothing recorded
    (${C}, ${C}, '${D} 16:40', 2),          -- still in examination: not judged
    (${B_EARLIER}, ${B}, '2026-02-02 10:00', 3),
    (${INJ}, ${A}, '${D} 11:00', 3),        -- an injection appointment: left out
    (${CANCELLED}, ${C}, '${D} 12:00', 4);
  INSERT INTO yarago.tblpatientinjectionopdinvestigationdetials (aid, npatid, napptid, isinjectiongiven) VALUES (${INJ}, ${A}, ${INJ}, 'Yes');
  INSERT INTO yarago.tbl_patient_appointment_history (nappoint_id, npatient_id, visionvadv_r_id, visionvadv_l_id, dva_r_id, dva_l_id,
      ph_r_id, ph_l_id, visionvanv_r_id, arsph_r_id, oeiop_right, pupil_right, colourvision_right, present_complaints, opthalamic_history,
      systemic_illness, drug_allergies, familyhistory, systemic_status, examination_history, medicinename, advice_id, followup)
    VALUES (${A}, ${A}, '6/6', '6/9', '6/12', '6/18', 'null', '0', 'N6', '-1.00', '14', 'Normal', 'Normal', '1,', '2,', '3,', '4,', '',
            '[{"key":"HbA1c","value":"7.1"}]', '5,', 'ZZ drops', '1,', '3 months'),
           (${B}, ${B}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO yarago.tbldiagnosis (adiagnosis_id, tappt_id, tdiagnosis_mst_id) VALUES (${A}, ${A}, '12');
  COMMIT;`);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
async function login(u: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: pw } });
  assert.equal(r.statusCode, 200, `login ${u}`); return String(r.headers["set-cookie"]).split(";")[0];
}
const call = async (url: string, cookie: string) => {
  const r = await app.inject({ method: "GET", url, headers: { cookie } });
  return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : null };
};
const visit = (body: any, id: number) => body.visits.find((v: any) => v.visitId === id);

try {
  const opt = await login("zz_test_emr_opt"), doc = await login("zz_test_emr_doc"), staff = await login("zz_test_emr_staff");

  await step("clinical roles read the daily report, front desk does not; a bad date is refused", async () => {
    assert.equal((await call(`/api/emr-daily?date=${D}`, staff)).status, 403);
    assert.equal((await call(`/api/emr-daily?date=${D}`, doc)).status, 200);
    assert.equal((await call(`/api/emr-daily?date=2026-13-40`, opt)).status, 400);
  });
  await step("the day's consultations only (no injection, no cancelled), each with exactly what is not recorded", async () => {
    const r = (await call(`/api/emr-daily?date=${D}`, opt)).body;
    assert.deepEqual(r.visits.map((v: any) => v.visitId), [A, B, C]);
    assert.equal(r.items.length, 19); assert.equal(r.at, "17:30"); assert.equal(r.takenAt, null);
    const a = visit(r, A);
    assert.deepEqual(a.missing, ["pinhole", "family"], "'null' and '0' are not recorded; everything else is");
    assert.equal(a.mrd, "SPD99911"); assert.equal(a.isNew, true); assert.equal(a.time, "09:30"); assert.equal(a.atReport, null);
    const b = visit(r, B);
    assert.equal(b.missing.length, 19); assert.equal(b.isNew, false, "seen in February");
    assert.equal(visit(r, C).statusId, 2);
    assert.ok(!JSON.stringify(r).includes("ZZ Test"), "no names on the report");
  });
  await step("the report is kept once a day; items saved later show against it", async () => {
    assert.equal(await takeReport(D), true);
    assert.equal(await takeReport(D), false, "only once");
    await pool.query(`UPDATE yarago.tbl_patient_appointment_history SET ph_r_id = '6/9' WHERE nappoint_id = ${A}`);
    const r = (await call(`/api/emr-daily?date=${D}`, opt)).body;
    assert.ok(r.takenAt);
    const a = visit(r, A);
    assert.deepEqual(a.missing, ["family"]);
    assert.deepEqual(a.atReport, { statusId: 3, missing: ["pinhole", "family"] });
    assert.equal(visit(r, C).atReport.statusId, 2);
    const n = Number((await pool.query(`SELECT count(*) n FROM app.audit_feed WHERE entity_type = 'emr_daily_reports' AND summary = 'EMR daily report taken for 2 Mar 2026 (3 visits)'`)).rows[0].n);
    assert.equal(n, 1, "the activity log says the report was taken");
  });
  await step("the monthly page counts from the same check: completed consultations only", async () => {
    await pool.query(`SELECT analytics.refresh_emr_completeness()`);
    const m = async (grp: string, item: string) => (await pool.query(
      `SELECT recorded, total FROM analytics.emr_completeness WHERE month = '2026-03-01' AND visit_group = $1 AND item = $2`, [grp, item])).rows[0];
    assert.deepEqual(await m("all", "pinhole"), { recorded: 1, total: 2 });
    assert.deepEqual(await m("all", "family"), { recorded: 0, total: 2 });
    assert.deepEqual(await m("new", "bcva"), { recorded: 1, total: 1 });
    assert.deepEqual(await m("review", "bcva"), { recorded: 0, total: 1 });
  });
} finally {
  await cleanup();
  await pool.query(`SELECT analytics.refresh_emr_completeness()`);
  await app.close(); await pool.end();
}
console.log(`\n${passed} EMR daily report checks passed`);
