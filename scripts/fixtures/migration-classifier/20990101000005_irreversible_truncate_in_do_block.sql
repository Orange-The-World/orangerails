-- IRREVERSIBLE fixture: TRUNCATE hidden inside a DO block.
--
-- Expected verdict: IRREVERSIBLE, rule [TRUNCATE].
--
-- This is the case that separates a scanner from a grep in BOTH directions. A
-- CREATE FUNCTION body does not run when the migration is applied, so the
-- classifier skips it. A DO block body runs immediately, so the classifier must
-- read it. Treating the two the same in either direction is a defect: skip both
-- and this file reads as clean while it empties a table on production.

do $$
begin
  truncate table public.or_fixture_widget;
end
$$;
