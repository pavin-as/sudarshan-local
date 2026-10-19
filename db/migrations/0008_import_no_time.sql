-- =====================================================================================
-- 0008: Google-app bookings without a time were imported at 00:00 (an empty TimeSlot read as midnight).
-- A booking without a time is the waiting list (Pavin, 19 Oct): clear the time; upcoming ones become waitlist.
-- The importer now does the same (scripts/import_sheets.py). Bulk correction of imported data: not in the activity log.
-- =====================================================================================
SET LOCAL app.skip_audit = 'on';
UPDATE app.appointments SET status = 'waitlist'
 WHERE legacy_id IS NOT NULL AND slot_time = '00:00' AND status IN ('booked', 'confirmed') AND appointment_date >= current_date;
UPDATE app.appointments SET slot_time = NULL
 WHERE legacy_id IS NOT NULL AND slot_time = '00:00';
