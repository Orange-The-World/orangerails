-- OUT-OF-ORDER-OK: absent from both ledgers, and no later migration touches this function, so applying it late is a no-op or the revoke it was always meant to be (OR-T2256).
--
-- What was actually checked, on 2026-09-05, twice and independently, by the
-- DBA and by the author of this line:
--
--   * The dev ledger (supabase_migrations.schema_migrations) tops out at
--     20260904150000 and has no row for 20260831130000. The prod ledger tops
--     out at 20260822031500 and has no row for it either. So no environment
--     is being asked to re-apply this; every environment is applying it for
--     the first time.
--   * Every migration numbered above this one was enumerated from the tree on
--     dev and read. None of them mentions
--     public.enforce_vault_workspace_key_write_once. There is no later grant
--     for this revoke to take back, and no later object that depends on the
--     grant it removes.
--   * The body is re-runnable by construction. Both DO blocks are guarded:
--     the first returns immediately when to_regprocedure finds no such
--     function, and the second only raises on a post-condition.
--
-- Renumbering was considered and rejected. This file already carries its
-- second version: it was 20260831120000 and was moved here because that
-- prefix collided with 20260831120000_user_vault_meta_keyring_epoch.sql
-- (OR-T1154). The ledger stores one row per version, so dev's existing
-- 20260831120000 row cannot be attributed to either of the two files that
-- shared that prefix. A third number would move the problem rather than end
-- it, and would leave the same guard refusing the same run tomorrow.
-- 20260831130000_revoke_public_enforce_vault_workspace_key_write_once.sql
--
-- WHY
-- public.enforce_vault_workspace_key_write_once is a trigger function in
-- schema public. Trigger machinery does not consult EXECUTE at fire time, so
-- this function needs no EXECUTE grant for anyone. Our standard is that a
-- function carries a grant only for the roles that actually call it.
--
-- WHERE THIS IS ACTUALLY NEEDED, and it is not dev.
-- Read live 2026-08-31 12:06 UTC (08:06 EDT), both projects, from pg_proc,
-- pg_default_acl and has_function_privilege rather than recalled:
--
--   dev  fzwmnzmtqidumdqjdddz
--     public.enforce_vault_workspace_key_write_once() exists and reads
--       postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres
--     has_function_privilege('anon', oid, 'EXECUTE') is FALSE for it.
--     Across the whole of schema public: 0 functions with a null proacl, 0
--     with a bare PUBLIC entry, 0 with a named anon entry, and 0 that anon
--     can execute.
--
--   prod lcdicqalreskibdfxkzb
--     public.enforce_vault_workspace_key_write_once() DOES NOT EXIST YET.
--     It is created by 20260828214500, which is still pending there.
--     Default privileges for functions in schema public owned by postgres:
--       {anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- So dev is already clean and this file changes nothing there. It is a no-op
-- on dev by design. The exposure it closes is on prod: the function will be
-- created under a default rule that hands anon EXECUTE, and it will land with
-- a NAMED anon grant, not merely a PUBLIC one.
--
-- THE FACT THAT WAS WRITTEN NOWHERE, and it is the load-bearing one: dev
-- reached that clean state OUT OF BAND. No migration in this repo produced
-- it. "dev is clean" is therefore not the same claim as "dev will stay
-- clean", and this file is what makes the property hold by rule rather than
-- by luck.
--
-- A NOTE ON COUNTING FUNCTIONS. An earlier version of this header cited a
-- headline count of functions in schema public as evidence. That number was
-- 52 when first written, 54 a few hours later, and 56 at the reading above,
-- all on the same day. A volatile count does not belong in a permanent
-- migration header: it is falsified by ordinary work and then reads as a
-- discovered exposure. The role-level facts above are the durable ones.
--
-- WHAT THIS DOES
-- Revokes EXECUTE from PUBLIC and from anon on this one function. Both roles
-- are named, because which entry is actually present depends on the project's
-- default privileges for functions in schema public.
--
-- Where those defaults still include anon, a newly created function lands
-- with BOTH a bare "=X/..." PUBLIC entry AND a named "anon=X/..." entry.
-- Revoking only PUBLIC leaves the named grant in place, the post condition
-- below then finds that anon still holds EXECUTE, and the migration aborts
-- partway through an ordered batch apply. Naming both roles is correct
-- everywhere and is a no op wherever one is already absent.
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
--
-- VERSION
-- Numbered 20260831130000, moved from 20260831120000, which collided with
-- 20260831120000_user_vault_meta_keyring_epoch.sql. Two files sharing a
-- version prefix make the drift report structurally blind: the ledger holds
-- one row per version, so once either is recorded the other is reported
-- applied whether it ran or not (OR-T1154).

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
