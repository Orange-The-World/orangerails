-- ============================================================
-- pg_cron work-unit assertions (DL-1592)
--
-- WHY THIS EXISTS.
-- Every pg_cron job on prod reports "succeeded" whether it processed all of
-- its work, one item, or nothing at all: the exit status describes the run
-- finishing, not the work happening. A drain that silently stops moving rows
-- looks identical to a healthy one. That is the failure shape behind DL-1540
-- and DL-1562.
--
-- Each function below asserts the WORK a job is supposed to have done, not
-- that it ran. It RAISES (a loud, non-zero signal) when the backlog it owns
-- is non-empty, and where it reads cron.job_run_details it wraps that read so
-- "I could not check" is itself an exception, never a silent pass.
--
-- Coverage: all 5 active jobs on prod.
--   assert_cleanup_quiltt_inbox_payloads   -> cleanup_quiltt_inbox_payloads (job 2)
--   assert_cleanup_expired_widget_sessions -> cleanup_expired_widget_sessions_hourly (job 3)
--   assert_or_quiltt_sync_drain            -> or_quiltt_sync_drain (job 4)
--   assert_or_quiltt_drain_alert           -> or_quiltt_drain_alert (job 5)
--   assert_or_webhook_dispatch_drain       -> or_webhook_dispatch_drain (job 6)
--
-- Logic author: SRE (assertions 1 to 4). Assertion 5 (webhook dispatch) was
-- added to close the job-6 gap SRE flagged, using the predicate CTO Rails
-- specified. Column names verified against dev and prod 2026-08-25.
-- ============================================================

-- 1. cleanup_quiltt_inbox_payloads (daily 03:17 UTC)
CREATE OR REPLACE FUNCTION public.assert_cleanup_quiltt_inbox_payloads()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  last_run    timestamptz;
  last_status text;
  stale_count int;
BEGIN
  BEGIN
    SELECT max(d.start_time),
           (array_agg(d.status ORDER BY d.start_time DESC))[1]
    INTO   last_run, last_status
    FROM   cron.job_run_details d
    JOIN   cron.job j ON j.jobid = d.jobid
    WHERE  j.jobname = 'cleanup_quiltt_inbox_payloads';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '[assert] cannot read cron.job_run_details: %', SQLERRM;
  END;

  IF last_run IS NULL THEN
    RAISE EXCEPTION '[assert] cleanup_quiltt_inbox_payloads: no run history';
  END IF;
  IF last_run < now() - interval '25 hours' THEN
    RAISE EXCEPTION '[assert] cleanup_quiltt_inbox_payloads: last ran %, >25h ago', last_run;
  END IF;
  IF last_status <> 'succeeded' THEN
    RAISE EXCEPTION '[assert] cleanup_quiltt_inbox_payloads: last status was %', last_status;
  END IF;

  -- Work-unit: no records that should have been truncated still carry live payloads
  SELECT count(*) INTO stale_count
  FROM   public.quiltt_webhook_inbox
  WHERE  processed_at IS NOT NULL
    AND  processed_at < now() - interval '31 days'
    AND  (payload->>'_truncated_at') IS NULL;

  IF stale_count > 0 THEN
    RAISE EXCEPTION '[assert] cleanup_quiltt_inbox_payloads: % untruncated rows >31d old', stale_count;
  END IF;

  RETURN format('ok: last ran %s (%s), 0 stale rows',
                last_run AT TIME ZONE 'America/New_York', last_status);
END;
$$;

-- 2. cleanup_expired_widget_sessions_hourly (hourly at :07)
CREATE OR REPLACE FUNCTION public.assert_cleanup_expired_widget_sessions()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  last_run    timestamptz;
  last_status text;
  leftover    int;
BEGIN
  BEGIN
    SELECT max(d.start_time),
           (array_agg(d.status ORDER BY d.start_time DESC))[1]
    INTO   last_run, last_status
    FROM   cron.job_run_details d
    JOIN   cron.job j ON j.jobid = d.jobid
    WHERE  j.jobname = 'cleanup_expired_widget_sessions_hourly';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '[assert] cannot read cron.job_run_details: %', SQLERRM;
  END;

  IF last_run IS NULL THEN
    RAISE EXCEPTION '[assert] cleanup_expired_widget_sessions_hourly: no run history';
  END IF;
  IF last_run < now() - interval '75 minutes' THEN
    RAISE EXCEPTION '[assert] cleanup_expired_widget_sessions_hourly: last ran %, >75m ago', last_run;
  END IF;
  IF last_status <> 'succeeded' THEN
    RAISE EXCEPTION '[assert] cleanup_expired_widget_sessions_hourly: last status was %', last_status;
  END IF;

  -- Work-unit: no sessions expired >2h ago should remain after two runs
  SELECT count(*) INTO leftover
  FROM   public.pending_widget_sessions
  WHERE  expires_at < now() - interval '2 hours';

  IF leftover > 0 THEN
    RAISE EXCEPTION '[assert] cleanup_expired_widget_sessions_hourly: % sessions expired >2h still present', leftover;
  END IF;

  RETURN format('ok: last ran %s (%s), 0 leftover sessions',
                last_run AT TIME ZONE 'America/New_York', last_status);
