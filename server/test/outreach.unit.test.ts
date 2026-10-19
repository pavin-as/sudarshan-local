// WhatsApp and payment rules that need no database (D-034): phone numbers, who may get a message, filling templates,
// which Razorpay keys fit which mode.   npx tsx test/outreach.unit.test.ts
import assert from "node:assert/strict";
import { cleanPhone, isPracticeBooking, phoneText, scrubNumbers } from "../src/services/outreach.js";
import { DEFAULT_TEMPLATES, fillParams, recipientFor, validateTemplates, waDate, waTime, type MessagingSettings } from "../src/services/whatsapp.js";
import { keysProblem } from "../src/services/payments.js";
import { keyMode } from "../src/services/razorpay.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

check("phone numbers become 91XXXXXXXXXX; landlines and short numbers are refused", () => {
  assert.equal(cleanPhone("98470 12345"), "919847012345");
  assert.equal(cleanPhone("+91 98470-12345"), "919847012345");
  assert.equal(cleanPhone("09847012345"), "919847012345");
  assert.equal(cleanPhone("919847012345"), "919847012345");
  assert.equal(cleanPhone("00971501234567"), "971501234567", "Gulf number with 00");
  assert.equal(cleanPhone("+971 50 123 4567"), "971501234567");
  assert.equal(cleanPhone("0494 2420000"), null, "Tirur landline");
  assert.equal(cleanPhone("4942420000"), null);
  assert.equal(cleanPhone("12345"), null);
  assert.equal(cleanPhone(""), null);
  assert.equal(cleanPhone(null), null);
  assert.equal(phoneText("919847012345"), "+91 98470 12345");
  assert.equal(scrubNumbers("AiSensy refused it (HTTP 400): 919847012345 is not on WhatsApp"), "AiSensy refused it (HTTP 400): [number] is not on WhatsApp");
  assert.equal(scrubNumbers("+91 98470 12345 blocked"), "[number] blocked");
});

check("practice bookings are the ones named TEST or ZZ Test", () => {
  for (const n of ["TEST Ramesh", "test", "Test booking", "ZZ Test One", " TEST  X"]) assert.ok(isPracticeBooking(n), n);
  for (const n of ["Testimony Joseph", "Ramesh TEST", "ZZ Outsider", "", null]) assert.ok(!isPracticeBooking(n), String(n));
});

const test: MessagingSettings = { mode: "test", testNumbers: ["919800000001"] };
const live: MessagingSettings = { mode: "live", testNumbers: [] };
const booked = { patientName: "TEST One", phone: "9800000001", status: "booked", slotTime: "10:20" };
const appt = { kind: "appointment" as const, alreadySent: false };

check("test mode: only TEST bookings, only to the test numbers", () => {
  assert.deepEqual(recipientFor(booked, test, appt), { to: "919800000001", reason: null });
  assert.match(recipientFor({ ...booked, patientName: "Real Patient" }, test, appt).reason!, /only TEST bookings/);
  assert.match(recipientFor({ ...booked, phone: "9800000002" }, test, appt).reason!, /not one of the test numbers/);
});

check("live mode: any booked patient with a mobile number; the reasons are in plain words", () => {
  assert.equal(recipientFor({ ...booked, patientName: "Real Patient", phone: "9800000002" }, live, appt).to, "919800000002");
  assert.match(recipientFor({ ...booked, phone: null }, live, appt).reason!, /No phone number/);
  assert.match(recipientFor({ ...booked, phone: "0494 2420000" }, live, appt).reason!, /Not a mobile number/);
  assert.match(recipientFor({ ...booked, status: "waitlist", slotTime: null }, live, appt).reason!, /waiting list/);
  assert.match(recipientFor({ ...booked, status: "cancelled" }, live, appt).reason!, /cancelled/);
  assert.match(recipientFor(booked, live, { ...appt, alreadySent: true }).reason!, /Already sent/);
  assert.match(recipientFor(booked, { ...live, mode: "off" }, appt).reason!, /switched off/);
});

check("templates fill in the Google app's wording: 17-June-2026, 4:10 PM", () => {
  assert.equal(waDate("2026-06-17"), "17-June-2026");
  assert.equal(waTime("16:10"), "4:10 PM");
  assert.equal(waTime("09:00"), "9:00 AM");
  assert.equal(waTime("12:30"), "12:30 PM");
  assert.equal(waTime("00:15"), "12:15 AM");
  assert.deepEqual(fillParams(DEFAULT_TEMPLATES[0], { name: "TEST One", date: "2026-10-22", time: "10:20" }), ["TEST One", "22-October-2026", "10:20 AM"]);
  assert.deepEqual(fillParams(DEFAULT_TEMPLATES[1], { name: "TEST One", amount: 500, link: "https://rzp.io/i/x" }), ["TEST One", "₹500", "https://rzp.io/i/x"]);
});

check("template settings are checked: both built-in templates stay, payment templates carry the link", () => {
  assert.equal(validateTemplates(DEFAULT_TEMPLATES), null);
  assert.match(validateTemplates(DEFAULT_TEMPLATES.slice(1))!, /cannot be removed/);
  assert.match(validateTemplates([DEFAULT_TEMPLATES[0], { ...DEFAULT_TEMPLATES[1], params: ["name", "amount"] }])!, /must carry the link/);
  assert.match(validateTemplates([{ ...DEFAULT_TEMPLATES[0], params: ["name", "link"] }, DEFAULT_TEMPLATES[1]])!, /belong to payment templates/);
  assert.match(validateTemplates([...DEFAULT_TEMPLATES, { ...DEFAULT_TEMPLATES[0] }])!, /appears twice/);
  assert.match(validateTemplates([{ ...DEFAULT_TEMPLATES[0], campaign: "bad;name" }, DEFAULT_TEMPLATES[1]])!, /campaign name/);
});

check("Razorpay keys: test mode needs rzp_test_, live needs rzp_live_, none = not set", () => {
  const before = { id: process.env.RAZORPAY_KEY_ID, s: process.env.RAZORPAY_KEY_SECRET };
  try {
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    assert.equal(keyMode(), null); assert.match(keysProblem("test")!, /not set/);
    process.env.RAZORPAY_KEY_SECRET = "x";
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc"; assert.equal(keysProblem("test"), null); assert.match(keysProblem("live")!, /live keys/);
    process.env.RAZORPAY_KEY_ID = "rzp_live_abc"; assert.equal(keysProblem("live"), null); assert.match(keysProblem("test")!, /test keys/);
    process.env.RAZORPAY_KEY_ID = "abc"; assert.match(keysProblem("test")!, /neither/);
    assert.match(keysProblem("off")!, /switched off/);
  } finally {
    if (before.id === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = before.id;
    if (before.s === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = before.s;
  }
});

console.log(`${passed} WhatsApp and payment checks passed`);
