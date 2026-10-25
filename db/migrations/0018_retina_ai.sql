-- =====================================================================================
-- 0018: retina AI, research use (D-040). The diabetic retinopathy grader (D:\classification\sampada-retinal-ai, a Docker
-- container on shichika, 127.0.0.1:7860) grades a fundus photograph; Sudarshan keeps the result here. Admin and doctors
-- only (permission retina_ai.use). Not a medical device: results never reach clinical records, summaries or follow-ups.
--   dr_gradings        one row per photograph graded, kept for good: no delete, only remarks may change (trigger)
--   dr_doctor_grades   a doctor's own grade of the same photograph, one per doctor, to measure agreement
--   dr_grading_views   who was shown which AI result (a log, like ai_summary_views: no audit trigger); it tells whether
--                      a doctor's grade was given before seeing the AI grade ("blinded")
-- The photograph itself is never stored, only its SHA-256 and size.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.dr_gradings (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       integer REFERENCES app.users(id),
  patient_id       bigint,                    -- Yarago patient (clinical.patient); NULL only for old records without a match
  mrd              text,                      -- MRD at the time of grading
  eye              text CHECK (eye IN ('RE','LE')),          -- NULL = not recorded (old records)
  source           text NOT NULL CHECK (source IN ('upload','batch','legacy_import')),
  batch_id         text,
  status           text NOT NULL CHECK (status IN ('ok','rejected','error')),
  error            text,                      -- why the photograph was not graded (plain words)
  ai_grade         smallint CHECK (ai_grade BETWEEN 0 AND 4),
  probs            double precision[],        -- five class probabilities, grade 0..4
  raw_outputs      double precision[],        -- the model's raw outputs
  calibration      text,                      -- native_probabilities / softmax_applied
  image_filename   text,
  image_sha256     text,
  image_width      integer,
  image_height     integer,
  preprocess_ms    numeric,
  inference_ms     numeric,
  model_repo       text,
  model_commit     text,
  model_sha256     text,
  grader_version   text,
  legacy_record_id integer UNIQUE,            -- id in the grader's old records.db (imported once)
  remarks          text NOT NULL DEFAULT '',
  CHECK (status <> 'ok' OR (ai_grade IS NOT NULL AND array_length(probs, 1) = 5))
);
CREATE INDEX IF NOT EXISTS dr_gradings_patient_idx ON app.dr_gradings (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dr_gradings_at_idx ON app.dr_gradings (created_at DESC);

-- Kept for good, as the grader's own store was: no delete, and nothing but remarks may change.
CREATE OR REPLACE FUNCTION app.dr_gradings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI gradings are kept for good and cannot be removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'remarks') IS DISTINCT FROM (to_jsonb(OLD) - 'remarks') THEN
    RAISE EXCEPTION 'Only the remarks of an AI grading can be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dr_gradings_guard ON app.dr_gradings;
CREATE TRIGGER dr_gradings_guard BEFORE UPDATE OR DELETE ON app.dr_gradings FOR EACH ROW EXECUTE FUNCTION app.dr_gradings_guard();

CREATE TABLE IF NOT EXISTS app.dr_doctor_grades (
  id          bigserial PRIMARY KEY,
  grading_id  bigint  NOT NULL REFERENCES app.dr_gradings(id),
  patient_id  bigint,                         -- copied from the grading, so the activity log finds the patient
  graded_by   integer NOT NULL REFERENCES app.users(id),
  grade       smallint CHECK (grade BETWEEN 0 AND 4),
  ungradable  boolean NOT NULL DEFAULT false, -- the photograph cannot be graded (blur, media opacity, ...)
  note        text NOT NULL DEFAULT '',
  blinded     boolean NOT NULL,               -- true = given before this doctor was shown the AI grade
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grading_id, graded_by),
  CHECK ((grade IS NOT NULL) <> ungradable)
);

CREATE TABLE IF NOT EXISTS app.dr_grading_views (
  grading_id  bigint  NOT NULL REFERENCES app.dr_gradings(id),
  user_id     integer NOT NULL REFERENCES app.users(id),
  viewed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dr_grading_views_idx ON app.dr_grading_views (grading_id, user_id, viewed_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dr_gradings','dr_doctor_grades'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit ON app.%I', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_trigger()', t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS touch ON app.dr_doctor_grades;
CREATE TRIGGER touch BEFORE UPDATE ON app.dr_doctor_grades FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The activity log is read by managers, who do not have retina_ai.use: grades show there only as "set" / "changed",
-- and the log's sentences never name a grade.
INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('dr_gradings','remarks','Remarks',false), ('dr_gradings','ai_grade','AI grade',true),
  ('dr_gradings','probs','AI scores',true), ('dr_gradings','raw_outputs','AI raw outputs',true),
  ('dr_doctor_grades','grade','Doctor''s grade',true), ('dr_doctor_grades','ungradable','Cannot be graded',true),
  ('dr_doctor_grades','note','Note',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0018_retina_ai') ON CONFLICT DO NOTHING;
