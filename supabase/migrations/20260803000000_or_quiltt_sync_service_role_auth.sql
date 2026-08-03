-- Swap the custom OR_INTERNAL_WORKER_TOKEN handshake for standard Supabase
-- service_role auth on the or-quiltt-sync cron invoker (DL-0599).
--
-- Background:
--   The drain previously read or_internal_worker_token from Vault and sent
--   it in an X-Internal-Worker-Token header. The Edge Function verified it
--   against the OR_INTERNAL_WORKER_TOKEN env var. This required a custom
--   credential managed out-of-band. On dev the Vault had zero rows, so the
--   drain failed on every tick since 2026-07-30 (DL-0599).
--
-- New design:
--   * The drain reads the project service_role key from Vault under the
--     secret name 'or_service_role_key' and sends it as a standard
--     'Authorization: Bearer <key>' header.
--   * The Edge Function verifies against SUPABASE_SERVICE_ROLE_KEY, which
--     Supabase sets automatically on every project. No new env var needed.
--   * The base URL still comes from Vault under 'or_functions_base_url'.
--
-- Operator runbook (one-time, per environment):
--   SELECT vault.create_secret(
--     '<project-service-role-key>',
--     'or_service_role_key',
--     'Service role key used by the cron drain to call or-quiltt-sync'
--   );
--   -- Remove the old secret if still present:
--   DELETE FROM vault.secrets WHERE name = 'or_internal_worker_token';

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $$
DECLARE
  service_role_key TEXT;
  base_url         TEXT;
  request_id       BIGINT;
BEGIN
  SELECT decrypted_secret INTO service_role_key
  FROM vault.decrypted_secrets
  WHERE name = 'or_service_role_key'
  LIMIT 1;

  IF service_role_key IS NULL OR service_role_key = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] vault secret or_service_role_key missing - skipping';
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] vault secret or_functions_base_url missing - skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-quiltt-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || service_role_key
    ),
    body                  := '{}'::jsonb,
    timeout_milliseconds  := 30000
  ) INTO request_id;

  RETURN request_id;
END
$$;

REVOKE ALL ON FUNCTION public.invoke_or_quiltt_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_quiltt_sync() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_quiltt_sync() IS
  'Cron-only helper. POSTs an empty body to or-quiltt-sync using service_role auth. '
  'Both the base URL (or_functions_base_url) and the service role key (or_service_role_key) '
  'are read from Supabase Vault. No-op + NOTICE if either secret is missing.';
