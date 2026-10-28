-- 0031: the Books audit (D-054): how well Zoho Books is kept, measured each week for Basith's Friday sheet; and what the
-- first HDFC statement imported into Zoho by PDF showed (28 Oct 2026). Re-run safe like every migration.

-- ---------- bank rules: statement lines imported by PDF -------------------------------------
-- Yodlee's feed to Zoho broke on 21 Oct 2026; Pavin imported HDFC's PDF statement instead. Its lines spell the UPI
-- merchant id in full (RY9181; the feed masks it as RYX181) and have double spaces (rules now match the description
-- with spaces collapsed, services/reconcile.ts). The terminal charges come from both terminals (66027444/RY9181 and
-- 64061321/EGD494), as "SERVICE CHARGES-SEP26-..." or masked "SERVICE CHARGES-SEPXX-...", with a monthly "LOW USAGE
-- CHARGES-...-EGD494" (₹588.82 since June 2026) and a "SETTLEMENT CHARGE-AUG26-RY9181" per batch.
UPDATE app.recon_bank_rules SET pattern = 'UPI SETTLEMENT\s*-RY[X9]181-'
 WHERE class = 'upi_settlement' AND pattern = 'UPI SETTLEMENT\s*-RYX181-';
UPDATE app.recon_bank_rules SET pattern = '^(SERVICE|LOW USAGE|SETTLEMENT) CHARGES?-[A-Z]{3}[0-9X]{2}-',
       note = 'HDFC card terminal charges, both terminals: monthly service charge, low-usage charge, settlement charge (money out)'
 WHERE class = 'bank_charge' AND pattern = '^SERVICE CHARGES-[A-Z]{3}[0-9]{2}-';

-- ---------- Zoho copies for the audit (read only, not audited, like app.zoho_bank_txns) -------
-- Need the READ scopes ZohoBooks.invoices.READ and ZohoBooks.expenses.READ (scripts/setup-zoho.ps1); without them the
-- fetch still copies the bank and the audit says which checks it cannot measure.
CREATE TABLE IF NOT EXISTS app.zoho_invoices (
  invoice_id      text PRIMARY KEY,
  invoice_number  text,
  inv_date        date NOT NULL,
  customer_name   text,
  status          text,             -- Zoho: draft, sent, paid, partially_paid, overdue, void ...
  total           numeric(14,2) NOT NULL,
  balance         numeric(14,2) NOT NULL,
  created_time    timestamptz,      -- when it was entered in Zoho
  raw             jsonb NOT NULL,
  raw_hash        text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  missing_since   timestamptz       -- Zoho no longer lists it for a fetched period (deleted there); never deleted here
);
CREATE INDEX IF NOT EXISTS zoho_invoices_date_idx ON app.zoho_invoices (inv_date);

CREATE TABLE IF NOT EXISTS app.zoho_expenses (
  expense_id         text PRIMARY KEY,
  exp_date           date NOT NULL,
  account_name       text,          -- the expense account (what it was for)
  paid_through       text,          -- the bank account or Petty Cash it was paid from
  description        text,          -- the bookkeeper's narration
  reference_number   text,
  vendor_name        text,
  total              numeric(14,2) NOT NULL,
  has_attachment     boolean NOT NULL DEFAULT false,
  created_time       timestamptz,
  raw                jsonb NOT NULL,
  raw_hash           text NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  missing_since      timestamptz
);
CREATE INDEX IF NOT EXISTS zoho_expenses_date_idx ON app.zoho_expenses (exp_date);

-- The audit's result for a day, saved after each Zoho fetch (the last one of the day wins): the weekly trend. Derived
-- from the copies above, so not audited.
CREATE TABLE IF NOT EXISTS app.books_audit_snapshots (
  on_date   date PRIMARY KEY,
  score     integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  checks    jsonb NOT NULL,          -- [{key, level, count, amount}]
  saved_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- settings ------------------------------------------------------------------------
-- Pavin, 28 Oct: Basith comes once a week; Pavin or Dr Sameera prints his sheet every Friday. So everything older than
-- dueDays (7) must be done; newer work is "not due yet". Expense quality rules apply from qualityFrom (new to Basith).
INSERT INTO app.settings (key, value, description) VALUES
  ('books.audit', '{"from":"2026-04-01","qualityFrom":"2026-10-01","dueDays":7,"bankBehindDays":3,"invoiceTolerance":100,"receiptAbove":2000,"vendorAbove":1000,"patientsCustomer":"Patients","vagueAccounts":["Uncategorized","Other Expenses","Miscellaneous Expenses","Suspense","Ask My Accountant"]}',
   'Books audit: checked from (bookkeeping) and qualityFrom (expense narration, vendor, receipt), days before work is due, bank lines at most this many days behind, ₹ a Patients invoice may differ from Yarago, receipts and vendor needed above ₹, the Zoho customer of the daily invoice, accounts too vague for an expense')
ON CONFLICT (key) DO NOTHING;

-- Pavin, 28 Oct: he and Dr Sameera read the audit; Basith gets no login
INSERT INTO app.user_permissions (user_id, permission, allowed)
SELECT u.id, 'books.audit', true FROM app.users u
 WHERE u.username = 'sam@sampada' AND u.role <> 'admin'
   AND NOT EXISTS (SELECT 1 FROM app.user_permissions x WHERE x.user_id = u.id AND x.permission = 'books.audit');

INSERT INTO app.schema_migrations(version) VALUES ('0031_books_audit') ON CONFLICT DO NOTHING;
