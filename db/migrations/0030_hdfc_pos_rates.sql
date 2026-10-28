-- 0030: the clinic's own HDFC POS commercials (D-053), from the bank to Pavin on 28 Oct 2026 for
-- SAMPADAVR SPECIALITY EYE CARE LLP, terminal TID 66027444. They replace the published-schedule placeholders of 0029:
--   RuPay domestic debit and UPI: zero MDR
--   other debit cards: 0.40% up to ₹2,000, 0.90% above (+ tax; no cap stated)
--   credit cards: 1.60% (+ tax); business / commercial and foreign cards: 2.75% (+ tax)
--   service charge ₹116 a month per terminal (₹99 + GST, as the bank lines show ₹116.82); rental waived
-- One set in force from 2020-01-01, so every past day is measured against the agreement. Runs once: later changes are
-- made by the admin under Reconciliation > Bank fees > Rates.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.bank_fee_rates WHERE note LIKE '%TID 66027444%') THEN
    DELETE FROM app.bank_fee_rates;
    INSERT INTO app.bank_fee_rates (effective_from, method, kind, amount_above, amount_upto, rate_pct, cap_rupees, note) VALUES
      ('2020-01-01', 'card', 'rupay_debit', 0, NULL, 0, NULL, 'RuPay domestic debit: zero MDR (HDFC, TID 66027444)'),
      ('2020-01-01', 'card', 'debit', 0, 2000, 0.40, NULL, 'Other debit cards up to ₹2,000 (HDFC, TID 66027444)'),
      ('2020-01-01', 'card', 'debit', 2000, NULL, 0.90, NULL, 'Other debit cards above ₹2,000 (HDFC, TID 66027444)'),
      ('2020-01-01', 'card', 'credit', 0, NULL, 1.60, NULL, 'Credit cards (HDFC, TID 66027444)'),
      ('2020-01-01', 'card', 'international', 0, NULL, 2.75, NULL, 'Business, commercial and foreign cards (HDFC, TID 66027444)'),
      ('2020-01-01', 'upi', 'upi', 0, NULL, 0, NULL, 'UPI: zero MDR (HDFC, TID 66027444)'),
      -- not in the bank's message: UPI paid from a RuPay credit card carries credit-card MDR at HDFC (a few rupees were
      -- kept on some UPI days in Sep 2026), so it is taken at the agreement's credit-card rate above ₹2,000
      ('2020-01-01', 'upi', 'upi_rupay_credit', 0, 2000, 0, NULL, 'UPI from a RuPay credit card up to ₹2,000 (TID 66027444; not in the bank''s message)'),
      ('2020-01-01', 'upi', 'upi_rupay_credit', 2000, NULL, 1.60, NULL, 'UPI from a RuPay credit card above ₹2,000, at the credit-card rate (TID 66027444; not in the bank''s message)');
  END IF;
END $$;
UPDATE app.settings SET value = value || '{"servicePerMonth":99}'::jsonb, description =
  'Bank fees beyond the rates: GST on fees, terminal service charge a month (HDFC: ₹116 incl. GST per terminal, rental waived), fee a settlement batch, days before a late settlement fee (HDFC: 0.5% or ₹499)'
 WHERE key = 'recon.fee_fixed' AND (value->>'servicePerMonth') IS DISTINCT FROM '99';

INSERT INTO app.schema_migrations(version) VALUES ('0030_hdfc_pos_rates') ON CONFLICT DO NOTHING;
