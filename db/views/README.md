Views here are re-created (CREATE OR REPLACE) by `scripts/migrate.py` and after every full Yarago copy,
because a full copy may drop and rebuild a mirror table when Yarago changes its structure.
Files run in name order. Keep them idempotent.

Rule: `CREATE OR REPLACE VIEW` can only ADD columns at the END of a view. Never rename, reorder or remove a
column in place; add new columns last, or DROP the view first if nothing depends on it.
