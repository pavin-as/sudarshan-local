-- Readable audit feed (lives in views/ because it joins clinical.patient).
-- Re-applied on every migrate, so functions here are CREATE OR REPLACE.

-- ---------- readable audit feed ------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_value_text(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL OR v = 'null'::jsonb THEN '(empty)'
    WHEN jsonb_typeof(v) = 'array' THEN coalesce(nullif((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(v) x), ''), '(none)')
    WHEN jsonb_typeof(v) = 'boolean' THEN CASE WHEN v::text = 'true' THEN 'yes' ELSE 'no' END
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' THEN to_char((v #>> '{}')::date, 'DD Mon YYYY')
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^\d{2}:\d{2}(:\d{2})?$' THEN left(v #>> '{}', 5)
    ELSE v #>> '{}'
  END
$$;

-- ids shown as names (doctor, staff)
CREATE OR REPLACE FUNCTION app.audit_field_text(p_field text, v jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN v IS NULL OR v = 'null'::jsonb THEN '(empty)'
    WHEN p_field = 'doctor_id' AND (v #>> '{}') ~ '^\d+$'
      THEN coalesce((SELECT name FROM app.doctors WHERE id = (v #>> '{}')::int), v #>> '{}')
    WHEN p_field IN ('booked_by','cancelled_by','confirmed_4day_by','confirmed_1day_by','created_by','decision_by','actor_id','user_id','requested_by')
         AND (v #>> '{}') ~ '^\d+$'
      THEN coalesce((SELECT full_name FROM app.users WHERE id = (v #>> '{}')::int), v #>> '{}')
    ELSE app.audit_value_text(v)
  END
$$;

CREATE OR REPLACE FUNCTION app.audit_changes_text(p_entity text, p_action text, p_changes jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_changes IS NULL THEN NULL
    WHEN p_action LIKE '%.update' THEN (
      SELECT string_agg(coalesce(l.label, initcap(replace(c.key, '_', ' '))) || ': ' ||
                        CASE WHEN coalesce(l.hidden, false) THEN 'changed'
                             ELSE app.audit_field_text(c.key, c.value -> 'from') || ' → ' || app.audit_field_text(c.key, c.value -> 'to') END,
                        '; ' ORDER BY c.key)
      FROM jsonb_each(p_changes) c
      LEFT JOIN app.field_labels l ON l.entity_type = p_entity AND l.field = c.key)
    ELSE (
      SELECT string_agg(l.label || ': ' || CASE WHEN l.hidden THEN 'set' ELSE app.audit_field_text(c.key, c.value) END, '; ' ORDER BY l.label)
      FROM jsonb_each(p_changes) c
      JOIN app.field_labels l ON l.entity_type = p_entity AND l.field = c.key)
  END
$$;


CREATE OR REPLACE VIEW app.audit_feed AS
SELECT a.id,
       a.at,
       to_char(a.at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI')         AS when_text,
       coalesce(u.full_name, CASE a.source WHEN 'import' THEN 'Import' WHEN 'job' THEN 'System' ELSE 'Unknown' END) AS who,
       CASE split_part(a.action, '.', 2) WHEN 'insert' THEN 'Added' WHEN 'update' THEN 'Changed' WHEN 'delete' THEN 'Removed' END
         || ' ' || replace(rtrim(a.entity_type, 's'), '_', ' ')                    AS what,
       coalesce(a.summary,
                CASE split_part(a.action, '.', 2) WHEN 'insert' THEN 'Added' WHEN 'update' THEN 'Changed' ELSE 'Removed' END
                || ' ' || replace(rtrim(a.entity_type, 's'), '_', ' ') || ' #' || a.entity_id) AS summary,
       app.audit_changes_text(a.entity_type, a.action, a.changes)                AS details,
       a.patient_id,
       p.mrd,
       p.name                                                                    AS patient_name,
       a.entity_type, a.entity_id, a.source, a.actor_id
FROM app.audit_log a
LEFT JOIN app.users u ON u.id = a.actor_id
LEFT JOIN clinical.patient p ON p.patient_id = a.patient_id;

