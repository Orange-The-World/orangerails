-- quiltt_webhook_inbox.retirement_reason and stealth catch-up (DL-0326 / DL-0465 / DL-0443)
--
-- PRIMARY PURPOSE: add retirement_reason to quiltt_webhook_inbox.
-- Records the reason a webhook row was permanently retired by the drain's
-- terminal guard (e.g. "max-attempts:<err>"). NULL until a row is retired.
--
-- CATCH-UP: also ensures last_sync_attempt_at lands on stealth_connections on prod.
-- Version 20260809120000 is shared by two files (quiltt and stealth). The quiltt
-- stub at that version runs first alphabetically on prod (q < s), recording
-- 20260809120000 in schema_migrations; the stealth file is then skipped by the
-- runner. Including the stealth ADD COLUMN here (IF NOT EXISTS, idempotent) ensures
-- the column lands on prod. On dev, 20260809120000 is already applied as
-- stealth_add_last_sync_attempt_at, so the IF NOT EXISTS is a no-op there.
--
-- Originally versioned 20260730120000, then attempted at 20260809120000, now
-- settled at 20260809130000 to avoid the duplicate-prefix collision.
-- Refs: DL-0647, DL-0326, DL-0465, DL-0443

-- Stealth catch-up (idempotent; may have been skipped on prod due to prefix collision)
ALTER TABLE public.stealth_connections
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz;

COMMENT ON COLUMN public.stealth_connections.last_sync_attempt_at IS
  'Set server-side at the start of each sync attempt (before runSync). Bare timestamp only, no scan targets. Distinguishes never-attempted from attempted-but-cursor-write-failed.';

-- Primary purpose: retirement reason tracking
ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS retirement_reason text;

COMMENT ON COLUMN public.quiltt_webhook_inbox.retirement_reason IS
  'Reason a webhook row was permanently retired by the drain terminal guard (e.g. max-attempts:<err>). NULL until retirement.';
