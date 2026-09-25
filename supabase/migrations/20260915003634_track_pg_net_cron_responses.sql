-- 20260915003634_track_pg_net_cron_responses.sql
--
-- WHAT THIS CHANGES: persists each pg_net cron request id, checks that exact id
-- on the following invocation, and makes the later cron run fail when the HTTP
-- response is missing, timed out, errored, or non-2xx (OR-T0417).
-- WHY NOW: net.http_post only queues work. A successful enqueue made all four
-- HTTP-backed cron jobs green even when pg_net never delivered the request.
-- CAN IT BE UNDONE: alter the four cron commands back to SELECT invoke_*(),
-- re-apply the four invoker definitions named below, then drop
-- run_tracked_http_cron(text), enqueue_tracked_http_post(text), and
-- pg_net_cron_state. That restores the prior enqueue-only behavior and removes
-- the recorded state.
-- IS IT IDEMPOTENT: table/function/procedure definitions replace or upsert, and
-- cron.alter_job updates the existing jobs without duplicating them.
--
-- The response table has no URL or job column. The only honest correlation is
-- the bigint returned by net.http_post, so pg_net_cron_state records that id per
-- job. Every cadence here is at most ten minutes, well inside pg_net's roughly
-- six-hour response retention.
--
-- Why a PROCEDURE and an explicit COMMIT. If a function updated state, queued
-- the next request, and then raised, PostgreSQL would roll all of it back. The
-- job would stay red forever on the same failed response and could never show
-- recovery. pg_cron instead issues a top-level CALL. The procedure commits the
-- state and next enqueue first, then raises in the automatically-started next
-- transaction. cron.job_run_details becomes red while the following request is
-- still able to run and prove recovery on a later cadence.
--
-- The procedure must remain SECURITY INVOKER and must not gain a SET clause:
-- PostgreSQL forbids transaction control in SECURITY DEFINER procedures and in
-- procedures carrying SET configuration clauses. Its callable surface is owner
-- only; the SECURITY DEFINER function beneath it has a fixed search_path.
--
-- Original invoker definitions used for a manual down migration:
--   20260804140000_or_quiltt_sync_fail_loudly.sql
--   20260811000000_schedule_or_quiltt_drain_alert.sql
--   20260824120000_schedule_or_webhook_dispatch.sql
--   20260824140000_schedule_or_queue_health.sql
-- Requires: 20260804140000
-- Requires: 20260811000000
-- Requires: 20260824120000
-- Requires: 20260824140000

BEGIN;

-- Check the extension surfaces this migration will execute against. Names in a
-- ticket or an older migration are not evidence that the deployed extension
-- still has the expected shape.
DO $preflight$
DECLARE
  v_response_columns INTEGER;
BEGIN
  IF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION 'required pg_net http_post signature is missing';
  END IF;

  IF to_regclass('net._http_response') IS NULL THEN
    RAISE EXCEPTION 'required net._http_response table is missing';
  END IF;

  SELECT count(*)
  INTO v_response_columns
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'net._http_response'::regclass
    AND attname IN ('id', 'status_code', 'timed_out', 'error_msg', 'created')
    AND NOT attisdropped;

  IF v_response_columns <> 5 THEN
    RAISE EXCEPTION
      'net._http_response does not expose all required response columns';
  END IF;

  IF to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'required pg_cron alter_job signature is missing';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.pg_net_cron_state (
  job_name             TEXT PRIMARY KEY,
  endpoint_path        TEXT NOT NULL CHECK (endpoint_path ~ '^/[a-z0-9-]+$'),
  timeout_milliseconds INTEGER NOT NULL CHECK (timeout_milliseconds > 0),
  last_request_id      BIGINT,
  last_requested_at    TIMESTAMPTZ,
  last_checked_request_id BIGINT,
  last_checked_at      TIMESTAMPTZ,
  last_check_status    TEXT CHECK (last_check_status IN ('succeeded', 'failed')),
  last_status_code     INTEGER,
  last_timed_out       BOOLEAN,
  last_error           TEXT,
  CHECK (
    (last_request_id IS NULL AND last_requested_at IS NULL)
    OR (last_request_id IS NOT NULL AND last_requested_at IS NOT NULL)
  ),
  CHECK (
    (last_checked_request_id IS NULL
      AND last_checked_at IS NULL
      AND last_check_status IS NULL)
    OR (last_checked_request_id IS NOT NULL
      AND last_checked_at IS NOT NULL
      AND last_check_status IS NOT NULL)
  )
);

