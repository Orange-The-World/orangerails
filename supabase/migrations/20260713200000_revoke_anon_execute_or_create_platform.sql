-- 20260713200000_revoke_anon_execute_or_create_platform.sql
--
-- Requirement: creating a platform must require an authenticated session, and
-- today no caller below service_role has any legitimate reason to execute it.
--
-- public.or_create_platform is SECURITY DEFINER and returns a newly minted
-- platform API key. EXECUTE is held by client facing roles, inherited from the
-- default privileges applied to the public schema rather than granted
-- deliberately. A definer function runs with the owner's rights and bypasses
-- table grants, so the column level revokes that already landed do not
-- constrain this path.
--
-- The live privilege differs per environment, so the revoke names every caller
-- role rather than the one that happens to be present:
--   dev:  postgres, authenticated, service_role
--   prod: postgres, anon, authenticated, service_role
-- postgres and service_role are deliberately left in place. They are the only
-- real callers: every platform mint on record was performed by postgres, and
-- there is no application call site for this function.
--
-- Scope: this function only. Other SECURITY DEFINER functions in public carry
-- the same inherited grant. At least one pre login redemption path depends on
-- anon EXECUTE by design, so a blanket revoke across the schema is not safe and
-- is deliberately not attempted here.
--
-- Reversible (restores exactly what is revoked below):
--   GRANT EXECUTE ON FUNCTION public.or_create_platform(
--     text, text, text, text, text, text, integer
--   ) TO anon, authenticated, PUBLIC;
--
-- Idempotent: revoking a privilege that is already absent is a no op, and the
-- regprocedure guard keeps this file safe to re run if the function is absent.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
       'public.or_create_platform(text, text, text, text, text, text, integer)'
     ) IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.or_create_platform(
      text, text, text, text, text, text, integer
    ) FROM anon, authenticated, PUBLIC;
  END IF;
END
$$;

-- Proof, not just intent: fail the migration if either client facing role can
-- still execute the function. A grant to PUBLIC is inherited by both roles, so
-- this check also catches a surviving PUBLIC grant.
DO $$
DECLARE
  fn   oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
  role text;
BEGIN
  IF fn IS NULL THEN
    RETURN;
  END IF;

  FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(role, fn, 'EXECUTE') THEN
      RAISE EXCEPTION
        'or_create_platform: % still holds EXECUTE after the revoke', role;
    END IF;
  END LOOP;
END
$$;

COMMIT;
