-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1695).
--
-- The quoted twin of 20990101000011. The same migration, laid out on the same
-- lines, except that the routine is named as a quoted identifier both where it
-- is defined and where the trigger invokes it:
--
--     for each row execute function public."or_fixture_quoted_purge"()
--
-- The definition side already strips the quotes off the name, so the two
-- spellings have to reach the same verdict, the same rule and the same line.
-- Before OR-T1695 they did not: the invocation test wanted whitespace or an
-- open parenthesis directly after the name, a double quote is neither, the body
-- was never read, and this file classified REVERSIBLE while applying it empties
-- a table.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create table if not exists public.or_fixture_quoted_audit (
  id bigserial primary key,
  note text
);

create or replace function public."or_fixture_quoted_purge"()
returns trigger
language plpgsql
as $$
begin
  truncate public.or_fixture_quoted_audit;
  return new;
end;
$$;

create trigger or_fixture_quoted_purge_after_insert
  after insert on public.or_fixture_quoted_audit
  for each row execute function public."or_fixture_quoted_purge"();

insert into public.or_fixture_quoted_audit (note)
values ('this row fires the trigger while the migration is being applied');
