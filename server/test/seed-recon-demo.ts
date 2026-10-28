// Demo data for the reconciliation screens (D-052), TEST database only: a week of synthetic Yarago bills and pharmacy
// payments ending yesterday, Zoho bank lines as if fetched now (UPI and card settled the next day, one UPI day short by a
// refund Yarago shows as cash, a weekend card settlement, an unknown NEFT credit), a pending and an approved request.
// D-053: card settled net of ~0.9% (as HDFC does), the terminal's monthly charge, a cash deposit recorded by the desk.
// Logins (test only), password Demo-Pass-42: demo (admin), demo_mgr (manager given finance, full view),
// demo_desk (manager given the cash desk only: blind deposits).
//   SUDARSHAN_ENV=D:\Sudarshan\testdb\test.env npx tsx test/seed-recon-demo.ts
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/lib/passwords.js";
import { addDays, todayIST } from "../src/lib/time.js";
import { effectsFor } from "../src/services/reconcile.js";
if (!process.env.SUDARSHAN_ENV) { console.error("Demo data goes into a TEST database only: set SUDARSHAN_ENV to a test .env"); process.exit(2); }

const c = await pool.connect();
await c.query("BEGIN"); await c.query("SET LOCAL app.skip_audit='on'");
const h = await hashPassword("Demo-Pass-42");
for (const [u, n, r] of [["demo", "Fameesha K", "admin"], ["demo_mgr", "Basith M", "manager"], ["demo_desk", "Syama T", "manager"]])
  await c.query(`INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,false)
                 ON CONFLICT (username) DO UPDATE SET password_hash = $4, role = $3, must_change_password = false, is_active = true`, [u, n, r, h]);
const mgr = (await c.query(`SELECT id FROM app.users WHERE username = 'demo_mgr'`)).rows[0].id;
const adm = (await c.query(`SELECT id FROM app.users WHERE username = 'demo'`)).rows[0].id;
const desk = (await c.query(`SELECT id FROM app.users WHERE username = 'demo_desk'`)).rows[0].id;
await c.query(`DELETE FROM app.user_permissions WHERE user_id IN ($1, $2)`, [mgr, desk]);
await c.query(`INSERT INTO app.user_permissions (user_id, permission, allowed, set_by) VALUES ($1,'reconciliation.read',true,$3), ($1,'adjustments.submit',true,$3),
               ($2,'cash.deposit',true,$3)`, [mgr, desk, adm]);
await c.query(`ALTER TABLE app.cash_deposits DISABLE TRIGGER cash_deposits_guard`);
await c.query(`DELETE FROM app.cash_deposits WHERE recorded_by IN ($1, $2, $3)`, [mgr, adm, desk]);
await c.query(`ALTER TABLE app.cash_deposits ENABLE TRIGGER cash_deposits_guard`);

// clear an earlier demo (ids 98xxxxxxx, Zoho ZD-*)
await c.query(`ALTER TABLE app.recon_adjustments DISABLE TRIGGER recon_adjustments_guard; ALTER TABLE app.recon_adjustment_effects DISABLE TRIGGER recon_effects_guard`);
await c.query(`DELETE FROM app.recon_adjustment_effects WHERE adjustment_id IN (SELECT id FROM app.recon_adjustments WHERE submitted_by IN ($1, $2))`, [mgr, adm]);
await c.query(`DELETE FROM app.recon_adjustments WHERE kind = 'reversal' AND submitted_by IN ($1, $2)`, [mgr, adm]);
await c.query(`DELETE FROM app.recon_adjustments WHERE submitted_by IN ($1, $2)`, [mgr, adm]);
await c.query(`ALTER TABLE app.recon_adjustments ENABLE TRIGGER recon_adjustments_guard; ALTER TABLE app.recon_adjustment_effects ENABLE TRIGGER recon_effects_guard`);
for (const t of ["tblpatientsappointmentbillingdetails WHERE abilling_id", "tbl_payment_receptionist_new WHERE trow_id", "tbl_payment_lab WHERE trow_id",
                 "tbl_payment_injectionorlaser_procedure_for_billing WHERE trow_id", "tblopticalpatientpayment WHERE apayid", "tblopticalpatientorders WHERE orderid",
                 "tblopticalpatientorderdetails WHERE odid", "tblpatientopdrefunddetails WHERE aoprefundid", "tblpatientregistration WHERE apatient_id"])
  await c.query(`DELETE FROM yarago.${t} BETWEEN 980000000 AND 989999999`);
