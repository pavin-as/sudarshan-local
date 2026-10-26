-- =====================================================================================
-- 0020: fundus photographs from Remidio (D-041). Sudarshan reads Remidio's Cloud Data Queue for site TIRUR, keeps each FOP
-- photograph on shichika (folder RETINA_PHOTO_DIR, administrators only, in the nightly backup) and grades it with the
-- research DR model (D-040). Photographs are clinical records: kept for good.
--   fundus_photos      one row per Remidio photograph; no delete; nothing changes except linking to a patient once
--                      (patient_id from empty), for numbers not in Yarago when it arrived
--   remidio_queue_log  what the receiver did with each queue item (a log: no audit trigger); items that are not photos
--                      (doctor reports, videos ...) are kept here whole, minus links, until Sudarshan reads them
--   dr_gradings.photo_id  the photograph an AI grading was made from (source 'remidio')
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.fundus_photos (
  id                 bigserial PRIMARY KEY,
  received_at        timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL DEFAULT 'remidio' CHECK (source IN ('remidio')),
  remidio_image_id   bigint UNIQUE,
  remidio_exam_id    bigint,
  remidio_patient_id bigint,
  mrn                text,                -- as typed on the FOP ("SPD12765"; also other series such as "WSD..")
  patient_id         bigint,              -- Yarago patient with that SPD number; NULL = not found when received
  sex_check          text CHECK (sex_check IN ('same','different')),   -- Remidio's sex against Yarago's (birth dates on the FOP are 1 January)
  eye                text CHECK (eye IN ('RE','LE')),
  field              text,                -- MACULA / DISC / OTHER
  quality            text,                -- Remidio's check: SUFFICIENT / INSUFFICIENT
  quality_score      numeric,
  captured_at        timestamptz,
  width              integer,
  height             integer,
  bytes              integer NOT NULL,
  sha256             text NOT NULL,
  file_path          text NOT NULL,       -- relative to RETINA_PHOTO_DIR
  thumb_path         text,                -- Remidio's thumbnail, same folder
  meta               jsonb                -- the queue item without its links
);
CREATE INDEX IF NOT EXISTS fundus_photos_patient_idx ON app.fundus_photos (patient_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS fundus_photos_at_idx ON app.fundus_photos (captured_at DESC);

CREATE OR REPLACE FUNCTION app.fundus_photos_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fundus photographs are clinical records and cannot be removed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.patient_id IS NULL AND NEW.patient_id IS NOT NULL
     AND (to_jsonb(NEW) - 'patient_id' - 'sex_check') = (to_jsonb(OLD) - 'patient_id' - 'sex_check') THEN
    RETURN NEW;                                     -- linking a photograph that arrived without a known patient, once
  END IF;
  RAISE EXCEPTION 'A fundus photograph cannot be changed' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS fundus_photos_guard ON app.fundus_photos;
CREATE TRIGGER fundus_photos_guard BEFORE UPDATE OR DELETE ON app.fundus_photos FOR EACH ROW EXECUTE FUNCTION app.fundus_photos_guard();
DROP TRIGGER IF EXISTS audit ON app.fundus_photos;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.fundus_photos FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

CREATE TABLE IF NOT EXISTS app.remidio_queue_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  item_type   text,                         -- IMAGE, or whatever else Remidio sends
  remidio_id  bigint,                       -- image id (or the item's own id)
  outcome     text NOT NULL CHECK (outcome IN ('stored','duplicate','kept','peeked','error','gave_up','skipped')),
  photo_id    bigint REFERENCES app.fundus_photos(id),
  message     text,
  payload     jsonb                         -- for items that are not photographs, peeks and give-ups: the item without links
);
CREATE INDEX IF NOT EXISTS remidio_queue_log_at_idx ON app.remidio_queue_log (at DESC);

ALTER TABLE app.dr_gradings ADD COLUMN IF NOT EXISTS photo_id bigint REFERENCES app.fundus_photos(id);
-- one grading per photograph, until 0023 (D-046) replaces this with one per photograph and model: once that has run,
-- never make this index again (every update re-runs all migrations, and photographs then have several gradings)
DO $$ BEGIN
  IF to_regclass('app.dr_gradings_photo_model_idx') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS dr_gradings_photo_idx ON app.dr_gradings (photo_id) WHERE photo_id IS NOT NULL;
  END IF;
END $$;
ALTER TABLE app.dr_gradings DROP CONSTRAINT IF EXISTS dr_gradings_source_check;
ALTER TABLE app.dr_gradings ADD CONSTRAINT dr_gradings_source_check CHECK (source IN ('upload', 'batch', 'remidio'));

INSERT INTO app.settings (key, value, description) VALUES
  ('retina.remidio_mode', '"off"'::jsonb, 'Remidio photo receiver: off / peek (look at the next queue item, take nothing) / on'),
  ('retina.remidio_unmatched', '"keep"'::jsonb, 'Photographs whose MRN is not a Yarago SPD number: keep (unlinked) / skip')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('fundus_photos','mrn','MRN on the FOP',false), ('fundus_photos','eye','Eye',false), ('fundus_photos','patient_id','Patient',false),
  ('fundus_photos','quality','Quality',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0020_remidio_photos') ON CONFLICT DO NOTHING;
