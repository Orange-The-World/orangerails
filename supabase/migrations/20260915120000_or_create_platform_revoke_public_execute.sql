-- Explicit REVOKE and ACL proof for or_create_platform (OR-T0851 step 7).
--
-- Raised by the Auditor pass on DEV-0418, against
-- 20260723120000_or_create_platform_require_authenticated_caller.sql. That
-- file's own proof block asserts the function exists, asserts SECURITY
-- DEFINER, and asserts the in-body caller guard string is present in prosrc.
-- It asserts nothing about proacl, and a migration named
-- require_authenticated_caller that never checks who may call the function
-- has not verified the thing it is named after.
--
-- WHY THIS IS ITS OWN MIGRATION, NOT AN EDIT TO THAT FILE. Dev cloud
-- (fzwmnzmtqidumdqjdddz) has already applied both 20260721120000 and
-- 20260723120000, so an edited body there would never re-run. This is a new
-- forward migration instead, so it applies on every project regardless of
-- migration history.
--
-- WHAT ACTUALLY NEEDS FIXING. or_create_platform is SECURITY DEFINER and
-- returns a freshly minted platform API key in its result set. CREATE OR
-- REPLACE preserves the function's ACL only when the function already
-- exists; on a project where it is CREATEd fresh, Postgres' default grants
-- EXECUTE to PUBLIC. On such a project, 20260723120000 alone would hand the
-- world EXECUTE on a key-minting function while its own proof block still
-- passed, because that block never looks at proacl.
--
-- MEASURED BEFORE WRITING THIS FILE, 2026-09-15, orangerails_dev
-- (fzwmnzmtqidumdqjdddz), live query:
--   select p.proacl from pg_proc p
--    where p.oid = to_regprocedure(
--      'public.or_create_platform(text,text,text,text,text,text,integer)');
--   -> {postgres=X/postgres,service_role=X/postgres}
-- No anon, no authenticated, no PUBLIC entry: the 2026-07-21 revoke already
-- landed here and CREATE OR REPLACE preserved it, because the function
-- pre-existed at that point. So on dev cloud the REVOKE below is a
-- documented no-op and the assertion is a proof of already-correct state,
-- not a change. The gap this file closes is the self-hosted cluster (and any
-- future fresh project), where the 2026-08-28 live read cited in
-- OR-T0851 step 7 found or_create_platform's proacl carrying an explicit
-- anon entry.
--
-- Idempotent: guarded with to_regprocedure so a project missing this
-- function is skipped with a NOTICE rather than failing the run, and a
-- REVOKE of a privilege that is already absent is itself a no-op.
--
-- Reversible: GRANT EXECUTE ON FUNCTION
--   public.or_create_platform(text,text,text,text,text,text,integer)
--   TO authenticated;
-- (anon and PUBLIC are not restored; neither ever had a documented caller.)
--
-- Locking: REVOKE on a function takes no table lock and scans no row.

BEGIN;

DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
BEGIN
  IF fn IS NULL THEN
    RAISE NOTICE 'skipped, or_create_platform not present on this project';
  ELSE
    REVOKE EXECUTE ON FUNCTION public.or_create_platform(
      text, text, text, text, text, text, integer
    ) FROM PUBLIC, anon, authenticated;
  END IF;
END
$$;

-- Proof: the thing this file is named after. Skipped, not silently passed,
-- on a project where the function is absent.
DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
  v_secdef boolean;
  n        integer;
BEGIN
  IF fn IS NULL THEN
    RAISE NOTICE 'or_create_platform not present on this project, ACL proof skipped';
    RETURN;
  END IF;

  SELECT p.prosecdef INTO v_secdef FROM pg_proc p WHERE p.oid = fn;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'or_create_platform lost SECURITY DEFINER';
  END IF;

  SELECT count(*)
    INTO n
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) AS x
   WHERE p.oid = fn
     AND x.privilege_type = 'EXECUTE'
     AND (x.grantee = 0::oid
          OR x.grantee = 'anon'::regrole
          OR x.grantee = 'authenticated'::regrole);

  IF n <> 0 THEN
    RAISE EXCEPTION
      'assert failed: or_create_platform still grants EXECUTE to PUBLIC, anon or authenticated (% matching entries)',
      n;
  END IF;

  RAISE NOTICE
    'or_create_platform ACL ok: no EXECUTE for PUBLIC, anon or authenticated';
END
$$;

COMMIT;