await c.query(`DELETE FROM app.zoho_bank_txns WHERE transaction_id LIKE 'ZD-%'; DELETE FROM app.zoho_customer_payments WHERE payment_id LIKE 'ZD-%'`);

const today = todayIST();
const names = ["TEST Ayisha", "TEST Rafi", "TEST Lakshmi", "TEST Joseph", "TEST Sreeja", "TEST Kareem", "TEST Fathima", "TEST Gopalan"];
for (const [i, n] of names.entries())
  await c.query(`INSERT INTO yarago.tblpatientregistration (apatient_id, apatientcode, tfisrt_name) VALUES ($1, $2, $3)`, [980000001 + i, `SPD9${8100 + i}`, n]);
await c.query(`INSERT INTO yarago.tbl_mst_category (acatid, acategoryname) VALUES (3, 'Eye Drops') ON CONFLICT DO NOTHING`);

let id = 980000100;
const bank: [string, number, string][] = [];
const openDays = [7, 6, 5, 4, 3, 2, 1].map((k) => addDays(today, -k)).filter((d) => new Date(d + "T00:00:00Z").getUTCDay() !== 0);   // closed on Sundays
const refundDay = openDays[openDays.length - 4], corrDay = openDays[openDays.length - 3];
for (let k = 7; k >= 1; k--) {
  const d = addDays(today, -k);
  if (!openDays.includes(d)) continue;
  const bills: [string, number][] = [["cash", 500 + k * 100], ["cash", 1500], ["upi", 1200 + k * 650], ["upi", 3000], ["card", k % 2 ? 2500 + k * 900 : 0], ["cash", 13000 - k * 300]];
  let upi = 0, card = 0;
  for (const [j, [m, amt]] of bills.entries()) {
    if (!amt) continue;
    const b = ++id, p = 980000001 + ((k + j) % names.length);
    await c.query(`INSERT INTO yarago.tblpatientsappointmentbillingdetails (abilling_id, npatient_id, totalamount, discountamount, billingdate, active, id_billno,
                     id_nbillid, cashamount, cardamount, chequeamount, otherpaymentamt, notherpaymenttype) VALUES ($1,$2,$3,0,$4,1,$5,$1,$6,$7,0,$8,$9)`,
                  [b, p, amt, `${d} ${10 + j}:00`, `D${b - 980000000}`, m === "cash" ? amt : 0, m === "card" ? amt : 0, m === "upi" ? amt : 0, m === "upi" ? 1 : null]);
    const table = j % 3 === 0 ? ["tbl_payment_receptionist_new", "chargepaidamount"] : j % 3 === 1 ? ["tbl_payment_lab", "labpaidamount"] : ["tbl_payment_injectionorlaser_procedure_for_billing", "procedureamount"];
    await c.query(`INSERT INTO yarago.${table[0]} (trow_id, nbillid, tdateofpayment, patient_id, ${table[1]}, active) VALUES ($1,$1,$2,$3,$4,1)`, [b, `${d} ${10 + j}:00`, p, amt]);
    if (m === "upi") upi += amt; if (m === "card") card += amt;
  }
  // pharmacy: one cash and one UPI sale
  for (const [m, amt] of [["cash", 640], ["upi", 1180]] as const) {
    const o = ++id;
    await c.query(`INSERT INTO yarago.tblopticalpatientorders (orderid, billno, npatid, isactive, inserteddate) VALUES ($1,$2,$3,1,$4)`, [o, o - 980000000, 980000001 + k, `${d} 12:00`]);
    await c.query(`INSERT INTO yarago.tblopticalpatientorderdetails (odid, orderid, ncategoryid, totamount, isactive, inserteddate) VALUES ($1,$1,3,$2,1,$3)`, [o, amt, `${d} 12:00`]);
    await c.query(`INSERT INTO yarago.tblopticalpatientpayment (apayid, orderid, npatid, atotalamount, cashamount, otherpaymentid, otherepaymentmode, isactive, inserteddate)
                   VALUES ($1,$1,$2,$3,$4,$5,$6,1,$7)`, [o, 980000001 + k, amt, m === "cash" ? amt : 0, m === "upi" ? 1 : -1, m === "upi" ? amt : 0, `${d} 12:00`]);
    if (m === "upi") upi += amt;
  }
  const next = addDays(d, 1), dd = `${next.slice(8, 10)}/${next.slice(5, 7)}/${next.slice(2, 4)}`;
  if (d === refundDay) {   // a 400 refund Yarago shows as cash, really paid back by UPI: the settlement is 400 short
    await c.query(`INSERT INTO yarago.tblpatientopdrefunddetails (aoprefundid, npatientid, nbillid, billno, refundamount, paymentmode, isrefunded, refunddate, cashamount, isactive)
                   VALUES ($1,$2,$3,$4,400,'1',1,$5,400,1)`, [980000900, 980000003, id - 4, `D${id - 4 - 980000000}`, `${d} 16:00`]);
    upi -= 400;
  }
  if (d === corrDay) upi += 1500;   // 1,500 entered as cash in Yarago was paid by UPI (the approved correction below): the bank has it
  if (next < today) bank.push([`ZD-UPI-${d}`, upi, `UPI SETTLEMENT -RYX181- ${dd} Ref Num: XXXXXXXXXXX0000`]);
  // HDFC keeps its commission from the card settlement (about 0.9% on these days)
  if (card && next < today) bank.push([`ZD-CARD-${d}`, Math.round(card * (1 - 0.0089) * 100) / 100, `XXXX7444TERMINAL 1 CARDS SETTL. ${dd} Ref Num: XXXXXXXXXXX0000`]);
}
bank.push([`ZD-NEFT`, 25000, "NEFT CR-HDFC0000001-TEST SOMEONE-RENT"]);
// the cash desk banks the first three open days' cash, rounded down to ₹50, the next day
const cashOf = async (from: string, to: string) => Number((await c.query(
  `SELECT coalesce((SELECT sum(amount) FROM clinical.money_payment WHERE method = 'cash' AND on_date BETWEEN $1 AND $2), 0)
        - coalesce((SELECT sum(amount) FROM clinical.money_refund WHERE method = 'cash' AND on_date BETWEEN $1 AND $2), 0) AS n`, [from, to])).rows[0].n);
