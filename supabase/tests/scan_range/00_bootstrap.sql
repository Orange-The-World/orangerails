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
--   2. the baseline table/sequence privileges Supabase grants those roles at
--      project provisioning time, before any application migration runs --
--      see OR-C1871 below for why this one is not optional
--   3. auth.uid(), called by the RLS read policy on stealth_scan_ranges
--   4. public.stealth_connections, the parent table that the foreign key and
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

-- 2. The baseline privileges a real Supabase project grants anon and
--    authenticated automatically, at provisioning time, before any
--    migration in supabase/migrations ever runs. No migration in this repo
--    GRANTs this baseline itself, because on dev and prod it is already
--    there when the migration applies -- migrations only ever REVOKE
--    narrower than the actual project baseline.
--
--    OR-C1871: this mapfile's grep (`stealth_scan_ranges|record_stealth_scan_range`)
--    is deliberately broad -- see ci.yml's own comment on that step -- and it
--    now also picks up cross-table sweep migrations such as
--    20260902154500_revoke_authenticated_unpoliced_dml.sql, which REVOKE a
--    named subset of privileges from authenticated and then assert (A2) that
--    every privilege a policy still admits is STILL held. Without this
--    baseline, authenticated never held that privilege here to begin with,
--    so a correct, narrowly-scoped REVOKE reads on this harness exactly like
--    the over-broad REVOKE ALL that assertion exists to catch, and the job
--    fails on a false positive that has nothing to do with the code under
--    test. Granting the same baseline real projects start from is what makes
--    "applied verbatim" true for a swept migration too, not just for the
--    scan-range migrations this file was originally written for.
--    Deliberately the same four verbs Supabase itself grants, not ALL: the
--    sweep migrations assert that anon/authenticated hold nothing beyond
--    SELECT/INSERT/UPDATE/DELETE on these tables (their own A2 check reads
--    "a.privilege_type <> 'SELECT'" with no allowance for REFERENCES,
--    TRIGGER or TRUNCATE), so granting ALL here would hand out privileges
--    no real Supabase project ever had and fail that check instead.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;

-- 3. auth.uid(). Returning NULL is honest: nothing in this harness is signed
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

-- 4. The parent table. Only the two columns the scan-range code path reads:
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

-- 5. RLS shape for the shim table, copied verbatim from
--    20260504000000_stealth_sync.sql. This is NOT the "convincing imitation
--    of RLS" the header above forbids -- auth.uid() still always returns
--    NULL here and psql still connects as the owner and bypasses RLS, so
--    nothing about how record_stealth_scan_range is exercised changes. It
--    exists only so this table's PRIVILEGE shape matches production's: a
--    broad sweep migration such as 20260902154500_revoke_authenticated_unpoliced_dml.sql
--    (OR-T1421) asserts that no privilege survives on a table unless a
--    policy admits it, and on the real stealth_connections that assertion
--    passes because the policy below exists. Without it here, the same
--    assertion reads this shim's SELECT grant as unpoliced and fails on a
--    table this suite does not even test (OR-C1871).
ALTER TABLE public.stealth_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read their stealth connections"
  ON public.stealth_connections;
CREATE POLICY "Owners can read their stealth connections"
  ON public.stealth_connections
  FOR SELECT
  USING (auth.uid()::text = app_user_id::text);
