// WhatsApp and Razorpay in test mode (D-034), end to end against a TEST database, with AiSensy and Razorpay replaced
// by fakes (nothing leaves the machine).   SUDARSHAN_ENV=/path/to/test.env npx tsx test/outreach.test.ts
// Its users are zz_test_out_*, its bookings "ZZ Test Out ..." and "ZZ Out Real ..."; all removed afterwards, and the
// settings it changes are put back.
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { addDays, todayIST } from "../src/lib/time.js";
import { deliverQueued, setWhatsAppTransport, type WaRequest, type WaResult } from "../src/services/whatsapp.js";
import { pollPayments } from "../src/services/payments.js";
import { setRazorpayTransport } from "../src/services/razorpay.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);
process.env.AISENSY_API_KEY = "fake-aisensy-key-for-tests";
process.env.RAZORPAY_KEY_ID = "rzp_test_fakeid";
process.env.RAZORPAY_KEY_SECRET = "fake-razorpay-secret";

// ---------- fakes ----------
const sent: WaRequest[] = [];
let waNext: WaResult | null = null;                      // set to make the next send fail
setWhatsAppTransport(async (r) => { sent.push(r); const x = waNext ?? { ok: true, ref: `wa-${sent.length}` }; waNext = null; return x; });

interface FakeLink { id: string; status: string; amount: number; amount_paid: number; payments: any[]; reference_id: string; body: any }
const links = new Map<string, FakeLink>();
const refunds = new Map<string, any>();
const rzpCalls: { method: string; path: string; body?: any; headers?: any }[] = [];
let rzpFailNext: { status: number; data: any } | null = null;
let refundStatusOnCreate = "pending";
setRazorpayTransport(async (method, path, body, headers) => {
  rzpCalls.push({ method, path, body, headers });
  if (rzpFailNext) { const f = rzpFailNext; rzpFailNext = null; return f; }
  let m: RegExpMatchArray | null;
  if (method === "POST" && path === "/payment_links") {
    const b = body as any;
    const id = `plink_${links.size + 1}`;
    links.set(id, { id, status: "created", amount: b.amount, amount_paid: 0, payments: [], reference_id: b.reference_id, body: b });
    return { status: 200, data: { id, short_url: `https://rzp.io/i/${id}`, status: "created", amount: b.amount, amount_paid: 0 } };
  }
  if ((m = path.match(/^\/payment_links\/([^/]+)$/)) && method === "GET") {
    const l = links.get(m[1]); return l ? { status: 200, data: { ...l, short_url: `https://rzp.io/i/${l.id}` } } : { status: 404, data: { error: { description: "not found" } } };
  }
  if ((m = path.match(/^\/payment_links\/([^/]+)\/cancel$/))) {
    const l = links.get(m[1])!;
    if (l.status !== "created") return { status: 400, data: { error: { description: `link is ${l.status}` } } };
    l.status = "cancelled"; return { status: 200, data: { ...l } };
  }
  if ((m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
    const id = `rfnd_${refunds.size + 1}`;
    const r = { id, payment_id: m[1], amount: (body as any).amount, status: refundStatusOnCreate };
    refunds.set(id, r); return { status: 200, data: r };
  }
  if ((m = path.match(/^\/payments\/([^/]+)\/refunds\/([^/]+)$/))) return { status: 200, data: refunds.get(m[2]) };
  return { status: 404, data: { error: { description: `fake: no ${method} ${path}` } } };
});
const pay = (linkId: string, rupees: number) => {
  const l = links.get(linkId)!;
  l.status = rupees * 100 >= l.amount ? "paid" : "partially_paid"; l.amount_paid = rupees * 100;
  l.payments = [{ payment_id: `pay_${linkId}`, amount: rupees * 100, status: "captured", created_at: Math.floor(Date.now() / 1000) }];
};

// ---------- fixtures ----------
const D = addDays(todayIST(), 3);
const KEYS = ["messaging.mode", "messaging.test_numbers", "messaging.templates", "payments.mode", "payments.default_amount",
              "payments.min_amount", "payments.max_amount", "payments.link_hours", "trial.google_master"];
const saved = (await pool.query(`SELECT key, value FROM app.settings WHERE key = ANY($1)`, [KEYS])).rows;
const app = await buildApp({ logger: !!process.env.TEST_LOG });

async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    DELETE FROM app.messages WHERE appointment_id IN (SELECT id FROM app.appointments WHERE patient_name LIKE 'ZZ Test Out%' OR patient_name LIKE 'ZZ Out Real%')
       OR created_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%');
    DELETE FROM app.broadcasts WHERE created_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%');
    DELETE FROM app.payment_refunds WHERE payment_id IN (SELECT id FROM app.payments WHERE created_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%'));
    DELETE FROM app.payments WHERE created_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%');
    DELETE FROM app.appointment_events WHERE appointment_id IN (SELECT id FROM app.appointments WHERE patient_name LIKE 'ZZ Test Out%' OR patient_name LIKE 'ZZ Out Real%');
    DELETE FROM app.appointments WHERE patient_name LIKE 'ZZ Test Out%' OR patient_name LIKE 'ZZ Out Real%';
    DELETE FROM app.day_capacity WHERE on_date = '${D}' AND notes = 'zz_test_out';
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%')
       OR summary LIKE '%ZZ Test Out%' OR summary LIKE '%ZZ Out Real%';
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_out%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_out%';
    COMMIT;`);
}
async function restoreSettings() {
  await pool.query(`DELETE FROM app.settings WHERE key = ANY($1)`, [KEYS]);
  for (const r of saved) await pool.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb)`, [r.key, JSON.stringify(r.value)]);
}
await cleanup();
const pw = "Correct-Horse-9";
{
  const c = await pool.connect(); const hash = await hashPassword(pw);
  await c.query("BEGIN"); await c.query("SET LOCAL app.skip_audit = 'on'");
  await c.query(`INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_out_admin','ZZ Out Admin','admin',$1,false), ('zz_test_out_mgr','ZZ Out Manager','manager',$1,false),
    ('zz_test_out_staff','ZZ Out Staff','staff',$1,false), ('zz_test_out_doc','ZZ Out Doctor','doctor',$1,false)`, [hash]);
  await c.query("COMMIT"); c.release();
}
const setting = (k: string, v: unknown) => pool.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
await setting("trial.google_master", false);
await setting("messaging.mode", "test");
await setting("messaging.test_numbers", ["919800000001"]);
await pool.query(`DELETE FROM app.settings WHERE key = 'messaging.templates'`);     // the built-in templates
await setting("payments.mode", "test");
for (const [k, v] of [["payments.default_amount", 500], ["payments.min_amount", 100], ["payments.max_amount", 5000], ["payments.link_hours", 24]] as const) await setting(k, v);
await pool.query(`INSERT INTO app.day_capacity (on_date, max_slots, notes) VALUES ($1, 40, 'zz_test_out') ON CONFLICT (on_date) DO NOTHING`, [D]);

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
async function call(method: string, url: string, cookie?: string, payload?: unknown) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: cookie ? { cookie } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
async function login(u: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: pw } });
  return String(r.headers["set-cookie"]).split(";")[0];
}

