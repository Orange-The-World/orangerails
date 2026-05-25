-- ============================================================
-- Webhook v2 wire format — event_id for consumer-side dedupe
-- ============================================================
-- Adds a per-delivery UUID surfaced to consumers via the new
-- `X-OR-Event-Id` header. Consumers use this for idempotent processing
-- (dedupe on retry, etc.) — the same model Stripe and Shopify ship.
--
-- The id is generated server-side at queue time (default gen_random_uuid())
-- and stays stable across retry attempts of the same delivery. A consumer
-- that sees the same event_id twice MUST treat the second as a duplicate.
--
-- Backwards compatible: column is additive + nullable; existing rows
-- predating this migration carry NULL, the dispatcher backfills any NULL
-- on its next attempt.

ALTER TABLE public.webhook_delivery
  ADD COLUMN IF NOT EXISTS event_id UUID;

-- Default for new rows; backfill the rest opportunistically.
ALTER TABLE public.webhook_delivery
  ALTER COLUMN event_id SET DEFAULT gen_random_uuid();

UPDATE public.webhook_delivery
   SET event_id = gen_random_uuid()
 WHERE event_id IS NULL;

-- Make event_id required going forward. Safe because the UPDATE above
-- backfilled every existing row and the new DEFAULT covers all future
-- inserts.
ALTER TABLE public.webhook_delivery
  ALTER COLUMN event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_delivery_event_id
  ON public.webhook_delivery (event_id);

COMMENT ON COLUMN public.webhook_delivery.event_id IS
  'Stable UUID for this delivery, surfaced to consumers via the X-OR-Event-Id header. Consumers dedupe on this — the same event_id may arrive more than once during retry.';
