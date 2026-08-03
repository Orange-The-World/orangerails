-- DL-0599: expose or_internal_worker_token via SECURITY DEFINER RPC
--
-- Problem: or-quiltt-sync reads the worker token with:
--
--   fetch('/rest/v1/decrypted_secrets?...', { 'Accept-Profile': 'vault' })
--
-- This fails at runtime with a 503 because the vault schema is not exposed
-- through PostgREST. The existing cron caller (invoke_or_quiltt_sync) reads
-- vault.decrypted_secrets directly as a PG function, but the edge function
-- has no equivalent path.
--
-- Fix: a narrow SECURITY DEFINER function that returns exactly this one secret
-- by hard-coded name. The edge function calls it via client.rpc(...) with the
-- service_role key. SECURITY DEFINER means the read runs as the function owner
-- (postgres), so it succeeds regardless of the calling role's direct vault grants.
--
-- Security posture:
--   * EXECUTE revoked from PUBLIC (removes the implicit grant given to all roles).
--   * EXECUTE granted only to service_role. anon and authenticated have no path.
--   * The function is scoped to one secret name, not a generic get-any-secret
--     surface. This keeps the blast radius as small as possible on a
--     self-custody product.

CREATE OR REPLACE FUNCTION public.get_or_internal_worker_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  secret_val text;
BEGIN
  SELECT decrypted_secret INTO secret_val
  FROM vault.decrypted_secrets
  WHERE name = 'or_internal_worker_token'
  LIMIT 1;
  RETURN secret_val;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_or_internal_worker_token() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_or_internal_worker_token() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_internal_worker_token() TO service_role;

COMMENT ON FUNCTION public.get_or_internal_worker_token() IS
  'Returns the or_internal_worker_token vault secret for use by the or-quiltt-sync edge function. '
  'SECURITY DEFINER so the read succeeds via the vault schema regardless of caller grants. '
  'EXECUTE granted to service_role only. Called via client.rpc() with the service_role key. '
  'Never expose to anon or authenticated. (DL-0599)';
