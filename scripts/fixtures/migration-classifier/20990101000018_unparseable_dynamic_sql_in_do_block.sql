-- UNPARSEABLE fixture: a DO block hands EXECUTE a value, not a string literal.
--
-- Expected verdict: UNPARSEABLE, reported at the EXECUTE line itself: unlike
-- the invoked-routine-body case (OR-T1715, reported at BEGIN because EXECUTE
-- shares its statement with BEGIN there), this EXECUTE starts its own
-- statement, so it is reported on its own line.
--
-- OR-T1730. A DO block runs unconditionally when the migration is applied, so
-- the refusal OR-T1715 gives an invoked routine body must apply here too: the
-- statement this EXECUTE runs is built at run time from a value read out of a
-- table, and it is nowhere in this file. Before this fix, nothing here fired:
-- there was no literal for the scrubber to blank, so the block read as
-- ordinary, harmless PL/pgSQL and the file classified REVERSIBLE, the
-- quietest possible wrong answer.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

do $$
declare
  cmd text;
begin
  select stmt into cmd from public.or_fixture_migration_plan where id = 1;
  execute cmd;
end
$$;
