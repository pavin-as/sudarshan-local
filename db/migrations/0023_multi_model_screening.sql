-- =====================================================================================
-- 0023: silent multi-model grading and screening outcomes (D-046). Every Remidio photograph is graded by each research
-- model switched on in retina.graders (Arko007; RFM with its APTOS head; RFM with its Messidor-2 head): one AI grading per
-- photograph per model. Each grading gets a screening outcome (refer / uncertain / routine) from that model's cut-offs in
-- retina.screening_cutoffs; ungradable photographs are always "uncertain". Outcomes are shown only on the Retina AI page
-- (research, silent): never on the fundus report screens, never to patients, never used to clear anyone (D-045).
-- Evaluation sets get a role: cut-offs may be chosen on a frozen VALIDATION set and are then applied unchanged to a frozen
-- TEST set; a patient is never in both a validation and a test set.
-- =====================================================================================
DROP INDEX IF EXISTS app.dr_gradings_photo_idx;
CREATE UNIQUE INDEX IF NOT EXISTS dr_gradings_photo_model_idx ON app.dr_gradings (photo_id, model_sha256)
  WHERE photo_id IS NOT NULL AND model_sha256 IS NOT NULL;

ALTER TABLE app.eval_sets ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'other';
ALTER TABLE app.eval_sets DROP CONSTRAINT IF EXISTS eval_sets_purpose_check;
ALTER TABLE app.eval_sets ADD CONSTRAINT eval_sets_purpose_check CHECK (purpose IN ('validation', 'test', 'other'));

CREATE OR REPLACE FUNCTION app.eval_frozen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE frozen timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'eval_sets' THEN
    IF OLD.frozen_at IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
        OR NEW.name IS DISTINCT FROM OLD.name OR NEW.criteria IS DISTINCT FROM OLD.criteria
        OR NEW.purpose IS DISTINCT FROM OLD.purpose) THEN
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

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES ('eval_sets','purpose','Role',false)
ON CONFLICT (entity_type, field) DO UPDATE SET label = EXCLUDED.label, hidden = EXCLUDED.hidden;

-- Which research graders grade every Remidio photograph (grader:head). Changed on Retina AI > System by an admin.
INSERT INTO app.settings (key, value, description) VALUES
  ('retina.graders', '["arko", "rfm:aptos", "rfm:messidor"]'::jsonb,
   'Research graders that grade every Remidio photograph (arko; rfm:<head>)'),
-- Starting cut-offs on the referral score p2+p3+p4, keyed by model SHA-256: refer = highest cut-off keeping >= 95% of
-- referable eyes, clear = >= 99%, both chosen on APTOS validation split v (514 images, 208 referable), 25 Oct 2026
-- (AI_EVALUATION.md section 5). Starting points only: to be re-chosen on a frozen Sampada validation set.
  ('retina.screening_cutoffs', jsonb_build_object(
     'f1a558fc09dbc07452bdd3570f4aa6af84f2bc2550c794cb88ff419c1efaaefb',
       jsonb_build_object('name', 'RFM (APTOS head)', 'refer', 0.2559265090239933, 'clear', 0.03850729079567827, 'source', 'APTOS validation v, 25 Oct 2026'),
     'b23dcc9b2ecde8b562f61e1a046345a799327e0aa0ace36188ca8315ab0efde3',
       jsonb_build_object('name', 'RFM (Messidor-2 head)', 'refer', 0.8116875886917114, 'clear', 0.15679254857241176, 'source', 'APTOS validation v, 25 Oct 2026'),
     'cd4b10c3e5bb1043ac01098284a1136bb423a0eafe7a2445587e969d370f3ffc',
       jsonb_build_object('name', 'Arko007 (unreliable)', 'refer', 0.000007, 'clear', 0, 'source', 'APTOS validation v, 25 Oct 2026: cannot screen (clears nothing)')),
   'Screening cut-offs per model (referral score p2+p3+p4): refer / clear, with their source')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.schema_migrations(version) VALUES ('0023_multi_model_screening') ON CONFLICT DO NOTHING;
