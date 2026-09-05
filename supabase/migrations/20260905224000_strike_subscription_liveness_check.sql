-- Strike subscription liveness check (OR-T0386).
--
-- The reconcile columns added in 20260905060000 heal a broken subscription
-- only after strike_bad_sig_count reaches its threshold, which requires
-- Strike to keep delivering to a failing subscription. Measured against
-- production 2026-09-05: the two connections that fix targets received 4
-- bad-sig deliveries in 7 days, all in one burst, then zero in the 6 days
-- since. A counter that depends on failures it never receives cannot cross
-- its threshold, so those connections would stay broken indefinitely.
--
-- This timestamp lets drainStrikeQueue positively verify the stored
-- subscription against Strike's own GET /v1/subscriptions/{id} at sync
-- time (the only moment the server holds the decrypted Strike key under
-- ZKA), instead of only reacting to failures. Damped to run at most once a
-- day per connection so a healthy connection does not add an extra Strike
-- API call to every single sync.
--
-- Null means never checked: every connection with an existing subscription
-- id gets checked on its first sync after this ships, which is the correct
-- default rather than an opt-in.
-- OUT-OF-ORDER-OK: additive only, one new nullable column with no default on public.connections; independent of every migration currently ahead of it, safe to apply out of order.
--
ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS strike_subscription_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.connections.strike_subscription_checked_at IS
    'Last time drainStrikeQueue positively verified the stored strike_subscription_id against Strike (exists, enabled, webhookUrl matches). Null means never checked. Damped to at most once a day; a mismatch forces a resubscribe on that sync (OR-T0386).';
