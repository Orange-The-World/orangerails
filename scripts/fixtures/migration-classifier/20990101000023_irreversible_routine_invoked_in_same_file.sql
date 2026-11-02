-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1658).
--
-- A routine body is not inert just because it is a routine body. This file
-- creates a routine and then CALLS it, so the body runs when the migration is
-- applied, and the DROP TABLE inside it is an irreversible act of applying this
-- file, not a thing that happens later when somebody calls the function.
--
-- Before OR-T1658 the classifier blanked every routine body unread, noted that
-- routine bodies do not execute at apply time, and returned REVERSIBLE here. On
-- the production path that meant this file would have been applied with no
-- authority reference required.
--
-- Expected: IRREVERSIBLE, rule DROP TABLE, reported at the line INSIDE the body.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create or replace function public.or_fixture_invoked_cleanup()
returns void
language plpgsql
as $$
begin
  drop table public.or_fixture_widget;
end;
$$;

select public.or_fixture_invoked_cleanup();
