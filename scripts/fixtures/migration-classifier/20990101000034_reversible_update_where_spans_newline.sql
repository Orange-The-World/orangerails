-- REVERSIBLE fixture: an UPDATE whose WHERE clause is on its own line.
--
-- Expected: REVERSIBLE, zero findings, zero warnings. The UNBOUNDED_WRITE
-- warning's WHERE scan must not be fooled by a newline between SET and
-- WHERE, or between WHERE and the rest of the clause.

update public.or_fixture_widget
set enabled = false
where
  id = 1;
