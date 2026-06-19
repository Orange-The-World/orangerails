-- ============================================================
-- Drop the temporary _quiltt_webhook_debug table.
-- The signature scheme has been verified (see PR
-- fix/quiltt-webhook-signature-scheme): Quiltt signs with literal
-- version "1" + timestamp + body, and the timestamp is unix seconds
-- (not ISO 8601). With those corrections, or-quiltt-webhook accepts
-- Quiltt's real webhooks and the debug capture is no longer needed.
-- ============================================================

DROP TABLE IF EXISTS public._quiltt_webhook_debug;
