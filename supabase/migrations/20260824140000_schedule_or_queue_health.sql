-- ============================================================
-- Wire or-queue-health to pg_cron (DL-1568).
--
-- WHY. This estate has had two "a drain stopped and nobody noticed" incidents
-- on two different pipelines, months apart, and a person chasing a customer
-- complaint found both. DL-0460: the Quiltt inbox drain silently dead 16 days.
-- DL-1562: the outbound webhook dispatcher never invoked at all, 52 rows with
-- attempts = 0 for ten weeks. or-quiltt-drain-alert already covers the Quiltt
-- inbox well. Nothing covers anything else, and nothing makes that visible.
--
-- This migration provides:
--   a. public.invoke_or_queue_health()
--      pg_net POST helper, same shape as invoke_or_quiltt_drain_alert() from
--      20260811000000. Reads or_internal_worker_token and or_functions_base_url
--      from vault. RAISE EXCEPTION on missing config so pg_cron marks the run
--      failed rather than silently doing nothing, which is the failure this
--      whole ticket is about.
--   b. pg_cron job or_queue_health, every 10 minutes.
--   c. public.queue_health_alert_state, ONE ROW PER QUEUE suppression table.
--   d. idx_webhook_delivery_undrained, the index the probe's query actually needs.
--
-- The 10 minute cadence deliberately matches or_quiltt_drain_alert. The signal
-- is the age of the oldest undrained row against a threshold measured in hours,
-- so a faster cadence would buy nothing and only add chat noise.
--
-- Separate suppression table rather than sharing drain_alert_state: two probes
-- sharing one cooldown row means whichever fires first silences the other for
-- an hour, and they watch different things. For the same reason this table is
-- keyed per queue rather than being a single row.
--
-- DDL scope: (a), (b) and (c) are DDL. Applied by the DBA on dev and prod.
--
-- Down / undo (run these manually to remove this migration):
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'or_queue_health';
--   DROP FUNCTION IF EXISTS public.invoke_or_queue_health();
--   DROP TABLE IF EXISTS public.queue_health_alert_state;
--   DROP INDEX IF EXISTS public.idx_webhook_delivery_undrained;
-- ============================================================


-- 1. HTTP helper to invoke the probe from pg_cron.

CREATE OR REPLACE FUNCTION public.invoke_or_queue_health()
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
    RAISE EXCEPTION '[invoke_or_queue_health] vault secret or_internal_worker_token missing';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION '[invoke_or_queue_health] vault secret or_functions_base_url missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-queue-health',
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

REVOKE ALL ON FUNCTION public.invoke_or_queue_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_queue_health() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_queue_health() IS
  'Cron-only helper. POSTs to or-queue-health with the internal worker token. '
  'Both secrets read from vault.decrypted_secrets (or_internal_worker_token, '
  'or_functions_base_url). RAISE EXCEPTION on missing config so pg_cron marks '
  'the run failed (DL-1568).';


-- 2. Schedule every 10 minutes.
--    Idempotent: unschedules any prior or_queue_health job first, so
--    re-running the migration is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'or_queue_health';

    PERFORM cron.schedule(
      'or_queue_health',
      '*/10 * * * *',
      $job$SELECT public.invoke_or_queue_health();$job$
    );
    RAISE NOTICE 'or_queue_health scheduled every 10 minutes via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; or_queue_health must be triggered manually';
  END IF;
END$$;


-- 3. Suppression state, ONE ROW PER QUEUE.
--    The probe reads last_notified_at for the queues that are firing and skips
--    posting for any that are inside the cooldown.
--
--    Deliberately NOT a single global row. Ruled on 2026-08-10 while reviewing
--    PR 648: with one shared row, the first queue to stall silences every other
--    queue for the whole cooldown window, so a second unrelated outage starting
--    inside that hour is never announced at all. The suppression key must be as
--    granular as the thing being suppressed.

CREATE TABLE IF NOT EXISTS public.queue_health_alert_state (
  queue            TEXT PRIMARY KEY,
  last_notified_at TIMESTAMPTZ NOT NULL
);

REVOKE ALL ON TABLE public.queue_health_alert_state FROM PUBLIC, authenticated, anon;
-- Service role only; read and written by the edge function.

ALTER TABLE public.queue_health_alert_state ENABLE ROW LEVEL SECURITY;
-- No policies: service role bypasses RLS. ENABLE keeps pg_advisor clean.

COMMENT ON TABLE public.queue_health_alert_state IS
  'Per-queue suppression state for or-queue-health. One row per queue table; '
  'last_notified_at is stamped only for queues actually named in a chat post, '
  'so suppressing one queue never silences another (DL-1568).';


-- 4. Index supporting the probe's own query.
--
--    The probe asks, per queue: oldest row where the drain column IS NULL,
--    ordered by the enqueue column, limit 1.
--
--    idx_webhook_delivery_pending already exists but CANNOT serve that query.
--    It is partial on (succeeded_at IS NULL AND attempts < 5), and the probe
--    deliberately omits the attempts clause because a row that exhausted its
--    retries is precisely the row that must still be visible. Postgres can only
--    use a partial index when the query predicate implies the index predicate,
--    and `succeeded_at IS NULL` does not imply `attempts < 5`. An earlier draft
--    of the probe carried a comment claiming the existing index covered this.
--    It did not. This index matches the probe's actual predicate.
--
--    Partial on succeeded_at IS NULL, so it stays small: once the dispatcher is
--    draining, the indexed set is only the rows still outstanding.

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_undrained
  ON public.webhook_delivery (created_at)
  WHERE succeeded_at IS NULL;

COMMENT ON INDEX public.idx_webhook_delivery_undrained IS
  'Serves or-queue-health: oldest undrained row by created_at. Distinct from '
  'idx_webhook_delivery_pending, which is partial on attempts < 5 and so cannot '
  'serve a query that must also see rows past MAX_ATTEMPTS (DL-1568).';
