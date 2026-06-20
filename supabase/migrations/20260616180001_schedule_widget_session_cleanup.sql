-- 20260616180001_schedule_widget_session_cleanup.sql
--
-- The cleanup_expired_widget_sessions() function was introduced in
-- 20260517120000_widget_sessions.sql but never scheduled. Used + expired
-- tokens accumulated forever, inviting DB bloat and enumeration vectors
-- as the table grows.
--
-- Schedule via pg_cron (already enabled on Supabase Pro). Hourly runs are
-- plenty — the function only catches rows >1h past expiry, and widget
-- tokens have a 5 min TTL, so the worst-case latency before a used token
-- is physically removed is ~2 hours.
--
-- Note on dollar quoting: the outer DO block uses $outer$ … $outer$ so
-- the cron.schedule SQL body (a regular '…' literal) is unambiguous.

DO $outer$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Drop prior schedule if any (idempotent).
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'cleanup_expired_widget_sessions_hourly';

    PERFORM cron.schedule(
      'cleanup_expired_widget_sessions_hourly',
      '7 * * * *',  -- :07 every hour, off the top-of-hour rush
      'SELECT public.cleanup_expired_widget_sessions();'
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed — widget session cleanup will not run automatically. Install with CREATE EXTENSION pg_cron; on the postgres role.';
  END IF;
END
$outer$;
