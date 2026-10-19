-- =====================================================================================
-- 0012: who printed which day list (D-029). The Google app logged every print of the Day Overview (logPrintUsage);
-- a printed list carries patient names and phone numbers, so Sudarshan keeps the same record. A log table, like
-- app.ai_summary_views: no audit trigger on it.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.print_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES app.users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,                 -- day_consult | day_checkin | poa
  for_date    date NOT NULL,
  rows        integer NOT NULL,
  options     jsonb                          -- e.g. {"doctorStart": "11:10", "delayMin": 40}
);
CREATE INDEX IF NOT EXISTS print_log_at_idx ON app.print_log (at DESC);
