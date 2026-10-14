-- OR-T0386: track when the Strike webhook secret was last rotated.
--
-- strike_subscription_checked_at is stamped whenever we verify the
-- subscription is alive (enabled + URL match, at most once per day).
-- That check cannot detect a secret mismatch because Strike's GET
-- /subscriptions endpoint never returns the secret value.
--
-- strike_subscription_rotated_at is stamped only when we actually
-- delete-and-recreate the subscription (generating a fresh HMAC secret).
-- queue.ts compares this timestamp against SUBSCRIPTION_SECRET_REFRESH_INTERVAL_MS
-- (7 days) and forces a resubscribe when the column is NULL or older than
-- the interval. NULL on existing rows intentionally triggers a rotation on
-- the first sync after this migration ships.

ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS strike_subscription_rotated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.connections.strike_subscription_rotated_at IS
  'Last time the Strike webhook subscription secret was rotated (delete+recreate). '
  'NULL means never rotated under the periodic-rotation scheme (OR-T0386). '
  'The sync path (queue.ts) forces a resubscribe when this is NULL or older than 7 days.';
