-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1658, OR-T1666).
-- A routine whose name is a QUOTED IDENTIFIER, created and then called by the
-- same migration, so the body runs when the migration is applied.
--
-- Expected: IRREVERSIBLE, rule DROP TABLE, reported inside the body.
-- This file is NOT a migration. The 2099 prefix cannot collide with a real one.

create table if not exists public.or_fixture_quoted (id int);

create or replace function public."MyFunc"()
returns void
language plpgsql
as $$
begin
  drop table public.or_fixture_quoted;
end;
$$;

select public."MyFunc"();
