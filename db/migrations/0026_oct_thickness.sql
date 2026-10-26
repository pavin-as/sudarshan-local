-- =====================================================================================
-- 0026: retinal thickness from Topcon's layer lines (D-050, docs/OCT_PLAN.md Step 7). One row per OCT scan and method
-- version: central subfield thickness (CST) and the nine ETDRS sectors, ILM to BM and ILM to OS/RPE, computed by Sudarshan
-- (services/octThickness.ts) for 3D macula cubes and radial macula scans. Derived data: a newer method version adds rows,
-- older ones stay. Not checked against IMAGEnet until retina.oct_thickness_checked says so (the Step 7 gate); every screen
-- that shows a value says which.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.oct_thickness (
  id               bigserial PRIMARY KEY,
  study_id         bigint NOT NULL REFERENCES app.oct_studies(id),
  version          integer NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL CHECK (kind IN ('cube','radial')),
  centre           jsonb NOT NULL,          -- uMm, vMm (from the scan centre; u right, v down on the photograph), method
  cst_ilm_bm_um    integer,
  cst_ilm_rpe_um   integer,                 -- ILM to OS/RPE
  results          jsonb NOT NULL,          -- per definition: cstUm, sectorsUm (C, S1, N1, I1, T1, S2, N2, I2, T2), cover
  UNIQUE (study_id, version)
);
CREATE INDEX IF NOT EXISTS oct_thickness_study_idx ON app.oct_thickness (study_id);
DROP TRIGGER IF EXISTS audit ON app.oct_thickness;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.oct_thickness FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

INSERT INTO app.settings (key, value, description) VALUES
  ('retina.oct_thickness_checked', 'null'::jsonb,
   'When Sudarshan''s CST was checked against IMAGEnet and passed: {"on": date, "definition": "ILM-BM", "n": scans, "biasUm": .., "loaUm": [..]}; null = not yet')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.schema_migrations(version) VALUES ('0026_oct_thickness') ON CONFLICT DO NOTHING;
