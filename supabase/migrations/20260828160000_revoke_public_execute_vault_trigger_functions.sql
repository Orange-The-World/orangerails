-- 20260828160000_revoke_public_execute_vault_trigger_functions.sql
--
-- Take PUBLIC (and therefore anon) off EXECUTE for the five vault trigger
-- functions that still carry it.
--
-- WHAT THIS FIXES
-- Measured on the dev project on 2026-08-28, five functions in schema public
-- carry an empty grantee entry in pg_proc.proacl. In PostgreSQL aclitem text an
-- empty grantee before the = means PUBLIC, and PUBLIC includes every role, anon
-- among them. All five read:
--   =X/postgres, postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres
--
--   public.fn_uvp_pubkey_immutable()                     SECURITY DEFINER
--   public.enforce_customer_vault_pubkey_write_once()
--   public.enforce_vault_meta_no_direct_delete()
--   public.enforce_vault_pubkey_write_once()
--   public.vault_key_version_must_not_decrease()
--
-- That entry is the PostgreSQL default for a newly created function, not a grant
-- anyone wrote. 20260723190000_revoke_anon_execute_public_functions cleared the
-- same class for the functions that existed on 2026-07-23; these five were
-- created after it, so they were never covered. The default privilege rule for
-- functions in public owned by postgres no longer includes PUBLIC or anon, so
-- this is a one time correction of an existing set and not a recurring gap.
--
-- HOW EXPOSED THESE ACTUALLY ARE, stated plainly so this is neither overstated
-- nor discounted. All five return type trigger, and PostgREST does not expose a
-- trigger returning function as an RPC, so no anonymous browser call path is
-- known. No reachable call path has been demonstrated for any of the five. This
-- is defence in depth on the self custody surface, not a live breach. It is
-- still worth closing: fn_uvp_pubkey_immutable is SECURITY DEFINER and sits on
-- the vault pubkey surface, and these are the same tables
-- 20260828120000_revoke_table_grants_org_vault.sql just hardened at the table
-- level.
--
-- THE SHAPE. One explicit block per function, PUBLIC always named, the full
-- identity signature written out so a same named overload cannot be missed. No
-- ALL FUNCTIONS IN SCHEMA and no comma separated multi function REVOKE, so there
-- is no wide statement that a later function can accidentally fall inside of.
--
-- WHAT IS DELIBERATELY LEFT ALONE. authenticated, service_role and postgres keep
-- EXECUTE. Trigger functions are invoked by the trigger machinery, which does not
-- consult EXECUTE at fire time, so none of these grants is what makes the vault
-- write path work; they are left because removing them is a different change with
-- a different blast radius and belongs in its own migration if it is wanted.
--
-- anon and authenticated are Supabase built in roles and exist on every project
-- this repo targets, so the REVOKE statements are written unguarded.
--
-- Idempotent. REVOKE is a no op when the privilege is already absent. The
-- assertions at the end fail loudly rather than letting a partial apply look
-- like a success. Fully reversible: nothing is dropped and no data is touched.

-- fn_uvp_pubkey_immutable: SECURITY DEFINER guard, x25519 pubkey is write once.
REVOKE ALL ON FUNCTION public.fn_uvp_pubkey_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_uvp_pubkey_immutable() FROM anon;

-- enforce_customer_vault_pubkey_write_once: customer_vault_meta pubkey guard.
REVOKE ALL ON FUNCTION public.enforce_customer_vault_pubkey_write_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_customer_vault_pubkey_write_once() FROM anon;

-- enforce_vault_meta_no_direct_delete: user_vault_meta delete guard.
REVOKE ALL ON FUNCTION public.enforce_vault_meta_no_direct_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_vault_meta_no_direct_delete() FROM anon;

-- enforce_vault_pubkey_write_once: user_vault_meta pubkey guard.
REVOKE ALL ON FUNCTION public.enforce_vault_pubkey_write_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_vault_pubkey_write_once() FROM anon;

-- vault_key_version_must_not_decrease: monotonic vault key version guard.
REVOKE ALL ON FUNCTION public.vault_key_version_must_not_decrease() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vault_key_version_must_not_decrease() FROM anon;

-- Prove it, rather than assume the statements above did what they say. Four
-- separate assertions, because "no PUBLIC entry", "proacl did not go null",
-- "anon cannot execute" and "the real callers kept EXECUTE" are four different
-- facts and a migration that can only report the first is not worth much.
DO $verify$
DECLARE
  guarded text[] := ARRAY[
    'public.fn_uvp_pubkey_immutable()',
    'public.enforce_customer_vault_pubkey_write_once()',
    'public.enforce_vault_meta_no_direct_delete()',
    'public.enforce_vault_pubkey_write_once()',
    'public.vault_key_version_must_not_decrease()'
  ];
  sig       text;
  offenders text := '';
BEGIN
  FOREACH sig IN ARRAY guarded LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE EXCEPTION 'signature % is absent from this database, the migration is targeting the wrong name', sig;
    END IF;

    -- 1. proacl must not be null. A null acl means the built in default applies,
    --    and the built in default for a function is EXECUTE to PUBLIC, which is
    --    the exact thing this migration removes.
    IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = to_regprocedure(sig)) THEN
      offenders := offenders || sig || ' has a null proacl (default PUBLIC EXECUTE applies); ';
      CONTINUE;
    END IF;

    -- 2. no PUBLIC entry and no direct anon entry may remain.
    IF EXISTS (
      SELECT 1
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = to_regprocedure(sig)
        AND (a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
    ) THEN
      offenders := offenders || sig || ' still carries a PUBLIC or anon entry; ';
      CONTINUE;
    END IF;

    -- 3. anon must not be able to execute it by any route.
    IF has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE') THEN
      offenders := offenders || sig || ' is still executable by anon; ';
      CONTINUE;
    END IF;

    -- 4. the real callers must keep EXECUTE, or this migration over reached.
    IF NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE') THEN
      offenders := offenders || sig || ' lost EXECUTE for authenticated; ';
      CONTINUE;
    END IF;
    IF NOT has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE') THEN
      offenders := offenders || sig || ' lost EXECUTE for service_role; ';
    END IF;
  END LOOP;

  IF offenders <> '' THEN
    RAISE EXCEPTION 'post condition failed: %', offenders;
  END IF;

  -- 5. every trigger that depends on these five must still be attached and
  --    enabled, so the revoke cannot be read as having detached a guard.
  IF (
    SELECT count(*)
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND t.tgenabled = 'O'
      AND p.proname IN (
        'fn_uvp_pubkey_immutable',
        'enforce_customer_vault_pubkey_write_once',
        'enforce_vault_meta_no_direct_delete',
        'enforce_vault_pubkey_write_once',
        'vault_key_version_must_not_decrease'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'expected 6 enabled triggers on the five guarded functions after the revoke';
  END IF;

  RAISE NOTICE 'post condition passed: PUBLIC and anon hold no EXECUTE on the five vault trigger functions, and all 6 triggers are still enabled';
END
$verify$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (run by hand only, this restores a grant we deliberately removed)
--
-- GRANT EXECUTE ON FUNCTION public.fn_uvp_pubkey_immutable() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.enforce_customer_vault_pubkey_write_once() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.enforce_vault_meta_no_direct_delete() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.enforce_vault_pubkey_write_once() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.vault_key_version_must_not_decrease() TO PUBLIC;
-- ---------------------------------------------------------------------------
