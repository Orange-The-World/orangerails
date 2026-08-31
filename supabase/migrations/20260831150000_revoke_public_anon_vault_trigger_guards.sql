-- 20260831150000_revoke_public_anon_vault_trigger_guards.sql
--
-- WHY
-- Three vault guard functions in schema public carry EXECUTE grants that
-- nothing needs: a bare PUBLIC entry (the aclitem with an empty grantee, which
-- renders as "=X/owner") and, on the production project, a named anon entry as
-- well. Both are attached by default privileges when the function is created,
-- not by anything in our migration set. Our standard is that a function
-- carries a grant only for the roles that actually call it, and all three are
-- trigger functions: the trigger machinery does not consult EXECUTE when it
-- fires, so no grant is required at all.
--
-- READ LIVE 2026-08-31 on both projects before this file was written:
--   dev  : all three carry postgres, authenticated and service_role only.
--          No PUBLIC entry and no anon entry, so this migration is a no-op
--          there and the post condition simply proves the end state.
--   prod : all three carry a bare PUBLIC entry AND a named anon entry.
--
-- WHAT THIS DOES
-- Revokes EXECUTE from PUBLIC and from anon on the three functions. PUBLIC is
-- named explicitly as well as anon, because anon reaches EXECUTE through
-- PUBLIC: revoking only anon leaves the bare entry in place, and the migration
-- apply gate then stays red, correctly.
--
-- SCOPE
--   public.enforce_customer_vault_pubkey_write_once()
--   public.enforce_vault_meta_no_direct_delete()
--   public.enforce_vault_pubkey_write_once()
-- A fourth function of the same class, enforce_vault_workspace_key_write_once,
-- is handled by its own migration in PR #991 and is deliberately not repeated
-- here. Either order is safe: the two files touch different functions.
--
-- WHAT THIS DOES NOT DO
-- Does not touch authenticated, service_role or postgres. Drops nothing, reads
-- and writes no row, takes no table lock. No allowlist entry is added, because
-- nothing calls these functions as an RPC and an exception added under deploy
-- pressure is how a temporary allowance becomes permanent.
--
-- REVERSIBILITY
-- Fully reversible. Nothing is dropped and no data is touched. The undo is the
-- matching GRANT, written at the bottom of this file for reference (to be run
-- by hand only).
--
-- IDEMPOTENCY
-- REVOKE is a no-op when the privilege is already absent, and every signature
-- is guarded by to_regprocedure, so a re-run, or a run against a database
-- where one of these functions does not exist, is a skip with a notice rather
-- than a failure.

DO $migration$
DECLARE
  v_sig      text;
  v_sigs     text[] := ARRAY[
    'public.enforce_customer_vault_pubkey_write_once()',
    'public.enforce_vault_meta_no_direct_delete()',
    'public.enforce_vault_pubkey_write_once()'
  ];
  v_has_anon boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE NOTICE '[revoke-public-anon] signature absent here, skipping: %', v_sig;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_sig);
    IF v_has_anon THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_sig);
    END IF;

    RAISE NOTICE '[revoke-public-anon] revoked PUBLIC (and anon where the role exists) EXECUTE on %', v_sig;
  END LOOP;
END
$migration$;

-- Post condition. Fails the transaction if any of the three still carries an
-- anon entry or a bare PUBLIC entry, and separately if anon can still execute
-- it by any route. The first test is deliberately the same predicate the
-- migration apply gate uses, so a pass here means a pass there.
DO $verify$
DECLARE
  v_sig  text;
  v_sigs text[] := ARRAY[
    'public.enforce_customer_vault_pubkey_write_once()',
    'public.enforce_vault_meta_no_direct_delete()',
    'public.enforce_vault_pubkey_write_once()'
  ];
  v_oid  oid;
  v_bad  text;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      CONTINUE;
    END IF;

    SELECT string_agg(ace::text, ', ')
      INTO v_bad
      FROM pg_proc p
      CROSS JOIN LATERAL unnest(coalesce(p.proacl, '{}'::aclitem[])) AS ace
     WHERE p.oid = v_oid
       AND (ace::text LIKE 'anon=%' OR ace::text LIKE '=%');

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION '[revoke-public-anon] % still carries an anon or PUBLIC EXECUTE entry: %', v_sig, v_bad;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '[revoke-public-anon] anon still holds EXECUTE on %', v_sig;
    END IF;

    RAISE NOTICE '[revoke-public-anon] post condition passed on %', v_sig;
  END LOOP;
END
$verify$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (run by hand only, this restores grants we deliberately removed)
--
-- GRANT EXECUTE ON FUNCTION public.enforce_customer_vault_pubkey_write_once() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.enforce_vault_meta_no_direct_delete()      TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.enforce_vault_pubkey_write_once()          TO PUBLIC;
-- ---------------------------------------------------------------------------
