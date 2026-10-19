-- =====================================================================================
-- 0015: WhatsApp messages and Razorpay payment links, built in TEST MODE (D-034).
-- app.messages and app.payments exist since 0003 (audited). This adds what sending and polling need:
--   app.broadcasts       one row per "send to the day's patients" a person started (the Google app's Broadcast sheet)
--   app.messages         + broadcast, payment, mode (test/live), attempts (a send interrupted by a restart is never repeated)
--   app.payments         + reference sent to Razorpay, phone the link went to, expiry, paid amount, review flag, cancel
--   app.payment_refunds  one row per refund asked for (admins only); status by polling, like the links (D-017)
-- Modes (settings messaging.mode / payments.mode): off | test | live. Test mode sends only for TEST bookings, WhatsApp
-- only to the test numbers, Razorpay only with rzp_test_ keys. Live is refused while the Google app is the master (D-025).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.broadcasts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template     text NOT NULL,                 -- key of the template in messaging.templates
  campaign     text NOT NULL,                 -- the AiSensy campaign it was sent with
  for_date     date NOT NULL,                 -- the appointment day it was sent for
  mode         text NOT NULL CHECK (mode IN ('test','live')),
  queued       integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,    -- listed in the preview but not sent (no phone, already sent, test mode ...)
  created_by   integer REFERENCES app.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS broadcasts_created_idx ON app.broadcasts (created_at DESC);

ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS broadcast_id bigint REFERENCES app.broadcasts(id);
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS payment_id   bigint REFERENCES app.payments(id);
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS mode         text CHECK (mode IN ('test','live'));
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS attempts     integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_queued_idx ON app.messages (id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS messages_broadcast_idx ON app.messages (broadcast_id);
CREATE INDEX IF NOT EXISTS messages_created_idx ON app.messages (created_at DESC);

ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS reference     text UNIQUE;     -- sent to Razorpay as reference_id (SUD-<id>)
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS phone         text;            -- the number the link is for (confirmed by staff)
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS currency      text NOT NULL DEFAULT 'INR';
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS mode          text CHECK (mode IN ('test','live'));
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS expires_at    timestamptz;
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS paid_amount   numeric(10,2);
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS sent_at       timestamptz;
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS sent_via      text;            -- whatsapp (AiSensy) | whatsapp_pc (wa.me, sent by staff)
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS needs_review  text;            -- e.g. amount paid differs from the amount asked
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS error         text;            -- why the link could not be made
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS cancelled_by  integer REFERENCES app.users(id);
ALTER TABLE app.payments ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE app.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE app.payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('created','sent','paid','expired','cancelled','refunded','partially_refunded','failed'));
CREATE INDEX IF NOT EXISTS payments_appt_idx ON app.payments (appointment_id);
CREATE INDEX IF NOT EXISTS payments_open_idx ON app.payments (id) WHERE status IN ('created','sent');

CREATE TABLE IF NOT EXISTS app.payment_refunds (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id          bigint NOT NULL REFERENCES app.payments(id),
  patient_id          integer,
  amount              numeric(10,2) NOT NULL CHECK (amount > 0),
  reason              text NOT NULL,
  note                text,
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending','processed','failed')),
  provider_refund_id  text UNIQUE,
  idempotency_key     text NOT NULL UNIQUE,      -- sent to Razorpay so a retried request never refunds twice
  error               text,
  requested_by        integer REFERENCES app.users(id),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_refunds_payment_idx ON app.payment_refunds (payment_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['broadcasts','payment_refunds'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit ON app.%I', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_trigger()', t);
  END LOOP;
  DROP TRIGGER IF EXISTS touch ON app.payment_refunds;
  CREATE TRIGGER touch BEFORE UPDATE ON app.payment_refunds FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
END $$;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('messages', 'channel', 'Channel', false), ('messages', 'template', 'Template', false), ('messages', 'recipient', 'To', false),
  ('messages', 'status', 'Status', false), ('messages', 'error', 'Problem', false), ('messages', 'mode', 'Mode', false),
  ('messages', 'provider_ref', 'AiSensy reference', false), ('messages', 'sent_at', 'Sent', false),
  ('broadcasts', 'template', 'Template', false), ('broadcasts', 'for_date', 'For the day', false),
  ('broadcasts', 'mode', 'Mode', false), ('broadcasts', 'queued', 'Messages', false), ('broadcasts', 'skipped', 'Not sent', false),
  ('broadcasts', 'finished_at', 'Finished', false),
  ('payments', 'amount', 'Amount', false), ('payments', 'purpose', 'For', false), ('payments', 'status', 'Status', false),
  ('payments', 'phone', 'Phone', false), ('payments', 'mode', 'Mode', false), ('payments', 'link_url', 'Link', false),
  ('payments', 'expires_at', 'Link valid until', false), ('payments', 'paid_amount', 'Paid', false),
  ('payments', 'paid_at', 'Paid at', false), ('payments', 'provider_payment_id', 'Razorpay payment', false),
  ('payments', 'refunded_amount', 'Refunded', false), ('payments', 'needs_review', 'To check', false),
  ('payments', 'error', 'Problem', false), ('payments', 'sent_via', 'Sent by', false), ('payments', 'sent_at', 'Sent', false),
  ('payments', 'cancel_reason', 'Cancel reason', false), ('payments', 'cancelled_at', 'Cancelled', false),
  ('payment_refunds', 'amount', 'Amount', false), ('payment_refunds', 'reason', 'Reason', false),
  ('payment_refunds', 'note', 'Note', false), ('payment_refunds', 'status', 'Status', false),
  ('payment_refunds', 'error', 'Problem', false), ('payment_refunds', 'processed_at', 'Refunded at', false)
ON CONFLICT (entity_type, field) DO NOTHING;

-- Settings (no secrets: the AiSensy and Razorpay keys are in .env). Test mode from the start; live only after cut-over.
INSERT INTO app.settings (key, value, description) VALUES
  ('messaging.mode', '"test"'::jsonb, 'WhatsApp: off | test (TEST bookings, test numbers only) | live (after cut-over)'),
  ('messaging.test_numbers', '[]'::jsonb, 'WhatsApp test mode: the only numbers messages may go to (staff phones)'),
  ('messaging.templates', '[
     {"key":"appointment_reminder","label":"Appointment reminder","campaign":"sudarsdhan_appointment","params":["name","date","time"],"kind":"appointment"},
     {"key":"payment_link","label":"Payment link","campaign":"","params":["name","amount","link"],"kind":"payment"}
   ]'::jsonb, 'WhatsApp templates: AiSensy campaign (Meta-approved template) and the values filled into it, in order'),
  ('payments.mode', '"test"'::jsonb, 'Razorpay: off | test (rzp_test_ keys, TEST bookings) | live (after cut-over)'),
  ('payments.default_amount', '500'::jsonb, 'Payment link: amount offered (rupees)'),
  ('payments.min_amount', '100'::jsonb, 'Payment link: smallest amount (rupees)'),
  ('payments.max_amount', '5000'::jsonb, 'Payment link: largest amount (rupees)'),
  ('payments.link_hours', '24'::jsonb, 'Payment link: hours the link stays valid')
ON CONFLICT (key) DO NOTHING;
