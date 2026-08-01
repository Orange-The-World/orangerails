-- ============================================================
-- Wire or-quiltt-inbox-alert to pg_cron for continuous inbox monitoring.
-- Closes alert gap identified in GH-378 / GH-385.
--
-- Three signals checked by the edge function every 5 minutes:
--   1. Depth: unprocessed row count > 50 (tunable via env)
--   2. Staleness: oldest unprocessed received_at older than 60 min
--   3. pg_cron: any failed run of or_quiltt_sync_drain in past 60 min
--
-- This migration provides:
--   a. public.quiltt_sync_cron_failures(window_minutes int DEFAULT 60)
--      SECURITY DEFINER bridge to cron.job_run_details (not in public
--      schema; not reachable via PostgREST without this function).
--   b. public.invoke_or_quiltt_inbox_alert()
--      Same pg_net POST pattern as invoke_or_quiltt_sync.
--   c. pg_cron job or_quiltt_inbox_alert, every 5 minutes.
--
-- DDL scope: (a) and (c) are DDL. Applied by the DBA on dev and prod.
-- The signal 1 and 2 reads in the edge function use existing tables only.
-- ============================================================

-- 1. SECURITY DEFINER bridge to cron.job_run_details for signal 3.
--    cron schema is not in the PostgREST search path; a supabase-js client
--    using the service role cannot reach it directly. This function returns
--    the count of failed runs for or_quiltt_sync_drain in the given window.
--    STABLE: result is consistent within a transaction (no side effects).

CREATE OR REPLACE FUNCTION public.quiltt_sync_cron_failures(
  window_minutes int DEFAULT 60
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = cron, pg_temp
AS $$
  SELECT count(*)::bigint
  FROM   cron.job_run_details jrd
  JOIN   cron.job j ON j.jobid = jrd.jobid
  WHERE  j.jobname = 'or_quiltt_sync_drain'
    AND  jrd.status = 'failed'
    AND  jrd.start_time > now() - (window_minutes || ' minutes')::interval;
$$;

REVOKE ALL ON FUNCTION public.quiltt_sync_cron_failures(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quiltt_sync_cron_failures(int) FROM authenticated, anon;
-- Service role only; called from the edge function via client.rpc().

COMMENT ON FUNCTION public.quiltt_sync_cron_failures(int) IS
  'Returns the count of failed pg_cron runs for or_quiltt_sync_drain in the past '
  'window_minutes minutes. SECURITY DEFINER bridge to cron schema for the '
  'or-quiltt-inbox-alert edge function (GH-385).';


-- 2. HTTP helper to invoke the alert edge function (same pattern as
--    invoke_or_quiltt_sync in 20260527000000_schedule_or_quiltt_sync.sql).
--    Reads the worker token and base URL from per-project GUCs set once with:
--      ALTER DATABASE postgres SET app.or_internal_worker_token = '<hex64>';
--      ALTER DATABASE postgres SET app.or_functions_base_url   = 'https://<ref>.supabase.co/functions/v1';

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_inbox_alert()
RETURNS bigint
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
    RAISE NOTICE '[invoke_or_quiltt_inbox_alert] app.or_internal_worker_token unset -- skipping';
    RETURN NULL;
  END IF;
  IF base_url IS NULL OR base_url = '' THEN
    RAISE NOTICE '[invoke_or_quiltt_inbox_alert] app.or_functions_base_url unset -- skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-quiltt-inbox-alert',
    headers := jsonb_build_object(
      'Content-Type',            'application/json',
      'X-Internal-Worker-Token', worker_token
    ),
    body                  := '{}'::jsonb,
    timeout_milliseconds  := 15000
  ) INTO request_id;

  RETURN request_id;
END
$$;

REVOKE ALL ON FUNCTION public.invoke_or_quiltt_inbox_alert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_quiltt_inbox_alert() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_quiltt_inbox_alert() IS
  'Cron-only helper. POSTs to or-quiltt-inbox-alert with the internal worker token GUC. '
  'Returns net.http_post request id. No-op + NOTICE if GUCs are unset. '
  'Same pattern as invoke_or_quiltt_sync (GH-385).';


-- 3. Schedule the alert job every 5 minutes.
--    Idempotent: unschedules any prior or_quiltt_inbox_alert job before
--    scheduling the new one, so re-running the migration is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'or_quiltt_inbox_alert';

    PERFORM cron.schedule(
      'or_quiltt_inbox_alert',
      '*/5 * * * *',
      $job$SELECT public.invoke_or_quiltt_inbox_alert();$job$
    );
    RAISE NOTICE 'or_quiltt_inbox_alert scheduled every 5 minutes via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; or_quiltt_inbox_alert must be triggered manually';
  END IF;
END$$;
