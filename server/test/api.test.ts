// End-to-end API test against a TEST database (never the clinic's real one).
//   SUDARSHAN_ENV=/path/to/test.env npm test
// It creates its own users, doctor and days with a "zz_test" prefix and removes them afterwards.
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { addDays, todayIST, isoWeekday } from "../src/lib/time.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
const dbName = (await pool.query("SELECT current_database() AS d, inet_server_port() AS p")).rows[0];
console.log(`test database: ${dbName.d} (port ${dbName.p ?? "socket"})`);

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

type Res = { status: number; body: any; cookie?: string };
async function call(method: string, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const set = r.headers["set-cookie"];
  const sc = Array.isArray(set) ? set[0] : set;
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, cookie: sc ? sc.split(";")[0] : undefined };
}

// ---------- fixtures ----------
const D1 = addDays(todayIST(), 10), D2 = addDays(todayIST(), 11), HOL = addDays(todayIST(), 12);
async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    DELETE FROM app.followup_actions WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test%');
    DELETE FROM app.appointment_events WHERE appointment_id IN (SELECT id FROM app.appointments WHERE patient_name LIKE 'ZZ Test%');
    DELETE FROM app.appointments WHERE patient_name LIKE 'ZZ Test%';
    DELETE FROM app.doctor_exceptions WHERE doctor_id IN (SELECT id FROM app.doctors WHERE name LIKE 'Dr ZZ Test%');
    DELETE FROM app.doctor_schedule WHERE doctor_id IN (SELECT id FROM app.doctors WHERE name LIKE 'Dr ZZ Test%');
    DELETE FROM app.doctors WHERE name LIKE 'Dr ZZ Test%';
    DELETE FROM app.day_capacity WHERE on_date IN ('${D1}','${D2}','${HOL}');
    DELETE FROM app.holidays WHERE on_date IN ('${D1}','${D2}','${HOL}');
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test%');
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test%');
    DELETE FROM app.users WHERE username LIKE 'zz_test%';
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9";
const hash = await hashPassword(pw);
{
  const c = await pool.connect();
  await c.query("BEGIN"); await c.query("SET LOCAL app.skip_audit = 'on'");
  await c.query(`INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_admin','ZZ Admin','admin',$1,false), ('zz_test_staff','ZZ Staff','staff',$1,false),
    ('zz_test_doc','ZZ Doctor','doctor',$1,false), ('zz_test_new','ZZ Newcomer','staff',$1,true)`, [hash]);
  await c.query("COMMIT"); c.release();
}
const doc = (await pool.query(`INSERT INTO app.doctors (name) VALUES ('Dr ZZ Test') RETURNING id`)).rows[0].id;
await pool.query(`INSERT INTO app.doctor_schedule (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','13:00')`, [doc, isoWeekday(D1)]);
await pool.query(`INSERT INTO app.day_capacity (on_date, max_slots) VALUES ($1, 3), ($2, 20)`, [D1, D2]);

