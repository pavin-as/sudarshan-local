-- =====================================================================================
-- 0024: colour fundus photographs from the Topcon Maestro2 (D-048, docs/OCT_PLAN.md Step 3). Sudarshan reads new IMAGEnet
-- exams (.fda + .fds) from the ImageNet PC's read-only share, converts each copy with Topcon's DICOM OCT Export Tool on
-- shichika, and keeps the exam's colour fundus photograph (the DICOM OP object) next to the Remidio photographs: linked to
-- the Yarago patient by the SPD number in the DICOM patient ID, reported by doctors, graded silently by the research
-- models. Maestro2 photographs are measured separately from Remidio (own evaluation sets: D-044, D-045).
--   fundus_photos      source 'topcon'; DICOM study / instance UIDs (the instance UID makes a second copy a duplicate),
--                      device, scan protocol, IMAGEnet's exam file name (a number, no patient details), the kept OP .dcm
--   topcon_import_log  what the import did with each exam file (a log: no audit trigger); shapes only, never names or IDs
-- A day's Maestro2 photographs of one patient form one fundus report session (remidio_exam_id empty = session 0).
-- =====================================================================================
ALTER TABLE app.fundus_photos DROP CONSTRAINT IF EXISTS fundus_photos_source_check;
ALTER TABLE app.fundus_photos ADD CONSTRAINT fundus_photos_source_check CHECK (source IN ('remidio', 'topcon'));
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS dicom_study_uid text;
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS dicom_sop_uid text;
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS device text;           -- 'Maestro2' (DICOM manufacturer model name)
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS protocol text;         -- e.g. 3D H/Macula/320/320/6x6mm/Angio
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS topcon_file text;      -- IMAGEnet's exam file, e.g. 12345.fda
ALTER TABLE app.fundus_photos ADD COLUMN IF NOT EXISTS dicom_path text;       -- the OP .dcm as exported, relative to RETINA_PHOTO_DIR
CREATE UNIQUE INDEX IF NOT EXISTS fundus_photos_sop_idx ON app.fundus_photos (dicom_sop_uid) WHERE dicom_sop_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS fundus_photos_source_idx ON app.fundus_photos (source, captured_at DESC);

CREATE TABLE IF NOT EXISTS app.topcon_import_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  file_name   text NOT NULL,                -- IMAGEnet's exam file (a number)
  file_bytes  bigint,
  file_mtime  timestamptz,                  -- with file_name: which version of the file this row is about
  outcome     text NOT NULL CHECK (outcome IN ('stored','duplicate','skipped','no_photo','peeked','error','gave_up')),
  photo_id    bigint REFERENCES app.fundus_photos(id),
  message     text,
  meta        jsonb                         -- shapes only: protocol, eye, patient-ID format, photograph size
);
CREATE INDEX IF NOT EXISTS topcon_import_log_file_idx ON app.topcon_import_log (file_name, file_mtime);
CREATE INDEX IF NOT EXISTS topcon_import_log_at_idx ON app.topcon_import_log (at DESC);

ALTER TABLE app.dr_gradings DROP CONSTRAINT IF EXISTS dr_gradings_source_check;
ALTER TABLE app.dr_gradings ADD CONSTRAINT dr_gradings_source_check CHECK (source IN ('upload', 'batch', 'remidio', 'topcon'));

INSERT INTO app.settings (key, value, description) VALUES
  ('retina.topcon_mode', '"off"'::jsonb, 'Topcon Maestro2 photo import: off / peek (convert the next waiting exam, keep nothing) / on'),
  ('retina.topcon_unmatched', '"keep"'::jsonb, 'Maestro2 photographs whose patient ID is not a Yarago SPD number: keep (unlinked) / skip'),
  ('retina.topcon_since', 'null'::jsonb, 'Maestro2 exams saved from this time on are imported (set when the import is first switched on)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('fundus_photos','source','Camera',false), ('fundus_photos','device','Device',false), ('fundus_photos','protocol','Scan protocol',false),
  ('fundus_photos','topcon_file','IMAGEnet exam file',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0024_topcon_photos') ON CONFLICT DO NOTHING;
