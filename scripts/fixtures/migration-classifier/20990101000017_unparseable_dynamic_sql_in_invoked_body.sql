-- UNPARSEABLE fixture for scripts/classify-migrations.mjs (OR-T1715).
--
-- A body this migration invokes builds its SQL at run time. The scrub that
-- runs before a body is scanned blanks every string literal, so the EXECUTE
-- below reached the rules as the bare word "execute", nothing fired, and the
-- file classified REVERSIBLE. Under the production migration rule that sends a
-- change which drops a table down the two party path, instead of the founder
-- gate that exists for exactly this.
--
-- The header of classify-migrations.mjs promises the script never concludes
-- REVERSIBLE from an absence. Here it was concluding REVERSIBLE from an absence
-- it had created itself. What this statement actually does is not in the file,
-- so the answer is a refusal rather than a scan.
--
-- Expected: UNPARSEABLE, reported at the BEGIN line of the body.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create or replace function public.or_fixture_dynamic_wipe()
returns void
language plpgsql
as $$
begin
  execute 'drop table public.or_fixture_widget';
end;
$$;

select public.or_fixture_dynamic_wipe();