let admin = "", staff = "", doctor = "";
try {
  console.log("auth");
  await step("health is public", async () => { const r = await call("GET", "/api/health"); assert.equal(r.status, 200); assert.equal(r.body.ok, true); });
  await step("API needs login", async () => { const r = await call("GET", "/api/meta"); assert.equal(r.status, 401); });
  await step("wrong password refused", async () => {
    const r = await call("POST", "/api/auth/login", undefined, { username: "zz_test_staff", password: "nope" });
    assert.equal(r.status, 401); assert.equal(r.body.error, "bad_login");
  });
  await step("login works and sets an HTTP-only cookie", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ZZ_TEST_ADMIN", password: pw } });
    assert.equal(r.statusCode, 200);
    const sc = String(r.headers["set-cookie"]);
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
    admin = sc.split(";")[0];
    staff = (await call("POST", "/api/auth/login", undefined, { username: "zz_test_staff", password: pw })).cookie!;
    doctor = (await call("POST", "/api/auth/login", undefined, { username: "zz_test_doc", password: pw })).cookie!;
    assert.ok(staff && doctor);
  });
  await step("brute force is slowed down", async () => {
    for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", undefined, { username: "zz_test_doc", password: "bad" + i });
    const r = await call("POST", "/api/auth/login", undefined, { username: "zz_test_doc", password: pw });
    assert.equal(r.status, 429);
  });
  await step("must change password before using the app", async () => {
    const c = (await call("POST", "/api/auth/login", undefined, { username: "zz_test_new", password: pw })).cookie!;
    assert.equal((await call("GET", "/api/meta", c)).status, 403);
    assert.equal((await call("GET", "/api/auth/me", c)).body.user.mustChangePassword, true);
    const weak = await call("POST", "/api/auth/change-password", c, { currentPassword: pw, newPassword: "zz_test_new1" });
    assert.equal(weak.status, 400);
    const ok = await call("POST", "/api/auth/change-password", c, { currentPassword: pw, newPassword: "Blue-River-42" });
    assert.equal(ok.status, 200);
    assert.equal((await call("GET", "/api/meta", c)).status, 200);
  });
  await step("writes from another site are refused", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1 }, { origin: "http://evil.example" });
    assert.equal(r.status, 403);
  });

  console.log("users");
  let newUserId = 0;
  await step("admin adds a user and gets a one-time password", async () => {
    const r = await call("POST", "/api/users", admin, { username: "zz_test_fameesha", fullName: "ZZ Fameesha", role: "staff" });
    assert.equal(r.status, 200); assert.match(r.body.temporaryPassword, /^[A-Z][a-z]{3}-\d{4}$/);
    newUserId = r.body.user.id;
    const login = await call("POST", "/api/auth/login", undefined, { username: "zz_test_fameesha", password: r.body.temporaryPassword });
    assert.equal(login.status, 200); assert.equal(login.body.user.mustChangePassword, true);
  });
  await step("staff cannot manage users", async () => {
    assert.equal((await call("GET", "/api/users", staff)).status, 403);
  });
  await step("deactivating a user logs them out", async () => {
    const r = await call("PATCH", `/api/users/${newUserId}`, admin, { isActive: false });
    assert.equal(r.status, 200); assert.equal(r.body.user.isActive, false);
  });
  await step("password never appears in the audit log", async () => {
    const r = await call("POST", `/api/users/${newUserId}/reset-password`, admin);
    assert.equal(r.status, 200);
    const row = (await pool.query(`SELECT changes FROM app.audit_log WHERE entity_type='users' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [String(newUserId)])).rows[0];
    assert.equal(row.changes.password_hash, "(changed)");
    assert.ok(!JSON.stringify(row.changes).includes("$2"));
  });

  console.log("calendar");
  await step("day list shows capacity", async () => {
    const r = await call("GET", `/api/days?from=${D1}&to=${D2}`, staff);
    assert.equal(r.status, 200); assert.equal(r.body.days[0].maxSlots, 3); assert.equal(r.body.days[0].open, true);
  });
  await step("day view gives the slot grid and the doctor's hours", async () => {
    const r = await call("GET", `/api/days/${D1}`, staff);
    assert.equal(r.body.slots[0].time, "09:00"); assert.equal(r.body.slots.length, 54);
    const d = r.body.doctors.find((x: any) => x.doctorId === doc);
    assert.deepEqual(d.sessions, [{ start: "09:00", end: "13:00" }]);
  });
  await step("staff cannot change capacity; manager/admin can", async () => {
    assert.equal((await call("PUT", `/api/days/${D2}/capacity`, staff, { maxSlots: 30 })).status, 403);
    assert.equal((await call("PUT", `/api/days/${D2}/capacity`, admin, { maxSlots: 30 })).status, 200);
  });
  await step("holiday blocks booking", async () => {
    assert.equal((await call("PUT", `/api/holidays/${HOL}`, admin, { reason: "Test holiday" })).status, 200);
    const r = await call("POST", "/api/appointments", staff, { date: HOL, slotTime: "10:00", patientName: "ZZ Test Holiday", phone: "9000000000" });
    assert.equal(r.status, 409); assert.match(r.body.message, /holiday/);
  });

  console.log("appointments");
  let a1 = 0, a2 = 0;
  await step("book a new patient", async () => {
    const r = await call("POST", "/api/appointments", staff, {
      date: D1, slotTime: "10:00", doctorId: doc, patientName: "ZZ Test One", phone: "9000000001", planOfAction: "R+D", tags: ["VIP"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    a1 = r.body.appointment.id;
    assert.equal(r.body.appointment.status, "booked"); assert.equal(r.body.appointment.patientType, "New");
    assert.equal(r.body.appointment.bookedBy, "ZZ Staff");
  });
  await step("same patient twice on a day is refused", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "10:10", patientName: "zz test one", phone: "9000000001" });
    assert.equal(r.status, 409); assert.match(r.body.message, /already has an appointment/);
  });
  await step("taken slot is refused with nearby free slots", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "10:00", patientName: "ZZ Test Two", phone: "9000000002" });
    assert.equal(r.status, 409); assert.ok(r.body.details.freeSlots.includes("10:10"));
  });
  await step("slot off the grid is refused", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "10:05", patientName: "ZZ Test Two", phone: "9000000002" });
    assert.equal(r.status, 409); assert.match(r.body.message, /not a booking slot/);
  });
  await step("outside the doctor's hours books with a warning", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "15:00", doctorId: doc, patientName: "ZZ Test Two", phone: "9000000002" });
    assert.equal(r.status, 200); a2 = r.body.appointment.id;
    assert.match(r.body.warnings[0], /outside Dr ZZ Test's hours/);
  });
  await step("waitlist booking needs no slot", async () => {
    const r = await call("POST", "/api/appointments", staff, { date: D1, patientName: "ZZ Test Wait", phone: "9000000003" });
    assert.equal(r.status, 200); assert.equal(r.body.appointment.status, "waitlist");
  });
  await step("day full: staff refused, staff override refused, admin override allowed", async () => {
    await call("POST", "/api/appointments", staff, { date: D1, slotTime: "11:00", patientName: "ZZ Test Three", phone: "9000000004" });
    const full = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "11:10", patientName: "ZZ Test Four", phone: "9000000005" });
    assert.equal(full.status, 409); assert.match(full.body.message, /full \(3 of 3/);
    const o1 = await call("POST", "/api/appointments", staff, { date: D1, slotTime: "11:10", patientName: "ZZ Test Four", phone: "9000000005", override: { reason: "Urgent RD" } });
    assert.equal(o1.status, 400);
    const o2 = await call("POST", "/api/appointments", admin, { date: D1, slotTime: "11:10", patientName: "ZZ Test Four", phone: "9000000005", override: { reason: "Urgent RD" } });
    assert.equal(o2.status, 200); assert.match(o2.body.warnings[0], /booked anyway: Urgent RD/);
  });
  await step("lowering capacity below bookings is refused", async () => {
    const r = await call("PUT", `/api/days/${D1}/capacity`, admin, { maxSlots: 2 });
    assert.equal(r.status, 400);
  });
  await step("doctor cannot book", async () => {
    const r = await call("POST", "/api/appointments", doctor, { date: D2, slotTime: "10:00", patientName: "ZZ Test Five", phone: "9000000006" });
    assert.equal(r.status, 403);
  });
  await step("reschedule to another day", async () => {
    const r = await call("POST", `/api/appointments/${a1}/move`, staff, { date: D2, slotTime: "09:40", reason: "Patient asked" });
    assert.equal(r.status, 200); assert.equal(r.body.appointment.date, D2); assert.equal(r.body.appointment.slotTime, "09:40");
  });
  await step("confirmation call", async () => {
    const r = await call("POST", `/api/appointments/${a1}/confirm`, staff, { stage: "4day", note: "Spoke to son" });
    assert.equal(r.status, 200); assert.equal(r.body.appointment.status, "confirmed"); assert.ok(r.body.appointment.confirmed4dayAt);
  });
  await step("edit tags and plan", async () => {
    const r = await call("PATCH", `/api/appointments/${a1}`, staff, { tags: ["VIP", "wheelchair"], planOfAction: "R+D, HFA" });
    assert.equal(r.status, 200); assert.deepEqual(r.body.appointment.tags, ["VIP", "wheelchair"]);
    assert.equal(r.body.appointment.phone, "9000000001", "fields not sent must stay as they were");
  });
  await step("doctor can add a remark", async () => {
    assert.equal((await call("POST", `/api/appointments/${a1}/remarks`, doctor, { note: "Needs OCT before consult" })).status, 200);
  });
  await step("cancel, then restore into a slot", async () => {
    const c = await call("POST", `/api/appointments/${a2}/cancel`, staff, { reason: "Patient unwell" });
    assert.equal(c.status, 200); assert.equal(c.body.appointment.status, "cancelled");
    assert.equal((await call("POST", `/api/appointments/${a2}/cancel`, staff, { reason: "again" })).status, 409);
    const r = await call("POST", `/api/appointments/${a2}/move`, staff, { date: D2, slotTime: "12:00" });
    assert.equal(r.status, 200); assert.equal(r.body.appointment.status, "booked"); assert.equal(r.body.appointment.cancelReason, null);
  });
  await step("appointment story lists every step with who did it", async () => {
    const r = await call("GET", `/api/appointments/${a1}`, doctor);
    const types = r.body.events.map((e: any) => e.type);
    assert.deepEqual(types, ["booked", "rescheduled", "confirmed_4day", "tag_added", "remark"]);
    assert.equal(r.body.events[4].by, "ZZ Doctor");
  });
  await step("day board lists bookings in slot order, waitlist last", async () => {
    const r = await call("GET", `/api/appointments?date=${D1}`, doctor);
    const names = r.body.appointments.map((a: any) => a.patientName);
    assert.deepEqual(names, ["ZZ Test Three", "ZZ Test Four", "ZZ Test Wait"]);
  });
  await step("search across days", async () => {
    const r = await call("GET", `/api/appointments?q=9000000001&from=${D1}`, staff);
    assert.equal(r.body.appointments.length, 1);
  });

  console.log("audit");
  await step("activity log reads as plain sentences", async () => {
    const r = await call("GET", `/api/audit?entity=appointments&entityId=${a1}&limit=20`, admin);
    assert.equal(r.status, 200);
    const lines = r.body.entries.map((e: any) => `${e.who} | ${e.summary} | ${e.details}`);
    const resched = lines.find((l: string) => l.includes("Rescheduled ZZ Test One"));
    assert.ok(resched, lines.join("\n"));
    assert.match(resched!, /^ZZ Staff \|/);
    assert.match(resched!, /Time: 10:00 → 09:40/);
    console.log("      e.g. " + resched);
  });
  await step("staff cannot read the activity log", async () => {
    assert.equal((await call("GET", "/api/audit", staff)).status, 403);
  });

  console.log("patients, follow-ups (empty Yarago mirror in the test DB)");
  await step("patient search runs", async () => {
    const r = await call("GET", "/api/patients/search?q=SPD", staff);
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.patients));
  });
  await step("follow-up board runs", async () => {
    for (const v of ["to_call", "upcoming", "all_overdue"]) assert.equal((await call("GET", `/api/followups?view=${v}`, staff)).status, 200);
  });
  await step("meta lists doctors and confirmed status labels", async () => {
    const r = await call("GET", "/api/meta", staff);
    assert.ok(r.body.doctors.some((d: any) => d.id === doc));
    assert.equal(r.body.codeLabels.find((l: any) => l.kind === "appointment_status" && l.code === 0).label, "Booked, not arrived");
  });

  await step("logout ends the session", async () => {
    await call("POST", "/api/auth/logout", staff);
    assert.equal((await call("GET", "/api/meta", staff)).status, 401);
  });
  console.log(`\nall ${passed} checks passed`);
} finally {
  await cleanup();
  await app.close();
  await pool.end();
}
