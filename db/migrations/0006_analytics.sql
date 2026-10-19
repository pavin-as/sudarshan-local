-- =====================================================================================
-- 0006: analytics schema - one source for every reported number (D-020, PLAN "Analytics and business intelligence").
-- Rebuilt nightly by analytics.refresh() (sync service, 02:30). Read by Metabase as sudarshan_bi, which can see this
-- schema and nothing else. Patients appear only as a random key and an age band: no name, phone, MRD, address or
-- free text typed by staff. Derived data, rebuilt from scratch: not audited.
-- =====================================================================================
CREATE SCHEMA IF NOT EXISTS analytics;

-- Random, stable key per Yarago patient. Kept in app (not readable by sudarshan_bi), so a key cannot be traced back.
CREATE TABLE IF NOT EXISTS app.analytics_patient_key (
  patient_id   integer PRIMARY KEY,
  patient_key  bigint NOT NULL UNIQUE DEFAULT (floor(random() * 9e15))::bigint + 1000000
);

-- ---------- reference: category rules --------------------------------------------------
-- Yarago records no diagnosis (the coded diagnosis link is empty and both "final diagnosis" text fields hold the visit
-- plan, e.g. "ref+dil", "re ivr"). So two groupings are derived by rules, each a case-insensitive regular expression,
-- first match by priority wins:
--   kind 'diagnosis': over the visit's coded examination findings, as "FUNDUS: SEVERE NPDR; LENS: PC IOL +"
--   kind 'purpose':   over the visit plan note ("re oct, ref+dil, post inj case")
-- Proposed by Claude; Dr. Sameera approves (approved = true). Re-running this migration updates unapproved rules only.
CREATE TABLE IF NOT EXISTS analytics.category_rule (
  kind       text NOT NULL CHECK (kind IN ('diagnosis', 'purpose')),
  priority   integer NOT NULL,
  category   text NOT NULL,
  pattern    text NOT NULL,
  approved   boolean NOT NULL DEFAULT false,
  note       text,
  PRIMARY KEY (kind, priority)
);
INSERT INTO analytics.category_rule (kind, priority, category, pattern, note) VALUES
  ('diagnosis', 10,  'ROP / ROP screening',              '\mrop\M|\mzone\M|mature retina|plus disease|prematurity', 'mature retina = screening, no ROP'),
  ('diagnosis', 20,  'Retinal detachment',               '\m(rd|rrd|trd)\M|detachment', NULL),
  ('diagnosis', 30,  'Retinal vein occlusion',           '\m(brvo|crvo|hrvo|rvo)\M|vein occlusion', NULL),
  ('diagnosis', 40,  'Diabetic retinopathy / DME',       'npdr|\mpdr\M|diabetic|\mcsme\M|\mdme\M|\mnv[de]\M', 'includes lasered PDR'),
  ('diagnosis', 50,  'Age-related macular degeneration', '\m(armd|amd|cnvm?|pcv)\M|drusen|disciform', NULL),
  ('diagnosis', 60,  'Macular hole / ERM / VMT',         '\m(erm|fthm|lmh|vmt)\M|macular hole|epiretinal', NULL),
  ('diagnosis', 70,  'CSCR',                             '\mcscr?\M|central serous', NULL),
  ('diagnosis', 80,  'Uveitis',                          'uveitis|vitritis|choroiditis|retinitis|\mkps?\M', NULL),
  ('diagnosis', 90,  'Vitreous haemorrhage',             '\mvh\M|vitreous ha?emorrhage', NULL),
  ('diagnosis', 100, 'Hypertensive retinopathy',         'hypertensive retinopathy', NULL),
  ('diagnosis', 110, 'Myopic fundus / degeneration',     'myopic|lattice|staphyloma', NULL),
  ('diagnosis', 120, 'Glaucoma / suspect',               'glaucom|\mcd - (0\.[6-9]|1)|cupping|\mpi\M|shallow', 'CD 0.6 or more, PI, shallow AC'),
  ('diagnosis', 130, 'Cataract',                         'cataract|\m(simc|imc|nsc|psc|lo)\M', NULL),
  ('diagnosis', 140, 'After cataract surgery',           'pc ?iol|pseudophak|aphak', NULL),
  ('diagnosis', 150, 'Squint / amblyopia',               'cover test|squint|tropia|phoria|amblyop', NULL),
  ('diagnosis', 160, 'Normal',                           '\mnormal\M', NULL),
  ('purpose',   10,  'ROP clinic',                       '\mrop\M', NULL),
  ('purpose',   20,  'Review after injection / laser / surgery', 'post inj|post yag|post laser|r/w after|review after|after (cat|vr) sx', NULL),
  ('purpose',   30,  'Injection',                        '\m(ivr|ivta|ozurdex|faricimab|eylea|brolucizumab|razumab|avastin|inj)\M|injection', NULL),
  ('purpose',   40,  'Laser',                            'prp|laser|barrage|\myag\M|focal|grid|sectoral', NULL),
  ('purpose',   50,  'Squint / Bynocs / myopia clinic',  'squint|bynocs|amblyop|myopia clinic', NULL),
  ('purpose',   60,  'Glaucoma work-up (AT, Gonio, HFA)','\m(at|gonio|hfa|perimetry|onh)\M', NULL),
  ('purpose',   70,  'OCT and examination',              '\moct\M', NULL),
  ('purpose',   80,  'Dilated examination',              '\mdil', NULL),
  ('purpose',   90,  'Refraction only',                  '\mref\M|refraction|homide', NULL),
  ('purpose',   100, 'Review with reports',              'r/w|review', NULL),
  ('purpose',   110, 'Direct OPD',                       'direct opd|urgent', NULL),
  ('purpose',   120, 'Investigations',                   'spd inv|\minv\M', NULL)
