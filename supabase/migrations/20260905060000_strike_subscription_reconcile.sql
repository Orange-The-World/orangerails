-- Strike webhook subscription reconcile columns (OR-T0386).
--
-- Root cause: the two production connections rejecting every Strike
-- webhook delivery (bad-sig 401, verified against production function
-- logs) both already hold a stored subscription id and a stored secret.
-- The signature verification code itself is correct end to end, proved
-- by signing a real request with a known secret against the deployed
-- function and getting 200, then a deliberately wrong signature and
-- getting 401. So the stored secret has drifted from the secret Strike
-- is actually signing with.
--
-- The existing registration guard in queue.ts, `if (!conn.strike_subscription_id)`,
-- only fires the first time a subscription is created. A connection that
-- already holds a (now wrong) subscription id never re-registers and stays
-- broken forever. These two columns are the reconcile-and-resubscribe fix:
--
--   strike_bad_sig_count      counts consecutive bad-sig 401s. Reset to 0 on
--                             any correctly verified delivery, so this only
--                             ever measures a run of genuine failures, never
--                             an accumulation across unrelated traffic.
--
--   strike_needs_resubscribe  set once the count crosses the threshold
--                             (see or-strike-webhook/index.ts). Read at the
--                             next user-initiated sync, the one moment the
--                             server holds decrypted Strike credentials
--                             (zero-knowledge auth: the server cannot act on
--                             a connection's Strike key when the user is not
--                             present). drainStrikeQueue then deletes the
--                             stale subscription and registers a fresh one
--                             with a new secret, and clears the flag.
--
-- Deliberately requires several consecutive bad-sig deliveries, not a
-- single one, before acting: one unusual delivery must not by itself
-- trigger a resubscribe cycle.
ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS strike_bad_sig_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS strike_needs_resubscribe BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.connections.strike_bad_sig_count IS
    'Consecutive Strike webhook bad-sig 401s since the last correctly verified delivery. Reset to 0 on any good delivery. Drives strike_needs_resubscribe.';

COMMENT ON COLUMN public.connections.strike_needs_resubscribe IS
    'Set by or-strike-webhook once strike_bad_sig_count crosses the threshold. Cleared by drainStrikeQueue on the next user-initiated sync, which deletes the stale Strike subscription and registers a fresh one with a new secret.';
