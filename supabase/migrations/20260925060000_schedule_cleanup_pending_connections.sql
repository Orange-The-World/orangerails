-- 20260925060000_schedule_cleanup_pending_connections.sql
--
-- OR-T0499 step 1 (OR-C2094): cleanup_pending_connections() has existed
-- since or-link-complete's recovery path was added, but was never
-- scheduled. Verified live on dev 2026-09-25: 0 of 8 active cron.job rows
-- reference it.
--
-- Without a schedule, a connection that reaches status='pending' and then
-- has its own compensating DELETE fail (the branch OR-C2094 found in
-- recoverIncompleteLink) stays permanently pending, and the widget token
-- that created it stays permanently claimed, with no automatic recovery.
--
-- cleanup_pending_connections() itself (DELETE FROM public.connections
-- WHERE status = 'pending' AND created_at < now() - interval '10 minutes')
-- already existed before this migration; this migration only wires it to
-- pg_cron. Acceptance per OR-T0499 step 1: a pg_cron job on dev calls it on
-- an interval <= 10 minutes, verified via select * from cron.job.
--
-- 10-minute cadence matches the function's own 10-minute staleness window --
-- nothing can be stale enough to delete on a faster cadence.
--
-- Idempotent: unschedules any prior job of this name first, so re-running
-- this migration is safe.
--
-- Down / undo (run manually to remove this migration):
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cleanup_pending_connections_10min';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'cleanup_pending_connections_10min';

    PERFORM cron.schedule(
      'cleanup_pending_connections_10min',
      '*/10 * * * *',
      $job$SELECT public.cleanup_pending_connections();$job$
    );
    RAISE NOTICE 'cleanup_pending_connections_10min scheduled every 10 minutes via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; cleanup_pending_connections must be triggered manually';
  END IF;
END$$;
