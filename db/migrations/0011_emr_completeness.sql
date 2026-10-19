-- =====================================================================================
-- 0011: EMR completeness per month (Phase B, D-028). What share of completed visits has each item recorded, by the
-- Yarago screen that holds it, as in the report "EMR data completeness: what to record at every visit" (19 Oct).
-- Rebuilt nightly by analytics.refresh_emr_completeness() (sync service, after analytics.refresh()); last 13 months.
-- Counts only: no patient appears in this table. Read by Sudarshan (/emr-completeness) and by Metabase.
-- "Recorded" = not empty, not "0", not the word "null" (Yarago stores all three for nothing).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS analytics.emr_completeness (
  month        date    NOT NULL,             -- first day of the month
  visit_group  text    NOT NULL,             -- all | new | review | injection
  screen       text    NOT NULL,             -- optometry | doctor | injection
  item         text    NOT NULL,             -- stable key
  label        text    NOT NULL,
  position     integer NOT NULL,
  recorded     integer NOT NULL,
  total        integer NOT NULL,
  PRIMARY KEY (month, visit_group, item)
);

DROP FUNCTION IF EXISTS analytics.filled(text);
CREATE OR REPLACE FUNCTION analytics.filled(v anyelement) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT nullif(nullif(nullif(btrim(v::text), ''), '0'), 'null') IS NOT NULL $$;

CREATE OR REPLACE FUNCTION analytics.refresh_emr_completeness() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM analytics.emr_completeness;

  WITH v AS (
    SELECT a.aappoint_id AS id, date_trunc('month', a.tappoint_date_time)::date AS month,
           NOT EXISTS (SELECT 1 FROM yarago.tblappointments p WHERE p.npatient_id = a.npatient_id AND p.nstatus_id = 3
                         AND p.tappoint_date_time < a.tappoint_date_time) AS is_new
      FROM yarago.tblappointments a
     WHERE a.nstatus_id = 3 AND a.tappoint_date_time >= date_trunc('month', current_date) - interval '12 months'
       -- an injection or laser is its own appointment with an empty record: only consultations count
       AND NOT EXISTS (SELECT 1 FROM yarago.tblpatientinjectionopdinvestigationdetials i WHERE i.napptid = a.aappoint_id)
       AND NOT EXISTS (SELECT 1 FROM yarago.tblpatientlaseropdinvestigationdetials l WHERE l.napptid = a.aappoint_id)),
  x AS (
    SELECT v.month, v.is_new,
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
    FROM v LEFT JOIN yarago.tbl_patient_appointment_history h ON h.nappoint_id = v.id),
  items AS (
    SELECT x.month, g.grp, i.screen, i.item, i.label, i.position, i.ok
      FROM x
     CROSS JOIN LATERAL (VALUES ('all'), (CASE WHEN x.is_new THEN 'new' ELSE 'review' END)) g(grp)
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
     ) i(screen, item, label, position, ok))
  INSERT INTO analytics.emr_completeness (month, visit_group, screen, item, label, position, recorded, total)
  SELECT month, grp, screen, item, label, position, count(*) FILTER (WHERE ok)::int, count(*)::int
    FROM items GROUP BY month, grp, screen, item, label, position;

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

INSERT INTO app.settings (key, value, description) VALUES
  ('emr.targets', '{"bcva": 95, "iop": 95, "diagnosis": 95, "systemic": 95, "allergy": 95, "followup": 95}'::jsonb,
   'EMR completeness targets (% of visits) shown on the EMR completeness page')
ON CONFLICT (key) DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sudarshan_bi') THEN
    GRANT SELECT ON analytics.emr_completeness TO sudarshan_bi;
  END IF;
END $$;