REVOKE ALL ON TABLE public.pg_net_cron_state FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pg_net_cron_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pg_net_cron_state IS
  'Registry and response-side state for HTTP-backed pg_cron jobs. The exact '
  'request id returned by pg_net is checked on the following invocation; '
  'missing evidence is failed, never healthy (OR-T0417).';

COMMENT ON COLUMN public.pg_net_cron_state.last_error IS
  'Bounded, non-response-body reason for the last failed check. NULL after a '
  'successful check. Response content is deliberately never copied here.';

-- The four rows are the coverage registry. Adding another HTTP-backed cron job
-- requires adding it here and giving it the same thin invoke_ wrapper.
INSERT INTO public.pg_net_cron_state (
  job_name,
  endpoint_path,
  timeout_milliseconds
)
VALUES
  (
    'or_quiltt_sync_drain',
    '/or-quiltt-sync',
    30000
  ),
  (
    'or_quiltt_drain_alert',
    '/or-quiltt-drain-alert',
    15000
  ),
  (
    'or_webhook_dispatch_drain',
    '/or-webhook-dispatch',
    30000
  ),
  (
    'or_queue_health',
    '/or-queue-health',
    15000
  )
ON CONFLICT (job_name) DO UPDATE
SET endpoint_path = EXCLUDED.endpoint_path,
    timeout_milliseconds = EXCLUDED.timeout_milliseconds;


