-- =====================================================================================
-- 0005: record of every backup and restore test (written by scripts/backup.ps1 and
-- scripts/restore-test.ps1), so the health check and the runbook can show the last good backup.
-- Operational table: not audited.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.backup_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backup', 'restore_test')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL CHECK (status IN ('ok', 'failed')),
  file         text,
  bytes        bigint,
  details      jsonb,
  message      text
);
CREATE INDEX IF NOT EXISTS backup_runs_kind_idx ON app.backup_runs (kind, started_at DESC);
