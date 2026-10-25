-- =====================================================================================
-- 0019: remove the test gradings copied from the old grader (D-040). The 4 records in the grader's records.db were random
-- fundus photographs used to try it in September, with made-up MRDs: not Sampada patients' photographs (Pavin, 25 Oct).
-- Real gradings start with photographs from Remidio (MRD = SPD number). The removal is written to the activity log.
-- The old-store copy is gone, so its column and its source value go too. Safe to run again: nothing to remove the second time.
-- =====================================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'app' AND table_name = 'dr_gradings' AND column_name = 'legacy_record_id') THEN
    PERFORM set_config('app.audit_summary',
      'Removed a test grading copied from the old grader (random test photograph, not a patient; Pavin, 25 Oct)', true);
    ALTER TABLE app.dr_gradings DISABLE TRIGGER dr_gradings_guard;
    DELETE FROM app.dr_grading_views WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE source = 'legacy_import');
    DELETE FROM app.dr_doctor_grades WHERE grading_id IN (SELECT id FROM app.dr_gradings WHERE source = 'legacy_import');
    DELETE FROM app.dr_gradings WHERE source = 'legacy_import';
    ALTER TABLE app.dr_gradings ENABLE TRIGGER dr_gradings_guard;
    ALTER TABLE app.dr_gradings DROP COLUMN legacy_record_id;
  END IF;
END $$;

ALTER TABLE app.dr_gradings DROP CONSTRAINT IF EXISTS dr_gradings_source_check;
ALTER TABLE app.dr_gradings ADD CONSTRAINT dr_gradings_source_check CHECK (source IN ('upload', 'batch'));

INSERT INTO app.schema_migrations(version) VALUES ('0019_retina_remove_test_records') ON CONFLICT DO NOTHING;
