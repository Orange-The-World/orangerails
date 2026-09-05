-- Revoke stray authenticated/PUBLIC EXECUTE on the user_vault_meta
-- delete-guard trigger function, found while reviewing PR #1334 (OR-T2419).
--
-- public.enforce_vault_meta_no_direct_delete() is the BEFORE DELETE guard on
-- public.user_vault_meta (trigger trg_vault_meta_no_direct_delete), created
-- by 20260809140000_revoke_delete_vault_meta and its body corrected by
-- 20260828170000_fix_vault_meta_delete_guard. It is RETURNS TRIGGER, NOT
-- SECURITY DEFINER, owned by a postgres-run migration (not a
-- supabase_admin default-privilege grant, so a plain REVOKE actually
-- removes it). Postgres does not check EXECUTE privilege when a function
-- fires as a trigger, so removing authenticated/PUBLIC EXECUTE does not
-- change trigger behavior at all. It only closes the direct-call path
-- (SELECT public.fn()), which this function was never meant to serve.
--
-- Verified live on dev before writing this migration:
--   has_function_privilege('anon', ..., 'EXECUTE')          = false
--   has_function_privilege('authenticated', ..., 'EXECUTE') = true
--   has_function_privilege('public', ..., 'EXECUTE')        = false
--   prosecdef                                                = false
-- anon and PUBLIC are included in the revoke anyway for completeness; a
-- REVOKE against an absent grant is a no-op.
--
-- Same shape as 20260905223000 (revoke_anon_execute_vault_meta_delete_guard_fns):
-- guarded with to_regprocedure so a database where the function does not
-- exist skips rather than raising 42883, and a verify block so a run that
-- revoked nothing fails loudly instead of reporting a false pass.
--
-- Idempotent: REVOKE against an absent grant is a no-op, safe to re-run.
-- Reversible: GRANT EXECUTE ON FUNCTION ... TO authenticated, though no
-- caller uses it (it is invoked only as a trigger).

DO $revoke$
DECLARE
  v_sig text := 'public.enforce_vault_meta_no_direct_delete()';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE NOTICE 'skipped, signature absent on this database: %', v_sig;
    RETURN;
  END IF;

  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);

  RAISE NOTICE 'revoked EXECUTE on %', v_sig;
END
$revoke$;

-- Post-condition. Fail rather than report a false pass.
DO $verify$
DECLARE
  v_sig text := 'public.enforce_vault_meta_no_direct_delete()';
  v_oid oid := to_regprocedure(v_sig);
BEGIN
  IF v_oid IS NULL THEN
    RETURN;
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon still holds EXECUTE on %', v_sig;
  END IF;

  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated still holds EXECUTE on %', v_sig;
  END IF;

  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: PUBLIC still holds EXECUTE on %', v_sig;
  END IF;
END
$verify$;
