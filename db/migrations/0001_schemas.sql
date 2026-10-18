-- 0001: base schemas for Sudarshan (run as sudarshan_app on database "sudarshan")
-- yarago          raw mirror of Yarago MySQL tables, written only by the sync worker
-- yarago_staging  nightly full copy lands here, then is swapped into yarago
-- clinical        decoded, readable views over yarago (what the app and AI read)
-- app             Sudarshan's own data (appointments, events, users, audit, ai_summaries)
CREATE SCHEMA IF NOT EXISTS yarago;
CREATE SCHEMA IF NOT EXISTS yarago_staging;
CREATE SCHEMA IF NOT EXISTS clinical;
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yarago.sync_state (
  table_name      text PRIMARY KEY,
  last_id         bigint,
  last_modified   timestamp,
  last_run_at     timestamptz,
  last_row_count  bigint,
  last_status     text,
  columns_hash    text
);

INSERT INTO app.schema_migrations(version) VALUES ('0001_schemas') ON CONFLICT DO NOTHING;
