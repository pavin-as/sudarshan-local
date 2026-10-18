-- =====================================================================================
-- 0004: things the API server needs.
--   * Yarago appointment status labels, confirmed from the data (check_views.py, 18 Oct 2026):
--     status 0: 11 of 673 ever checked in; 1: all checked in; 2: mostly examined; 3: checked out; 4: cancelled.
--   * Booking settings with the Google app's values (10-minute slots, 09:00-18:00).
-- =====================================================================================
INSERT INTO app.code_labels (kind, code, label, confirmed) VALUES
  ('appointment_status', 0, 'Booked, not arrived', true),
  ('appointment_status', 1, 'Checked in, waiting', true),
  ('appointment_status', 2, 'In examination', true),
  ('appointment_status', 3, 'Completed', true),
  ('appointment_status', 4, 'Cancelled', true)
ON CONFLICT (kind, code) DO UPDATE SET label = EXCLUDED.label, confirmed = true;

INSERT INTO app.settings (key, value, description) VALUES
  ('booking.day_start', '"09:00"', 'First booking slot of the day'),
  ('booking.day_end',   '"18:00"', 'Slots end before this time'),
  ('booking.slot_minutes', '10', 'Length of one booking slot in minutes')
ON CONFLICT (key) DO NOTHING;

-- the board looks up today's Yarago visit for each booking by patient and date
CREATE INDEX IF NOT EXISTS appointments_patient_day_idx ON app.appointments (patient_id, appointment_date);
CREATE INDEX IF NOT EXISTS followup_actions_patient_at_idx ON app.followup_actions (patient_id, at DESC);
