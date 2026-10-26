-- =====================================================================================
-- 0027: EMR daily report (D-051). For each consultation of a day, which of the EMR completeness items (D-028) are not
-- recorded in Yarago: the optometry screen for the optometrists, the doctor screen for the doctor. Week 1 is a team
-- report (no logins); every item is expected at every visit, new or review (Pavin, 26 Oct).
-- clinical.emr_visit_items() is the one per-visit check; the monthly page now counts from it too, so both always agree.
-- app.emr_daily_reports keeps what was missing when the report was taken (setting emr.daily_at, 17:30), so the page can
-- show what was completed afterwards. Ids and item keys only; MRDs are read live.
-- =====================================================================================

-- One row per item per visit. Visits: checked in, in examination or completed (status 1-3), injection and laser
-- appointments left out (they have no consultation record). p_to NULL = no upper limit. plpgsql, so the mirror
-- tables are only looked up when it runs (a full copy may rebuild them).
DROP FUNCTION IF EXISTS clinical.emr_visit_items(date, date);
CREATE FUNCTION clinical.emr_visit_items(p_from date, p_to date)
RETURNS TABLE (visit_id int, patient_id int, visit_at timestamp, status_id int, is_new boolean,
               screen text, item text, label text, item_position int, ok boolean)
LANGUAGE plpgsql STABLE AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH v AS (
    SELECT a.aappoint_id AS id, a.npatient_id AS pid, a.tappoint_date_time AS at, a.nstatus_id AS st,
           NOT EXISTS (SELECT 1 FROM yarago.tblappointments p WHERE p.npatient_id = a.npatient_id AND p.nstatus_id = 3
                         AND p.tappoint_date_time < a.tappoint_date_time) AS is_new
      FROM yarago.tblappointments a
     WHERE a.nstatus_id IN (1, 2, 3) AND a.tappoint_date_time >= p_from
       AND (p_to IS NULL OR a.tappoint_date_time < p_to + 1)
       -- an injection or laser is its own appointment with an empty record: only consultations count
       AND NOT EXISTS (SELECT 1 FROM yarago.tblpatientinjectionopdinvestigationdetials i WHERE i.napptid = a.aappoint_id)
       AND NOT EXISTS (SELECT 1 FROM yarago.tblpatientlaseropdinvestigationdetials l WHERE l.napptid = a.aappoint_id)),
  x AS (
    SELECT v.id, v.pid, v.at, v.st, v.is_new,
      analytics.filled(h.visionvadv_r_id) AND analytics.filled(h.visionvadv_l_id) AS bcva,
      analytics.filled(h.dva_r_id) AND analytics.filled(h.dva_l_id) AS ucva,
      analytics.filled(h.ph_r_id) OR analytics.filled(h.ph_l_id) AS pinhole,
      analytics.filled(h.visionvanv_r_id) OR analytics.filled(h.ucnva_r_id) AS near_va,
      analytics.filled(h.arsph_r_id) AS autoref,
      analytics.filled(h.oeiop_right) OR analytics.filled(h.nct_right) OR analytics.filled(h.oeiop_left) OR analytics.filled(h.nct_left)
        OR EXISTS (SELECT 1 FROM yarago.tbloptometryexamination o WHERE o.nappointment_id = v.id
                     AND (analytics.filled(o.nct_right) OR analytics.filled(o.iop_right) OR analytics.filled(o.nct_left) OR analytics.filled(o.iop_left))) AS iop,
      analytics.filled(h.pupil_right) OR analytics.filled(h.pupil_left)
        OR EXISTS (SELECT 1 FROM yarago.tbloptometryexamination o WHERE o.nappointment_id = v.id
                     AND (analytics.filled(o.pupil_right) OR analytics.filled(o.pupil_left))) AS pupils,
      analytics.filled(h.colourvision_right) OR analytics.filled(h.colourvision_left)
        OR EXISTS (SELECT 1 FROM yarago.tbloptometryexamination o WHERE o.nappointment_id = v.id
                     AND (analytics.filled(o.colourvision_right) OR analytics.filled(o.colourvision_left))) AS colour,
      analytics.filled(h.present_complaints) AS complaint,
      analytics.filled(h.opthalamic_history) OR analytics.filled(h.opthalmic_remarks) AS oph_history,
      analytics.filled(h.systemic_illness) AS systemic,
      analytics.filled(h.drug_allergies) AS allergy,
      analytics.filled(h.familyhistory) AS family,
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN left(btrim(h.systemic_status), 1) = '[' THEN h.systemic_status::jsonb ELSE '[]'::jsonb END) e
               WHERE e->>'key' IN ('HbA1c', 'Blood Sugar', 'BP') AND analytics.filled((e->>'value')::text)) AS labs,
      analytics.filled(h.examination_history) AS exam,
      EXISTS (SELECT 1 FROM yarago.tbldiagnosis d WHERE d.tappt_id = v.id AND analytics.filled(d.tdiagnosis_mst_id))
        OR analytics.filled(h.diagnosis) OR analytics.filled(h.diagnosis_right) OR analytics.filled(h.diagnosis_left) AS diagnosis,
      analytics.filled(h.medicinename) AS medicines,
      analytics.filled(h.advice_id) AS advice,
      analytics.filled(h.followup) OR analytics.filled(h.followup_indays) OR analytics.filled(h.followup_inweeks)
        OR analytics.filled(h.followup_inmonths) AS followup
    FROM v LEFT JOIN yarago.tbl_patient_appointment_history h ON h.nappoint_id = v.id)
  SELECT x.id::int, x.pid::int, x.at::timestamp, x.st::int, x.is_new, i.screen, i.item, i.label, i.position, coalesce(i.ok, false)
    FROM x
   CROSS JOIN LATERAL (VALUES
     ('optometry', 'bcva',       'Best-corrected vision, both eyes',  1, x.bcva),
     ('optometry', 'iop',        'Eye pressure (IOP)',                2, x.iop),
     ('optometry', 'ucva',       'Unaided vision, both eyes',         3, x.ucva),
     ('optometry', 'pinhole',    'Pinhole vision',                    4, x.pinhole),
     ('optometry', 'near_va',    'Near vision',                       5, x.near_va),
     ('optometry', 'autoref',    'Autorefraction',                    6, x.autoref),
     ('optometry', 'pupils',     'Pupils (RAPD)',                     7, x.pupils),
     ('optometry', 'colour',     'Colour vision',                     8, x.colour),
     ('doctor',    'diagnosis',  'Diagnosis from the list',          11, x.diagnosis),
     ('doctor',    'systemic',   'Systemic illness from the list',   12, x.systemic),
     ('doctor',    'allergy',    'Drug allergies',                   13, x.allergy),
     ('doctor',    'labs',       'HbA1c, blood sugar or BP',         14, x.labs),
     ('doctor',    'complaint',  'Complaint from the list',          15, x.complaint),
     ('doctor',    'exam',       'Examination findings',             16, x.exam),
     ('doctor',    'advice',     'Advice from the list',             17, x.advice),
     ('doctor',    'family',     'Family history',                   18, x.family),
     ('doctor',    'oph_history','Ophthalmic history',               19, x.oph_history),
     ('doctor',    'medicines',  'Medicines',                        20, x.medicines),
     ('doctor',    'followup',   'Follow-up date',                   21, x.followup)
   ) i(screen, item, label, position, ok);
