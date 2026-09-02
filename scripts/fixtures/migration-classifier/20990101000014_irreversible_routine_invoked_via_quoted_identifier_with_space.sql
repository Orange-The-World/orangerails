-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1708).
--
-- The quoted identifier itself contains a space this time: public."purge
-- audit"(). Before OR-T1708 the definition side stripped ALL whitespace from
-- the routine name at line 263, including the space inside the quotes, so
-- `short` became "purgeaudit", a name that does not exist. The invocation
-- side (line 100) only collapses whitespace, so it kept the space. The call
-- regex built from "purgeaudit" could never match "purge audit(", the body
-- was never scanned, and this file classified REVERSIBLE while it empties a
-- table.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create table if not exists public.or_fixture_spaced_audit (
  id bigserial primary key,
  note text
);

create or replace function public."purge audit"()
returns trigger
language plpgsql
as $$
begin
  truncate public.or_fixture_spaced_audit;
  return new;
end;
$$;

create trigger or_fixture_spaced_purge_after_insert
  after insert on public.or_fixture_spaced_audit
  for each row execute function public."purge audit"();

insert into public.or_fixture_spaced_audit (note)
values ('this row fires the trigger while the migration is being applied');
