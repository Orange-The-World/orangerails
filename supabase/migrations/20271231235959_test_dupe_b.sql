-- OR-T1189 forced-red proof, step 7. Scratch test file, not a real migration.
-- Deliberately shares its version prefix (20271231235959) with
-- 20271231235959_test_dupe_a.sql so check-duplicate-migrations detects the
-- collision and apply-migrations is skipped. Reverted in the same session
-- immediately after the run is observed. Safe no-op body.
select 1;
