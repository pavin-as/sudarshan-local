-- 0028: money reconciliation, Yarago against the Zoho Books bank (D-052).
-- Zoho copies: app.zoho_* (written only by the read-only Zoho fetch; never changed by a person; not audited, like
-- sync_runs: they are copies, and every changed bank line keeps its previous version in zoho_bank_txn_versions).
-- Bank rules: which bank credits count as clinic collections (admin, audited). A credit no rule matches is never counted.
-- Adjustments: requests by managers and admins, counted only once an admin approves. Content is fixed at submission
-- (guard trigger); effects are computed once and frozen in recon_adjustment_effects; the tally sums the effects of
-- approved rows only, so nothing is ever "applied" and nothing can be applied twice. Nothing is ever deleted.

-- ---------- Zoho copies ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.zoho_fetch_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  requested_by  integer REFERENCES app.users(id),   -- NULL = the two-hourly job
  counts        jsonb,
  message       text
);
CREATE INDEX IF NOT EXISTS zoho_fetch_runs_at_idx ON app.zoho_fetch_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS app.zoho_bank_accounts (
  account_id         text PRIMARY KEY,
  account_name       text NOT NULL,
  account_type       text,
  feed_refreshed_on  date,          -- Zoho's feeds_last_refresh_date: bank lines after this day are not known yet
  balance            numeric,
  fetched_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.zoho_bank_txns (
  transaction_id    text PRIMARY KEY,
  account_id        text NOT NULL,
  txn_date          date NOT NULL,
  amount            numeric(14,2) NOT NULL,
  debit_or_credit   text NOT NULL CHECK (debit_or_credit IN ('credit','debit')),
  transaction_type  text,
  zoho_status       text,
  description       text,
  reference_number  text,
  payee             text,
  raw               jsonb NOT NULL,
  raw_hash          text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  missing_since     timestamptz          -- no longer listed by Zoho for a fetched range (kept, shown as removed in Zoho)
);
CREATE INDEX IF NOT EXISTS zoho_bank_txns_date_idx ON app.zoho_bank_txns (account_id, txn_date);

CREATE TABLE IF NOT EXISTS app.zoho_bank_txn_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  text NOT NULL,
  raw             jsonb NOT NULL,
  raw_hash        text NOT NULL,
  replaced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zoho_bank_txn_versions_idx ON app.zoho_bank_txn_versions (transaction_id, replaced_at);

CREATE TABLE IF NOT EXISTS app.zoho_customer_payments (       -- what the bookkeeper recorded in Zoho: a cross-check only
  payment_id        text PRIMARY KEY,
  pay_date          date NOT NULL,
  payment_mode      text,
  amount            numeric(14,2) NOT NULL,
  account_id        text,
  account_name      text,
  description       text,
  reference_number  text,
  invoice_numbers   text,
  raw               jsonb NOT NULL,
  raw_hash          text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zoho_customer_payments_date_idx ON app.zoho_customer_payments (pay_date);

-- ---------- bank rules ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.recon_bank_rules (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position     integer NOT NULL DEFAULT 100,
  pattern      text NOT NULL,                     -- case-insensitive regular expression over the bank description
  class        text NOT NULL CHECK (class IN ('upi_settlement','card_settlement','cash_deposit','online_settlement','not_clinic')),
  method       text CHECK (method IN ('cash','card','upi','cheque','other')),
  window_days  integer NOT NULL DEFAULT 3 CHECK (window_days BETWEEN 0 AND 10),
  is_active    boolean NOT NULL DEFAULT true,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (class = 'not_clinic' OR method IS NOT NULL)
);
-- Seeded from the bank descriptions the bookkeeper's Zoho payments carry (28 Oct 2026): UPI settles the next day as
-- "UPI SETTLEMENT -RYX181- dd/mm/yy", card as "...TERMINAL 1 CARDS SETTL. dd/mm/yy". Cash deposits: no pattern known yet.
INSERT INTO app.recon_bank_rules (position, pattern, class, method, window_days, is_active, note)
SELECT * FROM (VALUES
  (10, 'UPI SETTLEMENT\s*-RYX181-', 'upi_settlement', 'upi', 3, true, 'Clinic UPI merchant settlement'),
  (20, 'TERMINAL 1 CARDS SETTL', 'card_settlement', 'card', 3, true, 'Clinic card terminal settlement'),
  (30, 'CASH DEP', 'cash_deposit', 'cash', 7, false, 'Cash deposited at the bank: check the bank''s wording before switching on')
) v WHERE NOT EXISTS (SELECT 1 FROM app.recon_bank_rules);

-- ---------- adjustments ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.recon_adjustments (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_key       uuid NOT NULL UNIQUE,              -- sent by the form: the same request sent twice is one row
  kind              text NOT NULL CHECK (kind IN ('refund_method','method_correction','amount_correction','date_correction',
                                                  'missing_entry','payment_fee','bank_credit','reversal')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn','reversed')),
  on_date           date NOT NULL,                     -- the business day the adjustment belongs to
  other_date        date,                              -- date correction: the actual day
  amount            numeric(12,2) NOT NULL,            -- amount correction: the correct amount (may be 0); others above 0
  recorded_amount   numeric(12,2),                     -- amount correction: as in Yarago
  category          text CHECK (category IN ('consultation','procedure','pharmacy','optical')),
  source_method     text CHECK (source_method IN ('cash','card','upi','cheque','other')),    -- refund: how the patient paid
  recorded_method   text CHECK (recorded_method IN ('cash','card','upi','cheque','other')),  -- as Yarago shows it (NULL: not in Yarago)
  actual_method     text CHECK (actual_method IN ('cash','card','upi','cheque','other')),    -- method actually used
  bank_class        text CHECK (bank_class IN ('clinic','not_clinic')),
  yarago_source     text CHECK (yarago_source IN ('clinic_bill','pharmacy_payment','opd_refund','pharmacy_refund')),
  yarago_id         text,
  bill_no           text,
  patient_id        integer,
  zoho_txn_id       text,
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 10),
  refs              text,                              -- receipt number, UPI reference, Zoho id: the app has no attachments
  submitted_by      integer NOT NULL REFERENCES app.users(id),
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by       integer REFERENCES app.users(id),
  reviewed_at       timestamptz,
  review_note       text,
  rejection_reason  text,
  self_approved     boolean NOT NULL DEFAULT false,
  withdrawn_at      timestamptz,
  reverses_id       bigint REFERENCES app.recon_adjustments(id),   -- kind reversal: the approved adjustment it undoes
  replaces_id       bigint REFERENCES app.recon_adjustments(id),   -- a corrected version of that adjustment
  paired_with       bigint REFERENCES app.recon_adjustments(id),   -- replacement: decided together with this reversal
  reversed_by       bigint REFERENCES app.recon_adjustments(id),   -- set on the original when its reversal is approved
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0 OR (kind = 'amount_correction' AND amount = 0)),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK (status <> 'rejected' OR length(btrim(coalesce(rejection_reason, ''))) >= 3),
  CHECK (status NOT IN ('approved','rejected','reversed') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (NOT self_approved OR (reviewed_by = submitted_by AND length(btrim(coalesce(review_note, ''))) >= 3))
);
CREATE INDEX IF NOT EXISTS recon_adjustments_status_idx ON app.recon_adjustments (status, on_date);
CREATE INDEX IF NOT EXISTS recon_adjustments_date_idx ON app.recon_adjustments (on_date);
-- one live reversal per adjustment
CREATE UNIQUE INDEX IF NOT EXISTS recon_adjustments_one_reversal ON app.recon_adjustments (reverses_id)
  WHERE reverses_id IS NOT NULL AND status IN ('pending','approved');
-- the same correction to the same Yarago record cannot be pending or approved twice
CREATE UNIQUE INDEX IF NOT EXISTS recon_adjustments_no_duplicate ON app.recon_adjustments
  (kind, yarago_source, yarago_id, amount, coalesce(recorded_method, ''), coalesce(actual_method, ''), on_date, coalesce(other_date, on_date))
  WHERE yarago_id IS NOT NULL AND kind <> 'reversal' AND replaces_id IS NULL AND status IN ('pending','approved');
-- a bank line is classified, or carries a fee, once
CREATE UNIQUE INDEX IF NOT EXISTS recon_adjustments_one_per_bank_line ON app.recon_adjustments (kind, zoho_txn_id)
  WHERE zoho_txn_id IS NOT NULL AND kind IN ('bank_credit','payment_fee') AND replaces_id IS NULL AND status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS app.recon_adjustment_effects (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adjustment_id  bigint NOT NULL REFERENCES app.recon_adjustments(id),
  position       smallint NOT NULL,
  on_date        date NOT NULL,
  measure        text NOT NULL CHECK (measure IN ('revenue','collected','refund','fee','deposit','excluded')),
  category       text,
  method         text,
  amount         numeric(12,2) NOT NULL,       -- signed
  zoho_txn_id    text,
  words          text NOT NULL,
  UNIQUE (adjustment_id, position)
);
CREATE INDEX IF NOT EXISTS recon_adjustment_effects_date_idx ON app.recon_adjustment_effects (on_date);

-- Guards: what was submitted never changes; status moves only forward; nothing is deleted.
CREATE OR REPLACE FUNCTION app.recon_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An adjustment request is kept for good; withdraw, reject or reverse it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reviewed_by','reviewed_at','review_note','rejection_reason','self_approved',
                            'withdrawn_at','reversed_by','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','reviewed_by','reviewed_at','review_note','rejection_reason','self_approved',
                            'withdrawn_at','reversed_by','updated_at']) THEN
    RAISE EXCEPTION 'What an adjustment request says cannot change after it is sent; withdraw it and send a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','rejected','withdrawn'))
         OR (OLD.status = 'approved' AND NEW.status = 'reversed' AND NEW.reversed_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'An adjustment cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (OLD.reviewed_by, OLD.reviewed_at, OLD.review_note, OLD.rejection_reason, OLD.self_approved, OLD.withdrawn_at, OLD.reversed_by)
        IS DISTINCT FROM
        (NEW.reviewed_by, NEW.reviewed_at, NEW.review_note, NEW.rejection_reason, NEW.self_approved, NEW.withdrawn_at, NEW.reversed_by) THEN
    RAISE EXCEPTION 'A decision on an adjustment is not changed afterwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recon_adjustments_guard ON app.recon_adjustments;
CREATE TRIGGER recon_adjustments_guard BEFORE UPDATE OR DELETE ON app.recon_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.recon_adjustments_guard();

CREATE OR REPLACE FUNCTION app.recon_effects_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The effects of an adjustment are fixed when it is sent' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS recon_effects_guard ON app.recon_adjustment_effects;
CREATE TRIGGER recon_effects_guard BEFORE UPDATE OR DELETE ON app.recon_adjustment_effects
  FOR EACH ROW EXECUTE FUNCTION app.recon_effects_guard();

-- ---------- assistant log (D-052): each answer is shown once, to the person who asked ----------
CREATE TABLE IF NOT EXISTS app.recon_assistant_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asked_by        integer NOT NULL REFERENCES app.users(id),
  asked_at        timestamptz NOT NULL DEFAULT now(),
  date_from       date NOT NULL,
  date_to         date NOT NULL,
  question        text,
  input           jsonb NOT NULL,          -- exactly what the model saw (no names, MRDs or phone numbers)
  answer          text,
  model           text,
  prompt_version  text,
  status          text NOT NULL CHECK (status IN ('ready','failed')),
  error           text,
  checked         jsonb
);

