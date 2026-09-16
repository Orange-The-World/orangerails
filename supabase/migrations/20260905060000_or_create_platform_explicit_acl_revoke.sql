-- Explicit REVOKE EXECUTE on or_create_platform, plus an ACL proof.
--
-- 20260723120000 added an in-body "must be signed in" guard and proved the
-- guard is present. It proved nothing about the function's EXECUTE grants.
-- CREATE OR REPLACE preserves an ACL only when the function already exists;
-- on a project where or_create_platform is absent, CREATE gives it PostgreSQL's
-- default ACL, EXECUTE to PUBLIC. or_create_platform is SECURITY DEFINER and
-- returns a freshly minted platform API key, so that default is a live key
-- minting function open to anyone. This migration makes the ACL explicit and
-- checks it, instead of relying on whatever a given project happened to have
-- before.
--
-- Idempotent: a REVOKE of a privilege that is already absent is a no-op.
-- Reversible: as postgres,
--   GRANT EXECUTE ON FUNCTION public.or_create_platform(text,text,text,text,text,text,integer) TO anon, authenticated;

BEGIN;

REVOKE EXECUTE ON FUNCTION public.or_create_platform(text, text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;

-- Proof: assert what the earlier migration never checked. Read the live ACL
-- back and fail the migration if anon, authenticated or PUBLIC still hold
-- EXECUTE, on this project, right now, rather than trusting a claim about
-- what some other project looked like on some other day.
DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'or_create_platform is absent; nothing to check';
  END IF;

  IF has_function_privilege('anon', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'or_create_platform: anon still holds EXECUTE after the revoke';
  END IF;

  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'or_create_platform: authenticated still holds EXECUTE after the revoke';
  END IF;

  IF has_function_privilege('PUBLIC', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'or_create_platform: PUBLIC still holds EXECUTE after the revoke';
  END IF;
END
$$;

COMMIT;
