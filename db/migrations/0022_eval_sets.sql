-- =====================================================================================
-- 0022: evaluation sets for the retina AI (D-043). A set is a list of Remidio photographs, each with the doctor's grade of
-- that eye taken from the fundus report (D-042) and copied into the set, so later corrections of a report cannot change a
-- benchmark. A set is a draft until frozen; once frozen its photographs and reference grades never change and it can
-- never be removed: every model is measured on exactly the same images. Patients keep one code per set (P001 ..) so
-- results can be resampled by patient and exported without names, MRDs or dates.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.eval_sets (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  notes       text NOT NULL DEFAULT '',
  criteria    jsonb NOT NULL,                   -- how the photographs were chosen (dates, blinded only, quality ...)
  created_by  integer NOT NULL REFERENCES app.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  frozen_by   integer REFERENCES app.users(id),
  frozen_at   timestamptz                       -- NULL = draft
);

CREATE TABLE IF NOT EXISTS app.eval_set_items (
  set_id              bigint  NOT NULL REFERENCES app.eval_sets(id),
  photo_id            bigint  NOT NULL REFERENCES app.fundus_photos(id),
  patient_id          bigint  NOT NULL,
  patient_code        text    NOT NULL,         -- P001 .. within this set
  image_code          text    NOT NULL,         -- P001-RE-01 ..
  eye                 text    NOT NULL CHECK (eye IN ('RE','LE')),
  reference_grade     smallint CHECK (reference_grade BETWEEN 0 AND 4),
  reference_ungradable boolean NOT NULL DEFAULT false,
  reference_blinded   boolean NOT NULL,
  reference_report_id bigint REFERENCES app.fundus_reports(id),
  reference_by        integer REFERENCES app.users(id),
  PRIMARY KEY (set_id, photo_id),
  UNIQUE (set_id, image_code),
  CHECK ((reference_grade IS NOT NULL) <> reference_ungradable)
);
CREATE INDEX IF NOT EXISTS eval_set_items_patient_idx ON app.eval_set_items (patient_id);

-- Frozen means frozen: no change to a frozen set's items, no removal of a frozen set, no unfreezing.
CREATE OR REPLACE FUNCTION app.eval_frozen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE frozen timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'eval_sets' THEN
    IF OLD.frozen_at IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
        OR NEW.name IS DISTINCT FROM OLD.name OR NEW.criteria IS DISTINCT FROM OLD.criteria) THEN
      RAISE EXCEPTION 'A frozen evaluation set cannot be changed or removed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN coalesce(NEW, OLD);
  END IF;
  SELECT s.frozen_at INTO frozen FROM app.eval_sets s WHERE s.id = coalesce(NEW.set_id, OLD.set_id);
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION 'The photographs of a frozen evaluation set cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS eval_frozen_guard ON app.eval_sets;
CREATE TRIGGER eval_frozen_guard BEFORE UPDATE OR DELETE ON app.eval_sets FOR EACH ROW EXECUTE FUNCTION app.eval_frozen_guard();
DROP TRIGGER IF EXISTS eval_frozen_guard ON app.eval_set_items;
CREATE TRIGGER eval_frozen_guard BEFORE INSERT OR UPDATE OR DELETE ON app.eval_set_items FOR EACH ROW EXECUTE FUNCTION app.eval_frozen_guard();

-- the set is audited; its items are many and their content is fixed by the set's criteria (no per-row audit)
DROP TRIGGER IF EXISTS audit ON app.eval_sets;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.eval_sets FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('eval_sets','name','Name',false), ('eval_sets','frozen_at','Frozen',false), ('eval_sets','notes','Notes',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0022_eval_sets') ON CONFLICT DO NOTHING;
