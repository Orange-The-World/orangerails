-- ============================================================
-- sync.completed webhook delivery scaffolding
-- ============================================================
-- Adds the event-push side of OR's platform protocol. Today every
-- consumer (V2, V3, OW) polls or-sync because OR has no event push.
-- This migration adds the durable queue (webhook_delivery) and the
-- per-platform webhook destination + signing secret.
--
-- The dispatcher (supabase/functions/or-webhook-dispatch) drains the
-- queue out-of-band; or-sync only INSERTs a row at the end of a
-- successful run when the platform has a webhook_url configured.
--
-- All changes are additive and nullable so this migration is safe to
-- apply against environments where no platform yet uses webhooks.

-- ============================================================
-- 1. platforms.webhook_url + platforms.webhook_secret
-- ============================================================

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS webhook_url    TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

COMMENT ON COLUMN public.platforms.webhook_url IS
  'HTTPS endpoint that OR POSTs sync.completed (and future) events to. NULL = platform has not enabled webhooks (skip dispatch).';

COMMENT ON COLUMN public.platforms.webhook_secret IS
  'Per-platform HMAC-SHA-256 signing secret (32 random bytes, hex-encoded = 64 chars). Used to populate the X-OR-Signature header on every webhook POST. Rotate by issuing a new secret; consumers verify against the value last fetched from their platform-admin dashboard.';

-- ============================================================
-- 2. webhook_delivery — the durable retry queue
-- ============================================================

CREATE TABLE IF NOT EXISTS public.webhook_delivery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id     UUID NOT NULL REFERENCES public.platforms(id) ON DELETE CASCADE,
  subaccount_id   UUID REFERENCES public.subaccounts(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  succeeded_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dispatcher's hot path: "pending rows, oldest first, < 5 attempts".
-- Partial index makes the queue drain query cheap regardless of how
-- many succeeded rows accumulate.
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_pending
  ON public.webhook_delivery (created_at)
  WHERE succeeded_at IS NULL AND attempts < 5;

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_platform
  ON public.webhook_delivery (platform_id);

ALTER TABLE public.webhook_delivery ENABLE ROW LEVEL SECURITY;

-- Only the service role (edge functions) touches this table. No
-- authenticated-user policy is intentional: consumers see deliveries
-- via their own webhook receiver, not by reading OR's queue.
DROP POLICY IF EXISTS "webhook_delivery service role only" ON public.webhook_delivery;
CREATE POLICY "webhook_delivery service role only"
  ON public.webhook_delivery FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.webhook_delivery IS
  'Durable outbound webhook queue. or-sync inserts a row on successful sync; or-webhook-dispatch drains the queue with exponential backoff and up to 5 attempts. See supabase/functions/or-webhook-dispatch/index.ts.';
