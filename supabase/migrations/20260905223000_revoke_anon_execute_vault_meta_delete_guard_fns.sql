-- Revoke anon/authenticated EXECUTE on the two vault-meta delete-guard trigger
-- functions created by 20260828170000 and 20260828221500.
--
-- Both functions are RETURNS TRIGGER, SECURITY DEFINER, owned by a
-- postgres-run migration (not a supabase_admin default-privilege grant, so a
-- plain REVOKE actually removes it, unlike the OR-T0701 case). Postgres does
-- not check EXECUTE privilege when a function fires as a trigger, so removing
-- anon/authenticated does not change trigger behavior at all. It only closes
-- the direct-call path (SELECT public.fn()), which these functions were never
-- meant to serve and which the check-pending-migrations CI job flags on every
-- dev deploy.
--
-- Same shape as 20260822031500 (record_stealth_scan_range): guarded with
-- to_regprocedure so a database where either function does not exist skips
-- rather than raising 42883, and a verify block so a run that revoked nothing
-- fails loudly instead of reporting a false pass.
--
-- Idempotent: REVOKE against an absent grant is a no-op, safe to re-run.
-- Reversible: GRANT EXECUTE ON FUNCTION ... TO anon, authenticated, though no
-- caller uses it and OR-T2401 found none.

DO $revoke$
DECLARE
  v_sig  text;
  v_sigs text[] := ARRAY[
    'public.clear_customer_vault_meta_on_account_removal()',
    'public.enforce_customer_vault_meta_no_direct_delete()'
  ];
  v_hit  int := 0;
  v_skip int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'role anon does not exist on this database, nothing to revoke';
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'skipped, signature absent on this database: %', v_sig;
      CONTINUE;
    END IF;
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    v_hit := v_hit + 1;
  END LOOP;

  IF v_hit = 0 THEN
    RAISE EXCEPTION
      'FAIL: neither vault-meta-delete-guard function exists here, so this migration revoked nothing (% signature(s) skipped)',
      v_skip;
  END IF;

  RAISE NOTICE 'revoked on % function(s), skipped % absent signature(s)', v_hit, v_skip;
END
$revoke$;

-- Post-conditions. Fail rather than report a false pass.
DO $verify$
DECLARE
  v_sig  text;
  v_oid  oid;
  v_sigs text[] := ARRAY[
    'public.clear_customer_vault_meta_on_account_removal()',
    'public.enforce_customer_vault_meta_no_direct_delete()'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_oid := to_regprocedure(v_sig);
    CONTINUE WHEN v_oid IS NULL;

    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: anon still holds EXECUTE on %', v_sig;
    END IF;

    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: authenticated still holds EXECUTE on %', v_sig;
    END IF;
  END LOOP;
END
$verify$;
