-- DL-0460: make invoke_or_quiltt_sync fail loudly when its vault config is missing.
--
-- Why this exists.
--
-- The Quiltt webhook drain (cron.job `or_quiltt_sync_drain`, `* * * * *`) stopped
-- doing anything on 2026-07-14 and nobody found out for 16 days. The queue grew to
-- 3550 unprocessed events while `cron.job_run_details` recorded `succeeded` on every
-- single tick, because the function's guards were written as:
--
--     RAISE NOTICE '... missing - skipping';
--     RETURN NULL;
--
-- A NOTICE is not an error. pg_cron sees a clean return and records success. The job
-- was green the entire time it was doing nothing at all, and the only visible symptom
-- was an absence: no transactions, anywhere, ever, for any Quiltt connection.
--
-- This migration changes both guards to RAISE EXCEPTION. The behaviour on the happy
-- path is byte-identical. The behaviour on a missing secret changes from "silently
-- return NULL" to "record the run as failed", which is the difference between a
-- condition a human can see and one nobody can.
--
-- Deliberately NOT changed here: the body of the function, the vault secret names, the
-- timeout, or the drain batch size. The missing secret itself (`or_functions_base_url`)
-- is hosting config and is restored out of band, not by a migration.
--
-- Note the failure mode this trades into. Once this is applied, a missing secret makes
-- the drain job fail once a minute rather than succeed once a minute. That is the
-- intended direction: a job that is loudly broken gets fixed, and a job that is quietly
-- broken costs 16 days of customer data.

CREATE OR REPLACE FUNCTION public.invoke_or_quiltt_sync()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'pg_temp'
AS $function$
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
    RAISE EXCEPTION
      '[invoke_or_quiltt_sync] vault secret or_internal_worker_token is missing or empty; drain cannot run';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION
      '[invoke_or_quiltt_sync] vault secret or_functions_base_url is missing or empty; drain cannot run';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-quiltt-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Worker-Token', worker_token
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO request_id;

  RETURN request_id;
END
$function$;

COMMENT ON FUNCTION public.invoke_or_quiltt_sync() IS
  'Fires the Quiltt webhook drain via pg_net. Raises rather than returning NULL when its '
  'vault config is absent, so a misconfigured drain shows up as a failed cron run instead '
  'of a green one that does nothing. See DL-0460.';
