-- =====================================================================================
-- Per-visit timeline from Yarago's station timer, and each patient's current follow-up state.
-- Station ids come from yarago.tbltimermodulewise: 1 Check in, 2 optometry, 3 Room In,
-- 4 Examination before dilatation, 6 Examination after dilatation, 8 Check Out.
-- =====================================================================================

CREATE OR REPLACE FUNCTION clinical.minutes_between(a timestamp, b timestamp) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- NULL when missing, negative, or longer than 10 hours (timer left open)
  SELECT CASE WHEN a IS NOT NULL AND b IS NOT NULL AND b >= a AND b - a <= interval '10 hours'
              THEN round(extract(epoch FROM b - a) / 60.0, 1) END
$$;

CREATE OR REPLACE VIEW clinical.visit_timeline AS
WITH t AS (
  SELECT napptid AS visit_id, max(npatid) AS patient_id,
         min(startdatetime) FILTER (WHERE nmoduletimerid = 1) AS check_in_at,
         min(startdatetime) FILTER (WHERE nmoduletimerid = 2) AS optometry_start_at,
         max(enddatetime)   FILTER (WHERE nmoduletimerid = 2) AS optometry_end_at,
         min(startdatetime) FILTER (WHERE nmoduletimerid = 3) AS room_in_at,
         min(startdatetime) FILTER (WHERE nmoduletimerid = 4) AS exam_start_at,
         max(enddatetime)   FILTER (WHERE nmoduletimerid = 4) AS exam_end_at,
         min(startdatetime) FILTER (WHERE nmoduletimerid = 6) AS exam_after_dilatation_at,
         max(enddatetime)   FILTER (WHERE nmoduletimerid = 8) AS check_out_at
  FROM yarago.tbltimerpatientwaiting
  WHERE coalesce(isdeleted, 0) = 0
  GROUP BY napptid
)
SELECT t.*,
       t.check_in_at::date                                                   AS visit_date,
       clinical.minutes_between(t.check_in_at, t.optometry_start_at)          AS wait_for_optometry_min,
       clinical.minutes_between(t.optometry_start_at, t.optometry_end_at)     AS optometry_min,
       clinical.minutes_between(t.optometry_end_at, coalesce(t.room_in_at, t.exam_start_at)) AS wait_for_doctor_min,
       clinical.minutes_between(coalesce(t.room_in_at, t.exam_start_at), coalesce(t.exam_end_at, t.check_out_at)) AS with_doctor_min,
       clinical.minutes_between(t.check_in_at, t.check_out_at)                AS total_min
FROM t;

-- Each patient's most recent follow-up and where it stands today
CREATE OR REPLACE VIEW clinical.followup_current AS
SELECT DISTINCT ON (f.patient_id)
       f.*,
       CASE
         WHEN f.came_back                       THEN 'returned'
         WHEN f.due_date >= current_date        THEN 'upcoming'
         WHEN f.days_overdue <= 30              THEN 'overdue up to 30 days'
         WHEN f.days_overdue <= 90              THEN 'overdue 31-90 days'
         WHEN f.days_overdue <= 365             THEN 'overdue 91-365 days'
         ELSE 'overdue over 1 year'
       END AS followup_state
FROM clinical.followup f
ORDER BY f.patient_id, f.due_date DESC, f.followup_id DESC;
