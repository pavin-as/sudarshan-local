-- =====================================================================================
-- 0009: during the trial the Google app is the master of bookings, the cancel list, direct calls, triage and the clinic
-- calendar (D-025). scripts/refresh-from-google.ps1 copies them every 15 minutes; Sudarshan refuses changes to those
-- records and to the calendar while this setting is true. At cut-over: set it to false (RUNBOOK, cut-over).
-- =====================================================================================
INSERT INTO app.settings (key, value, description)
VALUES ('trial.google_master', 'true'::jsonb, 'Trial: the Google app is the master of imported records and the calendar; set false at cut-over')
ON CONFLICT (key) DO NOTHING;
