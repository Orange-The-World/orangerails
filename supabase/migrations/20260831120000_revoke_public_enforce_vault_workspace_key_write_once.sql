-- 20260831120000_revoke_public_enforce_vault_workspace_key_write_once.sql
--
-- WHY
-- public.enforce_vault_workspace_key_write_once carries a bare PUBLIC EXECUTE
-- grant (proacl starts with the PUBLIC pseudo-role entry "=X/postgres"), which
-- Supabase attaches by default to every newly created function in schema
-- public. Our standard is that a function carries a grant only for the roles
-- that actually call it. This is a trigger function: it is invoked by trigger
-- machinery, which does not consult EXECUTE at fire time, so no grant is
-- needed at all. Confirmed live on dev 2026-08-31: 52 functions in schema
-- public, 0 carry a named anon= entry, exactly 1 carries a bare PUBLIC entry
-- (this one), and has_function_privilege('anon', oid, 'EXECUTE') is true only
-- for it.
--
-- WHAT THIS DOES
-- Revokes EXECUTE from PUBLIC and from anon on this one function. Both roles
-- are named, because which entry is actually present depends on the project's
-- default privileges for functions in schema public.
--
-- The dev reading above holds on dev only, and generalising it was a defect in
-- the first version of this file. Where those defaults still include anon, a
-- newly created function lands with BOTH a bare "=X/..." PUBLIC entry AND a
-- named "anon=X/..." entry. Revoking only PUBLIC leaves the named grant in
-- place, the post condition below then finds that anon still holds EXECUTE, and
-- the migration aborts partway through an ordered batch apply. Naming both
-- roles is correct everywhere and is a no op wherever one is already absent.
--
-- WHAT THIS DOES NOT DO
-- Does not touch authenticated, service_role or postgres. It is also not
-- added to any anon-EXECUTE RPC allowlist: nothing calls this function as an
-- RPC, so there is no reason to keep it public, and an allowlist entry added
-- under deploy pressure is how a temporary exception becomes permanent.
--
-- REVERSIBILITY
-- Fully reversible. Nothing is dropped, no data touched, no table locked. The
-- undo is the matching GRANT, written at the bottom of this file for
-- reference (run by hand only).
--
-- IDEMPOTENCY
-- REVOKE is a no-op when the privilege is already absent. Guarded by
-- to_regprocedure so re-running on an environment where the function does not
-- exist, or has already been fixed, is a skip with a notice rather than a
-- failure.

DO $migration$
DECLARE
  v_sig text := 'public.enforce_vault_workspace_key_write_once()';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE NOTICE '[revoke-public] signature absent here, skipping: %', v_sig;
    RETURN;
  END IF;

  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_sig);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_sig);
  END IF;
  RAISE NOTICE '[revoke-public] revoked PUBLIC and anon EXECUTE on %', v_sig;
END
$migration$;

-- Post condition. Fails the transaction if the function still exists and
-- anon can still execute it.
DO $verify$
DECLARE
  v_sig text := 'public.enforce_vault_workspace_key_write_once()';
  v_oid oid;
BEGIN
  v_oid := to_regprocedure(v_sig);
  IF v_oid IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '[revoke-public] anon still holds EXECUTE on %', v_sig;
  END IF;

  RAISE NOTICE '[revoke-public] post condition passed: anon holds no EXECUTE on %', v_sig;
END
$verify$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (run by hand only, this restores a grant we deliberately removed)
--
-- GRANT EXECUTE ON FUNCTION public.enforce_vault_workspace_key_write_once()
--   TO PUBLIC;
-- ---------------------------------------------------------------------------
