-- =====================================================================================
-- 0021: the doctor's fundus report, written in Sudarshan (D-042). From 25 Oct 2026 doctors report and grade Remidio
-- photographs here, not in Remidio Connect. One report per photo session (a Remidio exam: one patient, one day), per eye:
-- DR grade, macular oedema, other findings; then referral and comments. Signed by the doctor who writes it; never
-- removed; a correction needs a reason (the activity log keeps every version). Read by clinical roles, written by doctors.
-- The research AI grade is never shown on the report; the report's DR grade per eye is that doctor's blinded grade of the
-- session's photographs for the Retina AI agreement figures (written to app.dr_doctor_grades by the server).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.fundus_reports (
  id               bigserial PRIMARY KEY,
  patient_id       bigint  NOT NULL,                 -- Yarago patient
  exam_date        date    NOT NULL,                 -- day the photographs were taken (clinic time)
  remidio_exam_id  bigint,                           -- the Remidio exam the photographs came from
  photo_ids        bigint[] NOT NULL,                -- the photographs the doctor reported on
  re_dr            text CHECK (re_dr IN ('none','mild','moderate','severe','pdr','ungradable')),
  le_dr            text CHECK (le_dr IN ('none','mild','moderate','severe','pdr','ungradable')),
  re_dme           text CHECK (re_dme IN ('none','non_centre','centre','ungradable')),
  le_dme           text CHECK (le_dme IN ('none','non_centre','centre','ungradable')),
  re_findings      text[] NOT NULL DEFAULT '{}',     -- glaucoma_suspect, drusen_amd, hypertensive, vein_occlusion, other
  le_findings      text[] NOT NULL DEFAULT '{}',
  re_other         text NOT NULL DEFAULT '',
  le_other         text NOT NULL DEFAULT '',
  referral         text NOT NULL CHECK (referral IN ('none','routine','urgent')),
  comments         text NOT NULL DEFAULT '',
  reported_by      integer NOT NULL REFERENCES app.users(id),
  reported_at      timestamptz NOT NULL DEFAULT now(),
  amended_by       integer REFERENCES app.users(id),
  amended_at       timestamptz,
  amendment_reason text,
  CHECK (re_dr IS NOT NULL OR le_dr IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS fundus_reports_session_idx ON app.fundus_reports (patient_id, exam_date, coalesce(remidio_exam_id, 0));
CREATE INDEX IF NOT EXISTS fundus_reports_at_idx ON app.fundus_reports (reported_at DESC);

-- No delete. A change is a correction: it must carry a new reason, and the session and the signing doctor stay as written.
CREATE OR REPLACE FUNCTION app.fundus_reports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A fundus report is a clinical record and cannot be removed; correct it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.exam_date IS DISTINCT FROM OLD.exam_date
     OR NEW.remidio_exam_id IS DISTINCT FROM OLD.remidio_exam_id OR NEW.reported_by IS DISTINCT FROM OLD.reported_by
     OR NEW.reported_at IS DISTINCT FROM OLD.reported_at THEN
    RAISE EXCEPTION 'The patient, session and signing doctor of a fundus report cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(trim(NEW.amendment_reason), '') = '' OR NEW.amended_by IS NULL
     OR NEW.amended_at IS NOT DISTINCT FROM OLD.amended_at THEN
    RAISE EXCEPTION 'A correction to a fundus report needs a reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fundus_reports_guard ON app.fundus_reports;
CREATE TRIGGER fundus_reports_guard BEFORE UPDATE OR DELETE ON app.fundus_reports FOR EACH ROW EXECUTE FUNCTION app.fundus_reports_guard();
DROP TRIGGER IF EXISTS audit ON app.fundus_reports;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.fundus_reports FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('fundus_reports','re_dr','Right eye DR',false), ('fundus_reports','le_dr','Left eye DR',false),
  ('fundus_reports','re_dme','Right eye macular oedema',false), ('fundus_reports','le_dme','Left eye macular oedema',false),
  ('fundus_reports','re_findings','Right eye findings',false), ('fundus_reports','le_findings','Left eye findings',false),
  ('fundus_reports','re_other','Right eye other',false), ('fundus_reports','le_other','Left eye other',false),
  ('fundus_reports','referral','Referral',false), ('fundus_reports','comments','Comments',false),
  ('fundus_reports','amendment_reason','Reason for correction',false), ('fundus_reports','exam_date','Photographs taken',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

INSERT INTO app.schema_migrations(version) VALUES ('0021_fundus_reports') ON CONFLICT DO NOTHING;
