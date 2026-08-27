-- DL-1562: give the webhook_delivery queue a drain.
--
-- or-webhook-dispatch has been deployed and ACTIVE since at least 20 August and
-- nothing has ever invoked it. Every row in webhook_delivery sits at attempts = 0
-- with succeeded_at NULL and last_error NULL: 52 rows, oldest 11 June, newest
-- 23 August. Zero attempts is not failure, it is never having been picked up.
--
-- Confirmed three ways before writing this, because a single negative is weak:
--   1. cron.job held four entries and none of them was this function.
--   2. information_schema.routines held two invoke_ helpers, neither this one.
--   3. Repo-wide, every reference to or-webhook-dispatch outside its own
--      directory is a comment, a test, or the SDK. Producers enqueue and say
--      "let or-webhook-dispatch pick it up". No caller existed anywhere.
--
-- The function's own header said "Cron-eligible. Invoke on a schedule (every
-- 30-60s)". That was an instruction to a future operator, not a description of
-- anything, and nobody carried it out. This migration carries it out.
--
-- Consequence while it was unwired: integrators were never pushed a
-- sync.completed notification, so they learned about new data only when they
-- next pulled. Data was stale rather than absent. That is why this is worth
-- fixing properly and is not an emergency.
--
-- NOTE ON ORDERING, added 2026-08-27, DL-1596. This file was applied on dev
-- BEFORE 20260824105000_mark_pre_cutoff_webhook_backlog_dead.sql, which numbers
-- below it and whose whole purpose is to retire the pre-cutoff backlog before
-- this schedule can drain it. This one merged first, in #844 and #846; that one
-- merged about forty minutes later in #850 with the lower number and did not
-- apply in that run. For that window the drain was live and the retirement was
-- not. webhook_delivery on dev held 0 rows, so nothing was delivered wrongly:
-- that is luck, not a control.
--
-- The lesson is general and it is not about these two files. Filename order
-- orders the files inside ONE apply run. It cannot reorder across runs, so on
-- any partly applied database, which is every environment we own, a file that
-- merges late while numbering early runs after the migrations it was written to
-- precede. The control is the out-of-order gate in
-- .github/workflows/supabase-deploy.yml, which refuses the apply and names the
-- offending file and the highest version already applied.
--
-- Mirrors invoke_or_quiltt_sync (20260804140000_or_quiltt_sync_fail_loudly.sql)
-- deliberately, including the loud-failure behaviour: a missing Vault secret
-- RAISES rather than returning NULL, so a broken config shows up as a failed
-- cron run instead of a green one that did nothing. That silent-skip pattern is
-- exactly how the Quiltt drain went unnoticed for 16 days (DL-0460).
--
-- Honest limitation, same as the sync helper: net.http_post (pg_net) QUEUES the
-- request and returns a request_id BEFORE the HTTP call completes, so a failed
-- POST cannot be caught here. This makes the CONFIGURATION path loud. Delivery
-- failures surface in net._http_response and in webhook_delivery.last_error.
--
-- Reversible: SELECT cron.unschedule('or_webhook_dispatch_drain'); then
-- DROP FUNCTION public.invoke_or_webhook_dispatch();
-- Idempotent: CREATE OR REPLACE, and the schedule is unscheduled before it is
-- created so re-running does not stack duplicate jobs.

CREATE OR REPLACE FUNCTION public.invoke_or_webhook_dispatch()
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
    RAISE EXCEPTION '[invoke_or_webhook_dispatch] vault secret or_internal_worker_token missing';
  END IF;

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'or_functions_base_url'
  LIMIT 1;

  IF base_url IS NULL OR base_url = '' THEN
    RAISE EXCEPTION '[invoke_or_webhook_dispatch] vault secret or_functions_base_url missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/or-webhook-dispatch',
    headers := jsonb_build_object(
      'Content-Type',            'application/json',
      'X-Internal-Worker-Token', worker_token
    ),
    body                  := '{}'::jsonb,
    timeout_milliseconds  := 30000
  ) INTO request_id;

  RETURN request_id;
END
$$;

REVOKE ALL ON FUNCTION public.invoke_or_webhook_dispatch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_or_webhook_dispatch() FROM authenticated, anon;

COMMENT ON FUNCTION public.invoke_or_webhook_dispatch() IS
  'Cron-only helper. POSTs an empty body to or-webhook-dispatch with the internal worker token. Base URL and worker token are read from Supabase Vault (or_functions_base_url, or_internal_worker_token). RAISES if either secret is missing so a broken config is loud, not a silent no-op. DL-1562.';

-- Every minute, matching or_quiltt_sync_drain. The dispatcher self-limits to
-- BATCH_SIZE rows per invocation and honours its own per-row backoff, so a
-- one-minute tick is a ceiling on latency rather than a load decision.
SELECT cron.unschedule('or_webhook_dispatch_drain')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'or_webhook_dispatch_drain');

SELECT cron.schedule(
  'or_webhook_dispatch_drain',
  '* * * * *',
  $cron$SELECT public.invoke_or_webhook_dispatch();$cron$
);
