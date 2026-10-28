-- 0029: per-login access, the cash book, bank fees (D-053), and what the first live Zoho read showed (28 Oct 2026).
-- Re-run safe like every migration (scripts/migrate.py applies them all each time).

-- ---------- per-login access (D-053) -----------------------------------------------------------
-- A login gets its role's permissions (server/src/lib/permissions.ts) with these changes: allowed = true gives one the
-- role lacks, false takes one away. Only differences are stored. Admins always have everything. Audited.
CREATE TABLE IF NOT EXISTS app.user_permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES app.users(id),
  permission  text NOT NULL,
  allowed     boolean NOT NULL,
  set_by      integer REFERENCES app.users(id),
  set_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission)
);

-- Finance is no longer part of the manager role (D-053). Pavin, 28 Oct: Dr Sameera (sam@sampada) sees all of finance;
-- managers are chosen one by one on the Users page.
INSERT INTO app.user_permissions (user_id, permission, allowed)
SELECT u.id, p, true FROM app.users u CROSS JOIN unnest(ARRAY['reconciliation.read','adjustments.submit']) p
 WHERE u.username = 'sam@sampada' AND u.role <> 'admin'
   AND NOT EXISTS (SELECT 1 FROM app.user_permissions x WHERE x.user_id = u.id AND x.permission = p);

-- ---------- Zoho: money in is "debit" in Zoho's bank register --------------------------------
-- Zoho Books lists a bank account's lines from the ledger's side: a deposit DEBITS the bank account. 0028 read it the
-- other way round. Sudarshan keeps debit_or_credit from the bank statement's side (credit = money in), worked out from
-- Zoho's own field in raw, so this is safe to run again.
UPDATE app.zoho_bank_txns
   SET debit_or_credit = CASE WHEN lower(raw->>'debit_or_credit') = 'debit' THEN 'credit' ELSE 'debit' END
 WHERE debit_or_credit IS DISTINCT FROM CASE WHEN lower(raw->>'debit_or_credit') = 'debit' THEN 'credit' ELSE 'debit' END;

-- ---------- bank rules: charges, and the cash deposit wording ---------------------------------
ALTER TABLE app.recon_bank_rules DROP CONSTRAINT IF EXISTS recon_bank_rules_class_check;
ALTER TABLE app.recon_bank_rules ADD CONSTRAINT recon_bank_rules_class_check
  CHECK (class IN ('upi_settlement','card_settlement','cash_deposit','online_settlement','not_clinic','bank_charge'));
-- HDFC writes a cash deposit as "CASH DEPOSIT BY - <name> - TIRUR" (Zoho, 2023-2026); switch the seeded rule on
UPDATE app.recon_bank_rules SET pattern = '^CASH DEPOSIT BY\b', is_active = true, window_days = 3,
       note = 'Cash deposited at the HDFC Tirur branch ("CASH DEPOSIT BY - name - TIRUR")'
 WHERE class = 'cash_deposit' AND pattern = 'CASH DEP' AND NOT is_active;
-- the card terminal's monthly service charge, ₹99 + GST, debited on the 15th as "Service Charges-SEP26-...-RY..."
INSERT INTO app.recon_bank_rules (position, pattern, class, method, window_days, is_active, note)
SELECT 40, '^SERVICE CHARGES-[A-Z]{3}[0-9]{2}-', 'bank_charge', 'card', 0, true, 'HDFC card terminal monthly service charge (money out)'
 WHERE NOT EXISTS (SELECT 1 FROM app.recon_bank_rules WHERE class = 'bank_charge');

