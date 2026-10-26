-- =====================================================================================
-- 0025: OCT and OCTA scans from the Topcon Maestro2 in Sudarshan (D-049, docs/OCT_PLAN.md Step 4), and the safeguards for
-- importing IMAGEnet's past exams.
--   oct_studies        one row per exam's tomography (the OPT object): the exported DICOM (OPT, layer surfaces, OCTA
--                      flow and en face slabs, photographs) and the viewer's files (B-scan JPEGs, scan lines, layers,
--                      slabs) in OCT_DIR; linked to the exam's colour photograph and the Yarago patient. Kept for good,
--                      like the photographs: no delete, nothing changes except linking a patient once.
--   topcon_import_log  version: which import did the exam (1 = photograph only, 26 Oct; 2 = photograph and OCT). An
--                      exam done by an older version is done again: its photograph is recognised, its OCT is added.
--   settings           retina.topcon_report_from: Maestro2 photo sessions before this day are not on the doctors'
--                      "To report" list (IMAGEnet's past exams); retina.topcon_backfill_window: exams saved before today
--                      are converted, and their photographs graded, only in this window (outside clinic hours)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.oct_studies (
  id            bigserial PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL DEFAULT 'topcon' CHECK (source IN ('topcon')),
  photo_id      bigint REFERENCES app.fundus_photos(id),  -- the exam's colour photograph (scan lines are drawn on it)
  mrn           text,                 -- DICOM patient ID as exported (the SPD number)
  patient_id    bigint,               -- Yarago patient; NULL = not found when received
  eye           text CHECK (eye IN ('RE','LE')),
  captured_at   timestamptz,
  device        text,
  protocol      text,                 -- e.g. 3D H/Macula/320/320/6x6mm/Angio
  kind          text NOT NULL CHECK (kind IN ('oct','octa')),
  frames        integer NOT NULL,     -- B-scans
  rows          integer NOT NULL,     -- pixels deep
  cols          integer NOT NULL,     -- pixels across
  spacing       jsonb,                -- axialMm, lateralMm, betweenMm
  layers        text[],               -- Topcon's layer surfaces, e.g. ILM ... BM (US tier)
  slabs         text[],               -- OCTA en face slabs, e.g. Superficial, Deep, Choriocapillaris, Outer Retina
  dicom_study_uid text,
  opt_sop_uid   text NOT NULL UNIQUE, -- a re-saved exam is a duplicate
  topcon_file   text,                 -- IMAGEnet's exam file
  dir_path      text NOT NULL,        -- relative to OCT_DIR: dicom\ and view\ below it
  bytes         bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS oct_studies_patient_idx ON app.oct_studies (patient_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS oct_studies_photo_idx ON app.oct_studies (photo_id);

CREATE OR REPLACE FUNCTION app.oct_studies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OCT scans are clinical records and cannot be removed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.patient_id IS NULL AND NEW.patient_id IS NOT NULL
     AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;                                     -- linking a scan that arrived without a known patient, once
  END IF;
  RAISE EXCEPTION 'An OCT scan cannot be changed' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS oct_studies_guard ON app.oct_studies;
CREATE TRIGGER oct_studies_guard BEFORE UPDATE OR DELETE ON app.oct_studies FOR EACH ROW EXECUTE FUNCTION app.oct_studies_guard();
DROP TRIGGER IF EXISTS audit ON app.oct_studies;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.oct_studies FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

ALTER TABLE app.topcon_import_log ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

INSERT INTO app.settings (key, value, description) VALUES
  ('retina.topcon_report_from', '"2026-10-26"'::jsonb, 'Maestro2 photo sessions before this day are not on the doctors'' To report list (past IMAGEnet exams)'),
  ('retina.topcon_backfill_window', '{"from": "20:00", "to": "07:00", "sundays": true}'::jsonb,
   'Maestro2 exams saved before today are converted and graded only in this window (clinic time); Sundays all day')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('oct_studies','patient_id','Patient',false), ('oct_studies','eye','Eye',false), ('oct_studies','protocol','Scan protocol',false),
  ('oct_studies','kind','OCT or OCTA',false), ('oct_studies','topcon_file','IMAGEnet exam file',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0025_oct_studies') ON CONFLICT DO NOTHING;