END $fn$;

-- The monthly page (0011) now counts from the same check: completed visits only, as before.
CREATE OR REPLACE FUNCTION analytics.refresh_emr_completeness() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM analytics.emr_completeness;

  INSERT INTO analytics.emr_completeness (month, visit_group, screen, item, label, position, recorded, total)
  SELECT date_trunc('month', x.visit_at)::date, g.grp, x.screen, x.item, x.label, x.item_position,
         count(*) FILTER (WHERE x.ok)::int, count(*)::int
    FROM clinical.emr_visit_items((date_trunc('month', current_date) - interval '12 months')::date, NULL) x
   CROSS JOIN LATERAL (VALUES ('all'), (CASE WHEN x.is_new THEN 'new' ELSE 'review' END)) g(grp)
   WHERE x.status_id = 3
   GROUP BY 1, 2, 3, 4, 5, 6;

  -- the injection record itself (one row per injection given)
  INSERT INTO analytics.emr_completeness (month, visit_group, screen, item, label, position, recorded, total)
  SELECT date_trunc('month', coalesce(x.dateoftreatment, x.apptdate))::date, 'injection', 'injection', k.item, k.label, k.position,
         count(*) FILTER (WHERE k.ok)::int, count(*)::int
    FROM yarago.tblpatientinjectionopdinvestigationdetials x
   CROSS JOIN LATERAL (VALUES
       ('inj_drug', 'Injection drug in the injection record', 31, analytics.filled(x.drugsuggested)),
       ('inj_next', 'Next injection date',                     32, x.followupdate IS NOT NULL)) k(item, label, position, ok)
   WHERE x.isinjectiongiven = 'Yes' AND coalesce(x.isdeleted, 0) = 0
     AND coalesce(x.dateoftreatment, x.apptdate) >= date_trunc('month', current_date) - interval '12 months'
   GROUP BY 1, k.item, k.label, k.position;

  SELECT count(*) INTO n FROM analytics.emr_completeness;
  RETURN n;
END $$;

-- What was missing when the day's report was taken (one row per day, written by the server's job).
CREATE TABLE IF NOT EXISTS app.emr_daily_reports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_date  date NOT NULL UNIQUE,
  taken_at     timestamptz NOT NULL DEFAULT now(),
  visits       jsonb NOT NULL      -- [{"visitId": 123, "statusId": 3, "missing": ["pinhole", "family"]}], every visit then
);
DROP TRIGGER IF EXISTS audit ON app.emr_daily_reports;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.emr_daily_reports FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

INSERT INTO app.settings (key, value, description) VALUES
  ('emr.daily_at', '"17:30"'::jsonb, 'Time the EMR daily report is taken each day (HH:MM)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app.schema_migrations(version) VALUES ('0027_emr_daily_report') ON CONFLICT DO NOTHING;
