// Demo data for screenshots in the TEST database only.
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { addDays, todayIST } from "../src/lib/time.js";
if (!process.env.SUDARSHAN_ENV) { console.error("Demo data goes into a TEST database only: set SUDARSHAN_ENV to a test .env"); process.exit(2); }
const c = await pool.connect();
await c.query("BEGIN"); await c.query("SET LOCAL app.skip_audit='on'");
const h = await hashPassword("Demo-Pass-42");
await c.query(`INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES ('demo','Fameesha K','admin',$1,false)
  ON CONFLICT (username) DO UPDATE SET password_hash=$1, must_change_password=false, is_active=true`, [h]);
const t = todayIST();
for (let i = 0; i < 30; i++) await c.query(`INSERT INTO app.day_capacity VALUES ($1, $2) ON CONFLICT (on_date) DO UPDATE SET max_slots=$2`, [addDays(t, i), i % 7 === 6 ? 0 : 24]);
let doc = (await c.query(`SELECT id FROM app.doctors WHERE is_active ORDER BY id LIMIT 1`)).rows[0]?.id;
if (!doc) doc = (await c.query(`INSERT INTO app.doctors (name) VALUES ('Dr. Sameera') RETURNING id`)).rows[0].id;
const others = ['Dr. Arun Menon'];
for (const n of others) await c.query(`INSERT INTO app.doctors (name) VALUES ($1) ON CONFLICT DO NOTHING`, [n]);
await c.query(`DELETE FROM app.doctor_schedule WHERE doctor_id=$1`, [doc]);
for (let wd = 1; wd <= 6; wd++) { await c.query(`INSERT INTO app.doctor_schedule (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','13:30'),($1,$2,'14:30','17:30')`, [doc, wd]); }
await c.query(`DELETE FROM app.appointment_events WHERE appointment_id IN (SELECT id FROM app.appointments WHERE source_ref='demo')`);
await c.query(`DELETE FROM app.appointments WHERE source_ref='demo'`);
const names = [["Ayisha Beevi","SPD10231","R+D, OCT",["VIP"]],["Muhammed Rafi","SPD08812","Inj Eylea RE",[]],["Lakshmi Amma","SPD11902","HFA",["Wheelchair"]],
  ["Baby Nihal","SPD12011","ROP screening",["Kids"]],["Joseph Thomas","SPD07743","Laser PRP LE",[]],["Sreeja P","SPD12233","R+D",[]],
  ["Abdul Kareem","SPD09917","Review",["BNI"]],["Fathima Zahra","SPD12290","New, R+D",[]],["Gopalan Nair","SPD05521","Inj Avastin LE",[]]];
const slots = ["09:20","09:40","10:00","10:20","10:30","11:00","11:30","12:10","15:00"];
const status = ["confirmed","confirmed","booked","confirmed","booked","booked","confirmed","booked","booked"];
for (const d of [t, addDays(t,1)]) for (const [i, [n, mrd, plan, tags]] of names.entries()) {
  await c.query(`INSERT INTO app.appointments (appointment_date, slot_time, doctor_id, mrd, patient_name, phone, age_years, plan_of_action, tags, status, source, source_ref, patient_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'booking','demo',$11)`, [d, slots[i], doc, mrd, n, "98470" + (10000 + i * 37), 30 + i * 6, plan, tags, status[i], i === 7 ? "New" : "Old"]);
}
await c.query(`INSERT INTO app.appointments (appointment_date, mrd, patient_name, phone, plan_of_action, status, source, source_ref) VALUES ($1,'SPD12301','Rahul Krishnan','9847012345','Review','waitlist','booking','demo')`, [t]);
await c.query("COMMIT"); c.release(); await pool.end();
console.log("seeded");
