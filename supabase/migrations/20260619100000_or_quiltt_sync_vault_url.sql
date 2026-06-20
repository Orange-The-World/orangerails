-- Move the or-quiltt-sync base URL out of the function body into Supabase Vault.
--
-- Background:
--   * 20260611210000_or_quiltt_sync_vault_token.sql shipped invoke_or_quiltt_sync()
--     with the base URL as a literal and the worker token read from
--     vault.decrypted_secrets (name = 'or_internal_worker_token').
--   * The literal URL is fine for the maintainer's deploy but ties the
--     function to one Supabase project ref. Public forks self-hosting
--     this stack would otherwise need to edit migration files just to
--     change the URL.
--
-- New design:
--   * The base URL is now read from Vault, under the secret name
--     'or_functions_base_url'. Same pattern as the worker token: the
--     secret is set out-of-band via Supabase Studio (or
--     vault.create_secret) and rotates without a migration.
--   * If the secret is missing or empty, the function logs a NOTICE and
--     no-ops (same behavior as the worker-token-missing case).
--
-- Operator runbook (one-time, per environment):
--   SELECT vault.create_secret(
--     'https://<your-project>.supabase.co/functions/v1',
--     'or_functions_base_url',
--     'Base URL the or-quiltt-sync cron should POST to'
--   );
--
-- No plaintext URL stored in source control. No GUC dependency
-- (still cannot ALTER DATABASE through the Management API role).

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $$
DECLARE
  worker_token TEXT;
  base_url     TEXT;
  request_id   BIGINT;
BEGIN
  SELECT decrypted_secret INTO worker_token
  FROM vault.decrypted_secrets
  WHERE name = 'or_internal_worker_token'
  LIMIT 1;

  IF worker_token IS NULL OR worker_token = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] vault secret or_internal_worker_token missing - skipping';
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
      'Content-Type',            'application/json',
      'X-Internal-Worker-Token', worker_token
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
  'Cron-only helper. POSTs an empty body to or-quiltt-sync with the internal worker token. Both the base URL and the worker token are read from Supabase Vault (secret names: or_functions_base_url, or_internal_worker_token). No-op + NOTICE if either secret is missing.';
