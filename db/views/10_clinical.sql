-- =====================================================================================
-- clinical.*  Readable views over the Yarago mirror (schema yarago).
-- Re-applied after every full sync and by scripts/migrate.py, so always CREATE OR REPLACE.
-- Values come straight from Yarago; nothing here is invented. Codes are decoded through
-- Yarago's own master tables. Labels Yarago does not store are in app.code_labels.
-- =====================================================================================

-- ---------- helpers ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinical.clean(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN btrim(t) IN ('', 'null', 'NULL', 'None', 'undefined', '-', '--', 'Select') THEN NULL
              ELSE regexp_replace(btrim(t), '\s+', ' ', 'g') END
$$;

-- '1,3,' -> {1,3}
CREATE OR REPLACE FUNCTION clinical.id_list(t text) RETURNS int[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_agg(x::int ORDER BY o)
  FROM regexp_split_to_table(coalesce(t, ''), '\s*,\s*') WITH ORDINALITY AS s(x, o)
  WHERE x ~ '^\d{1,9}$'
$$;

-- Yarago stores "id list" + aligned "right flags" + "left flags": ('1,3,', '1,0,', '0,1,')
CREATE OR REPLACE FUNCTION clinical.list_items(ids text, r text, l text)
RETURNS TABLE(pos int, id int, re boolean, le boolean)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT i.o::int, i.x::int,
         (string_to_array(coalesce(r, ''), ','))[i.o] = '1',
         (string_to_array(coalesce(l, ''), ','))[i.o] = '1'
  FROM unnest(string_to_array(coalesce(ids, ''), ',')) WITH ORDINALITY AS i(x, o)
  WHERE btrim(i.x) ~ '^\d{1,9}$'
$$;

-- plain number from text ('14', ' 14 ', '14.5'); anything else -> NULL
CREATE OR REPLACE FUNCTION clinical.num(t text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN btrim(t) ~ '^\d{1,3}(\.\d+)?$' THEN btrim(t)::numeric END
$$;

-- RE / LE / BE from free text
CREATE OR REPLACE FUNCTION clinical.eye(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IS NULL THEN NULL
    WHEN upper(t) ~ '(^|[^A-Z])(BE|OU|BOTH)([^A-Z]|$)' THEN 'BE'
    WHEN upper(t) ~ '(^|[^A-Z])(RE|OD|RIGHT)([^A-Z]|$)' THEN 'RE'
    WHEN upper(t) ~ '(^|[^A-Z])(LE|OS|LEFT)([^A-Z]|$)' THEN 'LE'
  END
$$;

-- Snellen distance acuity -> approximate logMAR, only for trend arrows (never displayed as a value).
-- 6/x and 20/x; CF/HM/PL/NPL use common approximations. Suffixes like P, +, - are ignored.
CREATE OR REPLACE FUNCTION clinical.va_logmar(t text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IS NULL THEN NULL
    WHEN upper(t) ~ '^\s*6\s*/\s*\d+(\.\d+)?' THEN
      round(log(substring(upper(t) from '^\s*6\s*/\s*(\d+(?:\.\d+)?)')::numeric / 6), 2)
    WHEN upper(t) ~ '^\s*20\s*/\s*\d+' THEN
      round(log(substring(upper(t) from '^\s*20\s*/\s*(\d+)')::numeric / 20), 2)
    WHEN upper(t) ~ '^\s*CF' THEN 2.0
    WHEN upper(t) ~ '^\s*HM' THEN 2.3
    WHEN upper(t) ~ '^\s*(NPL|NO PL|PL-)' THEN 3.0
    WHEN upper(t) ~ '^\s*(PL|PR)' THEN 2.7
  END
$$;

-- dd-mm-yyyy or yyyy-mm-dd text -> date
CREATE OR REPLACE FUNCTION clinical.to_date_safe(t text) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF t ~ '^\s*\d{4}-\d{1,2}-\d{1,2}' THEN RETURN to_date(substring(t from '\d{4}-\d{1,2}-\d{1,2}'), 'YYYY-MM-DD');
  ELSIF t ~ '^\s*\d{1,2}[-/]\d{1,2}[-/]\d{4}' THEN RETURN to_date(replace(substring(t from '\d{1,2}[-/]\d{1,2}[-/]\d{4}'), '/', '-'), 'DD-MM-YYYY');
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- ---------- labels Yarago does not store --------------------------------------------
CREATE TABLE IF NOT EXISTS app.code_labels (
  kind       text NOT NULL,
  code       integer NOT NULL,
  label      text NOT NULL,
  confirmed  boolean NOT NULL DEFAULT false,   -- false = inferred from data, to be confirmed by the clinic
  PRIMARY KEY (kind, code)
);
INSERT INTO app.code_labels (kind, code, label, confirmed) VALUES
  ('appointment_status', 0, 'Booked, not arrived (to confirm)', false),
  ('appointment_status', 1, 'Checked in, waiting (to confirm)', false),
  ('appointment_status', 2, 'In examination (to confirm)', false),
  ('appointment_status', 3, 'Completed (to confirm)', false),
  ('appointment_status', 4, 'Cancelled (to confirm)', false),
  ('followup_status', 0, 'Pending (to confirm)', false),
  ('followup_status', 1, 'Realised (to confirm)', false),
  ('followup_status', 2, 'Status 2 (to confirm)', false)
ON CONFLICT (kind, code) DO UPDATE SET label = EXCLUDED.label WHERE NOT app.code_labels.confirmed;

-- ---------- patients -----------------------------------------------------------------
CREATE OR REPLACE VIEW clinical.patient AS
SELECT p.apatient_id                                         AS patient_id,
       clinical.clean(p.apatientcode)                        AS mrd,
       clinical.clean(concat_ws(' ', clinical.clean(p.tfisrt_name), clinical.clean(p.tmiddle_name),
                                     clinical.clean(p.tlast_name))) AS name,
       p.tdob                                                AS dob,
       coalesce(date_part('year', age(p.tdob))::int, round(p.tage)::int) AS age_years,
       upper(left(clinical.clean(p.tsex), 1))                AS sex,
       clinical.clean(p.tmobile_no)                          AS mobile,
       clinical.clean(p.preferredlanguage)                   AS language,
       clinical.clean(p.vip_category_vals)                   AS vip_category,
       p.inserteddate                                        AS registered_at
FROM yarago.tblpatientregistration p;

-- ---------- visits (one row per Yarago appointment) ------------------------------------
CREATE OR REPLACE VIEW clinical.visit AS
SELECT a.aappoint_id                                   AS visit_id,
       a.npatient_id                                   AS patient_id,
       a.tappoint_date_time                            AS visit_at,
       a.tappoint_date_time::date                      AS visit_date,
       a.tokenid                                       AS token,
       a.nappoint_type_id                              AS visit_type_id,
       clinical.clean(vt.tappoint_type)                AS visit_type,
       a.nstatus_id                                    AS status_id,
       sl.label                                        AS status,
       clinical.clean(d.tdoctorname)                   AS doctor,
       clinical.clean(a.treason_for_visit)             AS reason,
       a.inserteddate                                  AS booked_at,
       a.consultant_adviced_time                       AS consultant_done_at,
       -- vision (Yarago stores the displayed text)
       clinical.clean(h.dva_r_id)                      AS va_unaided_re,
       clinical.clean(h.dva_l_id)                      AS va_unaided_le,
       clinical.clean(h.ph_r_id)                       AS va_pinhole_re,
       clinical.clean(h.ph_l_id)                       AS va_pinhole_le,
       clinical.clean(h.visionvadv_r_id)               AS bcva_re,
       clinical.clean(h.visionvadv_l_id)               AS bcva_le,
       clinical.clean(h.visionvanv_r_id)               AS near_va_re,
       clinical.clean(h.visionvanv_l_id)               AS near_va_le,
       -- IOP: doctor's examination value, else latest optometry reading
       coalesce(clinical.num(h.oeiop_right), clinical.num(o.iop_right), clinical.num(o.nct_right)) AS iop_re,
       coalesce(clinical.num(h.oeiop_left),  clinical.num(o.iop_left),  clinical.num(o.nct_left))  AS iop_le,
       clinical.num(o.cct_right)                       AS cct_re,
       clinical.num(o.cct_left)                        AS cct_le,
       -- findings and plan
       clinical.clean(h.final_diagnosis)               AS diagnosis,
       (SELECT string_agg(clinical.clean(m.content), ', ' ORDER BY li.pos)
          FROM clinical.list_items(h.present_complaints, h.comp_right, h.comp_left) li
          JOIN yarago.tbl_mst_complaints m ON m.row_id = li.id)                      AS complaints,
       clinical.clean(h.agencompremarks)               AS complaint_notes,
       (SELECT string_agg(clinical.clean(m.tillness), ', ' ORDER BY li.o)
          FROM unnest(clinical.id_list(h.systemic_illness)) WITH ORDINALITY li(id, o)
          JOIN yarago.tbl_mst_sysillness m ON m.aillness_id = li.id)                AS systemic_illness,
       clinical.clean(h.agensysillremarks)             AS systemic_notes,
       (SELECT string_agg(clinical.clean(m.tdrugallergy), ', ' ORDER BY li.o)
          FROM unnest(clinical.id_list(h.drug_allergies)) WITH ORDINALITY li(id, o)
          JOIN yarago.tbl_mst_drugallergy m ON m.adrug_id = li.id)                  AS drug_allergies,
       (SELECT string_agg(clinical.clean(m.tcontent), ', ' ORDER BY li.pos)
          FROM clinical.list_items(h.opthalamic_history, h.opht_right, h.opht_left) li
          JOIN yarago.tbl_mst_ophthalmic_history m ON m.arow_id = li.id)            AS ophthalmic_history,
       clinical.clean(h.opthalmic_remarks)             AS ophthalmic_notes,
       clinical.clean(h.medicinename)                  AS medicines,
       clinical.clean(h.medinstruction)                AS medicine_instructions,
       (SELECT string_agg(clinical.clean(m.content), '; ' ORDER BY li.pos)
          FROM clinical.list_items(h.advice_id, h.advice_r_value, h.advice_l_value) li
          JOIN yarago.tbl_mst_advice m ON m.rowid = li.id)                          AS advice,
       clinical.clean(h.remarks)                       AS doctor_remarks,
       clinical.to_date_safe(h.followup)               AS followup_date,
       clinical.num(h.followup_indays)::int            AS followup_in_days,
       clinical.num(h.followup_inmonths)::int          AS followup_in_months,
       (h.adilatationstatus = 2)                       AS dilated,
       (s.issurgery = 1)                               AS surgery_advised
FROM yarago.tblappointments a
LEFT JOIN yarago.tblappointmenttype vt ON vt.aappoint_type_id = a.nappoint_type_id
LEFT JOIN yarago.tbldoctor d           ON d.adoctor_id = a.ndoctor_id
LEFT JOIN app.code_labels sl           ON sl.kind = 'appointment_status' AND sl.code = a.nstatus_id
LEFT JOIN yarago.tbl_patient_appointment_history h ON h.nappoint_id = a.aappoint_id
LEFT JOIN LATERAL (SELECT * FROM yarago.tbloptometryexamination x
                   WHERE x.nappointment_id = a.aappoint_id ORDER BY x.aoe_id DESC LIMIT 1) o ON true
LEFT JOIN LATERAL (SELECT * FROM yarago.tblpatientissurgery x
                   WHERE x.nappoint_id = a.aappoint_id ORDER BY x.ps_id DESC LIMIT 1) s ON true;

-- ---------- examination findings per visit (one row per finding) -----------------------
CREATE OR REPLACE VIEW clinical.visit_exam_finding AS
SELECT h.nappoint_id                                   AS visit_id,
       h.npatient_id                                   AS patient_id,
       li.pos                                          AS position,
       clinical.clean(part.teyeparts)                  AS eye_part,
       clinical.clean(c.texamination_for_eyepart_name) AS finding,
       CASE WHEN li.re AND li.le THEN 'BE' WHEN li.re THEN 'RE' WHEN li.le THEN 'LE' END AS eye
FROM yarago.tbl_patient_appointment_history h
CROSS JOIN LATERAL clinical.list_items(h.examination_history, h.examination_right, h.examination_left) li
LEFT JOIN yarago.tbleyeparts_examination_child c ON c.arow_id = li.id
LEFT JOIN yarago.tbl_mst_eyeparts_examination part ON part.arow_id = c.nmst_mst_eyeparts_examination_id;

-- ---------- vision / IOP trend (only visits with a value) ------------------------------
CREATE OR REPLACE VIEW clinical.va_iop_trend AS
SELECT patient_id, visit_id, visit_date,
       bcva_re, bcva_le,
       clinical.va_logmar(bcva_re) AS bcva_logmar_re,
       clinical.va_logmar(bcva_le) AS bcva_logmar_le,
       va_unaided_re, va_unaided_le,
       iop_re, iop_le
FROM clinical.visit
WHERE coalesce(bcva_re, bcva_le, va_unaided_re, va_unaided_le) IS NOT NULL
   OR coalesce(iop_re, iop_le) IS NOT NULL;

-- ---------- injections -----------------------------------------------------------------
CREATE OR REPLACE VIEW clinical.injection AS
WITH i AS (
  SELECT x.aid                                                       AS injection_id,
         x.npatid                                                    AS patient_id,
         x.napptid                                                   AS visit_id,
         x.fromnormalapptid                                          AS advised_at_visit_id,
         coalesce(x.dateoftreatment, x.apptdate)                     AS treated_at,
         x.apptdate                                                  AS scheduled_at,
         (x.isinjectiongiven = 'Yes')                                AS given,
         clinical.clean(x.procedurename)                             AS procedure,
         clinical.clean(x.drugsuggested)                             AS drug,
         coalesce(clinical.eye(x.drugsuggestedeye), clinical.eye(x.eyetobeoperated), clinical.eye(x.procedurename)) AS eye,
         x.followupdate                                              AS followup_date,
         clinical.clean(x.injapptremarks)                            AS remarks,
         clinical.clean(x.followupcomments)                          AS followup_comments
  FROM yarago.tblpatientinjectionopdinvestigationdetials x
  WHERE coalesce(x.isdeleted, 0) = 0
)
SELECT i.*,
       CASE WHEN i.given THEN row_number() OVER (PARTITION BY i.patient_id, i.eye, i.given ORDER BY i.treated_at, i.injection_id) END
         AS injection_number_for_eye
FROM i;

-- ---------- lasers (one row per eye) ---------------------------------------------------
CREATE OR REPLACE VIEW clinical.laser AS
SELECT alaserid AS laser_id, npatid AS patient_id, napptid AS visit_id, fromnormalapptid AS advised_at_visit_id,
       coalesce(dateoftreatment, apptdate) AS treated_at, 'RE'::text AS eye,
       clinical.clean(adviced_procedurename_re) AS advised, clinical.clean(proceduredonename_re) AS done,
       clinical.clean(remarks_re) AS remarks, clinical.clean(complecations_re) AS complications
FROM yarago.tblpatientlaseropdinvestigationdetials
WHERE coalesce(isdeleted, 0) = 0 AND coalesce(clinical.clean(adviced_procedurename_re), clinical.clean(proceduredonename_re)) IS NOT NULL
UNION ALL
SELECT alaserid, npatid, napptid, fromnormalapptid,
       coalesce(dateoftreatment, apptdate), 'LE',
       clinical.clean(adviced_procedurename_le), clinical.clean(proceduredonename_le),
       clinical.clean(remarks_le), clinical.clean(complecations_le)
FROM yarago.tblpatientlaseropdinvestigationdetials
WHERE coalesce(isdeleted, 0) = 0 AND coalesce(clinical.clean(adviced_procedurename_le), clinical.clean(proceduredonename_le)) IS NOT NULL;

-- ---------- follow-ups: did the patient come back? ------------------------------------
CREATE OR REPLACE VIEW clinical.followup AS
SELECT f.afollowid                              AS followup_id,
       f.npatient_id                            AS patient_id,
       f.current_appointment_id                 AS from_visit_id,
       src.tappoint_date_time::date             AS from_visit_date,
       f.follow_up_date::date                   AS due_date,
       f.appointment_status                     AS status_id,
       fl.label                                 AS status,
       f.realised_appointment_id,
       nxt.visit_id                             AS next_visit_id,
       nxt.visit_at::date                       AS next_visit_date,
       (nxt.visit_id IS NOT NULL)               AS came_back,
       CASE WHEN nxt.visit_id IS NULL AND f.follow_up_date::date < current_date
            THEN current_date - f.follow_up_date::date END AS days_overdue,
       clinical.clean(f.comments)               AS comments,
       f.updated_date
FROM yarago.tblfollowuppatientdetails f
LEFT JOIN yarago.tblappointments src ON src.aappoint_id = f.current_appointment_id
LEFT JOIN app.code_labels fl ON fl.kind = 'followup_status' AND fl.code = f.appointment_status
LEFT JOIN LATERAL (
  SELECT a.aappoint_id AS visit_id, a.tappoint_date_time AS visit_at
  FROM yarago.tblappointments a
  WHERE a.npatient_id = f.npatient_id
    AND a.aappoint_id <> f.current_appointment_id
    AND a.tappoint_date_time > coalesce(src.tappoint_date_time, f.inserted_date)
  ORDER BY a.tappoint_date_time LIMIT 1) nxt ON true
WHERE coalesce(f.isactive, 1) = 1;

-- ---------- patient flow: time at each station -----------------------------------------
CREATE OR REPLACE VIEW clinical.patient_flow AS
SELECT t.aid                                     AS flow_id,
       t.napptid                                 AS visit_id,
       t.npatid                                  AS patient_id,
       t.nmoduletimerid                          AS station_id,
       clinical.clean(m.modulename)              AS station,
       t.startdatetime                           AS started_at,
       t.enddatetime                             AS ended_at,
       CASE WHEN t.enddatetime >= t.startdatetime
            THEN round(extract(epoch FROM t.enddatetime - t.startdatetime) / 60.0, 1) END AS minutes
FROM yarago.tbltimerpatientwaiting t
LEFT JOIN yarago.tbltimermodulewise m ON m.amoduletimerid = t.nmoduletimerid
WHERE coalesce(t.isdeleted, 0) = 0;

-- ---------- outstanding dues per patient -----------------------------------------------
CREATE OR REPLACE VIEW clinical.patient_due AS
SELECT DISTINCT ON (d.npatientid)
       d.npatientid                               AS patient_id,
       round(d.dueamttowardshospital::numeric, 2) AS due_total,          -- patient owes the clinic
       round(d.opddueamt::numeric, 2)             AS due_opd,
       round(d.pharmacydueamt::numeric, 2)        AS due_pharmacy,
       round(d.opticaldueamt::numeric, 2)         AS due_optical,
       round(d.ipddueamt::numeric, 2)             AS due_ipd,
       d.modifieddate                             AS updated_at,
       round(d.dueamttowardspatient::numeric, 2)  AS clinic_owes_patient  -- refunds / advances (new columns go last)
FROM yarago.tbl_patient_payment_mainduedetails d
WHERE coalesce(d.isactive, 1) = 1 AND coalesce(d.isdeleted, 0) = 0
ORDER BY d.npatientid, d.modifieddate DESC NULLS LAST, d.amainduerowid DESC;
