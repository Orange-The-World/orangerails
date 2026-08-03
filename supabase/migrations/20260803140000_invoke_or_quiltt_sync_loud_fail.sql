-- Harden invoke_or_quiltt_sync() missing-secret guards (DL-0599).
--
-- The 20260619100000_or_quiltt_sync_vault_url migration used
-- RAISE NOTICE + RETURN NULL when a vault secret was absent. That is
-- the silent-success shape: pg_cron exits 0 and nothing fires, so
-- "secret missing" and "sync ran fine" are indistinguishable.
--
-- New behaviour: RAISE EXCEPTION on a missing secret so pg_cron marks
-- the run as failed and any monitoring alert fires.
--
-- DELETE-after-deploy runbook (DL-0599):
--   1. Deploy this migration and the updated edge function (PR #510).
--   2. Send one probe request to or-quiltt-sync with a WRONG token.
--      Expected response: HTTP 401 (unauthorized).
--      If 503: the vault REST path is not live -- do not proceed.
--   3. Only after observing 401 in step 2: remove OR_INTERNAL_WORKER_TOKEN
--      from the hosting environment secrets (Supabase project env vars /
--      Cloudflare Workers secrets -- wherever it is set).
--   Do NOT delete the vault secret (or_internal_worker_token); the cron
--   still reads it via vault.decrypted_secrets.

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
    RAISE EXCEPTION '[invoke_or_quiltt_sync] vault secret or_internal_worker_token missing';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION '[invoke_or_quiltt_sync] vault secret or_functions_base_url missing';
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
  'Cron-only helper. POSTs an empty body to or-quiltt-sync with the internal worker token. Both the base URL and the worker token are read from Supabase Vault (secret names: or_functions_base_url, or_internal_worker_token). EXCEPTION (not NOTICE) if either secret is missing -- loud failure, not silent no-op.';
