// Read-only check of the API against the clinic's real database: does each screen's query work,
// how long does it take, how many rows. Prints counts and timings only - no patient details.
// It adds a temporary admin login (zz_check) for the duration of the run and removes it after.
//   npx tsx test/real-data.ts
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { todayIST, addDays } from "../src/lib/time.js";

const app = await buildApp({ logger: false });
const c = await pool.connect();
await c.query("BEGIN"); await c.query("SET LOCAL app.skip_audit = 'on'");
const uid = (await c.query(`INSERT INTO app.users (username, full_name, role, must_change_password) VALUES ('zz_check','API check','admin',false)
                             ON CONFLICT (username) DO UPDATE SET is_active = true, must_change_password = false RETURNING id`)).rows[0].id;
const sid = (await c.query(`INSERT INTO app.sessions (user_id, expires_at) VALUES ($1, now() + interval '10 minutes') RETURNING id`, [uid])).rows[0].id;
await c.query("COMMIT"); c.release();
const cookie = `sudarshan_sid=${sid}`;

async function get(label: string, url: string, count: (b: any) => string) {
  const t = performance.now();
  const r = await app.inject({ method: "GET", url, headers: { cookie } });
  const ms = Math.round(performance.now() - t);
  const body = JSON.parse(r.body);
  const info = r.statusCode === 200 ? count(body) : `ERROR ${body.message}`;
  console.log(`  ${label.padEnd(44)} ${String(r.statusCode).padEnd(4)} ${String(ms).padStart(6)} ms   ${info}`);
  return body;
}

const today = todayIST();
try {
  console.log(`\nAPI check on real data (${today})   status   time   result`);
  await get("health", "/api/health", (b) => `last sync ${b.lastTableSync ?? "?"}`);
  await get("lists (doctors, plans, labels)", "/api/meta", (b) => `${b.doctors.length} doctors, ${b.plansOfAction.length} plans of action`);
  await get("days, next 6 weeks", "/api/days", (b) => `${b.days.filter((d: any) => d.open).length} open days`);
  await get("today's slot grid", `/api/days/${today}`, (b) => `${b.day.booked} booked of ${b.day.maxSlots}, ${b.doctors.length} doctors`);
  const board = await get("today's board with Yarago live state", `/api/appointments?date=${today}`,
    (b) => `${b.appointments.length} bookings, ${b.appointments.filter((a: any) => a.liveStage).length} matched to Yarago today`);
  const stages: Record<string, number> = {};
  for (const a of board.appointments ?? []) stages[a.liveStage ?? "no Yarago visit yet"] = (stages[a.liveStage ?? "no Yarago visit yet"] ?? 0) + 1;
  if (Object.keys(stages).length) console.log("     stages:", JSON.stringify(stages));
  await get("tomorrow's board", `/api/appointments?date=${addDays(today, 1)}`, (b) => `${b.appointments.length} bookings`);
  const s = await get("patient search 'SPD'", "/api/patients/search?q=SPD", (b) => `${b.patients.length} found`);
  await get("patient search by phone digits", "/api/patients/search?q=9846", (b) => `${b.patients.length} found`);
  // a patient with many visits makes the heaviest patient page
  const heavy = (await pool.query(`SELECT npatient_id AS id FROM yarago.tblappointments WHERE nstatus_id = 3
                                    GROUP BY npatient_id ORDER BY count(*) DESC LIMIT 1`)).rows[0]?.id ?? s.patients?.[0]?.patientId;
  if (heavy) {
    const p = await get("patient page (patient with most visits)", `/api/patients/${heavy}`,
      (b) => `${b.visits.length} visits, ${b.trend?.length ?? 0} trend points, ${b.injections?.length ?? 0} injections`);
    if (p.latestVisitId) await get("visit detail", `/api/patients/${heavy}/visits/${p.latestVisitId}`, (b) => `${b.findings.length} findings`);
  }
  await get("follow-ups to call (overdue up to 90 days)", "/api/followups", (b) => `${b.followups.length} to call, ${b.followups.filter((f: any) => f.injectionCount > 0).length} injection patients`);
  await get("follow-ups due next 7 days", "/api/followups?view=upcoming", (b) => `${b.followups.length}`);
  await get("activity log, latest 50", "/api/audit", (b) => `${b.entries.length} entries`);
  await get("imported appointments, last 30 days", `/api/appointments?from=${addDays(today, -30)}&to=${today}&limit=500`,
    (b) => `${b.appointments.length} (${b.appointments.filter((a: any) => a.status === "no_show").length} no-show)`);
} finally {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on'; DELETE FROM app.sessions WHERE user_id = ${uid}; DELETE FROM app.users WHERE id = ${uid}; COMMIT;`);
  await app.close(); await pool.end();
}
console.log("\n(temporary check login removed)");
