-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1658, OR-T1666).
-- A routine name that is a quoted identifier CONTAINING WHITESPACE, created and
-- then called by the same migration, so the body runs at apply time.
--
-- Expected: IRREVERSIBLE, rule TRUNCATE, reported inside the body.
-- This file is NOT a migration. The 2099 prefix cannot collide with a real one.

create table if not exists public.or_fixture_spaced (id int);

create or replace function public."drop helper"()
returns void
language plpgsql
as $$
begin
  truncate table public.or_fixture_spaced;
end;
$$;

select public."drop helper"();
