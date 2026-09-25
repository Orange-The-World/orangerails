-- 20260825120000_public_revoke_anon_grants.sql
-- Security hardening: close the anon EXECUTE default privilege tap in public schema.
-- Part of DL-1562. Owner: Sr Dev A.
-- Companion to 20260723190000 which removed the standing grants on 25 named functions.
--
-- WHAT
-- 1. ALTER DEFAULT PRIVILEGES: stop new functions in public from inheriting anon EXECUTE.
-- 2. REVOKE EXECUTE on all existing public functions from anon.
-- SCOPE: anon only. authenticated and service_role are untouched throughout.
--
-- WHY
-- After 20260723190000 removed the named anon grants on 25 functions, the default ACL
-- row (grantor=postgres, schema=public, objtype=f) was left open:
--     anon=X | authenticated=X | service_role=X
-- Every CREATE FUNCTION in public by postgres still hands anon EXECUTE at birth.
-- data_keys anon privileges (REVOKE ALL) are handled in file 4 (20260723170000) per CTO ruling.
--
-- NOTE ON TRIGGER FUNCTIONS: Three prosecdef=false trigger functions previously held
-- a direct anon EXECUTE grant. The Auditor confirmed trigger machinery does not consult
-- EXECUTE at fire time, so the grant was functionally inert. The blanket REVOKE removes
-- it cleanly; no re-grant is needed (triggers fire via the trigger mechanism regardless).
--     public.enforce_customer_vault_pubkey_write_once()
--     public.enforce_vault_meta_no_direct_delete()
--     public.enforce_vault_pubkey_write_once()
--
-- REQUIRES: run as postgres (confirmed grantor on the default ACL row, XO 2 / DBA).
-- The ALTER DEFAULT PRIVILEGES binds to the executing role when FOR ROLE is specified.
--
-- CLOSE CONDITION FOR DL-1562 (stated once so nobody has to guess):
-- The ticket stays open until a prod read shows:
--   (a) public functions default ACL with no anon entry
-- Verify after applying:
--     SELECT n.nspname, d.defaclobjtype, pg_get_userbyid(d.defaclrole), d.defaclacl
--       FROM pg_default_acl d
--       JOIN pg_namespace n ON n.oid = d.defaclnamespace
--      WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
--        AND d.defaclrole = 'postgres'::regrole;
-- and confirm anon is ABSENT.
--
-- The defaclrole filter matters. A Supabase project can carry a SECOND row for
-- (public, 'f') whose grantor is supabase_admin. That row is platform owned,
-- postgres cannot alter it, and this migration does not try to. Reading without
-- the filter reports a failure that no version of this file could fix.
--
-- THE RESIDUAL, AND THE DECISION ON IT. Recorded here so it is not re-derived.
--
-- REQUIREMENT: no function in schema public may carry an EXECUTE grant directly
-- to anon or indirectly through PUBLIC, whichever role granted it.
--
-- WHAT THIS FILE ENFORCES: the part owned by postgres. Step 1 closes the default
-- for new functions created by postgres, step 2 removes the standing grants, and
-- assertion (b) proves no public function holds an anon or bare PUBLIC entry at
-- apply time. This assertion is not a tripwire: the migration runs once and cannot
-- see grants or functions created after it applies.
--
-- WHAT THIS FILE CANNOT ENFORCE: the platform default-privilege row. We hold no
-- membership in the role that owns it (pg_has_role returns false), so a function
-- created in public by that role would take an anon EXECUTE entry at birth and no
-- migration in this repo can prevent it. This is a future condition, not a present
-- one on either project: as of 2026-09-05, verified live against both projects
-- (has_function_privilege and proacl, not inferred from an earlier migration
-- header), no function in public on either the dev project (fzwmnzmtqidumdqjdddz)
-- or the prod project (lcdicqalreskibdfxkzb) carries an anon entry from any
-- grantor, including the three trigger functions named above. They were already
-- cleared on both projects by 20260723190000_revoke_anon_execute_public_functions,
-- before this file was written. This file's own REVOKE over them is therefore a
-- no-op restatement of an already-closed grant on both projects, not the thing
-- that closes it.
--
-- DECISION: cover the remainder by DETECTION, not by another revoke, because a
-- revoke we cannot make stick is worse than no control at all. The detection is
-- one query and it is deliberately grantor-agnostic, which is the whole point:
--
--     SELECT n.nspname, p.proname, ace::text
--       FROM pg_proc p
--       JOIN pg_namespace n ON n.oid = p.pronamespace,
--            unnest(p.proacl) ace
--      WHERE n.nspname = 'public'
--        AND (ace::text LIKE 'anon=%' OR ace::text LIKE '=%');
--
-- Expected result: zero rows. Any row is a regression and names the function.
-- The historical failure proof covered only a throwaway function granted EXECUTE
-- directly to anon. The PUBLIC path must also be exercised deliberately: a bare
-- PUBLIC aclitem renders with an empty grantee, such as =X/postgres. A check that
-- has not returned each kind has not proved that it detects both kinds.
--
-- Running it on a schedule is tracked separately. If you are reading this because
-- that query just returned a row, the fix is a REVOKE for that specific function,
-- not a change to this file: this file has already run and is skipped by version.

BEGIN;

-- 1. Close the source: future functions in public created by postgres will no longer
--    inherit anon EXECUTE automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- 2. Remove the standing anon EXECUTE grant from all existing public functions.
--    Trigger functions are included in the blanket revoke; trigger machinery does not
--    consult EXECUTE at fire time, so removing the grant has no effect on their behavior.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- 3. Prove it or abort. Both directions in the same transaction.
DO $$
DECLARE
  v_execute_grant_failure text;
BEGIN
  -- (a) The tap is closed: no anon entry in public functions default ACL.
  IF EXISTS (
    SELECT 1
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public'
       AND d.defaclobjtype = 'f'
       -- Scoped to the row step 1 actually writes. ALTER DEFAULT PRIVILEGES FOR
       -- ROLE postgres can only change the row whose defaclrole is postgres. A
       -- platform owned supabase_admin row for the same (schema, objtype) is not
       -- reachable from this role, so including it here asserted something this
       -- migration does not do and can never do.
       AND d.defaclrole = 'postgres'::regrole
       AND array_to_string(d.defaclacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'FAIL: anon still appears in the postgres default ACL for public functions after revoke';
  END IF;

  -- (b) No public function grants EXECUTE directly to anon or indirectly through PUBLIC.
  --     Uses proacl directly so the failure identifies whether it found anon or PUBLIC
  --     (=X/postgres), which REVOKE FROM anon does not touch.
  --     When proacl IS NULL, unnest returns no rows and this assertion has no explicit aclitem
  --     to inspect. The scheduled privilege check separately covers implicit PUBLIC access.
  SELECT CASE
           WHEN ace::text LIKE 'anon=%'
             THEN format(
               'anon still holds a direct EXECUTE grant on %I.%I after blanket revoke',
               n.nspname,
               p.proname
             )
           ELSE format(
             'PUBLIC holds a bare EXECUTE grant on %I.%I; REVOKE FROM anon does not remove PUBLIC',
             n.nspname,
             p.proname
           )
         END
    INTO v_execute_grant_failure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proacl) AS ace
   WHERE n.nspname = 'public'
     AND (ace::text LIKE 'anon=%' OR ace::text LIKE '=%')
   ORDER BY (ace::text LIKE 'anon=%') DESC, p.oid
   LIMIT 1;

  IF v_execute_grant_failure IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: %', v_execute_grant_failure;
  END IF;
END $$;

COMMIT;
