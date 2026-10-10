-- UNPARSEABLE fixture: a dollar quoted block that is never closed.
--
-- Expected verdict: UNPARSEABLE, rule [UNPARSEABLE].
--
-- The scanner cannot tell where this routine body ends, so it cannot tell which
-- of the statements below execute when the migration is applied. That is not a
-- reason to wave the file through. UNPARSEABLE takes the irreversible branch,
-- because a check that could not do its work must never report the same green
-- as a check that did.

create or replace function public.or_fixture_broken()
returns void
language plpgsql
as $$
begin
  perform 1;
end;
