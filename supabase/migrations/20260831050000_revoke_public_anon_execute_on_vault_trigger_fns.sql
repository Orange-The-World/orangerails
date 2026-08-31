-- Revoke PUBLIC and anon EXECUTE on four vault trigger functions (OR-T0963).
--
-- Measured live 2026-08-31 across EVERY function in schema public, not just
-- these four:
--   dev  fzwmnzmtqidumdqjdddz  0 rows carrying an anon entry or a bare PUBLIC
--        entry. Already clean.
--   prod lcdicqalreskibdfxkzb  3 rows, each carrying BOTH:
--          enforce_customer_vault_pubkey_write_once
--          enforce_vault_meta_no_direct_delete
--          enforce_vault_pubkey_write_once
--        acl on all three:
--          {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- enforce_vault_workspace_key_write_once does not exist on prod yet (the
-- migration that creates it is unapplied there). It is handled below so this
-- file is correct in either order.
--
-- Both anon AND PUBLIC are revoked. Revoking anon alone leaves the bare PUBLIC
-- entry, and anon inherits EXECUTE through PUBLIC, so the grant stays reachable.
--
-- Safety: EXECUTE on a trigger function is checked at CREATE TRIGGER time, not
-- on each fire, and authenticated holds its own explicit EXECUTE entry on all
-- four. The assertion block below proves that entry survives, so a mistake
-- aborts rather than silently disarming a write-once guard.
--
-- Reversal:
--   GRANT EXECUTE ON FUNCTION public.enforce_customer_vault_pubkey_write_once() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.enforce_vault_meta_no_direct_delete() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.enforce_vault_pubkey_write_once() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.enforce_vault_workspace_key_write_once() TO PUBLIC;

BEGIN;

-- 1. Revoke, per function, only where the function exists.
--    A bare REVOKE on a missing function raises, which would make this file
--    order-dependent across the two projects. The loop resolves each function
--    by name in schema public and skips the ones that are not there, naming
--    what it skipped so a silent no-op is impossible to mistake for a success.
DO $$
DECLARE
  target      TEXT;
  fn          oid;
  n_revoked   INT := 0;
  n_absent    INT := 0;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'enforce_customer_vault_pubkey_write_once',
    'enforce_vault_meta_no_direct_delete',
    'enforce_vault_pubkey_write_once',
    'enforce_vault_workspace_key_write_once'
  ]
  LOOP
    SELECT p.oid INTO fn
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = target
       AND p.pronargs = 0;

    IF fn IS NULL THEN
      n_absent := n_absent + 1;
      RAISE NOTICE 'skipped, function not present in this database: public.%()', target;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC', target);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM anon',   target);
    n_revoked := n_revoked + 1;
    fn := NULL;
  END LOOP;

  RAISE NOTICE 'revoked on % function(s), % absent', n_revoked, n_absent;
END;
$$;

-- 2. Prove it in this transaction, or abort.
--    (a) no function in schema public still carries an anon entry or a bare
--        PUBLIC entry. Scanned across the WHOLE schema deliberately: pinning
--        only the four names would pass while a fifth function created the same
--        way sat there with the same inherited grant, which is exactly how this
--        was missed the first time.
--    (b) authenticated KEEPS EXECUTE on every one of the four that exists here.
--        Without this, a revoke that went too wide would disarm a write-once
--        guard and this migration would report success.
DO $$
DECLARE
  offenders TEXT;
  target    TEXT;
BEGIN
  SELECT string_agg(p.proname || ' ' || p.proacl::text, '; ' ORDER BY p.proname)
    INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proacl IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM unnest(p.proacl) a
        WHERE a::text LIKE '=%' OR a::text LIKE 'anon=%'
     );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: function(s) in schema public still reachable by anon or PUBLIC: %', offenders;
  END IF;

  FOREACH target IN ARRAY ARRAY[
    'enforce_customer_vault_pubkey_write_once',
    'enforce_vault_meta_no_direct_delete',
    'enforce_vault_pubkey_write_once',
    'enforce_vault_workspace_key_write_once'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = target AND p.pronargs = 0
    ) AND NOT has_function_privilege('authenticated', 'public.' || quote_ident(target) || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: authenticated lost EXECUTE on public.%() -- the write-once guard would refuse every write', target;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
