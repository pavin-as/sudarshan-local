-- =====================================================================================
-- 0010: doctor summary (Phase B, D-026). app.ai_summaries (0003) holds one row per patient per day: the facts shown
-- (each with its Yarago visit) and the two-line overview written by the local model. Audited like every app table;
-- app.ai_summary_views logs who looked at which summary (it is itself a log, so it has no audit trigger).
-- =====================================================================================
ALTER TABLE app.ai_summaries ADD COLUMN IF NOT EXISTS facts_hash text;          -- the overview was written from these facts
ALTER TABLE app.ai_summaries ADD COLUMN IF NOT EXISTS checked jsonb;           -- result of the number check on the overview

DROP TRIGGER IF EXISTS audit ON app.ai_summaries;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.ai_summaries FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

CREATE INDEX IF NOT EXISTS ai_summaries_day_idx ON app.ai_summaries (for_date, kind, status);

INSERT INTO app.settings (key, value, description) VALUES
  ('ai.overview_model', '"qwen3.5:9b"'::jsonb, 'Local Ollama model that writes the doctor summary overview'),
  ('ai.overview_at', '"07:00"'::jsonb, 'Time the day''s doctor summaries are prepared')
ON CONFLICT (key) DO NOTHING;