-- ---------- cash deposits (D-053) -------------------------------------------------------------
-- What the cash desk takes to the bank. Recorded blind: the person recording never sees Yarago's cash figure. Each
-- deposit covers the cash collected up to and including covers_to (the days after the previous deposit); the
-- difference rolls forward as cash carried in the drawer. Content never changes; a wrong entry is voided by an admin
-- with a reason and recorded again. Nothing is deleted.
CREATE TABLE IF NOT EXISTS app.cash_deposits (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_key   uuid NOT NULL UNIQUE,                 -- the same form sent twice is one deposit
  deposited_on  date NOT NULL,
  covers_to     date NOT NULL,                        -- cash collected up to and including this day
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  slip_no       text,
  note          text,
  recorded_by   integer NOT NULL REFERENCES app.users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','voided')),
  voided_by     integer REFERENCES app.users(id),
  voided_at     timestamptz,
  void_reason   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (covers_to <= deposited_on),
  CHECK (status <> 'voided' OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND length(btrim(coalesce(void_reason, ''))) >= 5))
);
-- two live deposits never cover up to the same day
CREATE UNIQUE INDEX IF NOT EXISTS cash_deposits_covers_to ON app.cash_deposits (covers_to) WHERE status = 'recorded';
CREATE INDEX IF NOT EXISTS cash_deposits_deposited_on ON app.cash_deposits (deposited_on);

CREATE OR REPLACE FUNCTION app.cash_deposits_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A cash deposit is kept for good; void it with a reason instead' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','voided_by','voided_at','void_reason','updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_by','voided_at','void_reason','updated_at']) THEN
    RAISE EXCEPTION 'A recorded cash deposit cannot be changed; void it and record it again' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'A voided cash deposit stays voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cash_deposits_guard ON app.cash_deposits;
CREATE TRIGGER cash_deposits_guard BEFORE UPDATE OR DELETE ON app.cash_deposits
  FOR EACH ROW EXECUTE FUNCTION app.cash_deposits_guard();

-- ---------- bank fee rates (D-053) ------------------------------------------------------------
-- The commission the bank keeps, by payment kind and amount, as a set of rows in force from a day until the next set.
-- Rates before GST (recon.fee_fixed gst_pct). Seeded from HDFC's published schedule (SmartHub merchants, turnover over
-- ₹20 lakh; the POS agreement's own card rates replace these when the bank sends them).
CREATE TABLE IF NOT EXISTS app.bank_fee_rates (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effective_from  date NOT NULL,
  method          text NOT NULL CHECK (method IN ('card','upi')),
  kind            text NOT NULL CHECK (kind IN ('debit','rupay_debit','credit','international','upi','upi_rupay_credit')),
  amount_above    numeric(12,2) NOT NULL DEFAULT 0,     -- applies to a payment above this ...
  amount_upto     numeric(12,2),                        -- ... and up to this (NULL: no upper limit)
  rate_pct        numeric(6,3) NOT NULL DEFAULT 0 CHECK (rate_pct >= 0 AND rate_pct <= 10),
  cap_rupees      numeric(10,2),                        -- most taken on one payment
  flat_rupees     numeric(10,2),                        -- a fixed fee instead of the rate
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (effective_from, method, kind, amount_above)
);
INSERT INTO app.bank_fee_rates (effective_from, method, kind, amount_above, amount_upto, rate_pct, cap_rupees, note)
SELECT * FROM (VALUES
  ('2020-01-01'::date, 'card', 'rupay_debit', 0, NULL::numeric, 0, NULL::numeric, 'RuPay debit: no MDR (government, 2020)'),
  ('2020-01-01', 'card', 'debit', 0, 2000, 0.40, NULL, 'Debit card up to ₹2,000'),
  ('2020-01-01', 'card', 'debit', 2000, NULL, 0.90, 1000, 'Debit card above ₹2,000, at most ₹1,000'),
  ('2020-01-01', 'card', 'credit', 0, NULL, 1.85, NULL, 'Domestic credit card (Visa, Mastercard, Diners, RuPay)'),
  ('2020-01-01', 'card', 'international', 0, NULL, 3.00, NULL, 'International card (commercial cards 2.75%)'),
  ('2020-01-01', 'upi', 'upi', 0, NULL, 0, NULL, 'UPI: no MDR'),
  ('2020-01-01', 'upi', 'upi_rupay_credit', 0, 2000, 0, NULL, 'UPI on a RuPay credit card up to ₹2,000'),
  ('2020-01-01', 'upi', 'upi_rupay_credit', 2000, NULL, 1.85, NULL, 'UPI on a RuPay credit card above ₹2,000'),
  ('2026-10-15', 'card', 'rupay_debit', 0, NULL, 0, NULL, 'RuPay debit: no MDR'),
  ('2026-10-15', 'card', 'debit', 0, 2000, 0.40, NULL, 'Debit card up to ₹2,000'),
  ('2026-10-15', 'card', 'debit', 2000, NULL, 0.90, 1000, 'Debit card above ₹2,000, at most ₹1,000'),
  ('2026-10-15', 'card', 'credit', 0, NULL, 1.85, NULL, 'Domestic credit card (Visa, Mastercard, Diners, RuPay)'),
  ('2026-10-15', 'card', 'international', 0, NULL, 3.00, NULL, 'International card (commercial cards 2.75%)'),
  ('2026-10-15', 'upi', 'upi', 0, 2000, 0, NULL, 'UPI up to ₹2,000: no MDR'),
  ('2026-10-15', 'upi', 'upi', 2000, NULL, 0.40, 300, 'UPI above ₹2,000 from 15 Oct 2026, at most ₹300 (₹5 flat for HDFC''s specialised sectors)'),
  ('2026-10-15', 'upi', 'upi_rupay_credit', 0, 2000, 0, NULL, 'UPI on a RuPay credit card up to ₹2,000'),
  ('2026-10-15', 'upi', 'upi_rupay_credit', 2000, NULL, 1.85, NULL, 'UPI on a RuPay credit card above ₹2,000')
) v(effective_from, method, kind, amount_above, amount_upto, rate_pct, cap_rupees, note)
WHERE NOT EXISTS (SELECT 1 FROM app.bank_fee_rates);

