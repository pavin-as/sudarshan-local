-- =====================================================================================
-- 0017: patient lists by group for the Patients page (D-039). One row per patient and group, rebuilt every night by the
-- sync worker after the analytics rebuild (02:30), so the Patients page counts and lists need no heavy query in clinic hours.
-- Lives in `app` (not `analytics`) because it holds patient ids; the Metabase role cannot read it. Derived data, rebuilt
-- in full: it has no audit trigger (the nightly rebuild is not a user's change).
--   rop        ROP clinic / screening visit ever (status: Active, Completed (mature retina), or no ROP visit for 12 months)
--   injection  at least one injection given          laser      at least one laser done
--   dr / glaucoma / squint / myopia / retina: the latest examination with findings matches the group's rule
--              (patterns from analytics.category_rule, Dr. Sameera's rules); squint and myopia also count a booking for that clinic
--   lowvision  best-corrected vision in the better eye worse than 6/18 at the latest visit with a value (WHO), or a booking for low vision
-- =====================================================================================
CREATE TABLE IF NOT EXISTS app.patient_group (
  patient_id  bigint NOT NULL,
  group_key   text   NOT NULL CHECK (group_key IN ('rop','injection','laser','dr','glaucoma','squint','myopia','lowvision','retina')),
  status      text,                 -- short words for the list, e.g. "Active", "Better eye worse than 6/18"
  detail      jsonb,                -- raw facts for the list (last injection, conditions matched, ...)
  last_event  date,                 -- the date the list is sorted by (last injection, last ROP visit, latest exam, ...)
  last_visit  date,                 -- latest completed visit
  bcva_re     text, bcva_le text, bcva_date date,   -- latest visit with a best-corrected value
  iop_re      numeric, iop_le numeric, iop_date date,
  built_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, group_key)
);
CREATE INDEX IF NOT EXISTS patient_group_list_idx ON app.patient_group (group_key, last_event DESC NULLS LAST);

CREATE OR REPLACE FUNCTION app.refresh_patient_groups() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  built_rows integer;
  retina_cats text[] := ARRAY['Retinal detachment','Retinal vein occlusion','Age-related macular degeneration','Vitreous haemorrhage',
                              'Uveitis','Macular hole / ERM / VMT','CSCR','Hypertensive retinopathy','Myopic fundus / degeneration'];
  dx_pattern text;
BEGIN
  -- the views decode id lists, so read them once
  CREATE TEMP TABLE pg_ef ON COMMIT DROP AS
    SELECT visit_id, patient_id, finding FROM clinical.visit_exam_finding WHERE finding IS NOT NULL;
  CREATE INDEX ON pg_ef (visit_id);
  CREATE TEMP TABLE pg_v ON COMMIT DROP AS
    SELECT visit_id, patient_id, visit_date, status_id, reason, bcva_re, bcva_le, iop_re, iop_le FROM clinical.visit;
  CREATE INDEX ON pg_v (patient_id);
  CREATE INDEX ON pg_v (visit_id);
  ANALYZE pg_ef; ANALYZE pg_v;

  CREATE TEMP TABLE pg_info ON COMMIT DROP AS
    SELECT p.patient_id, lv.visit_date AS last_visit, b.visit_date AS bcva_date, b.bcva_re, b.bcva_le,
           i.visit_date AS iop_date, i.iop_re, i.iop_le
      FROM clinical.patient p
      LEFT JOIN LATERAL (SELECT visit_date FROM pg_v WHERE patient_id = p.patient_id AND status_id = 3
                          ORDER BY visit_date DESC LIMIT 1) lv ON true
      LEFT JOIN LATERAL (SELECT visit_date, bcva_re, bcva_le FROM pg_v
                          WHERE patient_id = p.patient_id AND status_id = 3 AND coalesce(bcva_re, bcva_le) IS NOT NULL
                          ORDER BY visit_date DESC, visit_id DESC LIMIT 1) b ON true
      LEFT JOIN LATERAL (SELECT visit_date, iop_re, iop_le FROM pg_v
                          WHERE patient_id = p.patient_id AND status_id = 3 AND coalesce(iop_re, iop_le) IS NOT NULL
                          ORDER BY visit_date DESC, visit_id DESC LIMIT 1) i ON true;

  -- the latest examination that has findings, all its findings in one text (as the follow-up board reads it)
  CREATE TEMP TABLE pg_lf ON COMMIT DROP AS
    SELECT e.patient_id, e.visit_id, v.visit_date, string_agg(e.finding, ' ; ') AS f
      FROM pg_ef e
      JOIN (SELECT patient_id, max(visit_id) AS vid FROM pg_ef GROUP BY patient_id) m ON m.patient_id = e.patient_id AND m.vid = e.visit_id
      JOIN pg_v v ON v.visit_id = e.visit_id
     GROUP BY e.patient_id, e.visit_id, v.visit_date;

  CREATE TEMP TABLE pg_g (patient_id bigint, group_key text, status text, detail jsonb, last_event date) ON COMMIT DROP;

  -- ROP: the latest completed visit booked as ROP clinic / screening, or with ROP findings (same evidence as the follow-up board)
  INSERT INTO pg_g
  SELECT DISTINCT ON (v.patient_id) v.patient_id, 'rop',
         CASE WHEN EXISTS (SELECT 1 FROM pg_ef m WHERE m.visit_id = v.visit_id AND m.finding ~* 'mature retina') THEN 'Completed (mature retina)'
              WHEN v.visit_date < current_date - 365 THEN 'No ROP visit for 12 months'
              ELSE 'Active' END,
         jsonb_build_object('lastRopVisit', v.visit_date), v.visit_date
    FROM pg_v v
   WHERE v.status_id = 3
     AND (v.reason ~* '\mrop\M'
          OR EXISTS (SELECT 1 FROM pg_ef e WHERE e.visit_id = v.visit_id AND e.finding ~* '\mrop\M|prematur|plus disease|\mzone\M|mature retina'))
   ORDER BY v.patient_id, v.visit_date DESC, v.visit_id DESC;

  -- injection and laser: the last one given / done and how many in all
  INSERT INTO pg_g
  SELECT patient_id, 'injection', NULL,
         jsonb_build_object('total', tot, 'procedure', procedure, 'drug', drug, 'eye', eye, 'n', n), treated_at::date
    FROM (SELECT patient_id, treated_at, procedure, drug, eye, injection_number_for_eye AS n,
                 row_number() OVER (PARTITION BY patient_id ORDER BY treated_at DESC, injection_id DESC) AS rn,
                 count(*) OVER (PARTITION BY patient_id) AS tot
            FROM clinical.injection WHERE given) i
   WHERE rn = 1;
  INSERT INTO pg_g
  SELECT patient_id, 'laser', NULL, jsonb_build_object('total', tot, 'what', done, 'eye', eye), treated_at::date
    FROM (SELECT patient_id, treated_at, done, eye,
                 row_number() OVER (PARTITION BY patient_id ORDER BY treated_at DESC, laser_id DESC) AS rn,
                 count(*) OVER (PARTITION BY patient_id) AS tot
            FROM clinical.laser WHERE done IS NOT NULL) l
   WHERE rn = 1;

  -- conditions read from the latest examination with findings, each group by its own rule (a patient with glaucoma and
  -- diabetic retinopathy is on both lists)
  SELECT pattern INTO dx_pattern FROM analytics.category_rule WHERE kind = 'diagnosis' AND category = 'Diabetic retinopathy / DME';
  INSERT INTO pg_g SELECT patient_id, 'dr', 'Latest examination', NULL, visit_date FROM pg_lf WHERE f ~* dx_pattern;
  SELECT pattern INTO dx_pattern FROM analytics.category_rule WHERE kind = 'diagnosis' AND category = 'Glaucoma / suspect';
  INSERT INTO pg_g SELECT patient_id, 'glaucoma', 'Latest examination', NULL, visit_date FROM pg_lf WHERE f ~* dx_pattern;

  INSERT INTO pg_g
  SELECT DISTINCT ON (patient_id) patient_id, 'retina', 'Latest examination',
         jsonb_build_object('conditions', (SELECT jsonb_agg(r.category ORDER BY r.priority) FROM analytics.category_rule r
                                            WHERE r.kind = 'diagnosis' AND r.category = ANY (retina_cats) AND l.f ~* r.pattern)), visit_date
    FROM pg_lf l
   WHERE EXISTS (SELECT 1 FROM analytics.category_rule r WHERE r.kind = 'diagnosis' AND r.category = ANY (retina_cats) AND l.f ~* r.pattern);

  -- squint and myopia: the latest examination, or a booking for that clinic
  INSERT INTO pg_g
  SELECT DISTINCT ON (patient_id) patient_id, 'squint', basis, NULL, ev FROM (
    SELECT patient_id, 'Latest examination' AS basis, visit_date AS ev, 1 AS rk FROM pg_lf
     WHERE f ~* (SELECT pattern FROM analytics.category_rule WHERE kind = 'diagnosis' AND category = 'Squint / amblyopia')
    UNION ALL
    SELECT patient_id, 'Booked for squint / amblyopia clinic', max(visit_date), 2 FROM pg_v
     WHERE status_id <> 4 AND reason ~* 'squint|bynocs|amblyop' GROUP BY patient_id) s
   ORDER BY patient_id, rk;
  INSERT INTO pg_g
  SELECT DISTINCT ON (patient_id) patient_id, 'myopia', basis, NULL, ev FROM (
    SELECT patient_id, 'Latest examination' AS basis, visit_date AS ev, 1 AS rk FROM pg_lf
     WHERE f ~* (SELECT pattern FROM analytics.category_rule WHERE kind = 'diagnosis' AND category = 'Myopic fundus / degeneration')
    UNION ALL
    SELECT patient_id, 'Booked for myopia clinic', max(visit_date), 2 FROM pg_v
     WHERE status_id <> 4 AND reason ~* 'myopia' GROUP BY patient_id) s
   ORDER BY patient_id, rk;

  -- low vision (WHO, confirmed by Dr. Sameera): better eye worse than 6/18 on best-corrected vision, both eyes recorded; or booked for low vision
  INSERT INTO pg_g
  SELECT patient_id, 'lowvision',
         CASE WHEN vis AND booked IS NOT NULL THEN 'Better eye worse than 6/18; also booked for low vision'
              WHEN vis THEN 'Better eye worse than 6/18' ELSE 'Booked for low vision' END,
         jsonb_build_object('vision', vis, 'booked', booked IS NOT NULL), greatest(CASE WHEN vis THEN bcva_date END, booked)
    FROM (SELECT i.patient_id, i.bcva_date,
                 (clinical.va_logmar(i.bcva_re) IS NOT NULL AND clinical.va_logmar(i.bcva_le) IS NOT NULL
                  AND least(clinical.va_logmar(i.bcva_re), clinical.va_logmar(i.bcva_le)) > clinical.va_logmar('6/18')) AS vis,
                 (SELECT max(visit_date) FROM pg_v b WHERE b.patient_id = i.patient_id AND b.status_id <> 4
                     AND b.reason ~* 'low vision|\mlva\M|\mlv\M') AS booked
            FROM pg_info i) x
   WHERE vis OR booked IS NOT NULL;

  DELETE FROM app.patient_group;
  INSERT INTO app.patient_group (patient_id, group_key, status, detail, last_event, last_visit, bcva_re, bcva_le, bcva_date, iop_re, iop_le, iop_date)
  SELECT g.patient_id, g.group_key, g.status, g.detail, g.last_event, i.last_visit, i.bcva_re, i.bcva_le, i.bcva_date, i.iop_re, i.iop_le, i.iop_date
    FROM pg_g g JOIN pg_info i USING (patient_id);
  GET DIAGNOSTICS built_rows = ROW_COUNT;
  RETURN built_rows;
END
$$;