const depTo = openDays[2], depOn = addDays(depTo, 1);
const depAmt = Math.floor((await cashOf(openDays[0], depTo)) / 50) * 50;
bank.push([`ZD-CASH-${depOn}`, depAmt, "CASH DEPOSIT BY - SYAMA - TIRUR"]);
for (const [tid, amt, desc] of bank) {
  const date = tid === "ZD-NEFT" ? addDays(today, -3) : tid.startsWith("ZD-CASH") ? depOn : addDays(tid.slice(-10), 1);
  await c.query(`INSERT INTO app.zoho_bank_txns (transaction_id, account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status, description, raw, raw_hash)
                 VALUES ($1,'ZDACC',$2,$3,'credit','deposit','uncategorized',$4,'{}','demo')`, [tid, date, amt, desc]);
}
// the terminal's monthly service charge, money out
await c.query(`INSERT INTO app.zoho_bank_txns (transaction_id, account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status, description, raw, raw_hash)
               VALUES ('ZD-SC','ZDACC',$1,116.82,'debit','expense','uncategorized','Service Charges-OCT26-XXXXXXX0000-RYX181','{}','demo')`, [openDays[3]]);
await c.query(`UPDATE app.settings SET value = $1 WHERE key = 'cash.book'`, [JSON.stringify({ start: openDays[0], opening: 0, bankFrom: openDays[0] })]);
await c.query(`INSERT INTO app.cash_deposits (request_key, deposited_on, covers_to, amount, slip_no, recorded_by) VALUES ($1,$2,$3,$4,'TEST-0412',$5)`,
              [randomUUID(), depOn, depTo, depAmt, desk]);
