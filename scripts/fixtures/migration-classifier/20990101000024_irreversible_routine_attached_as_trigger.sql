-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1658).
--
-- The variant that a plain "does anything SELECT this function" check would
-- miss. Nothing here calls the routine directly. The migration attaches it to a
-- table as a row trigger and then inserts a row into that same table, so the
-- body runs during the apply and empties the table it just created.
--
-- The classifier does not try to prove that the trigger definitely fires. It
-- treats a statement that names the routine with an argument list as a reason to
-- READ the body rather than skip it, because over-reading costs an unnecessary
-- refusal a human can clear, and under-reading costs the data.
--
-- Expected: IRREVERSIBLE, rule TRUNCATE, reported at the line INSIDE the body.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create table if not exists public.or_fixture_audit (
  id bigserial primary key,
  note text
);

create or replace function public.or_fixture_purge_audit()
returns trigger
language plpgsql
as $$
begin
  truncate public.or_fixture_audit;
  return new;
end;
$$;

create trigger or_fixture_purge_audit_after_insert
  after insert on public.or_fixture_audit
  for each row execute function public.or_fixture_purge_audit();

insert into public.or_fixture_audit (note)
values ('this row fires the trigger while the migration is being applied');
