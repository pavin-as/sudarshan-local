import {pool} from "../server/src/db.ts";
const c=await pool.connect();
try {
 await c.query("BEGIN READ ONLY");
 await c.query("SET LOCAL statement_timeout='20s'");
 for (const [label,sql] of [
 ["bill_totals", "SELECT count(*) bills,sum(total) total,sum(discount) discount,sum(due_after) due,sum(cash+card+cheque+other_amount) paid FROM clinical.money_bill WHERE on_date='2026-10-28'"],
 ["service_totals", "SELECT service_group,count(*) lines,sum(amount) amount FROM clinical.money_revenue_line WHERE on_date='2026-10-28' AND source='clinic_bill' GROUP BY 1"],
 ["payments", "SELECT method,count(*) rows,sum(amount) amount FROM clinical.money_payment WHERE on_date='2026-10-28' AND source='clinic_bill' GROUP BY 1"],
 ["bill_line_comparison", "WITH l AS (SELECT source_id,sum(amount) amount FROM clinical.money_revenue_line WHERE source='clinic_bill' GROUP BY 1) SELECT CASE WHEN l.source_id IS NULL THEN 'no lines' WHEN b.total=l.amount THEN 'total matches lines' ELSE 'total differs from lines' END category,count(*) bills,sum(b.total) bill_total,sum(b.discount) discount,sum(b.cash+b.card+b.cheque+b.other_amount) collected,sum(coalesce(l.amount,0)) line_total FROM clinical.money_bill b LEFT JOIN l ON l.source_id=b.bill_id::text WHERE b.on_date='2026-10-28' GROUP BY 1"],
 ["source_columns","SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='yarago' AND table_name IN ('tbl_payment_receptionist_new','tbl_payment_lab','tbl_payment_injectionorlaser_procedure_for_billing') AND (column_name ~* 'amount|paid|bill|active|date') ORDER BY table_name,ordinal_position"]
 ]) { console.log(label,JSON.stringify((await c.query(sql)).rows)); }
 await c.query("ROLLBACK");
} finally {c.release();await pool.end();}
