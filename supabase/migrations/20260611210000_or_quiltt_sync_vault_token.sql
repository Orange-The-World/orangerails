-- Rewrite invoke_or_quiltt_sync() to remove its GUC dependency.
--
-- The previous version read app.or_functions_base_url and
-- app.or_internal_worker_token via current_setting(). Those GUCs can only be
-- set with ALTER DATABASE / ALTER ROLE, which the Management API role lacks
-- (permission denied), so they were never set and the cron silently no-opped
-- on every run.
--
-- New design:
--   * base URL is a literal (it is not a secret)
--   * the worker token is read from Supabase Vault, under the secret named
--     'or_internal_worker_token' (set out-of-band, never in a migration file)
--
-- This keeps the whole thing in source control and deployable via the normal
-- migration path, with no manual dashboard step and no plaintext secret in git.

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $$
DECLARE
  worker_token TEXT;
  base_url     CONSTANT TEXT := 'https://lcdicqalreskibdfxkzb.supabase.co/functions/v1';
  request_id   BIGINT;
BEGIN
  SELECT decrypted_secret INTO worker_token
  FROM vault.decrypted_secrets
  WHERE name = 'or_internal_worker_token'
  LIMIT 1;

  IF worker_token IS NULL OR worker_token = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] vault secret or_internal_worker_token missing — skipping';
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
  'Cron-only helper. POSTs an empty body to or-quiltt-sync with the internal worker token read from Vault (secret name or_internal_worker_token). Base URL is a literal. No-op + NOTICE if the Vault secret is missing.';
