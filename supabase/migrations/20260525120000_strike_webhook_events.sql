-- Strike webhook event queue.
--
-- OR is zero-knowledge: the customer's Strike API key is encrypted with
-- their vault password and OR can only decrypt when the user is actively
-- syncing. But Strike's webhooks arrive whenever (no user present), so
-- we can't make follow-up GETs at receipt time.
--
-- Pattern: webhook → queue → user-initiated sync drains the queue.
--
-- 1. Strike POSTs to or-strike-webhook with X-Webhook-Signature
-- 2. or-strike-webhook verifies HMAC, inserts a row here
-- 3. On next sync, or-sync (with the user's unlock key in memory)
--    decrypts the API key, drains pending rows by calling
--    GET /v1/invoices/{entity_id} etc., normalizes the result,
--    sinks into the consumer's system, marks the row processed.
--
-- The UNIQUE (connection_id, strike_event_id) constraint provides
-- idempotency: Strike may retry deliveries, we'll silently dedupe.

CREATE TABLE public.strike_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES public.connections(id) ON DELETE CASCADE,
    strike_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE (connection_id, strike_event_id)
);

CREATE INDEX strike_webhook_events_pending_idx
    ON public.strike_webhook_events (connection_id, received_at)
    WHERE processed_at IS NULL;

COMMENT ON TABLE public.strike_webhook_events IS
    'Queue of Strike webhook events awaiting user-initiated drain. Events arrive at or-strike-webhook; or-sync drains them on next user sync.';

-- No RLS policies = denied via PostgREST by default. Only service-role
-- edge functions touch this table.
ALTER TABLE public.strike_webhook_events ENABLE ROW LEVEL SECURITY;

-- Connection columns: Strike subscription metadata.
-- These are NOT customer credentials:
--   strike_subscription_id is a Strike-issued public ID
--   strike_webhook_secret is the HMAC key OR ↔ Strike share for payload
--     signing (similar to a webhook receiver token)
-- Storing in plaintext is correct: or-strike-webhook needs to verify
-- HMACs at receipt time (user not present, no unlock key available).
ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS strike_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS strike_webhook_secret TEXT;

COMMENT ON COLUMN public.connections.strike_subscription_id IS
    'Strike-issued subscription ID from POST /v1/subscriptions. Used to delete the subscription on disconnect.';

COMMENT ON COLUMN public.connections.strike_webhook_secret IS
    'HMAC-SHA256 key OR generated and registered with Strike. or-strike-webhook uses this to verify X-Webhook-Signature on inbound events. Not a customer credential.';
