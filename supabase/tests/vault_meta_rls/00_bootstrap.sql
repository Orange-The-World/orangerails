-- Bootstrap shim for the user_vault_meta RLS suite (OR-T0690).
--
-- READ THIS BEFORE TRUSTING A GREEN RUN. This file is a SHIM, not
-- production, same as its sibling supabase/tests/scan_range/00_bootstrap.sql.
-- It creates only what the one migration this suite applies actually needs:
--
--   1. the three Supabase roles the migration's grants and policies name
--      (anon, authenticated, service_role)
--   2. the baseline table/sequence privileges Supabase grants those roles at
--      project provisioning time, before any application migration runs
--   3. a minimal auth.users table, because user_vault_meta.user_id carries
--      REFERENCES auth.users(id) ON DELETE CASCADE
--   4. pgcrypto, for gen_random_bytes() used by the migration's own seed
--      INSERT into public.apps (gen_random_uuid() is core Postgres, no
--      extension needed)
--
-- THE ONE DELIBERATE DIFFERENCE FROM scan_range/00_bootstrap.sql, and it is
-- the whole point of this suite existing: auth.uid() here is NOT hardcoded
-- to NULL. It reads a per-session setting, so a test can impersonate a
-- specific signed-in user by setting that value before it runs a query --
-- exactly the "set role authenticated; set request.jwt.claim.sub = ..."
-- pattern Supabase's own local RLS-testing tooling uses. This is what makes
-- it possible to actually exercise the policy instead of only being able to
-- CREATE it.
--
-- WHAT THIS HARNESS PROVES: that the row level security policies on
-- public.user_vault_meta, applied from the real migration text in this
-- repo, behave the way OR-T0690 asks about -- a signed-in user can update
-- their own row and cannot update another user's row -- when the query
-- actually runs AS a non-owner, non-superuser session, the same footing a
-- real PostgREST/Supabase client request runs on.
--
-- WHAT IT DOES NOT PROVE: anything about auth.users beyond its bare id
-- column, or about any table this suite's own migration file does not
-- create. This is not a general-purpose RLS fixture; it is scoped to one
-- ticket's question.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Roles named by the grants and policies in the migration.
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
--    migration in supabase/migrations ever runs. The migration this suite
--    applies does not GRANT this baseline itself, because on dev and prod
--    it is already there when the migration runs.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;

-- 3. auth.users, minimal. Only the column the foreign key references.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY
);

COMMENT ON TABLE auth.users IS
  'CI harness shim only (OR-T0690). Not the production table. Carries only '
  'the id column the RLS-under-test foreign key references.';

-- 4. auth.uid(), reading a per-session setting instead of always NULL. The
--    second argument to current_setting (missing_ok = true) makes an unset
--    session return NULL rather than raise, so a query run before any test
--    calls t_set_user() still behaves like a signed-out request.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
