-- IRREVERSIBLE fixture: DELETE with no WHERE clause.
--
-- Expected verdict: IRREVERSIBLE, rule [DELETE WITHOUT WHERE].
-- One missing clause is the difference between removing the obsolete rows and
-- removing all of them. The reversible fixture carries the bounded version of
-- this same statement.

delete from public.or_fixture_widget;
