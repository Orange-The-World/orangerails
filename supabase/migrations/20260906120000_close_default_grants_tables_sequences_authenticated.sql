-- 20260906120000_close_default_grants_tables_sequences_authenticated.sql
-- Security hardening: close the rest of the schema public default privilege grants.
-- Part of OR-T0717, from the CTO ruling on DEV-0220 (option C).
-- Companion to 20260825120000 (landed via PR #920) which closed the anon EXECUTE
-- default on functions. This file closes what that one left: tables, sequences,
-- and the authenticated default on functions.
--
-- WHAT
-- 1. ALTER DEFAULT PRIVILEGES: stop new tables in public from handing anon SELECT
--    and authenticated DELETE/INSERT/SELECT/UPDATE at creation time.
-- 2. ALTER DEFAULT PRIVILEGES: stop new sequences in public from handing
--    authenticated SELECT/UPDATE/USAGE at creation time. anon already carries no
--    default on sequences under the postgres grantor row (verified below); this
--    statement is a documented no-op for anon and a real change for authenticated.
-- 3. ALTER DEFAULT PRIVILEGES: stop new functions in public from handing
--    authenticated EXECUTE at creation time. anon was already closed by 20260825120000.
--
-- SCOPE: the postgres grantor row only, exactly like 20260825120000. A second
-- default-ACL row for (public, r/S/f) owned by supabase_admin exists on dev and
-- grants anon and authenticated broad access; postgres is NOT a member of
-- supabase_admin (pg_has_role('postgres','supabase_admin','MEMBER') is FALSE,
-- verified live) and cannot alter that row. This migration does not try to, and
-- the assertion below is scoped so it cannot demand that unreachable state.
--
-- THIS DOES NOT TOUCH ANY EXISTING OBJECT. ALTER DEFAULT PRIVILEGES only changes
-- what a FUTURE CREATE TABLE / CREATE SEQUENCE / CREATE FUNCTION receives. Every
-- table, sequence and function that exists in public today keeps exactly the ACL
-- it has right now; postgres does not track whether a current grant came from a
-- default rule or an explicit GRANT, and there is nothing to backfill. Read back
-- proof: compare information_schema.role_table_grants counts for anon/authenticated
-- before and after this migration; they must be identical. (OR-T0717 acceptance
-- criterion 3: the enumeration of anon/authenticated surfaces relying on the
-- default rather than an explicit grant returns NONE, for exactly this reason,
-- and this comment is the query that produced that answer.)
--
-- THE ROLE APPLY-MIGRATIONS CONNECTS AS: postgres, non-superuser. Verified live
-- 2026-09-06 by running `select current_user, session_user` through the same
-- Supabase Management API endpoint apply-migrations itself calls
-- (POST /v1/projects/{ref}/database/query, the endpoint named in
-- .github/workflows/supabase-deploy.yml under "Apply pending DB migrations via
-- Management API"): both current_user and session_user returned postgres. So
-- FOR ROLE postgres covers every object a migration creates. Recorded on OR-T0717.
--
-- THE FRICTION THIS ACCEPTS ON PURPOSE (per DEV-0220): every new table now needs
-- its own explicit GRANT to authenticated in the same migration that creates it,
-- or authenticated gets nothing on it. That is a loud dev break (a 42501 the
-- first time the feature is exercised on dev, where migrations apply automatically
-- on merge), not a silent one. If the friction is worse than the ruling expected,
-- say so on DEV-0220; it can be walked back with a plain GRANT, since this is not
-- a one-way door (see REVERSIBILITY below).
--
-- REVERSIBILITY: undone by re-issuing the GRANT form of these same three
-- statements. No data is touched, no existing object is touched.
--
-- Verify after applying (must show no anon/authenticated row for r/S under
-- postgres, and no authenticated row for f under postgres):
--     SELECT n.nspname, d.defaclobjtype, pg_get_userbyid(d.defaclrole) AS grantor,
--            (aclexplode(d.defaclacl)).grantee::regrole::text AS grantee,
--            (aclexplode(d.defaclacl)).privilege_type
--       FROM pg_default_acl d
--       JOIN pg_namespace n ON n.oid = d.defaclnamespace
--      WHERE n.nspname = 'public'
--        AND d.defaclrole = 'postgres'::regrole
--        AND d.defaclobjtype IN ('r','S','f')
--      ORDER BY 2,4,5;

BEGIN;

-- 1. Tables: stop handing anon and authenticated anything by default.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- 2. Sequences: stop handing anon and authenticated anything by default.
--    (anon already carries no default entry here; this line is a documented
--    no-op for anon and the real change is for authenticated.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- 3. Functions: close the authenticated half. anon was closed by 20260825120000.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

-- 4. Prove it or abort. Scoped to the postgres grantor row throughout, exactly
--    like 20260825120000, so this can never demand the unreachable
--    supabase_admin state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public'
       AND d.defaclrole = 'postgres'::regrole
       AND d.defaclobjtype = 'r'
       AND (
         array_to_string(d.defaclacl, ',') LIKE '%anon=%'
         OR array_to_string(d.defaclacl, ',') LIKE '%authenticated=%'
       )
  ) THEN
    RAISE EXCEPTION 'FAIL: anon or authenticated still appears in the postgres default ACL for public tables after revoke';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public'
       AND d.defaclrole = 'postgres'::regrole
       AND d.defaclobjtype = 'S'
       AND (
         array_to_string(d.defaclacl, ',') LIKE '%anon=%'
         OR array_to_string(d.defaclacl, ',') LIKE '%authenticated=%'
       )
  ) THEN
    RAISE EXCEPTION 'FAIL: anon or authenticated still appears in the postgres default ACL for public sequences after revoke';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public'
       AND d.defaclrole = 'postgres'::regrole
       AND d.defaclobjtype = 'f'
       AND array_to_string(d.defaclacl, ',') LIKE '%authenticated=%'
  ) THEN
    RAISE EXCEPTION 'FAIL: authenticated still appears in the postgres default ACL for public functions after revoke';
  END IF;
END $$;

COMMIT;
