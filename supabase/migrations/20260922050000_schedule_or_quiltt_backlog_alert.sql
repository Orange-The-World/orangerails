-- ============================================================
-- Wire or-quiltt-backlog-alert to pg_cron (OR-T0267).
--
-- WHY. measureOpkDeferredBacklog / checkOpkDeferredBacklogAndAlert
-- (supabase/functions/or-quiltt-sync/deferred-backlog.ts, PR #1360) were
-- built and fully unit-tested but nothing on dev/prod ever called them:
-- no HTTP route, no cron entry, confirmed by a full-tree search for both.
-- A subaccount that never registers an OPK never drains its deferred
-- rows (clearDeferredRows is the only drain, per the ticket's own
-- confirmed finding), so the backlog grows unbounded and silently for
-- the life of that connection.
--
-- This migration provides:
--   a. public.invoke_or_quiltt_backlog_alert()
--      pg_net POST helper, same shape as invoke_or_quiltt_drain_alert()
--      (20260811000000) and invoke_or_queue_health() (20260824140000).
--      Reads or_internal_worker_token and or_functions_base_url from
--      vault. RAISE EXCEPTION on missing config so pg_cron marks the run
--      failed rather than silently doing nothing.
--   b. pg_cron job or_quiltt_backlog_alert, once a day.
--   c. idx_quiltt_webhook_inbox_opk_deferred_backlog, the partial index
--      the measurement query actually needs (see commit message).
--
-- Cadence: once a day, not every 10 minutes. The signal here is backlog
-- AGE against a 14 day threshold (DEFAULT_BACKLOG_THRESHOLD in
-- deferred-backlog.ts), so a faster cadence buys nothing, and
-- checkOpkDeferredBacklogAndAlert has no suppression state of its own
-- (unlike drain-alert and queue-health), so a faster cadence would mean
-- a persisting breach re-reports to GlitchTip every tick forever. No new
-- suppression table added here: the ticket's scope is detect-and-report
-- only, and daily cadence already bounds the repeat rate.
--
-- DDL scope: (a), (b), (c) are DDL. Applied by the DBA on dev and prod.
--
-- Down / undo (run these manually to remove this migration):
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'or_quiltt_backlog_alert';
--   DROP FUNCTION IF EXISTS public.invoke_or_quiltt_backlog_alert();
--   DROP INDEX IF EXISTS public.idx_quiltt_webhook_inbox_opk_deferred_backlog;
-- ============================================================


-- 1. HTTP helper to invoke the check from pg_cron.

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_backlog_alert()
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
    RAISE EXCEPTION '[invoke_or_quiltt_backlog_alert] vault secret or_internal_worker_token missing';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION '[invoke_or_quiltt_backlog_alert] vault secret or_functions_base_url missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-quiltt-backlog-alert',
    headers := jsonb_build_object(
      'Content-Type',            'application/json',
      'X-Internal-Worker-Token', worker_token
    ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) INTO request_id;

  RETURN request_id;
END
$$;

REVOKE ALL ON FUNCTION public.invoke_or_quiltt_backlog_alert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_quiltt_backlog_alert() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_quiltt_backlog_alert() IS
  'Cron-only helper. POSTs to or-quiltt-backlog-alert with the internal worker token. '
  'Both secrets read from vault.decrypted_secrets (or_internal_worker_token, '
  'or_functions_base_url). RAISE EXCEPTION on missing config so pg_cron marks '
  'the run failed (OR-T0267).';


-- 2. Schedule once a day. See cadence rationale above.
--    Idempotent: unschedules any prior or_quiltt_backlog_alert job first, so
--    re-running the migration is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'or_quiltt_backlog_alert';

    PERFORM cron.schedule(
      'or_quiltt_backlog_alert',
      '5 7 * * *',
      $job$SELECT public.invoke_or_quiltt_backlog_alert();$job$
    );
    RAISE NOTICE 'or_quiltt_backlog_alert scheduled daily via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; or_quiltt_backlog_alert must be triggered manually';
  END IF;
END$$;


-- 3. Index supporting the check's own query.
--
--    measureOpkDeferredBacklog fetches every row where opk_deferred_at IS
--    NOT NULL, ordered by received_at, paged. quiltt_webhook_inbox has no
--    "id" column (its primary key is event_id); received_at matches the
--    table's existing sibling index (idx_quiltt_webhook_inbox_pending,
--    20260730000000) and how the check actually pages. That sibling index
--    is partial on "processed_at IS NULL AND opk_deferred_at IS NULL" --
--    the exact opposite predicate -- so it cannot serve this query.
--    Without a matching index this degrades to a full scan of a table
--    that keeps rows indefinitely (only payload is truncated after 30
--    days, per 20260527010000_quiltt_inbox_retention.sql), which grows
--    every day this check runs.

CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_opk_deferred_backlog
  ON public.quiltt_webhook_inbox (received_at)
  WHERE opk_deferred_at IS NOT NULL;

COMMENT ON INDEX public.idx_quiltt_webhook_inbox_opk_deferred_backlog IS
  'Serves or-quiltt-backlog-alert: every currently-deferred row, ordered by '
  'received_at. Distinct from idx_quiltt_webhook_inbox_pending, which is '
  'partial on opk_deferred_at IS NULL and so cannot serve the opposite '
  'predicate (OR-T0267).';
