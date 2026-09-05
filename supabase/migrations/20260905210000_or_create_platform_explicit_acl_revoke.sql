-- 20260905210000_or_create_platform_explicit_acl_revoke.sql
--
-- Closes a gap left by 20260723120000_or_create_platform_require_authenticated_caller.sql
-- (OR-T0861, raised by the Auditor on DEV-0418): that migration's proof block
-- checks the function exists, is SECURITY DEFINER, and carries the caller-check
-- string, but asserts nothing about who may EXECUTE it. CREATE OR REPLACE only
-- preserves an existing ACL; on a project where the function does not exist yet,
-- CREATE grants EXECUTE to PUBLIC by default, and 20260723120000's own proof
-- block would still pass on that project while PUBLIC held EXECUTE on a
-- function that mints a live platform API key.
--
-- This file does not depend on 20260723120000 having run first, and does not
-- depend on the function already existing: REVOKE on a role holding no
-- privilege is a no-op, so this is safe to run standalone, in any order, on
-- any project, including a from-scratch replay.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.or_create_platform(
  text, text, text, text, text, text, integer
) FROM PUBLIC, anon, authenticated;

-- Proof, not just intent: fail the migration if anon, authenticated or PUBLIC
-- still holds EXECUTE after the revoke above. This is the check
-- 20260723120000 was missing.
DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
  v_acl text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'or_create_platform is absent; nothing to check the ACL of';
  END IF;

  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = fn;

  -- A NULL proacl means the built-in default ACL stands, which for a function
  -- grants EXECUTE to PUBLIC. Treat NULL as a failure, not as "nothing to see".
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'or_create_platform: proacl is NULL (default ACL stands, PUBLIC holds EXECUTE)';
  END IF;

  IF v_acl LIKE '%anon=%' THEN
    RAISE EXCEPTION 'or_create_platform: anon still holds a privilege after REVOKE: %', v_acl;
  END IF;

  IF v_acl LIKE '%authenticated=%' THEN
    RAISE EXCEPTION 'or_create_platform: authenticated still holds a privilege after REVOKE: %', v_acl;
  END IF;

  IF v_acl LIKE '{=%' OR v_acl LIKE '%,=%' THEN
    -- Postgres prints a PUBLIC grant as a bare "=X/owner" entry with no role
    -- name before the "=", either as the first entry in the array or right
    -- after a comma. Either shape means PUBLIC holds a privilege.
    RAISE EXCEPTION 'or_create_platform: PUBLIC still holds a privilege after REVOKE: %', v_acl;
  END IF;
END
$$;

COMMIT;
