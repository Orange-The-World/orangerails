-- 20260713200000_revoke_anon_execute_or_create_platform.sql
--
-- Requirement: creating a platform must require an authenticated session.
--
-- public.or_create_platform is SECURITY DEFINER and returns a newly minted
-- platform API key. EXECUTE is held by the anon role, inherited from the
-- default privileges applied to the public schema. A definer function runs with
-- the owner's rights and bypasses table grants, so the column level revokes that
-- already landed do not constrain this path.
--
-- Scope: this function only. Other SECURITY DEFINER functions in public carry
-- the same inherited grant. At least one pre login redemption path depends on
-- anon EXECUTE by design, so a blanket revoke across the schema is not safe and
-- is deliberately not attempted here.
--
-- Reversible:
--   GRANT EXECUTE ON FUNCTION public.or_create_platform(
--     text, text, text, text, text, text, integer
--   ) TO anon;
--
-- Idempotent: revoking a privilege that is already absent is a no op, and the
-- regprocedure guard keeps this file safe to re run if the function is absent.

DO $$
BEGIN
  IF to_regprocedure(
       'public.or_create_platform(text, text, text, text, text, text, integer)'
     ) IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.or_create_platform(
      text, text, text, text, text, text, integer
    ) FROM anon, PUBLIC;
  END IF;
END
$$;
