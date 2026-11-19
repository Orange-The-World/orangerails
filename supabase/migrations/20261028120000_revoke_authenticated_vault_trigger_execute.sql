-- supabase/migrations/20261028120000_revoke_authenticated_vault_trigger_execute.sql
--
-- Revokes EXECUTE on five vault functions from the authenticated role.
-- Three of the four trigger functions are called only by the PostgreSQL trigger
-- mechanism; lookup_vault_pubkey is called only by service-role paths. None
-- should be reachable directly via the PostgREST RPC surface under the
-- authenticated role.
--
-- HISTORY: migration 20260909020000 was never merged (PR #889 closed unmerged,
-- OR-T1963 dropped). This replaces that migration. See OR-T0509.

REVOKE EXECUTE ON FUNCTION public.enforce_customer_vault_pubkey_write_once() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_vault_pubkey_write_once() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_vault_workspace_key_write_once() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_key_version_must_not_decrease() FROM authenticated;

-- Post-apply rejection test: assert all five grants are gone.
-- Raises an exception (and aborts the migration) if any authenticated EXECUTE
-- grant on these functions survives the revoke above.
DO $$
DECLARE
  remaining text;
BEGIN
  SELECT string_agg(proname, ', ' ORDER BY proname) INTO remaining
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'enforce_customer_vault_pubkey_write_once',
      'enforce_vault_pubkey_write_once',
      'enforce_vault_workspace_key_write_once',
      'lookup_vault_pubkey',
      'vault_key_version_must_not_decrease'
    )
    AND has_function_privilege('authenticated', p.oid, 'execute');

  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION
      'revoke_authenticated_vault_trigger_execute: authenticated can still EXECUTE: %',
      remaining;
  END IF;
END;
$$;
