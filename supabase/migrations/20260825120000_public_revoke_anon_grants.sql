-- 20260825120000_public_revoke_anon_grants.sql
-- Security hardening: close the anon EXECUTE default privilege tap in public schema.
-- Part of DL-1562. Owner: Sr Dev A.
-- Companion to 20260723190000 which removed the standing grants on 25 named functions.
--
-- WHAT
-- 1. ALTER DEFAULT PRIVILEGES: stop new functions in public from inheriting anon EXECUTE.
-- 2. REVOKE EXECUTE on all existing public functions from anon, then restore the three
--    trigger functions that are harmless (trigger machinery ignores EXECUTE at fire time).
-- SCOPE: anon only. authenticated and service_role are untouched throughout.
--
-- WHY
-- After 20260723190000 removed the named anon grants on 25 functions, the default ACL
-- row (grantor=postgres, schema=public, objtype=f) was left open:
--     anon=X | authenticated=X | service_role=X
-- Every CREATE FUNCTION in public by postgres still hands anon EXECUTE at birth.
-- data_keys anon SELECT is handled in file 4 (20260723170000) per CTO ruling.
--
-- THREE FUNCTIONS EXCLUDED FROM NET REVOKE (restored after blanket revoke):
-- All three are prosecdef=false trigger functions named by Auditor in msg 39520.
-- Trigger machinery does not consult EXECUTE at fire time; the grant on them is
-- functionally inert. Net result is equivalent to them holding nothing.
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
--    Then restore the three trigger functions by name; the Auditor confirmed they are
--    prosecdef=false and the trigger machinery does not consult EXECUTE at fire time.
--    Inside this transaction the revoke and re-grant are atomic.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
GRANT EXECUTE ON FUNCTION public.enforce_customer_vault_pubkey_write_once() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_vault_meta_no_direct_delete() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_vault_pubkey_write_once() TO anon;

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

  -- (b) Nothing broke for authenticated: spot-check has_function_privilege on one
  --     function that RLS policies depend on (rotate_data_key is SECURITY DEFINER;
  --     authenticated must still be able to call it).
  --     NOTE: if rotate_data_key does not exist yet in this env, remove this check.
  --     The anon-only revokes above cannot affect authenticated grants.
END $$;

COMMIT;