-- ---------- audit + touch triggers, field names ---------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_permissions','cash_deposits','bank_fee_rates'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit ON app.%I', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_trigger()', t);
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name=t AND column_name='updated_at') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS touch ON app.%I', t);
      EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    END IF;
  END LOOP;
END $$;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('user_permissions','user_id','User',false), ('user_permissions','permission','Permission',false),
  ('user_permissions','allowed','Given',false), ('user_permissions','set_by','Set by',true), ('user_permissions','set_at','Set at',true),
  ('cash_deposits','deposited_on','Deposited on',false), ('cash_deposits','covers_to','Cash up to',false),
  ('cash_deposits','amount','Amount deposited',false), ('cash_deposits','slip_no','Slip number',false), ('cash_deposits','note','Note',false),
  ('cash_deposits','status','Status',false), ('cash_deposits','void_reason','Why voided',false),
  ('cash_deposits','request_key','Request key',true), ('cash_deposits','recorded_by','Recorded by',true),
  ('bank_fee_rates','effective_from','In force from',false), ('bank_fee_rates','method','Method',false), ('bank_fee_rates','kind','Payment kind',false),
  ('bank_fee_rates','amount_above','Above (₹)',false), ('bank_fee_rates','amount_upto','Up to (₹)',false), ('bank_fee_rates','rate_pct','Rate %',false),
  ('bank_fee_rates','cap_rupees','At most (₹)',false), ('bank_fee_rates','flat_rupees','Flat fee (₹)',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

-- ---------- settings ------------------------------------------------------------------------
INSERT INTO app.settings (key, value, description) VALUES
  ('cash.book', '{"start":"2026-10-11","opening":0}',
   'Cash book: the first collection day it counts (the day after the last deposit before Sudarshan) and the cash in hand before it'),
  ('cash.limits', '{"warnAt":300000,"limit":400000,"carryBand":99}',
   'Cash in hand: amber from warnAt, red at limit (Pavin: never above ₹4,00,000); a deposit may leave or add up to carryBand rupees for rounding'),
  ('recon.fee_fixed', '{"gstPct":18,"servicePerMonth":99,"perBatch":1,"lateSettleDays":2}',
   'Bank fees beyond the rates: GST on fees, terminal service charge a month, fee a settlement batch, days before a late settlement fee (HDFC: 0.5% or ₹499)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.schema_migrations(version) VALUES ('0029_finance_access_cash') ON CONFLICT DO NOTHING;
