-- =====================================================================================
-- 0003: Sudarshan's own data (schema app). Replaces the Google Sheets tabs.
-- Idempotent: safe to run on every migrate.
--   * Every record has a permanent id; status is a column, not "which sheet the row sits on".
--   * Every insert/update/delete on these tables is written to app.audit_log by a trigger,
--     with the user, a plain-language summary and a field-by-field change list.
--   * Yarago data is never copied here: patients/visits are referenced by Yarago ids.
-- =====================================================================================
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- people -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.users (
  id                   serial PRIMARY KEY,
  username             citext NOT NULL UNIQUE,
  full_name            text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin','doctor','manager','staff','optometrist','counsellor')),
  email                citext,
  password_hash        text,                       -- bcrypt; NULL = must set a password before first login
  must_change_password boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  yarago_user_id       integer,
  legacy_username      text,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       integer NOT NULL REFERENCES app.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            inet,
  user_agent    text,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON app.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS app.doctors (
  id                serial PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  short_name        text,
  yarago_doctor_id  integer,
  user_id           integer REFERENCES app.users(id),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- clinic calendar ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.doctor_schedule (          -- regular weekly sessions
  id          serial PRIMARY KEY,
  doctor_id   integer NOT NULL REFERENCES app.doctors(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- 1 = Monday
  start_time  time NOT NULL,
  end_time    time NOT NULL CHECK (end_time > start_time),
  valid_from  date,
  valid_to    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.doctor_exceptions (        -- leave, partial days, extra sessions
  id          serial PRIMARY KEY,
  doctor_id   integer NOT NULL REFERENCES app.doctors(id),
  on_date     date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('leave','partial','extra')),
  start_time  time,
  end_time    time,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doctor_exceptions_date_idx ON app.doctor_exceptions (on_date);

CREATE TABLE IF NOT EXISTS app.holidays (
  on_date     date PRIMARY KEY,
  reason      text NOT NULL,
  remarks     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.day_capacity (             -- replaces planningB maxSlots (+ edit history via audit)
  on_date     date PRIMARY KEY,
  max_slots   integer NOT NULL CHECK (max_slots >= 0),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.plan_of_action (           -- PlanOfActionMaster
  name         text PRIMARY KEY,
  eye          text,
  prep_min     integer,
  consult_min  integer,
  priority     integer,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.settings (                 -- generalSettings, RuleSettings, SystemSettings (no secrets)
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- appointments -------------------------------------------------------------
-- One row per booking for its whole life. Booking several patients in one slot is allowed
-- (families, short procedures); capacity is enforced by the booking service under a per-day lock.
CREATE TABLE IF NOT EXISTS app.appointments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_date   date NOT NULL,
  slot_time          time,
  duration_min       integer NOT NULL DEFAULT 10,
  doctor_id          integer REFERENCES app.doctors(id),
  patient_id         integer,                 -- Yarago aPatient_ID (NULL for a new patient not yet registered)
  mrd                text,
  patient_name       text NOT NULL,
  phone              text,
  age_years          integer,
  gender             text,
  patient_type       text,                    -- New / Old ...
  appointment_type   text,                    -- Consultation / Follow up / Injection ...
  plan_of_action     text,
  urgency            text,
  family_group       text,
  fixed_slot         boolean NOT NULL DEFAULT false,
  consult_start      time,
  tags               text[] NOT NULL DEFAULT '{}',
  remarks            text,
  status             text NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('waitlist','booked','confirmed','checked_in','completed','cancelled','no_show')),
  source             text NOT NULL DEFAULT 'booking'
                     CHECK (source IN ('booking','direct_call','followup','cancel_list','reschedule','import')),
  source_ref         text,                    -- Yarago follow-up id, direct call id ...
  yarago_visit_id    integer,                 -- matched Yarago appointment when the patient arrives
  confirmed_4day_at  timestamptz,
  confirmed_4day_by  integer REFERENCES app.users(id),
  confirmed_1day_at  timestamptz,
  confirmed_1day_by  integer REFERENCES app.users(id),
  cancelled_at       timestamptz,
  cancelled_by       integer REFERENCES app.users(id),
  cancel_reason      text,
  booked_by          integer REFERENCES app.users(id),
  booked_at          timestamptz NOT NULL DEFAULT now(),
  legacy_id          text UNIQUE,             -- yyyyMMdd_HHmmss id from the Google app
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_day_idx ON app.appointments (appointment_date, slot_time);
CREATE INDEX IF NOT EXISTS appointments_patient_idx ON app.appointments (patient_id);
CREATE INDEX IF NOT EXISTS appointments_mrd_idx ON app.appointments (mrd);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON app.appointments (status, appointment_date);

-- The appointment's story: replaces RescheduleHistory, AppointmentJourney, RemarksHistory
CREATE TABLE IF NOT EXISTS app.appointment_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  bigint NOT NULL REFERENCES app.appointments(id),
  at              timestamptz NOT NULL DEFAULT now(),
  actor_id        integer REFERENCES app.users(id),
  actor_name      text,                       -- kept for imported history whose user no longer exists
  event_type      text NOT NULL CHECK (event_type IN ('booked','rescheduled','confirmed_4day','confirmed_1day',
                    'cancelled','restored','checked_in','completed','no_show','remark','tag_added','tag_removed',
                    'moved_from_waitlist','imported')),
  from_value      jsonb,
  to_value        jsonb,
  note            text
);
CREATE INDEX IF NOT EXISTS appointment_events_appt_idx ON app.appointment_events (appointment_id, at);

-- ---------- calls, triage, follow-up work ---------------------------------------------
CREATE TABLE IF NOT EXISTS app.direct_calls (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id      integer,
  mrd             text,
  patient_name    text,
  phone           text,
  age_years       integer,
  gender          text,
  patient_type    text,
  call_type       text,
  case_type       text,
  urgency         text,
  remarks         text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled','archived')),
  appointment_id  bigint REFERENCES app.appointments(id),
  created_by      integer REFERENCES app.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  legacy_id       text UNIQUE
);

CREATE TABLE IF NOT EXISTS app.triage (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id       integer,
  mrd              text,
  patient_name     text,
  phone            text,
  age_years        integer,
  gender           text,
  patient_type     text,
  assessed_at      timestamptz NOT NULL DEFAULT now(),
  answers          jsonb NOT NULL DEFAULT '{}',   -- onset, vision, pain, floaters, redness, injury, symptoms
  max_score        integer,
  category         text,
  decision_status  text,
  decision_remarks text,
  decision_by      integer REFERENCES app.users(id),
  decision_at      timestamptz,
  created_by       integer REFERENCES app.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  legacy_id        text UNIQUE
);

-- Staff actions on Yarago follow-ups (the follow-up itself stays in the Yarago mirror)
CREATE TABLE IF NOT EXISTS app.followup_actions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  yarago_followup_id  integer,
  patient_id          integer,
  action              text NOT NULL CHECK (action IN ('called','no_answer','will_come','booked','declined',
                        'wrong_number','not_needed','moved_away','deceased','note')),
  note                text,
  next_call_on        date,
  appointment_id      bigint REFERENCES app.appointments(id),
  actor_id            integer REFERENCES app.users(id),
  actor_name          text,
  at                  timestamptz NOT NULL DEFAULT now(),
  legacy_ref          text
);
CREATE INDEX IF NOT EXISTS followup_actions_fu_idx ON app.followup_actions (yarago_followup_id, at);
CREATE INDEX IF NOT EXISTS followup_actions_patient_idx ON app.followup_actions (patient_id, at);

-- ---------- messages, payments ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.messages (                  -- WhatsApp / email / SMS sent by Sudarshan
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel         text NOT NULL CHECK (channel IN ('whatsapp','email','sms')),
  template        text,
  recipient       text NOT NULL,
  patient_id      integer,
  appointment_id  bigint REFERENCES app.appointments(id),
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  provider_ref    text,
  error           text,
  created_by      integer REFERENCES app.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  legacy_ref      text
);
CREATE INDEX IF NOT EXISTS messages_appt_idx ON app.messages (appointment_id);

CREATE TABLE IF NOT EXISTS app.payments (                  -- Razorpay payment links (status by polling)
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id       bigint REFERENCES app.appointments(id),
  patient_id           integer,
  amount               numeric(10,2) NOT NULL CHECK (amount > 0),
  purpose              text,
  provider             text NOT NULL DEFAULT 'razorpay',
  link_id              text UNIQUE,
  link_url             text,
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','sent','paid','expired','cancelled','refunded','partially_refunded')),
  provider_payment_id  text,
  paid_at              timestamptz,
  refunded_amount      numeric(10,2) NOT NULL DEFAULT 0,
  created_by           integer REFERENCES app.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------- reports, AI ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.kpi_daily (
  on_date      date PRIMARY KEY,
  metrics      jsonb NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.ai_summaries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id      integer NOT NULL,
  for_date        date NOT NULL,
  kind            text NOT NULL DEFAULT 'doctor_summary',
  facts           jsonb NOT NULL,              -- the exact data shown, each item with its Yarago source
  overview        text,                        -- the only AI-written part
  model           text,
  prompt_version  text,
  status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready','failed','superseded')),
  error           text,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, for_date, kind, generated_at)
);
CREATE INDEX IF NOT EXISTS ai_summaries_lookup_idx ON app.ai_summaries (patient_id, for_date DESC);

CREATE TABLE IF NOT EXISTS app.ai_summary_views (           -- who looked at which summary
  summary_id  bigint NOT NULL REFERENCES app.ai_summaries(id),
  user_id     integer NOT NULL REFERENCES app.users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (summary_id, user_id, at)
);

CREATE TABLE IF NOT EXISTS app.import_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',
  counts       jsonb,
  message      text
);

CREATE TABLE IF NOT EXISTS app.code_labels (
  kind       text NOT NULL,
  code       integer NOT NULL,
  label      text NOT NULL,
  confirmed  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (kind, code)
);

-- =====================================================================================
-- AUDIT LOG
-- Written by trigger, so no code path can forget it. The app sets, per transaction:
--   SET LOCAL app.user_id = '<users.id>';  SET LOCAL app.audit_summary = 'Booked ... for 21 Oct 10:20';
--   SET LOCAL app.source = 'web' | 'import' | 'job';   SET LOCAL app.request_id = '<uuid>'
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     integer,
  action       text NOT NULL,            -- e.g. appointments.insert / appointments.update / users.update
  entity_type  text NOT NULL,
  entity_id    text,
  patient_id   integer,
  summary      text,                     -- plain-language sentence set by the app
  changes      jsonb,                    -- {"field": {"from": .., "to": ..}}
  source       text NOT NULL DEFAULT 'app',
  request_id   text
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON app.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON app.audit_log (entity_type, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_patient_idx ON app.audit_log (patient_id, at DESC) WHERE patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON app.audit_log (actor_id, at DESC);

-- Friendly names for fields and actions, used by the readable feed
CREATE TABLE IF NOT EXISTS app.field_labels (
  entity_type  text NOT NULL,
  field        text NOT NULL,
  label        text NOT NULL,
  hidden       boolean NOT NULL DEFAULT false,     -- e.g. password_hash: logged as "changed", value never shown
  PRIMARY KEY (entity_type, field)
);
INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('appointments','appointment_date','Date',false), ('appointments','slot_time','Time',false),
  ('appointments','doctor_id','Doctor',false), ('appointments','status','Status',false),
  ('appointments','plan_of_action','Plan of action',false), ('appointments','remarks','Remarks',false),
  ('appointments','tags','Tags',false), ('appointments','urgency','Urgency',false),
  ('appointments','appointment_type','Visit type',false), ('appointments','patient_name','Patient name',false),
  ('appointments','phone','Phone',false), ('appointments','cancel_reason','Cancel reason',false),
  ('appointments','fixed_slot','Fixed slot',false), ('appointments','family_group','Family group',false),
  ('day_capacity','max_slots','Maximum slots',false),
  ('users','password_hash','Password',true), ('users','role','Role',false), ('users','is_active','Active',false),
  ('users','full_name','Name',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

CREATE OR REPLACE FUNCTION app.audit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_j jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  diff  jsonb := '{}'::jsonb;
  k     text;
  rec   jsonb := coalesce(new_j, old_j);
BEGIN
  -- bulk imports log one summary row in app.import_runs instead of one row per record
  IF current_setting('app.skip_audit', true) = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(new_j) LOOP
      IF k NOT IN ('updated_at','last_seen_at') AND (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k));
      END IF;
    END LOOP;
    IF diff = '{}'::jsonb THEN RETURN NEW; END IF;          -- nothing meaningful changed
  ELSIF TG_OP = 'INSERT' THEN
    diff := jsonb_strip_nulls(new_j) - 'created_at' - 'updated_at';
  ELSE
    diff := jsonb_strip_nulls(old_j);
  END IF;
  -- never store secrets in the log
  IF diff ? 'password_hash' THEN diff := jsonb_set(diff, '{password_hash}', '"(changed)"'); END IF;

  INSERT INTO app.audit_log (actor_id, action, entity_type, entity_id, patient_id, summary, changes, source, request_id)
  VALUES (nullif(current_setting('app.user_id', true), '')::int,
          TG_TABLE_NAME || '.' || lower(TG_OP),
          TG_TABLE_NAME,
          rec ->> 'id',
          CASE WHEN (rec ->> 'patient_id') ~ '^\d+$' THEN (rec ->> 'patient_id')::int END,
          nullif(current_setting('app.audit_summary', true), ''),
          diff,
          coalesce(nullif(current_setting('app.source', true), ''), 'app'),
          nullif(current_setting('app.request_id', true), ''));
  RETURN coalesce(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','doctors','doctor_schedule','doctor_exceptions','holidays','day_capacity',
                           'plan_of_action','settings','appointments','appointment_events','direct_calls','triage',
                           'followup_actions','messages','payments','code_labels'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit ON app.%I', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_trigger()', t);
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name=t AND column_name='updated_at') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS touch ON app.%I', t);
      EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    END IF;
  END LOOP;
END $$;

INSERT INTO app.schema_migrations(version) VALUES ('0003_app_core') ON CONFLICT DO NOTHING;