ON CONFLICT (kind, priority) DO UPDATE SET category = EXCLUDED.category, pattern = EXCLUDED.pattern, note = EXCLUDED.note
  WHERE NOT analytics.category_rule.approved;

-- Labels when no rule matches avoid the word "Other", which Metabase uses for its own "Other (n)" group.
CREATE OR REPLACE FUNCTION analytics.categorise(rule_kind text, t text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t IS NULL OR btrim(t) = '' THEN CASE rule_kind WHEN 'diagnosis' THEN 'No findings recorded' ELSE 'No plan note' END
              ELSE coalesce((SELECT category FROM analytics.category_rule WHERE kind = rule_kind AND t ~* pattern ORDER BY priority LIMIT 1),
                            CASE rule_kind WHEN 'diagnosis' THEN 'No specific finding' ELSE 'Plan note not grouped' END) END
$$;

-- ---------- reference: KPI definitions (also in docs/METRICS.md) ------------------------
CREATE TABLE IF NOT EXISTS analytics.metric_definitions (
  key         text PRIMARY KEY,
  area        text NOT NULL,
  name        text NOT NULL,
  definition  text NOT NULL,
  formula     text NOT NULL,
  unit        text,
  target      text,
  owner       text
);
INSERT INTO analytics.metric_definitions (key, area, name, definition, formula, unit, owner) VALUES
 ('visits', 'Volume', 'Visits', 'Completed Yarago visits (status 3), by new vs returning, doctor, visit type.',
  'count(*) FROM fact_visit WHERE completed', 'visits', 'Pavin'),
 ('slot_utilisation', 'Volume', 'Slot utilisation', 'Bookings with a time, not cancelled, divided by the maximum slots of each open day.',
  'sum(timed bookings not cancelled) / sum(dim_date.max_slots) over open days', '%', 'Pavin'),
 ('followup_overdue_rate', 'Leakage', 'Follow-up overdue rate', 'Follow-ups due in the period (at least 14 days ago) where the patient did not come back within 14 days of the due date.',
  'count(*) FILTER (WHERE NOT returned_within_14d) / count(*) FROM fact_followup WHERE due_date <= current_date - 14', '%', 'Dr. Sameera'),
 ('injection_adherence', 'Leakage', 'Injection adherence', 'After each injection given: did the patient come back for the first follow-up Yarago planned, no later than its due date + 7 days. (Yarago has no planned date for the next dose itself.)',
  'count(*) FILTER (WHERE next_on_time) / count(next_on_time) FROM fact_treatment WHERE kind = ''injection''', '%', 'Dr. Sameera'),
 ('advised_not_done', 'Leakage', 'Advised, not done', 'Injections or lasers advised over 60 days ago with no procedure done for that patient, eye and kind since.',
  'count(*) FROM fact_treatment WHERE advised_not_done', 'treatments', 'Dr. Sameera'),
 ('did_not_come_rate', 'Leakage', 'Did-not-come rate', 'Past bookings with a time that were not cancelled and had no Yarago visit that day, divided by all such past bookings.',
  'count(*) FILTER (WHERE did_not_come) / count(*) FROM fact_appointment WHERE timed AND NOT cancelled AND appointment_date < current_date', '%', 'Pavin'),
 ('time_per_station', 'Flow', 'Time per station', 'Median and 90th percentile minutes: waiting for optometry, optometry (incl. dilation), waiting for doctor, with doctor, total in clinic.',
  'percentile_cont(0.5 / 0.9) of fact_visit.*_min', 'minutes', 'Pavin'),
 ('confirmation_calls', 'Front desk', 'Confirmation calls done', 'Past bookings with a time, not cancelled, that had the 4-day / the 1-day confirmation call recorded.',
  'count(*) FILTER (WHERE confirmed_4day) / count(*) over past timed bookings not cancelled', '%', 'Front desk'),
 ('reschedules_cancellations', 'Front desk', 'Reschedules and cancellations', 'Bookings moved and bookings cancelled, with the reason group and days before the appointment.',
  'sum(rescheduled_count); count(*) FILTER (WHERE cancelled)', 'bookings', 'Front desk'),
 ('revenue', 'Money', 'Revenue per visit and per service', 'Billed amount (bill lines, after concession) by service group; optical orders separately; per completed visit.',
  'sum(amount) FROM fact_billing', '₹', 'Pavin'),
 ('collections_dues', 'Money', 'Collections and dues ageing', 'Collected = cash + card + cheque + other on each bill. Dues = what patients owe now, by days since last change (0-30, 31-90, over 90).',
  'sum(paid) FROM fact_bill; sum(due_total) FROM fact_due GROUP BY age_band', '₹', 'Pavin')
ON CONFLICT (key) DO UPDATE SET area = EXCLUDED.area, name = EXCLUDED.name, definition = EXCLUDED.definition,
  formula = EXCLUDED.formula, unit = EXCLUDED.unit;

-- ---------- dimensions -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.dim_date (
  date            date PRIMARY KEY,
  weekday         text NOT NULL,          -- Mon .. Sun
  iso_weekday     smallint NOT NULL,      -- 1 = Monday
  week_start      date NOT NULL,          -- Monday of the week
  month           text NOT NULL,          -- 2026-10
  month_start     date NOT NULL,
  year            smallint NOT NULL,
  fy              text NOT NULL,          -- FY 2026-27 (April - March)
  fy_quarter      text NOT NULL,          -- Q1 = Apr-Jun
  is_holiday      boolean NOT NULL,
  max_slots       integer,
  open_for_booking boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics.dim_doctor (
  doctor          text PRIMARY KEY,       -- as Yarago / Sudarshan name the doctor
  in_yarago       boolean NOT NULL,
  in_sudarshan    boolean NOT NULL,
  active          boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics.dim_patient (
  patient_key      bigint PRIMARY KEY,
  age_band         text,                  -- 0-17, 18-39, 40-59, 60-74, 75+
  sex              text,                  -- M / F / O
  first_visit_date date,
  first_visit_month text,
  completed_visits integer NOT NULL,
  injections_given integer NOT NULL
);

-- ---------- facts --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.fact_visit (
  visit_id            integer PRIMARY KEY,   -- Yarago appointment id
  patient_key         bigint,
  visit_date          date NOT NULL,
  doctor              text,
  visit_type          text,
  status              text,
  completed           boolean NOT NULL,
  new_patient         boolean NOT NULL,      -- the patient's first completed visit
  dilated             boolean,
  diagnosis_category  text NOT NULL,         -- from coded examination findings (category_rule kind 'diagnosis')
  visit_purpose       text NOT NULL,         -- from the visit plan note (category_rule kind 'purpose')
  check_in_hour       smallint,
  wait_for_optometry_min numeric,
  optometry_min       numeric,
  wait_for_doctor_min numeric,
  with_doctor_min     numeric,
  total_min           numeric,
  billed_amount       numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fact_visit_date_idx ON analytics.fact_visit (visit_date);

CREATE TABLE IF NOT EXISTS analytics.fact_appointment (
  appointment_id      bigint PRIMARY KEY,    -- Sudarshan booking id
  patient_key         bigint,
  booked_date         date,                  -- null = not known (imported without a booking date)
  appointment_date    date NOT NULL,
  lead_days           integer,
  timed               boolean NOT NULL,      -- false = waitlist
  slot_hour           smallint,
  doctor              text,
  source              text,                  -- booking / direct_call / followup / cancel_list / import
  status              text NOT NULL,
  new_patient         boolean NOT NULL,
  attended            boolean NOT NULL,
  did_not_come        boolean NOT NULL,
  cancelled           boolean NOT NULL,
  cancel_reason_group text,                  -- grouped; the typed reason itself is not copied here
  cancelled_days_before integer,
  rescheduled_count   integer NOT NULL,
  confirmed_4day      boolean NOT NULL,
  confirmed_1day      boolean NOT NULL,
  imported            boolean NOT NULL       -- booked in the Google app
);
CREATE INDEX IF NOT EXISTS fact_appointment_date_idx ON analytics.fact_appointment (appointment_date);

CREATE TABLE IF NOT EXISTS analytics.fact_followup (
  followup_id         integer PRIMARY KEY,   -- Yarago follow-up id
  patient_key         bigint,
  from_visit_date     date,
  due_date            date,
  came_back           boolean NOT NULL,
  next_visit_date     date,
  days_late           integer,               -- came back: next visit - due date (negative = early)
  days_overdue        integer,               -- not back yet and past due
  returned_within_14d boolean NOT NULL,
  state               text NOT NULL,
  calls_made          integer NOT NULL,
  last_call_outcome   text
);
CREATE INDEX IF NOT EXISTS fact_followup_due_idx ON analytics.fact_followup (due_date);

CREATE TABLE IF NOT EXISTS analytics.fact_treatment (
  kind                text NOT NULL,         -- injection / laser
  source_id           integer NOT NULL,      -- Yarago injection or laser row
  eye                 text NOT NULL DEFAULT '',
  patient_key         bigint,
  advised_date        date,
  scheduled_date      date,
  treated_date        date,
  done                boolean NOT NULL,
  item                text,                  -- drug or laser procedure
  dose_number         integer,               -- injections: nth injection for that eye
  days_since_previous integer,
  next_due_date       date,                  -- injections: first follow-up Yarago planned after it
  next_visit_date     date,                  -- the patient's next visit after that follow-up was set
  next_on_time        boolean,               -- came back by due + 7 days; null until then
  advised_not_done    boolean NOT NULL,
  PRIMARY KEY (kind, source_id, eye)
);

CREATE TABLE IF NOT EXISTS analytics.fact_bill (
  bill_id             integer PRIMARY KEY,
  bill_date           date NOT NULL,
  patient_key         bigint,
  visit_id            integer,
  total               numeric NOT NULL,
  discount            numeric NOT NULL,
  paid                numeric NOT NULL,
  paid_cash           numeric NOT NULL,
  paid_card           numeric NOT NULL,
  paid_other          numeric NOT NULL,
  due_after_bill      numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_bill_date_idx ON analytics.fact_bill (bill_date);

CREATE TABLE IF NOT EXISTS analytics.fact_billing (
  line_id             text PRIMARY KEY,      -- source table + row id
  bill_id             integer,
  bill_date           date NOT NULL,
  patient_key         bigint,
  visit_id            integer,
  service_group       text NOT NULL,         -- Consultation & charges / Investigations / Injections / Lasers / Other procedures / Others / Optical
  item                text,
  amount              numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_billing_date_idx ON analytics.fact_billing (bill_date);

CREATE TABLE IF NOT EXISTS analytics.fact_due (
  patient_key         bigint PRIMARY KEY,
  due_total           numeric NOT NULL,
  since_date          date,
  age_days            integer,
  age_band            text NOT NULL          -- 0-30 / 31-90 / over 90 days
);

CREATE TABLE IF NOT EXISTS analytics.refresh_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL,
  counts      jsonb,
  message     text
);

-- Findings and plan notes (last 12 months) that matched no rule, for Dr. Sameera to classify.
-- Lives in app: free text stays out of analytics.
CREATE OR REPLACE VIEW app.analytics_unmatched AS
SELECT 'diagnosis' AS kind, f.eye_part || ': ' || f.finding AS text, count(DISTINCT f.visit_id) AS visits
FROM clinical.visit_exam_finding f
JOIN yarago.tblappointments a ON a.aappoint_id = f.visit_id
WHERE a.tappoint_date_time >= current_date - 365
  AND analytics.categorise('diagnosis', f.eye_part || ': ' || f.finding) = 'No specific finding'
GROUP BY 1, 2
UNION ALL
SELECT 'purpose', lower(clinical.clean(h.final_diagnosis)), count(*)
FROM yarago.tbl_patient_appointment_history h
JOIN yarago.tblappointments a ON a.aappoint_id = h.nappoint_id
WHERE a.tappoint_date_time >= current_date - 365
  AND analytics.categorise('purpose', clinical.clean(h.final_diagnosis)) = 'Plan note not grouped'
GROUP BY 1, 2;

-- ---------- the nightly rebuild --------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.refresh() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  log_id bigint;
  totals jsonb;
BEGIN
  INSERT INTO analytics.refresh_log (status) VALUES ('running') RETURNING id INTO log_id;

  INSERT INTO app.analytics_patient_key (patient_id)
  SELECT apatient_id FROM yarago.tblpatientregistration ON CONFLICT DO NOTHING;
  INSERT INTO app.analytics_patient_key (patient_id)
  SELECT DISTINCT patient_id FROM app.appointments WHERE patient_id IS NOT NULL ON CONFLICT DO NOTHING;

  TRUNCATE analytics.dim_date, analytics.dim_doctor, analytics.dim_patient, analytics.fact_visit, analytics.fact_appointment,
           analytics.fact_followup, analytics.fact_treatment, analytics.fact_bill, analytics.fact_billing, analytics.fact_due;

  -- dates
  INSERT INTO analytics.dim_date
  SELECT d::date, to_char(d, 'Dy'), extract(isodow FROM d)::smallint, date_trunc('week', d)::date, to_char(d, 'YYYY-MM'),
         date_trunc('month', d)::date, extract(year FROM d)::smallint,
         'FY ' || fy || '-' || right((fy + 1)::text, 2),
         'Q' || ((extract(month FROM d)::int + 8) % 12 / 3 + 1),
         h.on_date IS NOT NULL, c.max_slots, coalesce(c.max_slots, 0) > 0 AND h.on_date IS NULL
  FROM generate_series(date '2015-01-01', current_date + 180, interval '1 day') d
  CROSS JOIN LATERAL (SELECT extract(year FROM d)::int - CASE WHEN extract(month FROM d) < 4 THEN 1 ELSE 0 END AS fy) f
  LEFT JOIN app.holidays h ON h.on_date = d::date
  LEFT JOIN app.day_capacity c ON c.on_date = d::date;

  -- doctors
  INSERT INTO analytics.dim_doctor
  SELECT name, bool_or(y), bool_or(s), bool_or(active)
  FROM (SELECT clinical.clean(tdoctorname) AS name, true AS y, false AS s, true AS active FROM yarago.tbldoctor
        UNION ALL SELECT name, false, true, is_active FROM app.doctors) x
  WHERE name IS NOT NULL GROUP BY name;

  -- visits (findings gathered once: the view decodes id lists per visit)
  DROP TABLE IF EXISTS visit_findings;
  CREATE TEMP TABLE visit_findings ON COMMIT DROP AS
  SELECT visit_id, string_agg(eye_part || ': ' || finding, '; ') AS findings
  FROM clinical.visit_exam_finding WHERE finding IS NOT NULL GROUP BY visit_id;
  CREATE INDEX ON visit_findings (visit_id);

  INSERT INTO analytics.fact_visit
  SELECT a.aappoint_id, k.patient_key, a.tappoint_date_time::date, clinical.clean(d.tdoctorname), clinical.clean(vt.tappoint_type),
         sl.label, a.nstatus_id = 3, false, h.adilatationstatus = 2,
         analytics.categorise('diagnosis', vf.findings), analytics.categorise('purpose', clinical.clean(h.final_diagnosis)),
         extract(hour FROM tl.check_in_at)::smallint,
         tl.wait_for_optometry_min, tl.optometry_min, tl.wait_for_doctor_min, tl.with_doctor_min, tl.total_min, 0
  FROM yarago.tblappointments a
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = a.npatient_id
  LEFT JOIN yarago.tbldoctor d ON d.adoctor_id = a.ndoctor_id
  LEFT JOIN yarago.tblappointmenttype vt ON vt.aappoint_type_id = a.nappoint_type_id
  LEFT JOIN app.code_labels sl ON sl.kind = 'appointment_status' AND sl.code = a.nstatus_id
  LEFT JOIN LATERAL (SELECT final_diagnosis, adilatationstatus FROM yarago.tbl_patient_appointment_history x
                     WHERE x.nappoint_id = a.aappoint_id LIMIT 1) h ON true
  LEFT JOIN clinical.visit_timeline tl ON tl.visit_id = a.aappoint_id
  LEFT JOIN visit_findings vf ON vf.visit_id = a.aappoint_id
  WHERE a.tappoint_date_time IS NOT NULL;

  UPDATE analytics.fact_visit v SET new_patient = true
  FROM (SELECT DISTINCT ON (patient_key) visit_id FROM analytics.fact_visit WHERE completed AND patient_key IS NOT NULL
        ORDER BY patient_key, visit_date, visit_id) f
  WHERE v.visit_id = f.visit_id;

  -- bills, bill lines, optical, dues
  INSERT INTO analytics.fact_bill
  SELECT b.id_nbillid, b.billingdate::date, k.patient_key, b.nappointmentid,
         coalesce(b.totalamount, 0), coalesce(b.discountamount, 0),
         coalesce(b.cashamount, 0) + coalesce(b.cardamount, 0) + coalesce(b.chequeamount, 0) + coalesce(b.otherpaymentamt, 0),
         coalesce(b.cashamount, 0), coalesce(b.cardamount, 0), coalesce(b.chequeamount, 0) + coalesce(b.otherpaymentamt, 0),
         coalesce(b.currentdueamount, 0)
  FROM (SELECT DISTINCT ON (id_nbillid) * FROM yarago.tblpatientsappointmentbillingdetails
        WHERE coalesce(active, 1) = 1 AND id_nbillid IS NOT NULL AND billingdate IS NOT NULL ORDER BY id_nbillid, abilling_id DESC) b
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = b.npatient_id;

  INSERT INTO analytics.fact_billing
  SELECT l.line_id, l.nbillid, coalesce(fb.bill_date, l.d::date), k.patient_key, l.appoint_id, l.grp, l.item, coalesce(l.amount, 0)
  FROM (
    SELECT 'charge-' || r.trow_id AS line_id, r.nbillid, r.tdateofpayment AS d, r.patient_id, r.appoint_id,
           'Consultation & charges' AS grp, initcap(btrim(m.chargetypename)) AS item, r.chargepaidamount AS amount
      FROM yarago.tbl_payment_receptionist_new r LEFT JOIN yarago.tbl_mst_chargetype m ON m.typeid = r.chargetypeid WHERE coalesce(r.active, 1) = 1
    UNION ALL
    SELECT 'lab-' || l.trow_id, l.nbillid, l.tdateofpayment, l.patient_id, l.appoint_id,
           'Investigations', btrim(regexp_replace(m.labtestname, '\s+(RE|LE)\s*$', '', 'i')), l.labpaidamount
      FROM yarago.tbl_payment_lab l LEFT JOIN yarago.tbl_mst_labstudies m ON m.id = l.labtypeid WHERE coalesce(l.active, 1) = 1
    UNION ALL
    SELECT 'proc-' || p.trow_id, p.nbillid, p.tdateofpayment, p.patient_id, p.appoint_id,
           CASE WHEN st.subsurgicaltypename ~* 'laser|barrage|prp|yag|grid|sectoral|focal' THEN 'Lasers'
                WHEN st.subsurgicaltypename ~* 'vitreal|pst|ozurdex|faricimab|inject|razumab|ranibizumab|bevacizumab|aflibercept|eylea|triamcinolone' THEN 'Injections'
                ELSE 'Other procedures' END,
           initcap(btrim(st.subsurgicaltypename)), p.procedureamount
      FROM yarago.tbl_payment_injectionorlaser_procedure_for_billing p
      LEFT JOIN yarago.tbl_mst_sub_surgical_types st ON st.subsurgid = p.procedureid WHERE coalesce(p.active, 1) = 1
    UNION ALL
    SELECT 'other-' || o.others_id, o.nbillid, o.dateofpayment, o.npatient_id, o.nappoint_id, 'Others', 'Other charges', o.amount
      FROM yarago.tbl_payment_others_details o WHERE coalesce(o.active, 1) = 1
    UNION ALL
    SELECT 'optical-' || op.apayid, NULL, op.inserteddate, op.npatid, op.napptid, 'Optical', 'Spectacles / optical order',
           coalesce(op.atotalamount, 0) - coalesce(op.refundamt, 0)
      FROM yarago.tblopticalpatientpayment op WHERE coalesce(op.isactive, 1) = 1
  ) l
  LEFT JOIN analytics.fact_bill fb ON fb.bill_id = l.nbillid
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = l.patient_id
  WHERE coalesce(fb.bill_date, l.d::date) IS NOT NULL;

  UPDATE analytics.fact_visit v SET billed_amount = s.amount
  FROM (SELECT visit_id, sum(amount) AS amount FROM analytics.fact_billing WHERE service_group <> 'Optical' AND visit_id IS NOT NULL GROUP BY 1) s
  WHERE v.visit_id = s.visit_id;

  INSERT INTO analytics.fact_due
  SELECT k.patient_key, d.due_total, d.updated_at::date, current_date - d.updated_at::date,
         CASE WHEN d.updated_at IS NULL THEN 'unknown' WHEN current_date - d.updated_at::date <= 30 THEN '0-30 days'
              WHEN current_date - d.updated_at::date <= 90 THEN '31-90 days' ELSE 'over 90 days' END
  FROM clinical.patient_due d JOIN app.analytics_patient_key k ON k.patient_id = d.patient_id
  WHERE d.due_total > 0;

  -- Sudarshan bookings (practice bookings named TEST / ZZ Test left out)
  INSERT INTO analytics.fact_appointment
  SELECT a.id, k.patient_key, bd.booked_date, a.appointment_date, a.appointment_date - bd.booked_date,
         a.slot_time IS NOT NULL, extract(hour FROM a.slot_time)::smallint, d.name,
         CASE WHEN a.legacy_id IS NOT NULL THEN 'import' ELSE a.source END, a.status,
         CASE WHEN nullif(btrim(a.mrd), '') IS NOT NULL THEN a.mrd ~* '^n'
              ELSE lower(coalesce(a.patient_type, '')) ~ 'new|guest' END,
         att.attended,
         a.appointment_date < current_date AND a.status IN ('booked', 'confirmed', 'no_show') AND NOT att.attended,
         a.status = 'cancelled',
         CASE WHEN a.status <> 'cancelled' THEN NULL
              WHEN a.cancel_reason ~* 'travel|abroad|out of station|gulf|not in (town|station)' THEN 'Travelling'
              WHEN a.cancel_reason ~* 'unwell|sick|fever|ill|hospital|admit|surgery' THEN 'Unwell / in hospital'
              WHEN a.cancel_reason ~* 'doctor|leave|dr\.? ' THEN 'Doctor unavailable'
              WHEN a.cancel_reason ~* 'duplicate|double|wrong|mistake|error' THEN 'Duplicate / entered by mistake'
              WHEN a.cancel_reason ~* 'resched|postpone|another date|later|next (week|month)|prepone' THEN 'Wants another date'
              WHEN a.cancel_reason ~* 'not (coming|interested|needed|required)|no need|other hospital|elsewhere|better' THEN 'Not coming / went elsewhere'
              WHEN a.cancel_reason ~* 'no response|not respond|not reachable|switch(ed)? off|no answer|not answering' THEN 'Could not reach'
              WHEN a.cancel_reason ~* 'death|expired|passed away|died' THEN 'Patient died'
              WHEN a.cancel_reason IS NULL THEN 'No reason given'
              ELSE 'Other' END,
         CASE WHEN a.status = 'cancelled' AND a.cancelled_at IS NOT NULL THEN a.appointment_date - a.cancelled_at::date END,
         coalesce(ev.moves, 0), a.confirmed_4day_at IS NOT NULL, a.confirmed_1day_at IS NOT NULL, a.legacy_id IS NOT NULL
  FROM app.appointments a
  LEFT JOIN app.doctors d ON d.id = a.doctor_id
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = a.patient_id
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE e.event_type = 'rescheduled') AS moves FROM app.appointment_events e WHERE e.appointment_id = a.id) ev ON true
  -- imported bookings without a BookingDate were stamped with the import day: booking date not known
  CROSS JOIN LATERAL (SELECT CASE WHEN a.legacy_id IS NOT NULL AND a.booked_at::date IN
                                       (SELECT DISTINCT (r.started_at AT TIME ZONE 'Asia/Kolkata')::date FROM app.import_runs r)
                                  THEN NULL ELSE a.booked_at::date END AS booked_date) bd
  CROSS JOIN LATERAL (SELECT a.status IN ('checked_in', 'completed')
                          OR (a.patient_id IS NOT NULL AND EXISTS (
                               SELECT 1 FROM yarago.tblappointments y WHERE y.npatient_id = a.patient_id AND y.nstatus_id <> 4
                                  AND y.tappoint_date_time >= a.appointment_date AND y.tappoint_date_time < a.appointment_date + 1)) AS attended) att
  WHERE a.patient_name !~* '^\s*(test|zz test)\M';

  -- follow-ups
  INSERT INTO analytics.fact_followup
  SELECT f.followup_id, k.patient_key, f.from_visit_date, f.due_date, f.came_back, f.next_visit_date,
         CASE WHEN f.came_back THEN f.next_visit_date - f.due_date END, f.days_overdue,
         coalesce(f.came_back AND f.next_visit_date <= f.due_date + 14, false),
         CASE WHEN f.came_back THEN 'returned' WHEN f.due_date >= current_date THEN 'upcoming'
              WHEN f.days_overdue <= 30 THEN 'overdue up to 30 days' WHEN f.days_overdue <= 90 THEN 'overdue 31-90 days'
              WHEN f.days_overdue <= 365 THEN 'overdue 91-365 days' ELSE 'overdue over 1 year' END,
         coalesce(c.calls, 0), c.last_action
  FROM clinical.followup f
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = f.patient_id
  LEFT JOIN LATERAL (SELECT count(*) AS calls, (array_agg(x.action ORDER BY x.at DESC))[1] AS last_action
                     FROM app.followup_actions x WHERE x.yarago_followup_id = f.followup_id) c ON true;

  -- injections and lasers
  INSERT INTO analytics.fact_treatment
  SELECT 'injection', i.injection_id, coalesce(i.eye, ''), k.patient_key, av.tappoint_date_time::date, i.scheduled_at::date,
         CASE WHEN i.given THEN i.treated_at::date END, coalesce(i.given, false), coalesce(i.drug, i.procedure),
         i.injection_number_for_eye,
         CASE WHEN i.given THEN i.treated_at::date - lag(i.treated_at::date) OVER w END,
         NULL, NULL,
         NULL, false
  FROM clinical.injection i
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = i.patient_id
  LEFT JOIN yarago.tblappointments av ON av.aappoint_id = i.advised_at_visit_id
  WINDOW w AS (PARTITION BY i.patient_id, i.eye, coalesce(i.given, false) ORDER BY i.treated_at, i.injection_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO analytics.fact_treatment
  SELECT 'laser', l.laser_id, l.eye, k.patient_key, av.tappoint_date_time::date, l.treated_at::date,
         CASE WHEN l.done IS NOT NULL THEN l.treated_at::date END, l.done IS NOT NULL, coalesce(l.done, l.advised),
         NULL, NULL, NULL, NULL, NULL, false
  FROM clinical.laser l
  LEFT JOIN app.analytics_patient_key k ON k.patient_id = l.patient_id
  LEFT JOIN yarago.tblappointments av ON av.aappoint_id = l.advised_at_visit_id
  ON CONFLICT DO NOTHING;

  -- after each injection: the first follow-up Yarago planned for that patient, and whether they came back by then + 7 days
  UPDATE analytics.fact_treatment t SET next_due_date = f.due_date, next_visit_date = f.next_visit_date
  FROM (SELECT DISTINCT ON (t2.kind, t2.source_id, t2.eye) t2.kind, t2.source_id, t2.eye, x.due_date, x.next_visit_date
        FROM analytics.fact_treatment t2
        JOIN analytics.fact_followup x ON x.patient_key = t2.patient_key AND x.due_date > t2.treated_date
        WHERE t2.kind = 'injection' AND t2.done
        ORDER BY t2.kind, t2.source_id, t2.eye, x.due_date) f
  WHERE t.kind = f.kind AND t.source_id = f.source_id AND t.eye = f.eye;
  UPDATE analytics.fact_treatment SET next_on_time =
    CASE WHEN next_due_date IS NULL THEN NULL
         WHEN next_visit_date IS NOT NULL AND next_visit_date <= next_due_date + 7 THEN true
         WHEN current_date > next_due_date + 7 THEN false END
  WHERE kind = 'injection' AND done;

  UPDATE analytics.fact_treatment t SET advised_not_done = true
  WHERE NOT t.done AND coalesce(t.scheduled_date, t.advised_date) < current_date - 60
    AND NOT EXISTS (SELECT 1 FROM analytics.fact_treatment d WHERE d.done AND d.kind = t.kind AND d.patient_key = t.patient_key
                      AND d.eye = t.eye AND d.treated_date >= coalesce(t.scheduled_date, t.advised_date));

  -- patients (only those with a visit, a booking or a bill)
  INSERT INTO analytics.dim_patient
  SELECT k.patient_key,
         CASE WHEN p.age_years IS NULL THEN NULL WHEN p.age_years < 18 THEN '0-17' WHEN p.age_years < 40 THEN '18-39'
              WHEN p.age_years < 60 THEN '40-59' WHEN p.age_years < 75 THEN '60-74' ELSE '75+' END,
         CASE WHEN p.sex IN ('M', 'F') THEN p.sex WHEN p.sex IS NULL THEN NULL ELSE 'O' END,
         v.first_visit, to_char(v.first_visit, 'YYYY-MM'), coalesce(v.completed, 0), coalesce(t.inj, 0)
  FROM app.analytics_patient_key k
  JOIN clinical.patient p ON p.patient_id = k.patient_id
  LEFT JOIN (SELECT patient_key, min(visit_date) FILTER (WHERE completed) AS first_visit, count(*) FILTER (WHERE completed) AS completed
             FROM analytics.fact_visit GROUP BY 1) v ON v.patient_key = k.patient_key
  LEFT JOIN (SELECT patient_key, count(*) AS inj FROM analytics.fact_treatment WHERE kind = 'injection' AND done GROUP BY 1) t ON t.patient_key = k.patient_key;

  SELECT jsonb_build_object(
    'dim_date', (SELECT count(*) FROM analytics.dim_date), 'dim_patient', (SELECT count(*) FROM analytics.dim_patient),
    'fact_visit', (SELECT count(*) FROM analytics.fact_visit), 'fact_appointment', (SELECT count(*) FROM analytics.fact_appointment),
    'fact_followup', (SELECT count(*) FROM analytics.fact_followup), 'fact_treatment', (SELECT count(*) FROM analytics.fact_treatment),
    'fact_bill', (SELECT count(*) FROM analytics.fact_bill), 'fact_billing', (SELECT count(*) FROM analytics.fact_billing),
    'fact_due', (SELECT count(*) FROM analytics.fact_due)) INTO totals;
  UPDATE analytics.refresh_log SET finished_at = clock_timestamp(), status = 'ok', counts = totals WHERE id = log_id;
  RETURN totals;
END $$;

-- Reporting login (created by scripts/install-metabase.ps1): this schema only, read only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sudarshan_bi') THEN
    GRANT USAGE ON SCHEMA analytics TO sudarshan_bi;
    GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO sudarshan_bi;
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO sudarshan_bi;
  END IF;
END $$;