await c.query(`INSERT INTO app.zoho_bank_accounts (account_id, account_name, account_type, feed_refreshed_on) VALUES ('ZDACC','TEST Current Account','bank',$1)
               ON CONFLICT (account_id) DO UPDATE SET feed_refreshed_on = $1`, [today]);
// Books audit (D-054): older work the bookkeeper has not done, a statement line imported twice, daily invoices and expenses
await c.query(`DELETE FROM app.zoho_invoices WHERE invoice_id LIKE 'ZD-%'; DELETE FROM app.zoho_expenses WHERE expense_id LIKE 'ZD-%'; DELETE FROM app.books_audit_snapshots`);
for (const [tid, k, amt, desc] of [["ZD-OUT1", 12, 18000, "NEFT DR-CNRB0000001-TEST OPTOMETRIST-NETBANK MUM-SALARY"], ["ZD-OUT2", 15, 4130, "ME DC SI 5XXXXX0001 AMAZON"],
                                   ["ZD-OUT3", 18, 21.24, "SETTLEMENT CHARGE-SEP26-RY9181"]] as const)
  await c.query(`INSERT INTO app.zoho_bank_txns (transaction_id, account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status, description, raw, raw_hash)
                 VALUES ($1,'ZDACC',$2,$3,'debit','uncategorized','uncategorized',$4,'{}','demo')`, [tid, addDays(today, -k), amt, desc]);
const first = bank.find(([tid]) => tid.startsWith("ZD-UPI-"))!;
await c.query(`INSERT INTO app.zoho_bank_txns (transaction_id, account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status, description, raw, raw_hash)
               SELECT 'ZD-PDF-1', account_id, txn_date, amount, debit_or_credit, transaction_type, zoho_status, replace(replace($2, 'RYX181', 'RY9181'), ' ', '  '), '{}', 'demo'
                 FROM app.zoho_bank_txns WHERE transaction_id = $1`, [first[0], first[2].replace(/ Ref Num:.*$/, "")]);
const inv = async (n: string, date: string, total: number, balance: number, entered: string) =>
  c.query(`INSERT INTO app.zoho_invoices (invoice_id, invoice_number, inv_date, customer_name, status, total, balance, created_time, raw, raw_hash)
           VALUES ($1,$1,$2,'Patients',$3,$4,$5,$6,'{}','demo')`, [`ZD-${n}`, date, balance ? "overdue" : "paid", total, balance, `${entered}T15:00:00+05:30`]);
await inv("INV-0901", addDays(today, -16), 61922, 0, addDays(today, -4));
await inv("INV-0902", addDays(today, -15), 259074, 259074, addDays(today, -4));
await inv("INV-0903", openDays[0], Math.round(await cashOf(openDays[0], openDays[0])) + 9000, 0, addDays(today, -1));
for (const [eid, k, acct, through, desc, vendor, total, att] of [
  ["ZD-EX1", 9, "Itemized", "Petty Cash", "food exp (staff meeting) 02/10/2026", null, 4194, false],
  ["ZD-EX2", 10, "Subscription Charge", "TEST Current Account", "ME DC SI 5XXXXX0001 SPOTIFYINDIA", null, 139, false],
  ["ZD-EX3", 11, "Miscellaneous Expenses", "TEST Current Account", "misc", null, 2500, false],
  ["ZD-EX4", 12, "Repairs and Maintenance", "TEST Current Account", "AC service, OCT room (Cool Air Tirur)", "Cool Air Tirur", 3200, true],
] as const)
  await c.query(`INSERT INTO app.zoho_expenses (expense_id, exp_date, account_name, paid_through, description, vendor_name, total, has_attachment, raw, raw_hash)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}','demo')`, [eid, addDays(today, -k), acct, through, desc, vendor, total, att]);
