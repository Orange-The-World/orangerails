-- REVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1658).
--
-- The mirror image of the two irreversible routine fixtures, and the one that
-- keeps the gate usable. This migration defines a routine whose body contains a
-- DROP TABLE, and NOTHING in the file calls it, attaches it as a trigger, or
-- otherwise causes it to run. Applying this migration does not drop anything, so
-- the classifier must return REVERSIBLE with ZERO findings.
--
-- The DROP TABLE in the body is deliberate. If the invocation analysis ever
-- starts over-reporting, this file goes red and names the reason, instead of the
-- gate quietly beginning to refuse ordinary work. A gate that refuses ordinary
-- work gets routed around, and a routed-around gate protects nothing.
--
-- The statements that NAME the routine without running it are here on purpose
-- too: the definition itself, a COMMENT and a GRANT. None of them executes the
-- body, and none of them may be read as an invocation.
--
-- If this file ever goes red, fix the classifier. Do not weaken this fixture.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create or replace function public.or_fixture_unreachable_cleanup()
returns void
language plpgsql
as $$
begin
  drop table public.or_fixture_scratch;
end;
$$;

comment on function public.or_fixture_unreachable_cleanup()
  is 'called by an operator when they choose to, never by this migration';

grant execute on function public.or_fixture_unreachable_cleanup() to authenticated;
