-- =====================================================================================
-- 0014: what we owe each wholesaler (D-033), and purchases at invoice value.
-- Yarago keeps one payment row per purchase invoice (tblpurchasepaymentdetails): invoice amount, paid, adjustment,
-- credit note. Staff enter a settlement as one lump adjustment against a single invoice that covers many, so a
-- balance exists only per WHOLESALER: everything invoiced minus everything paid, adjusted or credited. Which invoices
-- are still open is worked out oldest-paid-first (the usual trade practice). These are VIEWS over the Yarago mirror,
-- not nightly tables, so Metabase shows the balance as of the last sync (the payment tables sync every 150 s).
-- Purchases: tblopticalpharmacypurchasedetails.atotalamount is the SELLING value (unit selling price x quantity); the
-- amount we pay is the invoice amount, spread over the invoice's lines in proportion to their selling value.
-- =====================================================================================
ALTER TABLE analytics.fact_pharmacy_purchase ADD COLUMN IF NOT EXISTS selling_value numeric;

-- one row per purchase invoice, live
CREATE OR REPLACE VIEW analytics.wholesaler_invoice AS
SELECT p.poid                                                        AS purchase_id,
       nullif(btrim(coalesce(h.ainvoice, p.ninvoice)), '')          AS invoice_no,
       coalesce(analytics.dmy(h.dcdate), analytics.dmy(h.orderdate), h.inserteddate::date, p.inserteddate::date) AS invoice_date,
       coalesce(upper(regexp_replace(btrim(v.avendorname), '\s+', ' ', 'g')), 'NOT RECORDED') AS wholesaler,
       round(coalesce(p.atotalinvoiceamount, 0)::numeric, 2)       AS invoiced,
       round(coalesce(p.apaidamount, 0)::numeric, 2)               AS paid,
       round(coalesce(p.aadjustmentamount, 0)::numeric, 2)         AS adjusted,
       round(coalesce(p.creditnoteamt, 0)::numeric, 2)             AS credit_note,
       round((coalesce(p.apaidamount, 0) + coalesce(p.aadjustmentamount, 0) + coalesce(p.creditnoteamt, 0))::numeric, 2) AS settled,
       p.inserteddate                                               AS entered_at,
       CASE WHEN coalesce(p.apaidamount, 0) <> 0 OR coalesce(p.aadjustmentamount, 0) <> 0 OR coalesce(p.creditnoteamt, 0) <> 0
            THEN p.lastmodifieddate END                             AS settlement_entered_at
FROM yarago.tblpurchasepaymentdetails p
LEFT JOIN yarago.tblopticalpharmacypurchase h ON h.poid = p.poid
LEFT JOIN yarago.tbl_mst_vendor v ON v.avenid = coalesce(p.nsuppid, h.nsupplierid)
WHERE coalesce(p.isactive, 1) = 1 AND coalesce(h.isactive, 1) = 1;

-- balance per wholesaler now (negative pending = we paid in advance)
CREATE OR REPLACE VIEW analytics.wholesaler_balance AS
SELECT wholesaler,
       count(*)                                   AS invoices,
       sum(invoiced)                              AS invoiced,
       sum(paid)                                  AS paid,
       sum(adjusted)                              AS adjusted,
       sum(credit_note)                           AS credit_notes,
       sum(invoiced) - sum(settled)               AS pending,
       max(invoice_date)                          AS last_invoice,
       max(settlement_entered_at)::date           AS last_settlement_entered
FROM analytics.wholesaler_invoice
GROUP BY wholesaler;

