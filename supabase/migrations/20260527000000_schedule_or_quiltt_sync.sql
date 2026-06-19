-- ============================================================
-- Wire or-quiltt-sync to pg_cron so the inbox actually drains.
--
-- Without this, or-quiltt-webhook accepts Quiltt events and rows pile
-- up in quiltt_webhook_inbox forever. Nothing pulls them, nothing
-- seals them under OPK, nothing lands in encrypted_transactions.
--
-- The cron job calls the or-quiltt-sync edge function via pg_net every
-- minute. Each invocation drains a bounded batch (20 events) so the
-- worker stays well under Supabase's 60-second pg_cron + 60-second
-- edge function limits.
--
-- Two project-level GUCs gate the call. Set them once per Supabase
-- project (dev + prod) with:
--
--   ALTER DATABASE postgres SET app.or_internal_worker_token = '<hex64>';
--   ALTER DATABASE postgres SET app.or_functions_base_url   = 'https://<project-ref>.supabase.co/functions/v1';
--
-- The token MUST match the OR_INTERNAL_WORKER_TOKEN secret on the same
-- project. If either GUC is missing, the helper no-ops with a NOTICE
-- so the cron schedule survives a half-configured environment.
-- ============================================================

-- 1. Required extensions. On Supabase Cloud both come pre-installed
--    but need to be enabled per-project; CREATE EXTENSION IF NOT EXISTS
--    is a no-op if they're already on. On a self-hosted Postgres the
--    operator may need to GRANT permissions first; in that case the
--    migration fails fast and the operator fixes the install.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Helper function — fires off one HTTP POST to or-quiltt-sync.
--
--    SECURITY DEFINER so cron.schedule can call it under the cron user
--    while still reaching net.http_post + the OR settings. We do not
--    grant EXECUTE to authenticated / anon — only the cron job needs it.

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  worker_token TEXT;
  base_url     TEXT;
  request_id   BIGINT;
BEGIN
  worker_token := current_setting('app.or_internal_worker_token', true);
  base_url     := current_setting('app.or_functions_base_url',    true);

  IF worker_token IS NULL OR worker_token = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] app.or_internal_worker_token unset — skipping';
    RETURN NULL;
  END IF;
  IF base_url IS NULL OR base_url = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_sync] app.or_functions_base_url unset — skipping';
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
  'Cron-only helper. Posts an empty body to or-quiltt-sync with the internal worker token GUC. Returns net.http_post request id. No-op + NOTICE if GUCs are unset.';

-- 3. Schedule the job. Mirror the idempotent pattern from
--    20260523000000_atomic_connect_flow.sql so reruns of the migration
--    don't stack duplicate schedules.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'or_quiltt_sync_drain';

    PERFORM cron.schedule(
      'or_quiltt_sync_drain',
      '* * * * *',                                              -- every minute
      $job$SELECT public.invoke_or_quiltt_sync();$job$
    );
    RAISE NOTICE 'or_quiltt_sync_drain scheduled every minute via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; or_quiltt_sync_drain must be triggered manually or via an external scheduler';
  END IF;
END$$;
