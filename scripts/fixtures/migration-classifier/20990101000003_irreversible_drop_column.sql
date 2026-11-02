-- IRREVERSIBLE fixture: ALTER TABLE ... DROP COLUMN.
--
-- Expected verdict: IRREVERSIBLE, rule [ALTER TABLE DROP].
-- The column takes its data with it. Re-adding the column does not bring the
-- values back.

alter table public.or_fixture_widget drop column note;
