-- 0002: log of every sync run (kept in app schema so the nightly swap never touches it)
CREATE TABLE IF NOT EXISTS app.sync_runs (
  id           bigserial PRIMARY KEY,
  mode         text NOT NULL,              -- full | incremental | verify
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',  -- running | ok | warning | error
  tables_done  integer,
  rows_copied  bigint,
  message      text
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON app.sync_runs (started_at DESC);
INSERT INTO app.schema_migrations(version) VALUES ('0002_sync_runs') ON CONFLICT DO NOTHING;