-- invoices still open, oldest paid first: newest invoices stay open until their total reaches the pending balance
CREATE OR REPLACE VIEW analytics.wholesaler_open_invoice AS
WITH w AS (
  SELECT i.*, b.pending,
         coalesce(sum(i.invoiced) OVER (PARTITION BY i.wholesaler ORDER BY i.invoice_date DESC, i.purchase_id DESC
                                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS newer_total
    FROM analytics.wholesaler_invoice i JOIN analytics.wholesaler_balance b USING (wholesaler)
   WHERE b.pending > 1 AND i.invoiced > 0)
SELECT wholesaler, purchase_id, invoice_no, invoice_date, invoiced,
       least(invoiced, pending - newer_total)     AS open_amount,
       current_date - invoice_date                AS days_open
FROM w
WHERE newer_total < pending;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sudarshan_bi') THEN
    GRANT SELECT ON analytics.wholesaler_invoice, analytics.wholesaler_balance, analytics.wholesaler_open_invoice TO sudarshan_bi;
  END IF;
END $$;

-- purchases at invoice value: refresh_pharmacy() again, with amount = the line's share of the invoice amount
CREATE OR REPLACE FUNCTION analytics.refresh_pharmacy() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  TRUNCATE analytics.dim_medicine, analytics.dim_wholesaler, analytics.fact_pharmacy_sale, analytics.fact_pharmacy_purchase;

  INSERT INTO analytics.dim_wholesaler
  SELECT v.avenid, upper(regexp_replace(btrim(v.avendorname), '\s+', ' ', 'g'))
    FROM yarago.tbl_mst_vendor v WHERE nullif(btrim(v.avendorname), '') IS NOT NULL;

  INSERT INTO analytics.fact_pharmacy_purchase (line_id, purchase_id, invoice_no, invoice_date, vendor_id, manufacturer, product_id, category,
                                               quantity, amount, tax, discount, selling_value)
  SELECT d.podid, d.poid, nullif(btrim(h.ainvoice), ''),
         coalesce(analytics.dmy(h.dcdate), analytics.dmy(h.orderdate), h.inserteddate::date),
         h.nsupplierid,
         coalesce(upper(nullif(nullif(btrim(h.companyname), ''), '0')), 'NOT RECORDED'),
         d.aproductid, coalesce(c.acategoryname, 'Unknown'),
         greatest(coalesce(d.aactualqty, 0) - coalesce(d.returnqty, 0), 0),
         round((CASE WHEN coalesce(pay.atotalinvoiceamount, 0) > 0 AND inv.sell > 0
                     THEN pay.atotalinvoiceamount * coalesce(d.atotalamount, 0) / inv.sell
                     ELSE coalesce(d.unitrate, 0) * coalesce(d.aactualqty, 0) END)::numeric, 2),
         coalesce(d.totgstprdctamount, d.atax, 0), coalesce(d.adiscount, 0), coalesce(d.atotalamount, 0)
    FROM yarago.tblopticalpharmacypurchasedetails d
    JOIN yarago.tblopticalpharmacypurchase h ON h.poid = d.poid
    LEFT JOIN yarago.tblpurchasepaymentdetails pay ON pay.poid = d.poid AND coalesce(pay.isactive, 1) = 1
    LEFT JOIN LATERAL (SELECT sum(coalesce(x.atotalamount, 0)) AS sell FROM yarago.tblopticalpharmacypurchasedetails x
                        WHERE x.poid = d.poid AND coalesce(x.isactive, 1) = 1) inv ON true
    LEFT JOIN yarago.tbl_mst_category c ON c.acatid = d.acategoryid
   WHERE coalesce(d.isactive, 1) = 1 AND coalesce(h.isactive, 1) = 1 AND d.acategoryid IN (3, 5, 6, 7, 8)
     AND coalesce(analytics.dmy(h.dcdate), analytics.dmy(h.orderdate), h.inserteddate::date) IS NOT NULL;

  INSERT INTO analytics.dim_medicine
  SELECT p.aprodid, upper(regexp_replace(btrim(p.aproductname), '\s+', ' ', 'g')), coalesce(c.acategoryname, 'Unknown'),
         coalesce(m.manufacturer, 'NOT RECORDED'), coalesce(p.isactive, 1) = 1 AND coalesce(p.isdeleted, 0) = 0
    FROM yarago.tbl_mst_product p
    LEFT JOIN yarago.tbl_mst_category c ON c.acatid = nullif(p.ncatid, '')::int
    LEFT JOIN LATERAL (SELECT f.manufacturer FROM analytics.fact_pharmacy_purchase f
                        WHERE f.product_id = p.aprodid AND f.manufacturer <> 'NOT RECORDED'
                        GROUP BY f.manufacturer ORDER BY count(*) DESC, max(f.invoice_date) DESC LIMIT 1) m ON true
   WHERE nullif(btrim(p.aproductname), '') IS NOT NULL AND p.ncatid ~ '^\d+$';

  INSERT INTO analytics.fact_pharmacy_sale
  SELECT d.odid, d.orderid, o.billno, d.inserteddate::date, k.patient_key, d.nproductid, d.nsuppid, coalesce(c.acategoryname, 'Unknown'),
         greatest(coalesce(d.nqty, 0) - coalesce(d.cancelledqty, 0), 0),
         coalesce(d.totamount, 0) - coalesce(d.cancelledamt, 0),
         coalesce(d.taxamount, 0), coalesce(d.discrsamt, 0), coalesce(d.cancelledqty, 0), coalesce(d.cancelledamt, 0)
    FROM yarago.tblopticalpatientorderdetails d
    LEFT JOIN yarago.tblopticalpatientorders o ON o.orderid = d.orderid
    LEFT JOIN app.analytics_patient_key k ON k.patient_id = o.npatid
    LEFT JOIN yarago.tbl_mst_category c ON c.acatid = d.ncategoryid
   WHERE coalesce(d.isactive, 1) = 1 AND coalesce(o.isactive, 1) = 1 AND o.cancelleddate IS NULL
     AND d.ncategoryid IN (3, 5, 6, 7, 8) AND d.inserteddate IS NOT NULL;

  SELECT jsonb_build_object('medicines', (SELECT count(*) FROM analytics.dim_medicine),
                            'wholesalers', (SELECT count(*) FROM analytics.dim_wholesaler),
                            'sale_lines', (SELECT count(*) FROM analytics.fact_pharmacy_sale),
                            'purchase_lines', (SELECT count(*) FROM analytics.fact_pharmacy_purchase)) INTO r;
  RETURN r;
END $$;
