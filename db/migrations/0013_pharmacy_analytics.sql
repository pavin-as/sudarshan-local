-- =====================================================================================
-- 0013: pharmacy analytics (D-032): medicine sales, manufacturers and the wholesalers we buy from, for Metabase.
-- Sources (Yarago optical+pharmacy module): sale lines tblopticalpatientorderdetails (+ orders tblopticalpatientorders),
-- medicines tbl_mst_product (+ tbl_mst_category), purchases tblopticalpharmacypurchase (+ details), wholesalers
-- tbl_mst_vendor. Yarago keeps no manufacturer on the medicine: it is the company named on the purchase invoices of
-- that medicine (the most frequent one). Pharmacy = categories Eye Drops, Tablets, Ointments, Others, Pharmacy
-- Stationary (3, 5, 6, 7, 8); optical categories are left out. Rebuilt nightly by analytics.refresh_pharmacy()
-- (sync service, after analytics.refresh()). Patients appear only as the random analytics key (D-020).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS analytics.dim_medicine (
  product_id     integer PRIMARY KEY,
  medicine       text NOT NULL,
  category       text NOT NULL,
  manufacturer   text NOT NULL,          -- 'Not recorded' when no purchase invoice names the company
  is_active      boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics.dim_wholesaler (
  vendor_id      integer PRIMARY KEY,
  wholesaler     text NOT NULL           -- name as in Yarago, tidied (one wholesaler may have several Yarago ids)
);

CREATE TABLE IF NOT EXISTS analytics.fact_pharmacy_sale (
  line_id        integer PRIMARY KEY,    -- Yarago odid
  order_id       integer,
  bill_no        bigint,
  sale_date      date NOT NULL,
  patient_key    bigint,
  product_id     integer,
  vendor_id      integer,                -- wholesaler the batch came from
  category       text NOT NULL,
  quantity       integer NOT NULL,       -- sold, after returns
  amount         numeric NOT NULL,       -- after discount and returns, including tax (what the patient paid)
  tax            numeric NOT NULL,
  discount       numeric NOT NULL,
  returned_qty   integer NOT NULL,
  returned_amount numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_pharmacy_sale_date_idx ON analytics.fact_pharmacy_sale (sale_date);

CREATE TABLE IF NOT EXISTS analytics.fact_pharmacy_purchase (
  line_id        integer PRIMARY KEY,    -- Yarago podid
  purchase_id    integer NOT NULL,
  invoice_no     text,
  invoice_date   date NOT NULL,
  vendor_id      integer,
  manufacturer   text NOT NULL,          -- company on this invoice ('Not recorded' when blank)
  product_id     integer,
  category       text NOT NULL,
  quantity       integer NOT NULL,       -- received, after returns to the wholesaler
  amount         numeric NOT NULL,       -- invoice line total
  tax            numeric NOT NULL,
  discount       numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_pharmacy_purchase_date_idx ON analytics.fact_pharmacy_purchase (invoice_date);

-- a dd-mm-yyyy text date from Yarago, or NULL
CREATE OR REPLACE FUNCTION analytics.dmy(t text) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^\d{2}-\d{2}-\d{4}$' AND substr(t, 4, 2)::int BETWEEN 1 AND 12 AND substr(t, 1, 2)::int BETWEEN 1 AND 31
              THEN to_date(t, 'DD-MM-YYYY') END
$$;

CREATE OR REPLACE FUNCTION analytics.refresh_pharmacy() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  TRUNCATE analytics.dim_medicine, analytics.dim_wholesaler, analytics.fact_pharmacy_sale, analytics.fact_pharmacy_purchase;

  INSERT INTO analytics.dim_wholesaler
  SELECT v.avenid, regexp_replace(btrim(v.avendorname), '\s+', ' ', 'g')
    FROM yarago.tbl_mst_vendor v WHERE nullif(btrim(v.avendorname), '') IS NOT NULL;

  INSERT INTO analytics.fact_pharmacy_purchase
  SELECT d.podid, d.poid, nullif(btrim(h.ainvoice), ''),
         coalesce(analytics.dmy(h.dcdate), analytics.dmy(h.orderdate), h.inserteddate::date),
         h.nsupplierid,
         coalesce(upper(nullif(nullif(btrim(h.companyname), ''), '0')), 'Not recorded'),
         d.aproductid, coalesce(c.acategoryname, 'Unknown'),
         greatest(coalesce(d.aactualqty, 0) - coalesce(d.returnqty, 0), 0),
         coalesce(d.atotalamount, 0), coalesce(d.totgstprdctamount, d.atax, 0), coalesce(d.adiscount, 0)
    FROM yarago.tblopticalpharmacypurchasedetails d
    JOIN yarago.tblopticalpharmacypurchase h ON h.poid = d.poid
    LEFT JOIN yarago.tbl_mst_category c ON c.acatid = d.acategoryid
   WHERE coalesce(d.isactive, 1) = 1 AND coalesce(h.isactive, 1) = 1 AND d.acategoryid IN (3, 5, 6, 7, 8)
     AND coalesce(analytics.dmy(h.dcdate), analytics.dmy(h.orderdate), h.inserteddate::date) IS NOT NULL;

  -- manufacturer of a medicine = the company most often on its purchase invoices
  INSERT INTO analytics.dim_medicine
  SELECT p.aprodid, upper(regexp_replace(btrim(p.aproductname), '\s+', ' ', 'g')), coalesce(c.acategoryname, 'Unknown'),
         coalesce(m.manufacturer, 'Not recorded'), coalesce(p.isactive, 1) = 1 AND coalesce(p.isdeleted, 0) = 0
    FROM yarago.tbl_mst_product p
    LEFT JOIN yarago.tbl_mst_category c ON c.acatid = nullif(p.ncatid, '')::int
    LEFT JOIN LATERAL (SELECT f.manufacturer FROM analytics.fact_pharmacy_purchase f
                        WHERE f.product_id = p.aprodid AND f.manufacturer <> 'Not recorded'
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

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sudarshan_bi') THEN
    GRANT SELECT ON analytics.dim_medicine, analytics.dim_wholesaler, analytics.fact_pharmacy_sale, analytics.fact_pharmacy_purchase TO sudarshan_bi;
  END IF;
END $$;