-- One response-side implementation for every invoke_ helper. A missing row is
-- failed deliberately: by the next one- or ten-minute cadence, even the longest
-- configured HTTP timeout (30 seconds) has elapsed. Missing can mean the worker
-- stopped, its unlogged table was truncated, or evidence aged out; none is a
-- successful delivery.
CREATE OR REPLACE FUNCTION public.enqueue_tracked_http_post(p_job_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $function$
DECLARE
  v_endpoint_path        TEXT;
  v_timeout_milliseconds INTEGER;
  v_previous_request_id  BIGINT;
  v_had_previous         BOOLEAN := FALSE;
  v_response_found       BOOLEAN := FALSE;
  v_status_code          INTEGER;
  v_timed_out            BOOLEAN;
  v_error_msg            TEXT;
  v_check_status         TEXT;
  v_check_error          TEXT;
  v_worker_token         TEXT;
  v_base_url             TEXT;
  v_request_id           BIGINT;
BEGIN
  SELECT state.endpoint_path,
         state.timeout_milliseconds,
         state.last_request_id
  INTO v_endpoint_path,
       v_timeout_milliseconds,
       v_previous_request_id
  FROM public.pg_net_cron_state AS state
  WHERE state.job_name = p_job_name
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '[enqueue_tracked_http_post] unregistered job: %', p_job_name;
  END IF;

  v_had_previous := v_previous_request_id IS NOT NULL;

  IF v_had_previous THEN
    SELECT response.status_code,
           response.timed_out,
           response.error_msg
    INTO v_status_code,
         v_timed_out,
         v_error_msg
    FROM net._http_response AS response
    WHERE response.id = v_previous_request_id
    ORDER BY response.created DESC
    LIMIT 1;

    v_response_found := FOUND;

    IF NOT v_response_found THEN
      v_check_status := 'failed';
      v_check_error := 'no net._http_response row on the following invocation';
    ELSIF v_timed_out IS TRUE THEN
      v_check_status := 'failed';
      v_check_error := 'pg_net timed out';
    ELSIF v_error_msg IS NOT NULL AND v_error_msg <> '' THEN
      v_check_status := 'failed';
      v_check_error := left(v_error_msg, 500);
    ELSIF v_status_code BETWEEN 200 AND 299 THEN
      v_check_status := 'succeeded';
      v_check_error := NULL;
    ELSE
      v_check_status := 'failed';
      v_check_error := format(
        'HTTP status %s',
        COALESCE(v_status_code::TEXT, 'NULL')
      );
    END IF;
  END IF;

  SELECT decrypted_secret
  INTO v_worker_token
  FROM vault.decrypted_secrets
  WHERE name = 'or_internal_worker_token'
  LIMIT 1;

  IF v_worker_token IS NULL OR v_worker_token = '' THEN
    RAISE EXCEPTION '[%] vault secret or_internal_worker_token missing', p_job_name;
  END IF;

  SELECT decrypted_secret
  INTO v_base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF v_base_url IS NULL OR v_base_url = '' THEN
    RAISE EXCEPTION '[%] vault secret or_functions_base_url missing', p_job_name;
  END IF;

  SELECT net.http_post(
    url                  := rtrim(v_base_url, '/') || v_endpoint_path,
    headers              := jsonb_build_object(
      'Content-Type',            'application/json',
      'X-Internal-Worker-Token', v_worker_token
    ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := v_timeout_milliseconds
  )
  INTO v_request_id;

  IF v_request_id IS NULL THEN
    RAISE EXCEPTION '[%] net.http_post returned a NULL request id', p_job_name;
  END IF;

  UPDATE public.pg_net_cron_state
  SET last_request_id = v_request_id,
      last_requested_at = clock_timestamp(),
      last_checked_request_id = CASE
        WHEN v_had_previous THEN v_previous_request_id
        ELSE last_checked_request_id
      END,
      last_checked_at = CASE
        WHEN v_had_previous THEN clock_timestamp()
        ELSE last_checked_at
      END,
      last_check_status = CASE
        WHEN v_had_previous THEN v_check_status
        ELSE last_check_status
      END,
      last_status_code = CASE
        WHEN v_had_previous THEN v_status_code
        ELSE last_status_code
      END,
      last_timed_out = CASE
        WHEN v_had_previous THEN v_timed_out
        ELSE last_timed_out
      END,
      last_error = CASE
        WHEN v_had_previous THEN v_check_error
        ELSE last_error
      END
  WHERE job_name = p_job_name;

  RETURN v_request_id;
END
$function$;

REVOKE ALL ON FUNCTION public.enqueue_tracked_http_post(TEXT)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enqueue_tracked_http_post(TEXT) IS
  'Owner-only shared pg_net invoker. Checks the prior persisted request id in '
  'net._http_response, records its status, then queues and persists the next '
  'request. Called through the four invoke_ wrappers (OR-T0417).';


-- Preserve the public names and bigint return type used by existing code and
-- operators. Their only differences now live in the four-row registry above.
CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.enqueue_tracked_http_post('or_quiltt_sync_drain');
$$;

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_drain_alert()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.enqueue_tracked_http_post('or_quiltt_drain_alert');
$$;

CREATE OR REPLACE FUNCTION public.invoke_or_webhook_dispatch()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.enqueue_tracked_http_post('or_webhook_dispatch_drain');
$$;

CREATE OR REPLACE FUNCTION public.invoke_or_queue_health()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.enqueue_tracked_http_post('or_queue_health');
$$;

REVOKE ALL ON FUNCTION public.invoke_or_quiltt_sync()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_or_quiltt_drain_alert()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_or_webhook_dispatch()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_or_queue_health()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.invoke_or_quiltt_sync() IS
  'Tracked pg_net wrapper for or_quiltt_sync_drain. Persists the new request id '
  'and checks the preceding response through enqueue_tracked_http_post (OR-T0417).';
COMMENT ON FUNCTION public.invoke_or_quiltt_drain_alert() IS
  'Tracked pg_net wrapper for or_quiltt_drain_alert. Persists the new request id '
  'and checks the preceding response through enqueue_tracked_http_post (OR-T0417).';
COMMENT ON FUNCTION public.invoke_or_webhook_dispatch() IS
  'Tracked pg_net wrapper for or_webhook_dispatch_drain. Persists the new request '
  'id and checks the preceding response through enqueue_tracked_http_post (OR-T0417).';
COMMENT ON FUNCTION public.invoke_or_queue_health() IS
  'Tracked pg_net wrapper for or_queue_health. Persists the new request id and '
  'checks the preceding response through enqueue_tracked_http_post (OR-T0417).';


-- Called only as the complete, top-level pg_cron command. This explicit
-- dispatcher keeps each existing invoke_ helper on the actual customer path.
-- The response check remains single-source in enqueue_tracked_http_post().
CREATE OR REPLACE PROCEDURE public.run_tracked_http_cron(p_job_name TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
AS $procedure$
DECLARE
  v_request_id         BIGINT;
  v_checked_request_id BIGINT;
  v_check_status       TEXT;
  v_check_error        TEXT;
BEGIN
  CASE p_job_name
    WHEN 'or_quiltt_sync_drain' THEN
      SELECT public.invoke_or_quiltt_sync() INTO v_request_id;
    WHEN 'or_quiltt_drain_alert' THEN
      SELECT public.invoke_or_quiltt_drain_alert() INTO v_request_id;
    WHEN 'or_webhook_dispatch_drain' THEN
      SELECT public.invoke_or_webhook_dispatch() INTO v_request_id;
    WHEN 'or_queue_health' THEN
      SELECT public.invoke_or_queue_health() INTO v_request_id;
    ELSE
      RAISE EXCEPTION '[run_tracked_http_cron] unregistered job: %', p_job_name;
  END CASE;

  SELECT state.last_checked_request_id,
         state.last_check_status,
         state.last_error
  INTO v_checked_request_id,
       v_check_status,
       v_check_error
  FROM public.pg_net_cron_state AS state
  WHERE state.job_name = p_job_name;

  -- This commit is the boundary that keeps the next request and checked state
  -- durable even when the exception below makes cron.job_run_details red.
  COMMIT;

  IF v_check_status = 'failed' THEN
    RAISE EXCEPTION '[%] pg_net request % failed: %',
      p_job_name,
      v_checked_request_id,
      v_check_error;
  END IF;

  RAISE NOTICE '[%] queued pg_net request %; prior response status: %',
    p_job_name,
    v_request_id,
    COALESCE(v_check_status, 'first invocation, nothing to check');
END
$procedure$;

REVOKE ALL ON PROCEDURE public.run_tracked_http_cron(TEXT)
  FROM PUBLIC, anon, authenticated;

COMMENT ON PROCEDURE public.run_tracked_http_cron(TEXT) IS
  'Top-level pg_cron entry point. Calls the registered invoke_ helper, commits '
  'its next request and prior response status, then raises for a failed prior '
  'response so cron.job_run_details is visibly red without blocking recovery.';


-- Keep the existing job ids, cadences, database, username, active flag, and run
-- history. Only the command changes from enqueue-only SELECT to tracked CALL.
DO $schedule$
DECLARE
  v_job_count INTEGER;
  v_bad_jobs  TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron missing; cannot wire response-side checks';
  END IF;

  SELECT count(*)
  INTO v_job_count
  FROM cron.job
  WHERE jobname IN (
    'or_quiltt_sync_drain',
    'or_quiltt_drain_alert',
    'or_webhook_dispatch_drain',
    'or_queue_health'
  );

  IF v_job_count <> 4 THEN
    RAISE EXCEPTION
      'expected exactly four HTTP-backed cron jobs before rewiring, found %',
      v_job_count;
  END IF;

  SELECT array_agg(jobname ORDER BY jobname)
  INTO v_bad_jobs
  FROM cron.job
  WHERE jobname IN (
    'or_quiltt_sync_drain',
    'or_quiltt_drain_alert',
    'or_webhook_dispatch_drain',
    'or_queue_health'
  )
    AND (
      NOT active
      OR schedule <> CASE jobname
        WHEN 'or_quiltt_sync_drain' THEN '* * * * *'
        WHEN 'or_webhook_dispatch_drain' THEN '* * * * *'
        WHEN 'or_quiltt_drain_alert' THEN '*/10 * * * *'
        WHEN 'or_queue_health' THEN '*/10 * * * *'
      END
    );

  IF v_bad_jobs IS NOT NULL THEN
    RAISE EXCEPTION
      'HTTP cron jobs inactive or outside their one/ten-minute cadence: %',
      v_bad_jobs;
  END IF;

  PERFORM cron.alter_job(
    job_id := job.jobid,
    command := format(
      'CALL public.run_tracked_http_cron(%L)',
      job.jobname
    )
  )
  FROM cron.job AS job
  WHERE job.jobname IN (
    'or_quiltt_sync_drain',
    'or_quiltt_drain_alert',
    'or_webhook_dispatch_drain',
    'or_queue_health'
  );
END
$schedule$;

-- Apply-time structural postconditions. These prove the migration did not omit
-- a helper or leave one of the four known cron commands on the blind SELECT
-- path. They do not prove HTTP failure behavior; acceptance must do that on dev.
DO $postconditions$
DECLARE
  v_bad TEXT[];
BEGIN
  SELECT array_agg(job.jobname ORDER BY job.jobname)
  INTO v_bad
  FROM cron.job AS job
  WHERE job.jobname IN (
    'or_quiltt_sync_drain',
    'or_quiltt_drain_alert',
    'or_webhook_dispatch_drain',
    'or_queue_health'
  )
    AND job.command <> format(
      'CALL public.run_tracked_http_cron(%L)',
      job.jobname
    );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'HTTP cron jobs left on an untracked command: %', v_bad;
  END IF;

  IF (
    SELECT count(*)
    FROM public.pg_net_cron_state
    WHERE job_name IN (
      'or_quiltt_sync_drain',
      'or_quiltt_drain_alert',
      'or_webhook_dispatch_drain',
      'or_queue_health'
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'pg_net_cron_state registry is missing a required job';
  END IF;
END
$postconditions$;

COMMIT;
