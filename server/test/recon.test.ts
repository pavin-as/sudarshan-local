// Money reconciliation (D-052) against a TEST database, with Zoho and the local model faked.
//   SUDARSHAN_ENV=/path/to/test.env npx tsx test/recon.test.ts
// Synthetic Yarago bills on 2 Mar 2026 (patients 990000301-303, MRD SPD99921-23, bills 990000301-304), Zoho lines ZZ-*,
// users zz_test_recon_*; all removed afterwards (the adjustment guards are switched off for the clean-up only).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { allowed, setZohoTransport, type ZohoRequest } from "../src/services/zohoBooks.js";

if (!process.env.SUDARSHAN_ENV) { console.error("Set SUDARSHAN_ENV to a test .env file"); process.exit(2); }
console.log(`test database: ${(await pool.query("SELECT current_database() AS d")).rows[0].d}`);

const D = "2026-03-02", NEXT = "2026-03-03";
const P1 = 990000301, P2 = 990000302, P3 = 990000303;
const B_UPI = 990000301, B_CASH = 990000302, B_CARD = 990000303, B_CARD2 = 990000304, REFUND = 990000301;
const BILLS = [B_UPI, B_CASH, B_CARD, B_CARD2];
for (const k of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID", "ZOHO_BANK_ACCOUNTS", "ZOHO_DC"]) delete process.env[k];

async function cleanup() {
  await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
    ALTER TABLE app.recon_adjustments DISABLE TRIGGER recon_adjustments_guard;
    ALTER TABLE app.recon_adjustment_effects DISABLE TRIGGER recon_effects_guard;
    DELETE FROM app.audit_log WHERE entity_type IN ('recon_adjustments','recon_adjustment_effects','recon_bank_rules')
      AND actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.recon_adjustment_effects WHERE adjustment_id IN (SELECT id FROM app.recon_adjustments WHERE submitted_by IN
      (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%'));
    UPDATE app.recon_adjustments SET replaces_id = NULL, paired_with = NULL, reversed_by = NULL
      WHERE submitted_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.recon_adjustments WHERE kind = 'reversal' AND submitted_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.recon_adjustments WHERE submitted_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    ALTER TABLE app.recon_adjustments ENABLE TRIGGER recon_adjustments_guard;
    ALTER TABLE app.recon_adjustment_effects ENABLE TRIGGER recon_effects_guard;
    DELETE FROM app.recon_assistant_log WHERE asked_by IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.zoho_bank_txn_versions WHERE transaction_id LIKE 'ZZ-%';
    DELETE FROM app.zoho_bank_txns WHERE transaction_id LIKE 'ZZ-%';
    DELETE FROM app.zoho_customer_payments WHERE payment_id LIKE 'ZZ-%';
    DELETE FROM app.zoho_bank_accounts WHERE account_id = 'ZZACC';
    DELETE FROM app.zoho_fetch_runs WHERE date_from BETWEEN '2026-02-01' AND '2026-03-31';
    DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.audit_log WHERE actor_id IN (SELECT id FROM app.users WHERE username LIKE 'zz_test_recon%');
    DELETE FROM app.users WHERE username LIKE 'zz_test_recon%';
    DELETE FROM yarago.tblpatientsappointmentbillingdetails WHERE id_nbillid IN (${BILLS});
    DELETE FROM yarago.tbl_payment_receptionist_new WHERE nbillid IN (${BILLS});
    DELETE FROM yarago.tbl_payment_lab WHERE nbillid IN (${BILLS});
    DELETE FROM yarago.tbl_payment_injectionorlaser_procedure_for_billing WHERE nbillid IN (${BILLS});
    DELETE FROM yarago.tblpatientopdrefunddetails WHERE aoprefundid = ${REFUND};
    DELETE FROM yarago.tblpatientregistration WHERE apatient_id IN (${P1}, ${P2}, ${P3});
    COMMIT;`);
}
await cleanup();
const pw = "Correct-Horse-9", hash = await hashPassword(pw);
await pool.query(`BEGIN; SET LOCAL app.skip_audit = 'on';
  INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES
    ('zz_test_recon_admin','ZZ Recon Admin','admin','${hash}',false), ('zz_test_recon_mgr','ZZ Recon Manager','manager','${hash}',false),
    ('zz_test_recon_staff','ZZ Recon Staff','staff','${hash}',false), ('zz_test_recon_opt','ZZ Recon Optometrist','optometrist','${hash}',false),
    ('zz_test_recon_doc','ZZ Recon Doctor','doctor','${hash}',false);
  INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name) VALUES
    (${P1}, 'SPD99921', 'ZZ Test Upi'), (${P2}, 'SPD99922', 'ZZ Test Cash'), (${P3}, 'SPD99923', 'ZZ Test Card');
  -- bill 301: investigation 1,500 paid by UPI; 302: consultation 5,000 cash; 303 and 304: procedures 2,000 and 3,000 by card
  INSERT INTO yarago.tblpatientsappointmentbillingdetails (abilling_id, npatient_id, totalamount, discountamount, billingdate, active, id_billno, id_nbillid,
      cashamount, cardamount, chequeamount, otherpaymentamt, notherpaymenttype) VALUES
    (${B_UPI}, ${P1}, 1500, 0, '${D} 10:00', 1, 'ZB301', ${B_UPI}, 0, 0, 0, 1500, 1),
    (${B_CASH}, ${P2}, 5000, 0, '${D} 10:30', 1, 'ZB302', ${B_CASH}, 5000, 0, 0, 0, NULL),
    (${B_CARD}, ${P3}, 2000, 0, '${D} 11:00', 1, 'ZB303', ${B_CARD}, 0, 2000, 0, 0, NULL),
    (${B_CARD2}, ${P3}, 3000, 0, '${D} 11:30', 1, 'ZB304', ${B_CARD2}, 0, 3000, 0, 0, NULL);
  INSERT INTO yarago.tbl_payment_lab (trow_id, nbillid, tdateofpayment, patient_id, labpaidamount, active) VALUES (${B_UPI}, ${B_UPI}, '${D} 10:00', ${P1}, 1500, 1);
  INSERT INTO yarago.tbl_payment_receptionist_new (trow_id, nbillid, tdateofpayment, patient_id, chargepaidamount, active) VALUES (${B_CASH}, ${B_CASH}, '${D} 10:30', ${P2}, 5000, 1);
  INSERT INTO yarago.tbl_payment_injectionorlaser_procedure_for_billing (trow_id, nbillid, tdateofpayment, patient_id, procedureamount, active) VALUES
    (${B_CARD}, ${B_CARD}, '${D} 11:00', ${P3}, 2000, 1), (${B_CARD2}, ${B_CARD2}, '${D} 11:30', ${P3}, 3000, 1);
  -- a 500 refund on bill 301, recorded in Yarago as cash (it was really paid back by UPI)
  INSERT INTO yarago.tblpatientopdrefunddetails (aoprefundid, npatientid, nbillid, billno, refundamount, paymentmode, isrefunded, refunddate, cashamount, isactive)
    VALUES (${REFUND}, ${P1}, ${B_UPI}, 'ZB301', 500, '1', 1, '${D} 15:00', 500, 1);
  COMMIT;`);
const yaragoHash = async () => (await pool.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) h FROM (
    SELECT b::text t FROM yarago.tblpatientsappointmentbillingdetails b WHERE id_nbillid IN (${BILLS})
    UNION ALL SELECT r::text FROM yarago.tblpatientopdrefunddetails r WHERE aoprefundid = ${REFUND}) x`)).rows[0].h as string;
const yaragoBefore = await yaragoHash();

// ---- fake Zoho: records every request; only GETs to the Books API and the token refresh are possible ----
const zohoCalls: ZohoRequest[] = [];
let zohoLines: any[] = [
  { transaction_id: "ZZ-UPI", account_id: "ZZACC", date: NEXT, amount: 1000, debit_or_credit: "credit", transaction_type: "deposit", status: "uncategorized",
    description: "UPI SETTLEMENT -RYX181- 03/03/26 Ref Num: XXXX" },
  { transaction_id: "ZZ-CARD", account_id: "ZZACC", date: NEXT, amount: 5000, debit_or_credit: "credit", transaction_type: "deposit", status: "uncategorized",
    description: "XXXX7444TERMINAL 1 CARDS SETTL. 03/03/26" },
  { transaction_id: "ZZ-NEFT", account_id: "ZZACC", date: NEXT, amount: 25000, debit_or_credit: "credit", transaction_type: "deposit", status: "uncategorized",
    description: "NEFT FROM ZZ SOMEONE" },
  { transaction_id: "ZZ-CHG", account_id: "ZZACC", date: "2026-03-04", amount: 50, debit_or_credit: "debit", transaction_type: "expense", status: "uncategorized",
    description: "SMS CHARGES" },
];
setZohoTransport(async (req) => {
  zohoCalls.push(req);
  assert.ok(allowed(req), `only reads reach Zoho: ${req.method} ${req.url.split("?")[0]}`);
  if (req.method === "POST") return { status: 200, data: { access_token: "zz-token", expires_in: 3600 } };
  const path = new URL(req.url).pathname;
  if (path.endsWith("/bankaccounts")) return { status: 200, data: { code: 0, bankaccounts: [{ account_id: "ZZACC", account_name: "ZZ Current", account_type: "bank", feeds_last_refresh_date: "2026-10-28", bank_balance: 1 }], page_context: { has_more_page: false } } };
  if (path.endsWith("/banktransactions")) return { status: 200, data: { code: 0, banktransactions: zohoLines, page_context: { has_more_page: false } } };
  if (path.endsWith("/customerpayments")) return { status: 200, data: { code: 0, customerpayments: [{ payment_id: "ZZ-CP1", date: D, payment_mode: "Cash", amount: 5000, account_name: "Petty Cash" }], page_context: { has_more_page: false } } };
  return { status: 404, data: { code: 1, message: "no such path in the fake" } };
});

// ---- fake local model ----
let modelAnswer = "";
const ollama = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: { content: modelAnswer } }));
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as any).port}`;

const app = await buildApp({ logger: !!process.env.TEST_LOG });
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}
async function login(u: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: pw } });
  assert.equal(r.statusCode, 200, `login ${u}`); return String(r.headers["set-cookie"]).split(";")[0];
}
const call = async (method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: { cookie }, payload: payload as any });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const recon = async (cookie: string) => { const r = await call("GET", `/api/recon?from=${D}&to=${D}`, cookie); assert.equal(r.status, 200, r.body?.message); return r.body.result; };
const row = (res: any, method: string) => res.rows.find((x: any) => x.date === D && x.method === method);
const upiRefundFix = () => ({ requestKey: randomUUID(), kind: "refund_method", onDate: D, amount: 500, sourceMethod: "upi", recordedMethod: "cash", actualMethod: "upi",
                              yaragoSource: "opd_refund", yaragoId: String(REFUND), reason: "ZZ test: refund for bill ZB301 was paid back by UPI, not cash" });
const cardCashRefund = (amount = 1000) => ({ requestKey: randomUUID(), kind: "refund_method", onDate: D, amount, sourceMethod: "card", recordedMethod: null,
                              actualMethod: "cash", category: "procedure", yaragoSource: "clinic_bill", yaragoId: String(B_CARD2),
                              reason: "ZZ test: paid by card, given a cash refund at the desk, not entered in Yarago" });

try {
  const admin = await login("zz_test_recon_admin"), mgr = await login("zz_test_recon_mgr");
  const staff = await login("zz_test_recon_staff"), opt = await login("zz_test_recon_opt"), doc = await login("zz_test_recon_doc");
  let upiAdj = 0, cardAdj = 0;

  await step("who may: managers and admins read and submit; only admins approve or change bank rules; others are refused", async () => {
    for (const c of [staff, opt, doc]) {
      assert.equal((await call("GET", `/api/recon?from=${D}&to=${D}`, c)).status, 403);
      assert.equal((await call("POST", "/api/adjustments", c, upiRefundFix())).status, 403);
      assert.equal((await call("POST", "/api/adjustments/1/approve", c, {})).status, 403);
      assert.equal((await call("GET", `/api/recon/detail?date=${D}`, c)).status, 403);
      assert.equal((await call("POST", "/api/recon/zoho/fetch", c, { from: D, to: D })).status, 403);
    }
    assert.equal((await call("GET", `/api/recon?from=${D}&to=${D}`, mgr)).status, 200);
    assert.equal((await call("POST", "/api/adjustments/1/approve", mgr, {})).status, 403);
    assert.equal((await call("POST", "/api/recon/bank-rules", mgr, { position: 50, pattern: "ZZ", class: "not_clinic", method: null, windowDays: 1, isActive: false })).status, 403);
    assert.equal((await call("PUT", "/api/recon/settings", mgr, { tolerance: { card: 5 } })).status, 403);
    assert.equal((await call("GET", `/api/recon?from=${D}&to=2026-07-01`, mgr)).status, 400, "at most 92 days");
  });

  await step("without Zoho the bank side is 'not available', never a difference", async () => {
    const r = await recon(mgr);
    assert.equal(r.zoho.configured, false);
    assert.equal(row(r, "upi").status, "no_bank_data"); assert.equal(r.totals.differenceToExplain, 0);
    assert.equal(r.totals.billed, 11500); assert.equal(r.totals.collected, 11500);
    assert.equal(row(r, "cash").expected, 4500, "5,000 cash less the 500 refund Yarago shows as cash");
    const f = await call("POST", "/api/recon/zoho/fetch", mgr, { from: D, to: D });
    assert.equal(f.status, 503); assert.match(f.body.message, /setup-zoho/);
  });

  Object.assign(process.env, { ZOHO_CLIENT_ID: "1000.ZZ", ZOHO_CLIENT_SECRET: "zz-secret", ZOHO_REFRESH_TOKEN: "zz-refresh", ZOHO_ORG_ID: "1", ZOHO_BANK_ACCOUNTS: "ZZACC", ZOHO_DC: "in" });

  await step("Zoho fetch reads only (GETs and the token refresh); a write would be stopped before leaving", async () => {
    const f = await call("POST", "/api/recon/zoho/fetch", mgr, { from: D, to: D });
    assert.equal(f.status, 200, f.body?.message); assert.equal(f.body.status, "ok");
    assert.deepEqual([f.body.counts.lines, f.body.counts.new, f.body.counts.payments], [4, 4, 1]);
    assert.ok(zohoCalls.length >= 4 && zohoCalls.every((x) => x.method === "GET" || x.url.includes("/oauth/v2/token?")));
    assert.ok(!zohoCalls.some((x) => x.url.includes("zz-secret") && x.method === "GET"), "the secret only goes to the token refresh");
    assert.equal(allowed({ method: "POST", url: "https://www.zohoapis.in/books/v3/invoices?organization_id=1", headers: {} }), false);
    assert.equal(allowed({ method: "POST", url: "https://accounts.zoho.in/oauth/v2/token?grant_type=authorization_code", headers: {} }), false);
  });

  await step("matching: card settled in full; UPI short by the refund is a difference; the unknown NEFT credit is not counted", async () => {
    const r = await recon(mgr);
    assert.equal(row(r, "card").status, "matched"); assert.equal(row(r, "card").deposited, 5000);
    assert.equal(row(r, "upi").status, "difference"); assert.equal(row(r, "upi").expected, 1500);
    assert.deepEqual(row(r, "upi").candidates.map((c: any) => c.transactionId), ["ZZ-UPI"]);
    assert.deepEqual(r.unclassified.map((u: any) => u.transactionId), ["ZZ-NEFT"]); assert.equal(r.totals.unclassifiedCredits, 25000);
    assert.equal(r.totals.depositsMatched, 5000, "the 25,000 NEFT credit is not clinic money until classified");
    const d = await call("GET", `/api/recon/detail?date=${D}&method=upi`, mgr);
    assert.equal(d.status, 200); assert.deepEqual(d.body.payments.map((p: any) => [p.mrd, p.billNo, p.amount]), [["SPD99921", "ZB301", 1500]]);
    assert.deepEqual(d.body.bank.map((b: any) => b.id).sort(), ["ZZ-CARD", "ZZ-CHG", "ZZ-NEFT", "ZZ-UPI"], "bank lines in the window, debits too (fees)");
    const all = await call("GET", `/api/recon/detail?date=${D}`, mgr);
    assert.deepEqual(all.body.refunds.map((x: any) => [x.billNo, x.method, x.amount]), [["ZB301", "cash", 500]]);
    assert.equal(all.body.payments.length, 4);
  });

  await step("a request waits: pending changes nothing; the same form sent twice is one request; a duplicate is refused", async () => {
    const body = upiRefundFix();
    const a = await call("POST", "/api/adjustments", mgr, body);
    assert.equal(a.status, 201, a.body?.message); upiAdj = a.body.adjustment.id;
    assert.equal(a.body.adjustment.status, "pending"); assert.equal(a.body.adjustment.billNo, "ZB301"); assert.equal(a.body.adjustment.effects.length, 2);
    const again = await call("POST", "/api/adjustments", mgr, body);
    assert.equal(again.status, 200); assert.equal(again.body.adjustment.id, upiAdj); assert.equal(again.body.again, true);
    const dup = await call("POST", "/api/adjustments", mgr, { ...body, requestKey: randomUUID() });
    assert.equal(dup.status, 409); assert.match(dup.body.message, new RegExp(`#${upiAdj}`));
    const r = await recon(mgr);
    assert.equal(row(r, "upi").status, "difference"); assert.equal(r.totals.adjustments.count, 0);
    const bad = await call("POST", "/api/adjustments", mgr, { ...body, requestKey: randomUUID(), recordedMethod: "card" });
    assert.equal(bad.status, 400); assert.match(bad.body.message, /does not show this refund as card/);
    const short = await call("POST", "/api/adjustments", mgr, { ...body, requestKey: randomUUID(), reason: "short" });
    assert.equal(short.status, 400);
  });

  await step("UPI paid, refund in Yarago as cash but paid by UPI: approved, the UPI settlement matches and cash is whole", async () => {
    const ap = await call("POST", `/api/adjustments/${upiAdj}/approve`, admin, {});
    assert.equal(ap.status, 200, ap.body?.message); assert.equal(ap.body.adjustment.status, "approved"); assert.equal(ap.body.adjustment.selfApproved, false);
    const r = await recon(mgr);
    assert.equal(row(r, "upi").status, "matched"); assert.equal(row(r, "upi").expected, 1000);
    assert.equal(row(r, "cash").expected, 5000);
    assert.equal(r.totals.adjustments.count, 1); assert.equal(r.totals.differenceToExplain, 0);
    const twice = await call("POST", `/api/adjustments/${upiAdj}/approve`, admin, {});
    assert.equal(twice.status, 409); assert.match(twice.body.message, /already approved \(by ZZ Recon Admin\)/);
    assert.equal((await recon(mgr)).totals.adjustments.count, 1, "approving twice changes nothing");
  });

  await step("card paid, cash refund not in Yarago: two approvals at once, one wins; card still reaches the bank, cash falls", async () => {
    const a = await call("POST", "/api/adjustments", mgr, cardCashRefund());
    assert.equal(a.status, 201, a.body?.message); cardAdj = a.body.adjustment.id;
    const [x, y] = await Promise.all([call("POST", `/api/adjustments/${cardAdj}/approve`, admin, {}), call("POST", `/api/adjustments/${cardAdj}/approve`, admin, {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const r = await recon(mgr);
    assert.equal(row(r, "card").status, "matched"); assert.equal(row(r, "card").expected, 5000);
    assert.equal(row(r, "cash").expected, 4000); assert.equal(r.totals.billedAdjusted, 10500);
    assert.equal(Number((await pool.query(`SELECT count(*) n FROM app.recon_adjustment_effects WHERE adjustment_id = $1`, [cardAdj])).rows[0].n), 2, "effects written once");
  });

  await step("rejecting needs a reason and counts nothing; a decided request cannot be decided again; only the sender withdraws", async () => {
    const a = await call("POST", "/api/adjustments", mgr, { requestKey: randomUUID(), kind: "method_correction", onDate: D, amount: 100, recordedMethod: "cash",
                                                           actualMethod: "upi", yaragoSource: "clinic_bill", yaragoId: String(B_CASH), reason: "ZZ test: 100 was paid by UPI" });
    assert.equal(a.status, 201, a.body?.message);
    assert.equal((await call("POST", `/api/adjustments/${a.body.adjustment.id}/reject`, admin, { reason: "" })).status, 400);
    const rj = await call("POST", `/api/adjustments/${a.body.adjustment.id}/reject`, admin, { reason: "Bank statement shows no such UPI" });
    assert.equal(rj.status, 200); assert.equal(rj.body.adjustment.status, "rejected"); assert.equal(rj.body.adjustment.rejectionReason, "Bank statement shows no such UPI");
    assert.equal((await call("POST", `/api/adjustments/${a.body.adjustment.id}/approve`, admin, {})).status, 409);
    assert.equal(row(await recon(mgr), "cash").expected, 4000);
    const w = await call("POST", "/api/adjustments", mgr, { requestKey: randomUUID(), kind: "missing_entry", onDate: D, amount: 200, category: "pharmacy", actualMethod: "cash",
                                                           reason: "ZZ test: a pharmacy sale not entered" });
    assert.equal(w.status, 201);
    assert.equal((await call("POST", `/api/adjustments/${w.body.adjustment.id}/withdraw`, admin, {})).status, 403);
    const ww = await call("POST", `/api/adjustments/${w.body.adjustment.id}/withdraw`, mgr, {});
    assert.equal(ww.body.adjustment.status, "withdrawn");
  });

  await step("an admin approving their own request must write a note and is flagged self-approved", async () => {
    const a = await call("POST", "/api/adjustments", admin, { requestKey: randomUUID(), kind: "bank_credit", onDate: D, amount: 25000, bankClass: "not_clinic",
                                                             zohoTxnId: "ZZ-NEFT", reason: "ZZ test: a loan repayment from a relative, not clinic money" });
    assert.equal(a.status, 201, a.body?.message);
    assert.equal((await call("POST", `/api/adjustments/${a.body.adjustment.id}/approve`, admin, {})).status, 400);
    const ap = await call("POST", `/api/adjustments/${a.body.adjustment.id}/approve`, admin, { note: "Checked the bank statement myself" });
    assert.equal(ap.status, 200); assert.equal(ap.body.adjustment.selfApproved, true);
    const r = await recon(mgr);
    assert.equal(r.unclassified.length, 0); assert.equal(r.credits.find((c: any) => c.transactionId === "ZZ-NEFT").state, "excluded");
    const wrong = await call("POST", "/api/adjustments", mgr, { requestKey: randomUUID(), kind: "bank_credit", onDate: D, amount: 20000, bankClass: "clinic",
                                                               actualMethod: "upi", zohoTxnId: "ZZ-NEFT", reason: "ZZ test: part of the credit" });
    assert.equal(wrong.status, 400, "the whole credit, and it is classified already");
  });

  await step("reversal: waits for approval, then the original is reversed and the tally returns; no second reversal; correction with replacement", async () => {
    const rv = await call("POST", `/api/adjustments/${upiAdj}/reverse`, mgr, { requestKey: randomUUID(), reason: "ZZ test: the patient confirms the refund was cash after all" });
    assert.equal(rv.status, 201, rv.body?.message); const revId = rv.body.adjustment.id;
    assert.equal(row(await recon(mgr), "upi").status, "matched", "a pending reversal changes nothing");
    assert.equal((await call("POST", `/api/adjustments/${upiAdj}/reverse`, mgr, { requestKey: randomUUID(), reason: "ZZ test: once more please" })).status, 409);
    assert.equal((await call("POST", `/api/adjustments/${revId}/approve`, admin, {})).status, 200);
    const orig = await call("GET", `/api/adjustments/${upiAdj}`, mgr);
    assert.equal(orig.body.adjustment.status, "reversed"); assert.equal(orig.body.adjustment.reversedBy, revId);
    assert.ok(orig.body.trail.some((t: any) => t.summary === `Adjustment #${upiAdj} reversed by #${revId}`));
    const r = await recon(mgr);
    assert.equal(row(r, "upi").status, "difference"); assert.equal(row(r, "cash").expected, 3500);
    assert.equal((await call("POST", `/api/adjustments/${revId}/reverse`, mgr, { requestKey: randomUUID(), reason: "ZZ test: undo the undo" })).status, 400);
    // correct the card / cash refund: it was 800, not 1,000
    const fix = await call("POST", `/api/adjustments/${cardAdj}/reverse`, mgr, { requestKey: randomUUID(), reason: "ZZ test: the cash refund was 800",
                                                                                replacement: cardCashRefund(800) });
    assert.equal(fix.status, 201, fix.body?.message); assert.ok(fix.body.replacementId);
    assert.equal((await call("POST", `/api/adjustments/${fix.body.replacementId}/approve`, admin, {})).status, 400, "decided with its reversal");
    assert.equal((await call("POST", `/api/adjustments/${fix.body.adjustment.id}/approve`, admin, {})).status, 200);
    const rep = await call("GET", `/api/adjustments/${fix.body.replacementId}`, mgr);
    assert.equal(rep.body.adjustment.status, "approved"); assert.equal(rep.body.adjustment.replacesId, cardAdj);
    assert.equal(row(await recon(mgr), "cash").expected, 3700);
  });

  await step("the database itself refuses changes to a sent request, its effects, backward moves and deletion", async () => {
    const tries = [`UPDATE app.recon_adjustments SET amount = 1 WHERE id = ${cardAdj}`, `UPDATE app.recon_adjustments SET status = 'pending' WHERE id = ${cardAdj}`,
                   `UPDATE app.recon_adjustments SET review_note = 'x' WHERE id = ${cardAdj}`, `DELETE FROM app.recon_adjustments WHERE id = ${cardAdj}`,
                   `UPDATE app.recon_adjustment_effects SET amount = 1 WHERE adjustment_id = ${cardAdj}`, `DELETE FROM app.recon_adjustment_effects WHERE adjustment_id = ${cardAdj}`];
    for (const sql of tries) await assert.rejects(pool.query(sql), (e: any) => e.code === "23514", sql);
  });

  await step("Yarago records are never changed; a changed Zoho line keeps its old version; a vanished one is marked, not deleted", async () => {
    assert.equal(await yaragoHash(), yaragoBefore);
    zohoLines = zohoLines.filter((l) => l.transaction_id !== "ZZ-CHG").map((l) => (l.transaction_id === "ZZ-UPI" ? { ...l, status: "categorized" } : l));
    const f = await call("POST", "/api/recon/zoho/fetch", mgr, { from: D, to: D });
    assert.equal(f.body.counts.changed, 1); assert.equal(f.body.counts.missing, 1);
    assert.equal(Number((await pool.query(`SELECT count(*) n FROM app.zoho_bank_txn_versions WHERE transaction_id = 'ZZ-UPI'`)).rows[0].n), 1);
    assert.ok((await pool.query(`SELECT missing_since FROM app.zoho_bank_txns WHERE transaction_id = 'ZZ-CHG'`)).rows[0].missing_since);
  });

  await step("activity log: who asked, who decided, in plain sentences", async () => {
    const t = (await call("GET", `/api/adjustments/${cardAdj}`, admin)).body.trail.map((x: any) => `${x.who}: ${x.summary}`);
    assert.ok(t.some((s: string) => s.startsWith("ZZ Recon Manager: Adjustment requested: Refund by another method ₹1,000 for 2 Mar 2026 (bill ZB304)")), t.join("\n"));
    assert.ok(t.some((s: string) => /^ZZ Recon Admin: Adjustment #\d+ approved: Refund by another method/.test(s)), t.join("\n"));
  });

  await step("assistant: unavailable model is a plain 503 and the page still works; answers with unknown numbers are not shown", async () => {
    process.env.OLLAMA_URL = "http://127.0.0.1:9";
    const down = await call("POST", "/api/recon/assistant", mgr, { from: D, to: D });
    assert.equal(down.status, 503); assert.match(down.body.message, /not running/);
    assert.equal((await call("GET", `/api/recon?from=${D}&to=${D}`, mgr)).status, 200);
    process.env.OLLAMA_URL = ollamaUrl;
    const r = await recon(mgr);
    modelAnswer = `UPI on 2 Mar expected ₹${row(r, "upi").expected.toLocaleString("en-IN")} and is a difference: check the refund.`;
    const ok = await call("POST", "/api/recon/assistant", mgr, { from: D, to: D, question: "Why is UPI different?" });
    assert.equal(ok.status, 200, ok.body?.message); assert.equal(ok.body.status, "ready"); assert.equal(ok.body.text, modelAnswer);
    modelAnswer = "The bank owes the clinic ₹7,777.";
    const bad = await call("POST", "/api/recon/assistant", mgr, { from: D, to: D });
    assert.equal(bad.body.status, "failed"); assert.equal(bad.body.text, null); assert.match(bad.body.error, /7777/);
    const log = (await pool.query(`SELECT input::text FROM app.recon_assistant_log WHERE id = $1`, [ok.body.id])).rows[0].input;
    assert.ok(!/SPD999|ZZ Test|ZB30|RYX181|NEFT/.test(log), "the model saw no MRD, name, bill number or bank wording");
  });
} finally {
  setZohoTransport(null);
  ollama.close();
  await cleanup();
  await app.close(); await pool.end();
}
console.log(`\n${passed} reconciliation API checks passed`);
