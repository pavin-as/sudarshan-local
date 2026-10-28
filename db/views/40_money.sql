-- Money as Yarago recorded it, for the reconciliation (D-052). Read live from the mirror (not the nightly analytics).
-- Definitions checked on 1 Sep - 10 Oct 2026 against the bookkeeper's Zoho entries: card matched on 32 of 33 days and
-- UPI on 21 (the rest are refunds and method mix-ups in Yarago, which is what adjustments are for).
--   money_revenue_line: one row per billed line (clinic bill lines, pharmacy/optical sale lines), by service group.
--   money_payment:      one row per payment method on a clinic bill or a pharmacy/optical payment.
--   money_refund:       one row per refund (OPD refunds by method; pharmacy refunds: method and date not recorded).
-- Methods: cash, card, cheque, upi (Yarago "other payment" UPI or PayTm), other.

CREATE OR REPLACE VIEW clinical.money_bill AS
SELECT DISTINCT ON (b.id_nbillid)
       b.id_nbillid AS bill_id, b.id_billno AS bill_no, b.billingdate::date AS on_date, b.npatient_id AS patient_id,
       b.nappointmentid AS visit_id, coalesce(b.totalamount, 0)::numeric AS total, coalesce(b.discountamount, 0)::numeric AS discount,
       coalesce(b.cashamount, 0)::numeric AS cash, coalesce(b.cardamount, 0)::numeric AS card, coalesce(b.chequeamount, 0)::numeric AS cheque,
       coalesce(b.otherpaymentamt, 0)::numeric AS other_amount, b.notherpaymenttype AS other_type,
       nullif(btrim(b.otherpaymentref), '') AS other_ref, nullif(btrim(b.checknumber), '') AS cheque_no,
       coalesce(b.currentdueamount, 0)::numeric AS due_after, b.ncollectedbyuser AS collected_by
FROM yarago.tblpatientsappointmentbillingdetails b
WHERE coalesce(b.active, 1) = 1 AND b.id_nbillid IS NOT NULL AND b.billingdate IS NOT NULL
ORDER BY b.id_nbillid, b.abilling_id DESC;

CREATE OR REPLACE VIEW clinical.money_revenue_line AS
SELECT l.line_id, 'clinic_bill'::text AS source, l.nbillid::text AS source_id, mb.bill_no, coalesce(mb.on_date, l.d::date) AS on_date,
       l.patient_id, l.appoint_id AS visit_id, l.grp AS service_group, l.item, coalesce(l.amount, 0)::numeric AS amount
FROM (
  SELECT 'charge-' || r.trow_id AS line_id, r.nbillid, r.tdateofpayment AS d, r.patient_id, r.appoint_id,
         'Consultation & charges' AS grp, initcap(btrim(m.chargetypename)) AS item, r.chargepaidamount AS amount
    FROM yarago.tbl_payment_receptionist_new r LEFT JOIN yarago.tbl_mst_chargetype m ON m.typeid = r.chargetypeid WHERE coalesce(r.active, 1) = 1
  UNION ALL
  SELECT 'lab-' || l.trow_id, l.nbillid, l.tdateofpayment, l.patient_id, l.appoint_id,
         'Investigations', btrim(regexp_replace(m.labtestname, '\s+(RE|LE)\s*$', '', 'i')), l.labpaidamount
    FROM yarago.tbl_payment_lab l LEFT JOIN yarago.tbl_mst_labstudies m ON m.id = l.labtypeid WHERE coalesce(l.active, 1) = 1
  UNION ALL
  SELECT 'proc-' || p.trow_id, p.nbillid, p.tdateofpayment, p.patient_id, p.appoint_id,
         CASE WHEN st.subsurgicaltypename ~* 'laser|barrage|prp|yag|grid|sectoral|focal' THEN 'Lasers'
              WHEN st.subsurgicaltypename ~* 'vitreal|pst|ozurdex|faricimab|inject|razumab|ranibizumab|bevacizumab|aflibercept|eylea|triamcinolone' THEN 'Injections'
              ELSE 'Other procedures' END,
         initcap(btrim(st.subsurgicaltypename)), p.procedureamount
    FROM yarago.tbl_payment_injectionorlaser_procedure_for_billing p
    LEFT JOIN yarago.tbl_mst_sub_surgical_types st ON st.subsurgid = p.procedureid WHERE coalesce(p.active, 1) = 1
  UNION ALL
  SELECT 'other-' || o.others_id, o.nbillid, o.dateofpayment, o.npatient_id, o.nappoint_id, 'Others', 'Other charges', o.amount
    FROM yarago.tbl_payment_others_details o WHERE coalesce(o.active, 1) = 1
) l
LEFT JOIN clinical.money_bill mb ON mb.bill_id = l.nbillid
WHERE coalesce(mb.on_date, l.d::date) IS NOT NULL
UNION ALL
-- pharmacy and optical sale lines (D-032: pharmacy = categories 3, 5, 6, 7, 8), after cancellations, cancelled orders left out
SELECT 'sale-' || d.odid, 'pharmacy_order', d.orderid::text, o.billno::text, d.inserteddate::date, o.npatid, o.napptid,
       CASE WHEN d.ncategoryid IN (3, 5, 6, 7, 8) THEN 'Pharmacy' ELSE 'Optical' END,
       coalesce(c.acategoryname, 'Unknown'), (coalesce(d.totamount, 0) - coalesce(d.cancelledamt, 0))::numeric
