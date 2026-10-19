-- =====================================================================================
-- 0007: fields for the direct-call list and the cancel list (Google app directCall and cancel sheets).
-- Direct calls get a close reason; cancelled bookings get a call-back date and leave the cancel list when done
-- (the Google app moved rows to other sheets and used the "call back" / "Call back date" columns and tags).
-- Both tables already have audit triggers (0003).
-- =====================================================================================
ALTER TABLE app.direct_calls ADD COLUMN IF NOT EXISTS closed_at   timestamptz;
ALTER TABLE app.direct_calls ADD COLUMN IF NOT EXISTS closed_by   integer REFERENCES app.users(id);
ALTER TABLE app.direct_calls ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE app.direct_calls ADD COLUMN IF NOT EXISTS doctor_id   integer REFERENCES app.doctors(id);
CREATE INDEX IF NOT EXISTS direct_calls_status_idx ON app.direct_calls (status, created_at DESC);

ALTER TABLE app.appointments ADD COLUMN IF NOT EXISTS callback_on        date;          -- cancelled: when to call the patient back
ALTER TABLE app.appointments ADD COLUMN IF NOT EXISTS cancel_list_done_at timestamptz;  -- cancelled: taken off the cancel list
ALTER TABLE app.appointments ADD COLUMN IF NOT EXISTS cancel_list_done_by integer REFERENCES app.users(id);
ALTER TABLE app.appointments ADD COLUMN IF NOT EXISTS cancel_list_note    text;         -- why it left the list
CREATE INDEX IF NOT EXISTS appointments_cancel_list_idx ON app.appointments (appointment_date) WHERE status = 'cancelled' AND cancel_list_done_at IS NULL;

-- imported cancel-sheet state, carried by the importer as tags: archived rows are off the list
-- (a bulk correction of imported data: not written to the activity log, like the import itself)
SET LOCAL app.skip_audit = 'on';
UPDATE app.appointments SET cancel_list_done_at = coalesce(cancelled_at, booked_at), cancel_list_note = 'Archived from the cancel list in the Google app'
 WHERE status = 'cancelled' AND cancel_list_done_at IS NULL AND 'archived from cancel list' = ANY (tags);
-- the Google app's old_cancel sheet is its history of earlier cancellations, not the live cancel list
UPDATE app.appointments a SET cancel_list_done_at = coalesce(a.cancelled_at, a.booked_at), cancel_list_note = 'Old cancellation (old_cancel sheet in the Google app)'
 WHERE a.status = 'cancelled' AND a.cancel_list_done_at IS NULL
   AND EXISTS (SELECT 1 FROM app.appointment_events e WHERE e.appointment_id = a.id AND e.event_type = 'imported' AND e.to_value->>'sheet' = 'old_cancel');

INSERT INTO app.field_labels (entity_type, field, label, hidden) VALUES
  ('direct_calls', 'closed_at', 'Closed', false), ('direct_calls', 'closed_by', 'Closed by', false),
  ('direct_calls', 'close_reason', 'Close reason', false), ('direct_calls', 'doctor_id', 'Doctor', false),
  ('appointments', 'callback_on', 'Call back on', false), ('appointments', 'cancel_list_done_at', 'Off the cancel list', false),
  ('appointments', 'cancel_list_done_by', 'Taken off the cancel list by', false), ('appointments', 'cancel_list_note', 'Cancel list note', false)
ON CONFLICT DO NOTHING;