-- ---------- audit + touch triggers, field names ---------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recon_bank_rules','recon_adjustments','recon_adjustment_effects'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit ON app.%I', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_trigger()', t);
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name=t AND column_name='updated_at') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS touch ON app.%I', t);
      EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    END IF;
  END LOOP;
END $$;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('recon_adjustments','kind','Adjustment type',false), ('recon_adjustments','status','Status',false),
  ('recon_adjustments','on_date','Business day',false), ('recon_adjustments','other_date','Actual day',false),
  ('recon_adjustments','amount','Amount',false), ('recon_adjustments','recorded_amount','Amount in Yarago',false),
  ('recon_adjustments','category','Category',false), ('recon_adjustments','source_method','Patient paid by',false),
  ('recon_adjustments','recorded_method','Method in Yarago',false), ('recon_adjustments','actual_method','Method actually used',false),
  ('recon_adjustments','bank_class','Bank credit is',false), ('recon_adjustments','yarago_source','Yarago record type',false),
  ('recon_adjustments','yarago_id','Yarago record',false), ('recon_adjustments','bill_no','Bill number',false),
  ('recon_adjustments','zoho_txn_id','Zoho bank line',false), ('recon_adjustments','reason','Explanation',false),
  ('recon_adjustments','refs','References',false), ('recon_adjustments','review_note','Approval note',false),
  ('recon_adjustments','rejection_reason','Reason for rejection',false), ('recon_adjustments','self_approved','Self-approved',false),
  ('recon_adjustments','reverses_id','Reverses request',false), ('recon_adjustments','replaces_id','Replaces request',false),
  ('recon_adjustments','reversed_by','Reversed by request',false), ('recon_adjustments','request_key','Request key',true),
  ('recon_bank_rules','pattern','Bank wording',false), ('recon_bank_rules','class','Counts as',false),
  ('recon_bank_rules','method','Payment method',false), ('recon_bank_rules','window_days','Settlement window (days)',false),
  ('recon_bank_rules','is_active','On',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

-- ---------- settings (no secrets: Zoho keys live in .env) ------------------------------------
INSERT INTO app.settings (key, value, description) VALUES
  ('recon.category_map', '{"Consultation & charges":"consultation","Investigations":"procedure","Injections":"procedure","Lasers":"procedure","Other procedures":"procedure","Others":"procedure","Pharmacy":"pharmacy","Optical":"optical"}',
   'Reconciliation: which Yarago service group counts under which category (D-052)'),
  ('recon.tolerance', '{"upi":0,"card":0,"cash":0,"cheque":0,"other":0}', 'Reconciliation: rupees a settlement may differ and still count as matched'),
  ('recon.stale_hours', '24', 'Reconciliation: Zoho copy older than this many hours is shown as out of date'),
  ('ai.recon_model', '"qwen3.5:9b"', 'Local model (Ollama) for the reconciliation assistant')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.schema_migrations(version) VALUES ('0028_reconciliation') ON CONFLICT DO NOTHING;
