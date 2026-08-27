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
--      WHERE n.nspname = 'public' AND d.defaclobjtype = 'f';
-- and confirm anon is ABSENT.

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
       AND array_to_string(d.defaclacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'FAIL: anon still appears in public functions default ACL after revoke';
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
