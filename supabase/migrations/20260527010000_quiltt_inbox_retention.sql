-- ============================================================
-- quiltt_webhook_inbox payload retention.
--
-- 20260526200000_quiltt_tables.sql left a TODO: the worker should null
-- or truncate `payload` ~30 days after `processed_at`. The raw event
-- bodies aren't needed for audit beyond that window — event_id, type,
-- and timestamps are kept indefinitely as the per-event audit trail.
--
-- This migration adds the cleanup function and schedules it once a day
-- via pg_cron. The function is also idempotent and safe to call
-- manually (operators or ad-hoc).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_quiltt_inbox_payloads()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.quiltt_webhook_inbox
     SET payload = jsonb_build_object('_truncated_at', now())
   WHERE processed_at IS NOT NULL
     AND processed_at < now() - INTERVAL '30 days'
     AND (payload->>'_truncated_at') IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

REVOKE ALL ON FUNCTION public.cleanup_quiltt_inbox_payloads() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_quiltt_inbox_payloads() FROM authenticated, anon;

COMMENT ON FUNCTION public.cleanup_quiltt_inbox_payloads() IS
  'Truncate Quiltt webhook event payloads older than 30 days while keeping the row metadata for audit. Returns rows affected.';

-- Schedule via pg_cron once a day at 03:17 UTC. Idempotent unschedule
-- mirrors the pattern from 20260523000000_atomic_connect_flow.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'cleanup_quiltt_inbox_payloads';

    PERFORM cron.schedule(
      'cleanup_quiltt_inbox_payloads',
      '17 3 * * *',                                          -- 03:17 UTC daily
      $job$SELECT public.cleanup_quiltt_inbox_payloads();$job$
    );
    RAISE NOTICE 'cleanup_quiltt_inbox_payloads scheduled daily via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; cleanup_quiltt_inbox_payloads must be triggered manually';
  END IF;
END$$;
