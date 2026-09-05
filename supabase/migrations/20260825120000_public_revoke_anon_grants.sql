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
-- REQUIREMENT: no function in schema public may carry an EXECUTE grant to anon,
-- whichever role granted it.
--
-- WHAT THIS FILE ENFORCES: the part owned by postgres. Step 1 closes the default
-- for new functions created by postgres, step 2 removes the standing grants, and
-- assertion (b) proves no public function holds an anon entry at apply time.
--
-- WHAT THIS FILE CANNOT ENFORCE: the platform default-privilege row. We hold no
-- membership in the role that owns it (pg_has_role returns false), so a function
-- created in public by that role would take an anon EXECUTE entry at birth and no
-- migration in this repo can prevent it. This is a future condition, not a present
-- one on dev: as of 2026-09-05, no function in public on the dev project
-- (fzwmnzmtqidumdqjdddz) carries an anon entry from any grantor. Prod is a
-- separate case until this file's own REVOKE lands there: as of the same date,
-- the three trigger functions named above (enforce_customer_vault_pubkey_write_once,
-- enforce_vault_meta_no_direct_delete, enforce_vault_pubkey_write_once) still carry
-- a direct anon EXECUTE grant on prod, functionally inert per the NOTE ON TRIGGER
-- FUNCTIONS above, and cleared the moment this migration is applied there.
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
--        AND ace::text LIKE 'anon=%';
--
-- Expected result: zero rows. Any row is a regression and names the function.
-- The query was proved able to FAIL before it was trusted: on the dev project a
-- throwaway function was created in public, granted EXECUTE to anon, and the
-- query returned it; the function was dropped and the query returned to zero.
-- A check that has only ever returned empty has not been shown to detect anything.
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

  -- (b) Blanket revoke landed: anon holds no direct EXECUTE grant on any public function.
  --     Uses proacl directly, not has_function_privilege, which also returns true for PUBLIC (=X/postgres)
  --     grants that our REVOKE FROM anon does not touch.
  --     When proacl IS NULL, unnest returns no rows and EXISTS returns false, which is correct:
  --     NULL proacl means the function inherits the default ACL, and assertion (a) already confirmed
  --     the default ACL carries no anon entry.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND EXISTS (
         SELECT 1
           FROM unnest(p.proacl) AS ace
          WHERE ace::text LIKE 'anon=%'
       )
  ) THEN
    RAISE EXCEPTION 'FAIL: anon still holds a direct EXECUTE grant on a public function after blanket revoke';
  END IF;
END $$;

COMMIT;
