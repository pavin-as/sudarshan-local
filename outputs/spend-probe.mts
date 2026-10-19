import {q,pool} from '../server/src/db.js';
try {
 console.log(JSON.stringify(await q(`SELECT sum(total) AS billed,sum(paid) AS paid,sum(discount) AS discounts,count(*) FILTER(WHERE paid=0) AS zero_paid FROM analytics.fact_bill`)));
 console.log(JSON.stringify(await q(`SELECT coalesce(is_paid::text,'NULL') AS paid_flag,count(*),sum(procedureamount) FROM yarago.tbl_payment_injectionorlaser_procedure_for_billing WHERE coalesce(active,1)=1 GROUP BY 1`)));
 console.log(JSON.stringify(await q(`SELECT coalesce(ispaid::text,'NULL') AS paid_flag,count(*),sum(totalamount) AS total,sum(cashamount) AS cash,sum(cardamount) AS card FROM yarago.tblpatientsappointmentbillingdetails WHERE coalesce(active,1)=1 GROUP BY 1`)));
 console.log(JSON.stringify(await q(`SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='yarago' AND table_name IN ('tblpatientsappointmentbillingdetails','tblopticalpatientpayment','tblopticalpatientorders','tbl_payment_receptionist_new','tbl_payment_injectionorlaser_procedure_for_billing') GROUP BY 1`)));
 console.log(JSON.stringify(await q(`SELECT service_group,count(*),sum(amount) FROM analytics.fact_billing GROUP BY 1`)));
 console.log(JSON.stringify(await q(`SELECT min(bill_date),max(bill_date),count(*),sum(total),sum(paid),sum(discount) FROM analytics.fact_bill`)));
 console.log(JSON.stringify(await q(`SELECT max(finished_at) FROM analytics.refresh_log WHERE status='ok'`)));
} finally {await pool.end();}
