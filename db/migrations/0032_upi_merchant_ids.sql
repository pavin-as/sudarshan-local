-- 0032: UPI settlements from every merchant id of the clinic's HDFC terminals (28 Oct 2026). Re-run safe.
-- The bank lines show three terminals: 66027444 (merchant RY9181, the one in use), 64061321 (EGD494; no money since
-- April 2026, charged ₹705.64 a month since July) and 69348544 (EHD956; a little UPI and card in July and October). A
-- day's UPI can come in two settlements (6 Oct: ₹2,400 from EHD956 + ₹42,048 from RY9181), so the UPI rule takes any
-- merchant id; services/reconcile.ts adds up 2-3 settlements of one date. The card rule ("TERMINAL 1 CARDS SETTL") already
-- takes every terminal.
UPDATE app.recon_bank_rules SET pattern = 'UPI SETTLEMENT\s*-[A-Z0-9]{6}-',
       note = 'Clinic UPI merchant settlement, any of the clinic''s merchant ids (RY9181, EHD956, EGD494)'
 WHERE class = 'upi_settlement' AND pattern IN ('UPI SETTLEMENT\s*-RYX181-', 'UPI SETTLEMENT\s*-RY[X9]181-');

INSERT INTO app.schema_migrations(version) VALUES ('0032_upi_merchant_ids') ON CONFLICT DO NOTHING;
