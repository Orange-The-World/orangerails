-- ============================================================
-- Wire or-quiltt-drain-alert to pg_cron for drain health monitoring.
-- Closes monitoring gap for or_quiltt_sync_drain (DL-0640).
--
-- Three signals checked every 10 minutes by the edge function:
--   A. Failure rate: >10% of runs failed in last 30 min
--   B. Zero completions: 0 succeeded runs in last 60 min
--   C. Queue stall: unprocessed, non-retired row older than 2 hours
--
-- This migration provides:
--   a. public.drain_cron_job_stats(failure_window_minutes int, success_window_minutes int)
--      SECURITY DEFINER bridge to cron.job_run_details for signals A and B.
--      cron schema is not in the PostgREST search path; same pattern as
--      quiltt_sync_cron_failures() from 20260801000000.
--   b. public.invoke_or_quiltt_drain_alert()
--      pg_net POST helper; reads secrets from vault. RAISE EXCEPTION on
--      missing config so pg_cron marks the run failed.
--   c. pg_cron job or_quiltt_drain_alert, every 10 minutes.
--   d. public.drain_alert_state (single-row suppression table).
--      Tracks last_notified_at to gate chat repost (60-min cooldown, DL-0640).
--
-- DDL scope: (a), (b), (c), and (d) are DDL. Applied by the DBA on dev and prod.
-- Signal C reads quiltt_webhook_inbox directly in the edge function; no
-- additional RPC bridge required.
--
-- Down / undo (run these manually to remove this migration):
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'or_quiltt_drain_alert';
--   DROP FUNCTION IF EXISTS public.invoke_or_quiltt_drain_alert();
--   DROP FUNCTION IF EXISTS public.drain_cron_job_stats(int, int);
--   DROP TABLE IF EXISTS public.drain_alert_state;
-- ============================================================


-- 1. SECURITY DEFINER bridge to cron.job_run_details for signals A and B.
--    Returns a jsonb row with three aggregate counts for or_quiltt_sync_drain:
--      failed_count:    runs with status='failed' in the last failure_window_minutes
--      total_count:     all runs in the last failure_window_minutes
--      succeeded_count: runs with status='succeeded' in the last success_window_minutes
--    Both windows scan the full history from GREATEST(windows) back, using FILTER
--    clauses to partition the aggregates. STABLE: no side effects.

CREATE OR REPLACE FUNCTION public.drain_cron_job_stats(
  failure_window_minutes int DEFAULT 30,
  success_window_minutes int DEFAULT 60
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = cron, pg_temp
AS $$
  SELECT jsonb_build_object(
    'failed_count',
      COUNT(*) FILTER (
        WHERE jrd.status = 'failed'
          AND jrd.start_time > now() - (failure_window_minutes || ' minutes')::interval
      ),
    'total_count',
      COUNT(*) FILTER (
        WHERE jrd.start_time > now() - (failure_window_minutes || ' minutes')::interval
      ),
    'succeeded_count',
      COUNT(*) FILTER (
        WHERE jrd.status = 'succeeded'
          AND jrd.start_time > now() - (success_window_minutes || ' minutes')::interval
      )
  )
  FROM   cron.job_run_details jrd
  JOIN   cron.job j ON j.jobid = jrd.jobid
  WHERE  j.jobname = 'or_quiltt_sync_drain';
$$;

REVOKE ALL ON FUNCTION public.drain_cron_job_stats(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drain_cron_job_stats(int, int) FROM authenticated, anon;
-- Service role only; called from the edge function via client.rpc().

COMMENT ON FUNCTION public.drain_cron_job_stats(int, int) IS
  'SECURITY DEFINER bridge to cron.job_run_details for or-quiltt-drain-alert. '
  'Returns JSON {failed_count, total_count, succeeded_count} for or_quiltt_sync_drain '
  'in the configured time windows (DL-0640). cron schema not reachable via PostgREST.';


-- 2. HTTP helper to invoke the drain alert edge function from pg_cron.
--    Matches the pattern of invoke_or_quiltt_inbox_alert() in 20260801000000.
--    Reads or_internal_worker_token and or_functions_base_url from vault.
--    RAISE EXCEPTION on missing config so pg_cron marks the job run as failed.

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_drain_alert()
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
    RAISE EXCEPTION '[invoke_or_quiltt_drain_alert] vault secret or_internal_worker_token missing';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION '[invoke_or_quiltt_drain_alert] vault secret or_functions_base_url missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-quiltt-drain-alert',
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

REVOKE ALL ON FUNCTION public.invoke_or_quiltt_drain_alert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_quiltt_drain_alert() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_quiltt_drain_alert() IS
  'Cron-only helper. POSTs to or-quiltt-drain-alert with the internal worker token. '
  'Both secrets read from vault.decrypted_secrets (or_internal_worker_token, or_functions_base_url). '
  'RAISE EXCEPTION on missing config so pg_cron marks the run failed (DL-0640).';


-- 3. Schedule the drain alert job every 10 minutes.
--    Idempotent: unschedules any prior or_quiltt_drain_alert job before scheduling
--    the new one, so re-running the migration is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'or_quiltt_drain_alert';

    PERFORM cron.schedule(
      'or_quiltt_drain_alert',
      '*/10 * * * *',
      $job$SELECT public.invoke_or_quiltt_drain_alert();$job$
    );
    RAISE NOTICE 'or_quiltt_drain_alert scheduled every 10 minutes via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; or_quiltt_drain_alert must be triggered manually';
  END IF;
END$$;


-- 4. Suppression state table.
--    Single-row table. The edge function checks last_notified_at before posting
--    and suppresses repeated chat posts when firing continuously.
--    Cooldown: 60 minutes (~6 posts/day max vs 144 without suppression).

CREATE TABLE IF NOT EXISTS public.drain_alert_state (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_notified_at TIMESTAMPTZ
);

INSERT INTO public.drain_alert_state (id, last_notified_at)
VALUES (1, NULL)
ON CONFLICT DO NOTHING;

REVOKE ALL ON TABLE public.drain_alert_state FROM PUBLIC, authenticated, anon;
-- Service role only; read and written by the edge function.

COMMENT ON TABLE public.drain_alert_state IS
  'Single-row suppression state for or-quiltt-drain-alert. '
  'last_notified_at is updated each time a Zulip alert is posted. '
  'Edge function suppresses reposts within 60 minutes (DL-0640).';
