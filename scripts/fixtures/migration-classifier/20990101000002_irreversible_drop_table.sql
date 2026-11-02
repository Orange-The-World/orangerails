-- IRREVERSIBLE fixture: DROP TABLE.
--
-- Expected verdict: IRREVERSIBLE, rule [DROP TABLE].
-- There is no restore path. Running this wrong costs the rows, not a revert.

drop table if exists public.or_fixture_widget;
