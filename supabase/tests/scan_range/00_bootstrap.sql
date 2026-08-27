-- Minimal stand-in for the parts of a Supabase database that the scan-range
-- migrations reach for, so those migrations can be applied VERBATIM from
-- supabase/migrations to a throwaway Postgres container inside the Actions
-- runner. Applying the real migration text is the whole point: a hand-copied
-- schema in a test directory drifts away from what ships, and then the test
-- proves something nobody deployed.
--
-- READ THIS BEFORE TRUSTING A GREEN RUN. This file is a SHIM, not production.
-- It creates only what the scan-range migrations actually touch:
--
--   1. the three Supabase roles the GRANT and REVOKE statements name
--      (anon, authenticated, service_role)
--   2. auth.uid(), called by the RLS read policy on stealth_scan_ranges
--   3. public.stealth_connections, the parent table that the foreign key and
--      the ownership guard read, carrying only the two columns those two
--      things use
--
-- WHAT THIS HARNESS PROVES: the merge arithmetic and the ownership guard
-- inside record_stealth_scan_range, against the real migration text in this
-- repo.
--
-- WHAT IT DOES NOT PROVE, stated so a green tick is not read wider than it
-- is: it does not exercise row level security the way a real client meets it.
-- auth.uid() here always returns NULL, and psql connects as the database
-- owner, which bypasses RLS entirely. Do NOT extend this file into a
-- convincing imitation of RLS. A fake of a security control that passes is
-- worse than having no test of that control, because it reports safe.

-- 1. Roles named by the grants in the migrations.
--    Guarded so the file can be re-applied to a database that already has
--    them, rather than failing on the second run for an uninteresting reason.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- 2. auth.uid(). Returning NULL is honest: nothing in this harness is signed
--    in. It exists so the RLS policy in the migration can be CREATEd, not so
--    that policy can be meaningfully tested here.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULL::uuid
$$;

-- 3. The parent table. Only the two columns the scan-range code path reads:
--    id, which the foreign key on stealth_scan_ranges references, and
--    app_user_id, which the ownership guard compares the caller against.
--    app_user_id is deliberately NULLABLE so the "connection has no owner"
--    rejection path can be exercised.
CREATE TABLE IF NOT EXISTS public.stealth_connections (
  id           UUID PRIMARY KEY,
  app_user_id  TEXT
);

COMMENT ON TABLE public.stealth_connections IS
  'CI harness shim only (DL-1856). Not the production table definition. '
  'Carries only the columns the scan-range migrations read.';
