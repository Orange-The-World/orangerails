-- 20260828220000_or_create_platform_revoke_public_execute.sql
--
-- Requirement: public.or_create_platform must never be callable by anon,
-- authenticated, or PUBLIC, on any project, regardless of migration order
-- or of whether the function already existed when 20260723120000 ran.
--
-- Why this is a separate forward migration and not an edit to
-- 20260723120000: dev cloud (fzwmnzmtqidumdqjdddz) has ALREADY applied
-- both 20260721120000 and 20260723120000 (verified 2026-08-28: both rows
-- present in supabase_migrations.schema_migrations), so an edited body of
-- either file would never re run there. The self hosted cluster has
-- applied neither (0 rows there as of the same check), so this file must
-- be correct standing alone, on either project, in either order.
--
-- Why an explicit REVOKE is required even though 20260723120000 already
-- added an in-body auth.uid() guard: CREATE OR REPLACE preserves the ACL
-- only when the function already exists. On a project where
-- or_create_platform is ABSENT before that migration runs, CREATE creates
-- it fresh, and a new function's default ACL grants EXECUTE to PUBLIC. On
-- that project 20260723120000 alone would hand the world EXECUTE on a key
-- minting function, and its own proof block, which asserts existence,
-- SECURITY DEFINER, and that the guard string is in prosrc, would still
-- pass, because none of those three assertions look at proacl. This
-- migration closes that gap directly, and its own proof block checks the
-- ACL, not just the source.
--
-- Idempotent: REVOKE on a role that already holds no privilege is a no-op,
-- so this is safe to re run. Reversible: re run the historical
-- GRANT EXECUTE ... TO PUBLIC that existed before 20260721120000, captured
-- verbatim in the maintainer only record for that change.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.or_create_platform(
  text, text, text, text, text, text, integer
) FROM PUBLIC, anon, authenticated;

-- Proof, not just intent: check the ACL itself, not merely that a REVOKE
-- statement ran without error. Uses aclexplode over coalesce(proacl,
-- acldefault(...)) so this also catches the case where proacl is still
-- NULL (a function that has never had an explicit grant carries the
-- default ACL, which for a function includes PUBLIC EXECUTE) rather than
-- only catching an explicit grant row.
DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
  v_owner  oid;
  v_offenders int;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'or_create_platform is absent, nothing to revoke';
  END IF;

  SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = fn;

  SELECT count(*) INTO v_offenders
  FROM pg_proc p,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', v_owner))) a
  WHERE p.oid = fn
    AND a.privilege_type = 'EXECUTE'
    AND (
      a.grantee = 0                          -- 0 is PUBLIC in an aclitem
      OR a.grantee = 'anon'::regrole
      OR a.grantee = 'authenticated'::regrole
    );

  IF v_offenders > 0 THEN
    RAISE EXCEPTION
      'or_create_platform still grants EXECUTE to PUBLIC, anon, or authenticated (% offending grant(s))',
      v_offenders;
  END IF;
END
$$;

COMMIT;