FROM yarago.tblopticalpatientorderdetails d
JOIN yarago.tblopticalpatientorders o ON o.orderid = d.orderid
LEFT JOIN yarago.tbl_mst_category c ON c.acatid = d.ncategoryid
WHERE coalesce(d.isactive, 1) = 1 AND coalesce(o.isactive, 1) = 1 AND o.cancelleddate IS NULL AND d.inserteddate IS NOT NULL;

CREATE OR REPLACE VIEW clinical.money_payment AS
SELECT 'bill-' || b.bill_id || '-' || m.method AS payment_id, 'clinic_bill'::text AS source, b.bill_id::text AS source_id, b.bill_no,
       b.on_date, b.patient_id, m.method, m.amount, m.ref
FROM clinical.money_bill b
CROSS JOIN LATERAL (VALUES ('cash', b.cash, NULL::text), ('card', b.card, NULL), ('cheque', b.cheque, b.cheque_no),
                           (CASE WHEN b.other_type IN (1, 2) THEN 'upi' ELSE 'other' END, b.other_amount, b.other_ref)) m(method, amount, ref)
WHERE m.amount <> 0
UNION ALL
SELECT 'pharm-' || p.apayid || '-' || m.method, 'pharmacy_payment', p.apayid::text, o.billno::text, p.inserteddate::date, p.npatid,
       m.method, m.amount, m.ref
FROM yarago.tblopticalpatientpayment p
JOIN yarago.tblopticalpatientorders o ON o.orderid = p.orderid
CROSS JOIN LATERAL (VALUES ('cash', coalesce(p.cashamount, 0)::numeric, NULL::text), ('card', coalesce(p.cardamount, 0)::numeric, NULL),
                           ('cheque', coalesce(p.chequeamount, 0)::numeric, nullif(btrim(p.chequeno), '')),
                           (CASE WHEN p.otherpaymentid IN (1, 2) THEN 'upi' ELSE 'other' END, coalesce(p.otherepaymentmode, 0)::numeric,
                            nullif(btrim(p.referencenumber), ''))) m(method, amount, ref)
WHERE coalesce(p.isactive, 1) = 1 AND p.inserteddate IS NOT NULL AND m.amount <> 0;

CREATE OR REPLACE VIEW clinical.money_refund AS
SELECT 'opd-' || r.aoprefundid || '-' || m.method AS refund_id, 'opd_refund'::text AS source, r.aoprefundid::text AS source_id,
       r.billno AS bill_no, r.nbillid::text AS bill_id, r.refunddate::date AS on_date, r.npatientid AS patient_id, m.method, m.amount,
       false AS date_uncertain, nullif(btrim(r.refundreason), '') AS reason
FROM yarago.tblpatientopdrefunddetails r
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES ('cash', coalesce(r.cashamount, 0)::numeric), ('card', coalesce(r.cardamount, 0)::numeric),
                        ('cheque', coalesce(r.chequeamount, 0)::numeric)) v(method, amount) WHERE v.amount <> 0
  UNION ALL   -- no split recorded: the whole refund under its payment mode (1 cash, 2 cheque, 3 card: tbl_mst_modesofpayment)
  SELECT CASE btrim(r.paymentmode) WHEN '2' THEN 'cheque' WHEN '3' THEN 'card' WHEN '1' THEN 'cash' ELSE 'unrecorded' END,
         coalesce(r.refundamount, 0)::numeric
  WHERE coalesce(r.cashamount, 0) = 0 AND coalesce(r.cardamount, 0) = 0 AND coalesce(r.chequeamount, 0) = 0
) m
WHERE coalesce(r.isactive, 1) = 1 AND coalesce(r.isrefunded, 1) = 1 AND r.refunddate IS NOT NULL AND m.amount <> 0
UNION ALL
-- pharmacy/optical refunds: Yarago keeps only the amount on the payment row, so the day is the row's last change and the
-- method is not recorded; shown as uncertain and never taken off any method's expected money
SELECT 'pharm-' || p.apayid, 'pharmacy_refund', p.apayid::text, o.billno::text, NULL, coalesce(p.lastmodifieddate, p.inserteddate)::date,
       p.npatid, 'unrecorded', p.refundamt::numeric, true, NULL
FROM yarago.tblopticalpatientpayment p
JOIN yarago.tblopticalpatientorders o ON o.orderid = p.orderid
WHERE coalesce(p.isactive, 1) = 1 AND coalesce(p.refundamt, 0) > 0;