try {
  const admin = await login("zz_test_out_admin"), mgr = await login("zz_test_out_mgr"), staff = await login("zz_test_out_staff"), doc = await login("zz_test_out_doc");
  const book = async (name: string, slot: string | null, phone: string | null) => {
    const r = await call("POST", "/api/appointments", staff, { date: D, slotTime: slot, patientName: name, phone });
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.appointment.id as number;
  };
  const one = await book("ZZ Test Out One", "10:00", "98000 00001");
  const two = await book("ZZ Test Out Two", "10:10", "9800000002");
  const real = await book("ZZ Out Real Patient", "10:20", "9800000001");
  const nophone = await book("ZZ Test Out Nophone", "10:30", null);
  const land = await book("ZZ Test Out Land", "10:40", "0494 2420000");
  await book("ZZ Test Out Wait", null, "9800000001");

  console.log("who may");
  await step("doctors do not send messages or handle payments; front desk sends one message but not the day's broadcast", async () => {
    assert.equal((await call("GET", "/api/whatsapp/status", doc)).status, 403);
    assert.equal((await call("GET", "/api/payments", doc)).status, 403);
    assert.equal((await call("GET", `/api/whatsapp/preview?date=${D}`, staff)).status, 403);
    assert.equal((await call("POST", "/api/whatsapp/broadcasts", staff, { date: D, template: "appointment_reminder", appointmentIds: [one] })).status, 403);
    assert.equal((await call("GET", "/api/whatsapp/status", staff)).status, 200);
    assert.equal((await call("GET", `/api/appointments/${one}/messages`, doc)).status, 200, "doctors see what was sent");
    assert.equal((await call("GET", "/api/settings/whatsapp", staff)).status, 403);
  });

  console.log("WhatsApp, test mode");
  let preview: any;
  await step("the preview lists the day's timed bookings and says why each one would not get the message", async () => {
    const r = await call("GET", `/api/whatsapp/preview?date=${D}`, mgr);
    assert.equal(r.status, 200); preview = r.body;
    const row = (id: number) => r.body.rows.find((x: any) => x.appointmentId === id);
    assert.equal(r.body.mode, "test");
    assert.equal(row(one).send, true); assert.equal(row(one).to, "+91 98000 00001");
    assert.match(row(two).reason, /not one of the test numbers/);
    assert.match(row(real).reason, /only TEST bookings/);
    assert.match(row(nophone).reason, /No phone number/);
    assert.match(row(land).reason, /Not a mobile number/);
    assert.ok(!r.body.rows.some((x: any) => /Wait/.test(x.patientName)), "the waitlist (no time) is not on the day's list");
    assert.equal(sent.length, 0, "a preview sends nothing");
  });
  await step("sending queues only those still allowed; the outbox sends them with the Google app's template wording", async () => {
    const r = await call("POST", "/api/whatsapp/broadcasts", mgr, { date: D, template: "appointment_reminder", appointmentIds: preview.rows.map((x: any) => x.appointmentId) });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.queued, 1);
    assert.equal(sent.length, 0, "nothing goes out until the outbox runs");
    assert.equal(await deliverQueued(), 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].campaignName, "sudarsdhan_appointment"); assert.equal(sent[0].destination, "919800000001");
    assert.equal(sent[0].templateParams[0], "ZZ Test Out One");
    assert.match(sent[0].templateParams[1], /^\d{1,2}-[A-Z][a-z]+-\d{4}$/); assert.equal(sent[0].templateParams[2], "10:00 AM");
    const h = await call("GET", "/api/whatsapp/broadcasts", staff);
    const b = h.body.broadcasts.find((x: any) => x.id === r.body.broadcastId);
    assert.equal(b.sent, 1); assert.equal(b.mode, "test"); assert.ok(b.finishedAt); assert.equal(b.notSent, preview.rows.length - 1);
    const msgs = (await call("GET", `/api/whatsapp/broadcasts/${b.id}`, staff)).body.messages;
    assert.equal(msgs[0].status, "sent"); assert.equal(msgs[0].templateLabel, "Appointment reminder");
  });
  await step("a reminder already sent is not sent twice, unless someone chooses to send it again", async () => {
    const p = await call("GET", `/api/whatsapp/preview?date=${D}`, mgr);
    assert.match(p.body.rows.find((x: any) => x.appointmentId === one).reason, /Already sent/);
    const r1 = await call("POST", `/api/appointments/${one}/messages`, staff, {});
    assert.equal(r1.status, 409); assert.match(r1.body.message, /already sent.*Send again/);
    waNext = { ok: false, error: "AiSensy refused it (HTTP 400): template paused" };
    const r2 = await call("POST", `/api/appointments/${one}/messages`, staff, { again: true });
    assert.equal(r2.status, 200);
    await deliverQueued();
    const m = (await call("GET", `/api/appointments/${one}/messages`, staff)).body.messages[0];
    assert.equal(m.status, "failed"); assert.match(m.error, /template paused/);
  });
  await step("a message interrupted by a restart is never sent again by itself", async () => {
    const n = sent.length;
    const u = (await pool.query(`SELECT id FROM app.users WHERE username = 'zz_test_out_staff'`)).rows[0].id;
    await pool.query(`INSERT INTO app.messages (channel, template, recipient, appointment_id, payload, status, mode, attempts, created_by)
                      VALUES ('whatsapp','appointment_reminder','919800000001',$1,'{"campaign":"sudarsdhan_appointment","params":[],"patient_name":"ZZ Test Out One"}','queued','test',1,$2)`, [one, u]);
    await deliverQueued();
    assert.equal(sent.length, n, "not sent");
    const m = (await call("GET", `/api/appointments/${one}/messages`, staff)).body.messages[0];
    assert.equal(m.status, "failed"); assert.match(m.error, /stopped while sending/);
  });
  await step("a message queued before WhatsApp was switched off is not sent; while off nothing can be queued", async () => {
    assert.equal((await call("POST", `/api/appointments/${one}/messages`, staff, { again: true })).status, 200);
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { mode: "off" })).status, 200);
    const n = sent.length;
    await deliverQueued();
    assert.equal(sent.length, n);
    assert.match((await call("GET", `/api/appointments/${one}/messages`, staff)).body.messages[0].error, /switched off before/);
    const p = await call("GET", `/api/whatsapp/preview?date=${D}`, mgr);
    assert.ok(p.body.rows.every((x: any) => /switched off/.test(x.reason)));
    assert.equal((await call("POST", `/api/appointments/${one}/messages`, staff, { again: true })).status, 409);
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { mode: "test" })).status, 200);
  });
  await step("live only by an admin, and only after cut-over (the Google app no longer the master)", async () => {
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { mode: "live" })).status, 403);
    await setting("trial.google_master", true);
    await new Promise((r) => setTimeout(r, 31_000));          // googleIsMaster() caches for 30 s
    const r = await call("PUT", "/api/settings/whatsapp", admin, { mode: "live" });
    assert.equal(r.status, 409); assert.match(r.body.message, /only after cut-over/);
    assert.equal((await call("PUT", "/api/settings/payments", admin, { mode: "live" })).status, 409);
    await setting("trial.google_master", false);
    await new Promise((r) => setTimeout(r, 31_000));
    assert.equal((await call("PUT", "/api/settings/whatsapp", admin, { mode: "live" })).status, 200);
    const p = await call("GET", `/api/whatsapp/preview?date=${D}`, mgr);
    assert.equal(p.body.rows.find((x: any) => x.appointmentId === real).send, true, "live: real patients too");
    assert.equal((await call("PUT", "/api/settings/payments", admin, { mode: "live" })).status, 400, "live payments need live keys");
    assert.equal((await call("PUT", "/api/settings/whatsapp", admin, { mode: "test" })).status, 200);
  });
  await step("settings refuse a wrong test number and a template list without the built-in templates", async () => {
    const r = await call("PUT", "/api/settings/whatsapp", mgr, { testNumbers: ["12345"] });
    assert.equal(r.status, 400); assert.match(r.body.message, /Not a mobile number: 12345/);
    const s = (await call("GET", "/api/settings/whatsapp", mgr)).body;
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { templates: s.templates.slice(1) })).status, 400);
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { testNumbers: ["+91 98000 00001", "9800000001"] })).status, 200);
    assert.deepEqual((await call("GET", "/api/settings/whatsapp", mgr)).body.testNumbers, ["919800000001"]);
  });

  console.log("payment links, test mode");
  let p1: any;
  await step("a link needs a TEST booking, a checked phone number and an amount within the limits", async () => {
    let r = await call("POST", `/api/appointments/${real}/payments`, staff, { phone: "9800000001", phoneConfirmed: true });
    assert.equal(r.status, 409); assert.match(r.body.message, /only for TEST bookings/);
    r = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "9800000001" });
    assert.equal(r.status, 400); assert.match(r.body.message, /Check the phone number/);
    r = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "9800000001", phoneConfirmed: true, amount: 50 });
    assert.equal(r.status, 400); assert.match(r.body.message, /between ₹100 and ₹5000/);
    r = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "0494 2420000", phoneConfirmed: true });
    assert.equal(r.status, 400);
  });
  await step("test mode refuses live Razorpay keys", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_live_fakeid";
    try {
      const r = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "9800000001", phoneConfirmed: true });
      assert.equal(r.status, 409); assert.match(r.body.message, /Test mode needs Razorpay test keys/);
    } finally { process.env.RAZORPAY_KEY_ID = "rzp_test_fakeid"; }
  });
  await step("making a link: our reference, paise, the confirmed number; nothing clinical goes to Razorpay", async () => {
    await call("PATCH", `/api/appointments/${one}`, staff, { planOfAction: "INJ (RE)" });
    const r = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "98000 00001", phoneConfirmed: true, purpose: "Advance for injection day" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); p1 = r.body.payment;
    assert.equal(p1.status, "created"); assert.equal(p1.amount, 500); assert.equal(p1.mode, "test");
    assert.equal(p1.reference, `SUD-${p1.id}`); assert.match(p1.linkUrl, /^https:\/\/rzp\.io\/i\/plink_/); assert.ok(p1.expiresAt);
    const body = rzpCalls.find((c) => c.path === "/payment_links")!.body;
    assert.equal(body.amount, 50000); assert.equal(body.reference_id, p1.reference); assert.equal(body.customer.contact, "+919800000001");
    assert.deepEqual(body.notify, { sms: false, email: false });
    assert.ok(!JSON.stringify(body).includes("INJ") && !JSON.stringify(body).includes("injection"), "no plan or purpose sent to Razorpay");
    const again = await call("POST", `/api/appointments/${one}/payments`, staff, { phone: "9800000001", phoneConfirmed: true });
    assert.equal(again.status, 409); assert.match(again.body.message, /already has an open payment link/);
  });
  await step("sending the link on WhatsApp needs its approved template; then the outbox sends it and the link shows as sent", async () => {
    const r = await call("POST", `/api/payments/${p1.id}/whatsapp`, staff);
    assert.equal(r.status, 400); assert.match(r.body.message, /no AiSensy campaign yet/);
    const s = (await call("GET", "/api/settings/whatsapp", mgr)).body;
    const templates = s.templates.map((t: any) => (t.key === "payment_link" ? { ...t, campaign: "sudarshan_payment_link" } : t));
    assert.equal((await call("PUT", "/api/settings/whatsapp", mgr, { templates })).status, 200);
    assert.equal((await call("POST", `/api/payments/${p1.id}/whatsapp`, staff)).status, 200);
    await deliverQueued();
    const last = sent[sent.length - 1];
    assert.equal(last.campaignName, "sudarshan_payment_link"); assert.deepEqual(last.templateParams, ["ZZ Test Out One", "₹500", p1.linkUrl]);
    const p = (await call("GET", `/api/appointments/${one}/payments`, doc)).body.payments[0];
    assert.equal(p.status, "sent"); assert.equal(p.sentVia, "whatsapp");
    assert.equal((await call("POST", `/api/payments/${p1.id}/whatsapp`, staff)).status, 409, "the same link is not sent twice");
  });
  await step("paid: found by asking Razorpay (no webhook), and the once-a-minute check leaves it alone afterwards", async () => {
    pay(links.get(p1.linkUrl.split("/").pop())!.id, 500);
    const r = await call("POST", `/api/payments/${p1.id}/check`, staff);
    assert.equal(r.status, 200); assert.equal(r.body.changed, true);
    assert.equal(r.body.payment.status, "paid"); assert.equal(r.body.payment.paidAmount, 500); assert.ok(r.body.payment.razorpayPaymentId);
    const n = rzpCalls.length; await pollPayments(); assert.equal(rzpCalls.length, n, "paid links are not asked about again");
    const appt = (await call("GET", `/api/appointments/${one}`, staff)).body.appointment;
    assert.equal(appt.status, "booked", "a payment does not change the appointment (P-5)");
  });
  await step("refunds: admins only, never more than was paid, pending until Razorpay says processed", async () => {
    assert.equal((await call("POST", `/api/payments/${p1.id}/refunds`, mgr, { amount: 100, reason: "Patient cancelled" })).status, 403);
    let r = await call("POST", `/api/payments/${p1.id}/refunds`, admin, { amount: 600, reason: "Patient cancelled" });
    assert.equal(r.status, 400); assert.match(r.body.message, /At most ₹500/);
    r = await call("POST", `/api/payments/${p1.id}/refunds`, admin, { amount: 200, reason: "Patient cancelled", note: "asked by phone" });
    assert.equal(r.status, 200); assert.equal(r.body.payment.refunds[0].status, "pending"); assert.equal(r.body.payment.status, "paid");
    const rc = rzpCalls.find((c) => /\/refund$/.test(c.path))!;
    assert.equal(rc.body.amount, 20000); assert.equal(rc.headers["X-Razorpay-Idempotency-Key"], `SUDR-${p1.id}-1`);
    r = await call("POST", `/api/payments/${p1.id}/refunds`, admin, { amount: 400, reason: "Paid twice" });
    assert.equal(r.status, 400, "the pending refund counts"); assert.match(r.body.message, /At most ₹300/);
    for (const x of refunds.values()) x.status = "processed";
    await pollPayments();
    let p = (await call("GET", `/api/appointments/${one}/payments`, staff)).body.payments[0];
    assert.equal(p.status, "partially_refunded"); assert.equal(p.refundedAmount, 200); assert.equal(p.refunds[0].status, "processed");
    refundStatusOnCreate = "processed";
    r = await call("POST", `/api/payments/${p1.id}/refunds`, admin, { amount: 300, reason: "Appointment cancelled by the clinic" });
    assert.equal(r.status, 200); assert.equal(r.body.payment.status, "refunded"); assert.equal(r.body.payment.refundedAmount, 500);
    assert.equal((await call("POST", `/api/payments/${p1.id}/refunds`, admin, { amount: 1, reason: "again" })).status, 409);
  });
  await step("cancel: Razorpay cancels the link first; a link just paid is not cancelled, it shows as paid", async () => {
    const a = (await call("POST", `/api/appointments/${two}/payments`, staff, { phone: "9800000002", phoneConfirmed: true, amount: 300 })).body.payment;
    let r = await call("POST", `/api/payments/${a.id}/cancel`, staff, { reason: "Paid at the desk" });
    assert.equal(r.status, 200); assert.equal(r.body.payment.status, "cancelled"); assert.equal(r.body.payment.cancelReason, "Paid at the desk");
    assert.ok(rzpCalls.some((c) => c.path.endsWith("/cancel")));
    const b = (await call("POST", `/api/appointments/${two}/payments`, staff, { phone: "9800000002", phoneConfirmed: true, amount: 300 })).body.payment;
    assert.equal(b.status, "created", "a new link after a cancelled one");
    pay(b.linkUrl.split("/").pop(), 300);
    r = await call("POST", `/api/payments/${b.id}/cancel`, staff, { reason: "Not needed" });
    assert.equal(r.status, 409); assert.match(r.body.message, /just paid/);
    assert.equal((await call("GET", `/api/appointments/${two}/payments`, staff)).body.payments[0].status, "paid");
  });
  await step("a different amount paid is flagged to check; a link Razorpay would not make is recorded as failed", async () => {
    const nb = await book("ZZ Test Out Three", "11:00", "9800000003");
    const a = (await call("POST", `/api/appointments/${nb}/payments`, staff, { phone: "9800000003", phoneConfirmed: true })).body.payment;
    pay(a.linkUrl.split("/").pop(), 400);
    await pollPayments();
    const p = (await call("GET", `/api/appointments/${nb}/payments`, staff)).body.payments[0];
    assert.equal(p.status, "created"); assert.match(p.needsReview, /Partly paid: ₹400 of ₹500/);
    assert.ok((await call("GET", "/api/payments?view=review", staff)).body.payments.some((x: any) => x.id === p.id));
    const nb2 = await book("ZZ Test Out Four", "11:10", "9800000004");
    rzpFailNext = { status: 400, data: { error: { description: "contact is invalid" } } };
    const f = await call("POST", `/api/appointments/${nb2}/payments`, staff, { phone: "9800000004", phoneConfirmed: true });
    assert.equal(f.status, 200); assert.equal(f.body.payment.status, "failed"); assert.match(f.body.payment.error, /contact is invalid/);
    assert.equal((await call("POST", `/api/appointments/${nb2}/payments`, staff, { phone: "9800000004", phoneConfirmed: true })).body.payment.status, "created",
      "a failed link does not block a new one");
  });
  await step("the activity log has a plain sentence for each step and never a key", async () => {
    const rows = (await pool.query(`SELECT summary, changes::text AS ch FROM app.audit_log WHERE summary LIKE '%ZZ Test Out%' OR summary LIKE 'WhatsApp%'`)).rows;
    const all = rows.map((r) => r.summary).join("\n");
    for (const re of [/WhatsApp appointment reminder for .*: 1 queued \(test mode\)/, /WhatsApp sent to ZZ Test Out One/, /Payment link of ₹500 for ZZ Test Out One/,
                      /Paid ₹500: ZZ Test Out One/, /Refund of ₹200 asked for ZZ Test Out One: Patient cancelled/, /Refund of ₹200 done/,
                      /Payment link of ₹300 cancelled: ZZ Test Out Two \(Paid at the desk\)/]) assert.match(all, re);
    const blob = JSON.stringify(rows);
    for (const secret of ["fake-aisensy-key-for-tests", "fake-razorpay-secret"]) assert.ok(!blob.includes(secret), "no key in the log");
  });
  await step("payment settings: the usual amount must lie between the smallest and largest", async () => {
    assert.equal((await call("PUT", "/api/settings/payments", mgr, { minAmount: 600 })).status, 400);
    assert.equal((await call("PUT", "/api/settings/payments", mgr, { defaultAmount: 750, linkHours: 12 })).status, 200);
    const s = (await call("GET", "/api/payments/status", staff)).body;
    assert.equal(s.defaultAmount, 750); assert.equal(s.linkHours, 12); assert.equal(s.keyMode, "test"); assert.equal(s.problem, null);
  });
  console.log(`\nall ${passed} WhatsApp and payment checks passed`);
} finally {
  setWhatsAppTransport(null); setRazorpayTransport(null);
  await cleanup();
  await restoreSettings();
  await app.close();
  await pool.end();
}
