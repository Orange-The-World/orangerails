-- DL-0460 Quiltt drain, Gate 2: make invoke_or_quiltt_sync() fail loudly.
--
-- Prior behavior (20260619100000_or_quiltt_sync_vault_url.sql): if either vault
-- secret was missing the function logged a NOTICE and returned NULL. A cron that
-- no-ops silently looks healthy while no sync ever runs, which is exactly how the
-- Quiltt drain went unnoticed. This migration removes the silent skip: a missing
-- secret now RAISES, so a broken config shows up as a failed cron run instead of
-- a green one that did nothing.
--
-- Scope note (honest limitation): net.http_post (pg_net) QUEUES the request and
-- returns a request_id BEFORE the HTTP call completes, so a failed POST cannot be
-- caught synchronously here. This migration makes the CONFIGURATION path loud
-- (missing secret raises). Delivery failures surface in net._http_response, not in
-- this function's return value.
--
-- Reversible: re-apply 20260619100000_or_quiltt_sync_vault_url.sql to restore the
-- NOTICE + RETURN NULL behavior. Idempotent: CREATE OR REPLACE.

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
  'Cron-only helper. POSTs an empty body to or-quiltt-sync with the internal worker token. Base URL and worker token are read from Supabase Vault (or_functions_base_url, or_internal_worker_token). RAISES if either secret is missing so a broken config is loud, not a silent no-op.';