await c.query(`UPDATE app.settings SET value = jsonb_set(jsonb_set(value, '{from}', to_jsonb($1::text)), '{qualityFrom}', to_jsonb($1::text)) WHERE key = 'books.audit'`, [addDays(today, -20)]);
await c.query(`INSERT INTO app.user_permissions (user_id, permission, allowed, set_by) VALUES ($1,'books.audit',true,$2) ON CONFLICT (user_id, permission) DO NOTHING`, [mgr, adm]);
await c.query(`INSERT INTO app.books_audit_snapshots (on_date, score, checks) VALUES ($1, 38, '[]'), ($2, 46, '[]'), ($3, 54, '[]')`,
              [addDays(today, -21), addDays(today, -14), addDays(today, -7)]);
await c.query(`INSERT INTO app.zoho_fetch_runs (date_from, date_to, status, finished_at, counts) VALUES ($1, $2, 'ok', now(), $3)`,
              [addDays(today, -20), today, JSON.stringify({ lines: bank.length, invoices: 3, expenses: 4 })]);

// one approved request (a method correction) and one waiting (the UPI refund), as a manager would send them
const d3 = corrDay, d4 = refundDay;
const ins = async (b: any, effects: any[], status: string) => {
  const r = await c.query(`INSERT INTO app.recon_adjustments (request_key, kind, on_date, amount, source_method, recorded_method, actual_method, yarago_source, yarago_id,
                             bill_no, patient_id, reason, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
                           [randomUUID(), b.kind, b.onDate, b.amount, b.sourceMethod ?? null, b.recordedMethod ?? null, b.actualMethod ?? null, b.yaragoSource, b.yaragoId,
                            b.billNo, b.patientId, b.reason, mgr]);
  for (const [i, e] of effects.entries())
    await c.query(`INSERT INTO app.recon_adjustment_effects (adjustment_id, position, on_date, measure, category, method, amount, words) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                  [r.rows[0].id, i + 1, e.onDate, e.measure, e.category, e.method, e.amount, e.words]);
  if (status === "approved") await c.query(`UPDATE app.recon_adjustments SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [r.rows[0].id, adm]);
};
const cashBill = (await c.query(`SELECT id_nbillid, id_billno, npatient_id FROM yarago.tblpatientsappointmentbillingdetails WHERE billingdate::date = $1 AND cashamount = 1500 LIMIT 1`, [d3])).rows[0];
const mc = { kind: "method_correction", onDate: d3, amount: 1500, recordedMethod: "cash", actualMethod: "upi", yaragoSource: "clinic_bill", yaragoId: String(cashBill.id_nbillid),
             billNo: cashBill.id_billno, patientId: cashBill.npatient_id, reason: "TEST demo: entered as cash at the desk; the patient paid by UPI (GPay screenshot seen)" };
await ins(mc, effectsFor(mc as any), "approved");
const rf = { kind: "refund_method", onDate: d4, amount: 400, sourceMethod: "upi", recordedMethod: "cash", actualMethod: "upi", yaragoSource: "opd_refund", yaragoId: "980000900",
             billNo: null, patientId: 980000003, reason: "TEST demo: the refund for the cancelled OCT went back by UPI; Yarago shows cash" };
await ins(rf, effectsFor(rf as any), "pending");
await c.query("COMMIT"); c.release(); await pool.end();
console.log(`Reconciliation demo data in place: ${bank.length} bank lines; log in as demo, demo_mgr or demo_desk (Demo-Pass-42).`);