END;
$$;

-- 3. or_quiltt_sync_drain (every minute)
-- Work-unit: quiltt inbox backlog empty. Replaces the earlier net._http_response
-- join, which returned zero rows always because pg_net deletes
-- net.http_request_queue on completion.
CREATE OR REPLACE FUNCTION public.assert_or_quiltt_sync_drain()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_stuck int;
BEGIN
  SELECT COUNT(*) INTO v_stuck
  FROM quiltt_webhook_inbox
  WHERE processed_at IS NULL
    AND received_at < now() - interval '15 min'
    AND attempts < 5;
  IF v_stuck > 0 THEN
    RAISE EXCEPTION 'or_quiltt_sync_drain: % events unprocessed >15 min with retries remaining', v_stuck;
  END IF;
END;
$$;

-- 4. or_quiltt_drain_alert (every 10 minutes)
-- Domain check: events arriving but none being processed means the drain stalled.
CREATE OR REPLACE FUNCTION public.assert_or_quiltt_drain_alert()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_received int; v_processed int;
BEGIN
  SELECT COUNT(*) INTO v_received FROM quiltt_webhook_inbox
    WHERE received_at > now() - interval '30 min';
  SELECT COUNT(*) INTO v_processed FROM quiltt_webhook_inbox
    WHERE processed_at > now() - interval '30 min';
  IF v_received > 0 AND v_processed = 0 THEN
    RAISE EXCEPTION 'or_quiltt_drain_alert: % events received in last 30 min, none processed, drain stalled', v_received;
  END IF;
END;
$$;

-- 5. or_webhook_dispatch_drain (every minute)
-- Work-unit: webhook delivery backlog empty.
-- Predicate per CTO Rails (DL-1592): a row counts as delivered only when
-- succeeded_at IS NOT NULL AND last_error IS NULL, so "not delivered" is
-- (succeeded_at IS NULL OR last_error IS NOT NULL). A row that carries
-- succeeded_at with last_error set was never truly delivered and must still
-- count as stuck. Verified on prod 2026-08-25: 0 rows carry succeeded_at with
-- last_error set, so the OR clause adds no false positives against live data.
CREATE OR REPLACE FUNCTION public.assert_or_webhook_dispatch_drain()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_stuck int;
BEGIN
  SELECT COUNT(*) INTO v_stuck
  FROM webhook_delivery
  WHERE (succeeded_at IS NULL OR last_error IS NOT NULL)
    AND attempts < 5
    AND created_at < now() - interval '15 min';
  IF v_stuck > 0 THEN
    RAISE EXCEPTION 'or_webhook_dispatch_drain: % deliveries undelivered >15 min with retries remaining', v_stuck;
  END IF;
END;
$$;

-- ============================================================
-- Grants (DL-1661). service_role only.
--
-- Creating a function in the public schema on this project is not a neutral
-- act: the schema carries a default ACL (pg_default_acl, objtype f, grantor
-- postgres) that issues a PER-ROLE EXECUTE grant to anon and to authenticated
-- at CREATE FUNCTION time. As first written this file set no grants at all, so
-- all five assertions above landed callable by the anonymous role. They report
-- internal backlog depth and nothing outside the database should invoke them.
--
-- The revoke NAMES the roles. REVOKE ... FROM PUBLIC does not remove a grant
-- made directly to a named role, so the FROM PUBLIC spelling would run clean
-- and change nothing. The pg_cron jobs that call these run as postgres, which
-- is the owner and is unaffected either way.
-- ============================================================
DO $grants$
DECLARE
  v_sig  text;
  v_sigs text[] := ARRAY[
    'public.assert_cleanup_quiltt_inbox_payloads()',
    'public.assert_cleanup_expired_widget_sessions()',
    'public.assert_or_quiltt_sync_drain()',
    'public.assert_or_quiltt_drain_alert()',
    'public.assert_or_webhook_dispatch_drain()'
  ];
  v_hit int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase API roles absent on this database, nothing to revoke';
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'FAIL: % does not exist after this migration created it', v_sig;
    END IF;
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    v_hit := v_hit + 1;
  END LOOP;

  RAISE NOTICE 'locked down % assertion function(s)', v_hit;
END
$grants$;

-- Post-condition, per function. The revoke above is the statement; this is the
-- evidence. A migration that reports success while leaving one of these open to
-- anon is the exact failure this block exists to make impossible.
DO $verify$
DECLARE
  v_sig  text;
  v_oid  oid;
  v_open text[] := ARRAY[]::text[];
  v_sigs text[] := ARRAY[
    'public.assert_cleanup_quiltt_inbox_payloads()',
    'public.assert_cleanup_expired_widget_sessions()',
    'public.assert_or_quiltt_sync_drain()',
    'public.assert_or_quiltt_drain_alert()',
    'public.assert_or_webhook_dispatch_drain()'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL: % does not exist', v_sig;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_open := v_open || v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: service_role cannot execute %', v_sig;
    END IF;
  END LOOP;

  IF array_length(v_open, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: anon or authenticated still holds EXECUTE on: %',
      array_to_string(v_open, ', ');
  END IF;
END
$verify$;
