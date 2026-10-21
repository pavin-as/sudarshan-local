-- Payment links stay open 15 minutes (D-035), set in minutes instead of hours. Replaces payments.link_hours.
INSERT INTO app.settings (key, value, description) VALUES
  ('payments.link_minutes', '15'::jsonb, 'Payment link: minutes the link stays open (15 to 10080)')
ON CONFLICT (key) DO NOTHING;
DELETE FROM app.settings WHERE key = 'payments.link_hours';
